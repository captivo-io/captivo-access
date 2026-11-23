package main

import (
	"bufio"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// The database proxy: a user's own PostgreSQL client (psql, DBeaver, DataGrip,
// pgAdmin), or MySQL client on its own port (mysqlproxy.go), reaches a database resource through Captivo with a connection
// ticket from the portal as its user name:
//
//	psql "host=<console host> port=15432 user=<ticket> dbname=<db> sslmode=require"
//
// TLS is required (the ticket must not travel in the clear). The proxy checks
// the ticket with the control plane, and the resource's connector signs in to
// the server with the saved password (connector/dbproxy.go), so the client
// never needs or sees it. From then on the proxy relays the protocol message by
// message, logging each statement (pgwire.go) and nothing of the data.
//
// A client's connections from one ticket and address are one session in the
// console: tools open several and reconnect after idling, and a session that
// came and went with every connection would bury the list.

const (
	pgHandshakeLimit = 30 * time.Second
	pgMaxPending     = 64 // handshakes and ticket checks in progress at once
	pgStartupMax     = 10000
	pgMessageKeep    = 1 << 20 // a frontend message read whole to log it; longer ones are streamed
	dbSessionLinger  = 60 * time.Second
	dbRecheckEvery   = 60 * time.Second
	dbLogFlushEvery  = 2 * time.Second
	dbLogFlushCount  = 100
)

type dbAuthorizer interface {
	DatabaseTarget(ticket, clientIP string) (dbTarget, error)
}

type pgProxyDeps struct {
	ctrl     dbAuthorizer
	session  func(connectorID string) *Session
	pick     func([]routeCandidate) routeCandidate
	hub      *SessionHub
	audit    *AuditQueue
	recIndex func(userID, siteID, host string, body []byte) error
	now      func() time.Time
}

type pgProxy struct {
	d        pgProxyDeps
	tls      *tls.Config
	myTLS    *tls.Config // MySQL clients: the same certificate, no ALPN
	mu       sync.Mutex
	sessions map[string]*dbSession // ticket + client address
	cancels  map[uint64]dbCancel   // the key the client was given -> the server's
	myConns  map[uint32]myConnRef  // the connection id a MySQL client was given -> the server's
}

type dbCancel struct {
	connectorID, host, port, tls, ca string
	pid, secret                      uint32
}

// certReloader serves the certificate files and picks up a renewed one
// without a restart (the wildcard certificate is renewed every two months).
type certReloader struct {
	certFile, keyFile string
	mu                sync.Mutex
	cert              *tls.Certificate
	mod               time.Time
	checked           time.Time
}

func (c *certReloader) get(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cert != nil && time.Since(c.checked) < time.Minute {
		return c.cert, nil
	}
	c.checked = time.Now()
	ci, err1 := os.Stat(c.certFile)
	ki, err2 := os.Stat(c.keyFile)
	if err1 != nil || err2 != nil {
		if c.cert != nil {
			return c.cert, nil
		}
		return nil, errors.New("no certificate")
	}
	mod := ci.ModTime()
	if ki.ModTime().After(mod) {
		mod = ki.ModTime()
	}
	if c.cert != nil && !mod.After(c.mod) {
		return c.cert, nil
	}
	cert, err := tls.LoadX509KeyPair(c.certFile, c.keyFile)
	if err != nil {
		if c.cert != nil {
			log.Printf("db proxy: can't load the renewed certificate (%v); keeping the old one", err)
			return c.cert, nil
		}
		return nil, err
	}
	if c.cert != nil {
		log.Printf("db proxy: loaded the renewed certificate")
	}
	c.cert, c.mod = &cert, mod
	return c.cert, nil
}

// startDbProxy listens for PostgreSQL clients on pgAddr and MySQL clients on
// myAddr (mysqlproxy.go); "" or "off" leaves one out. The certificate is
// newEdgeCert's: a self-signed one is taken by clients that connect with
// sslmode=require (ssl-mode=REQUIRED), which encrypts without checking it; set
// DB_TLS_CERT/DB_TLS_KEY (the console's own) for clients that verify it.
func startDbProxy(pgAddr, myAddr string, cr *certReloader, d pgProxyDeps) (pgOn, myOn bool, err error) {
	off := func(a string) bool { return a == "" || a == "off" }
	if off(pgAddr) && off(myAddr) {
		return false, false, nil
	}
	if cr == nil {
		return false, false, errors.New("no certificate")
	}
	p := &pgProxy{
		d: d, sessions: map[string]*dbSession{}, cancels: map[uint64]dbCancel{}, myConns: map[uint32]myConnRef{},
		tls:   &tls.Config{GetCertificate: cr.get, MinVersion: tls.VersionTLS12, NextProtos: []string{"postgresql"}},
		myTLS: &tls.Config{GetCertificate: cr.get, MinVersion: tls.VersionTLS12},
	}
	var errs []error
	if !off(pgAddr) {
		if ln, err := net.Listen("tcp", pgAddr); err != nil {
			errs = append(errs, fmt.Errorf("postgresql: %w", err))
		} else {
			go p.serve(ln, p.handle)
			pgOn = true
			log.Printf("db proxy: listening on %s", pgAddr)
		}
	}
	if !off(myAddr) {
		if ln, err := net.Listen("tcp", myAddr); err != nil {
			errs = append(errs, fmt.Errorf("mysql: %w", err))
		} else {
			go p.serve(ln, p.handleMySQL)
			myOn = true
			log.Printf("db proxy: mysql listening on %s", myAddr)
		}
	}
	if pgOn || myOn {
		go p.recheck()
	}
	return pgOn, myOn, errors.Join(errs...)
}

func (p *pgProxy) serve(ln net.Listener, handle func(net.Conn, func())) {
	pending := make(chan struct{}, pgMaxPending)
	for {
		c, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			time.Sleep(100 * time.Millisecond)
			continue
		}
		select {
		case pending <- struct{}{}:
		default:
			c.Close() // too many at once
			continue
		}
		go handle(c, func() { <-pending })
	}
}

// newEdgeCert is the certificate clients see where this side ends their TLS
// (the database proxies, recorded native RDP): DB_TLS_CERT/DB_TLS_KEY, the
// console's own, or else a self-signed one kept in dataDir.
func newEdgeCert(certFile, keyFile, dataDir string) (*certReloader, error) {
	if certFile == "" || keyFile == "" {
		var err error
		if certFile, keyFile, err = selfSignedDbCert(dataDir); err != nil {
			return nil, err
		}
	}
	cr := &certReloader{certFile: certFile, keyFile: keyFile}
	if _, err := cr.get(nil); err != nil {
		return nil, err
	}
	return cr, nil
}

// selfSignedDbCert returns the proxy's own certificate files, making them on
// first start. They are kept so a client that pinned the certificate keeps
// trusting it across updates.
func selfSignedDbCert(dir string) (string, string, error) {
	certFile, keyFile := filepath.Join(dir, "db_tls_cert.pem"), filepath.Join(dir, "db_tls_key.pem")
	if _, err := tls.LoadX509KeyPair(certFile, keyFile); err == nil {
		return certFile, keyFile, nil
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return "", "", err
	}
	serial, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	tpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "Captivo Access database proxy"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().AddDate(20, 0, 0),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		return "", "", err
	}
	kb, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return "", "", err
	}
	if err := os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kb}), 0o600); err != nil {
		return "", "", err
	}
	if err := os.WriteFile(certFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644); err != nil {
		return "", "", err
	}
	log.Printf("db proxy: made a self-signed certificate at %s (set DB_TLS_CERT/DB_TLS_KEY to use the console's own)", certFile)
	return certFile, keyFile, nil
}

// bufConn reads through a bufio.Reader that may already hold bytes.
type bufConn struct {
	net.Conn
	r *bufio.Reader
}

func (b *bufConn) Read(p []byte) (int, error) { return b.r.Read(p) }

func readStartup(r *bufio.Reader) (uint32, []byte, error) {
	var h [8]byte
	if _, err := io.ReadFull(r, h[:]); err != nil {
		return 0, nil, err
	}
	n := binary.BigEndian.Uint32(h[:4])
	if n < 8 || n > pgStartupMax {
		return 0, nil, errors.New("bad startup packet")
	}
	body := make([]byte, n-8)
	if _, err := io.ReadFull(r, body); err != nil {
		return 0, nil, err
	}
	return binary.BigEndian.Uint32(h[4:]), body, nil
}

// handle runs one client connection; started is called once it is past the
// handshake and the ticket check (or gave up), freeing its pending slot.
func (p *pgProxy) handle(raw net.Conn, started func()) {
	var once sync.Once
	release := func() { once.Do(started) }
	defer release()
	clientIP, _, _ := net.SplitHostPort(raw.RemoteAddr().String())
	_ = raw.SetDeadline(time.Now().Add(pgHandshakeLimit))
	var conn net.Conn = raw
	// Closing the TLS layer sends close_notify: libpq 17 counts a cancel as
	// failed when the connection just drops.
	defer func() { conn.Close() }()
	r := bufio.NewReader(raw)
	encrypted := false
	if b, err := r.Peek(1); err == nil && b[0] == 0x16 {
		// Direct TLS (PostgreSQL 17's sslnegotiation=direct).
		tc := tls.Server(&bufConn{Conn: raw, r: r}, p.tls)
		if tc.Handshake() != nil || tc.ConnectionState().NegotiatedProtocol != "postgresql" {
			return
		}
		conn, r, encrypted = tc, bufio.NewReader(tc), true
	}
	var params map[string]string
	var minor uint32
	for range 3 {
		code, body, err := readStartup(r)
		if err != nil {
			return
		}
		switch {
		case code == pgSSLRequest && !encrypted:
			if _, err := conn.Write([]byte{'S'}); err != nil {
				return
			}
			tc := tls.Server(&bufConn{Conn: raw, r: r}, p.tls)
			if tc.Handshake() != nil {
				return
			}
			conn, r, encrypted = tc, bufio.NewReader(tc), true
			continue
		case code == pgGSSENCRequest:
			if _, err := conn.Write([]byte{'N'}); err != nil {
				return
			}
			continue
		case code == pgCancelRequest:
			p.cancel(body)
			return
		case code>>16 == pgProtocol3:
			minor = code & 0xffff
			params = pgStartupParams(body)
		default:
			_, _ = conn.Write(pgFatal("08P01", "Captivo Access: unsupported protocol"))
			return
		}
		break
	}
	if params == nil {
		return
	}
	if !encrypted {
		_, _ = conn.Write(pgFatal("28000", "Captivo Access requires an encrypted connection: connect with sslmode=require"))
		return
	}
	p.open(conn, r, params, minor, clientIP, release)
}

func (p *pgProxy) open(conn net.Conn, r *bufio.Reader, params map[string]string, minor uint32, clientIP string, started func()) {
	ticket := params["user"]
	t, err := p.d.ctrl.DatabaseTarget(ticket, clientIP)
	if err != nil {
		code, msg := "28000", "Captivo Access could not check your access; try again"
		switch httpStatus(err) {
		case 404:
			time.Sleep(500 * time.Millisecond) // a guess costs time
			msg = "Captivo Access: this connection ticket is unknown or has expired. Get a new one from My access in your Captivo portal."
		case 403:
			msg = "Captivo Access: your access to this resource is not active"
		case 409:
			msg = "Captivo Access: this resource can't be opened as a database right now; ask your administrator"
		}
		_, _ = conn.Write(pgFatal(code, msg))
		return
	}
	if t.Engine != "" && t.Engine != "postgres" {
		_, _ = conn.Write(pgFatal("28000", "Captivo Access: this resource is a MySQL database; connect with a MySQL client (the Connect details in your portal)"))
		return
	}
	db := params["database"]
	if db == "" || db == ticket {
		db = t.Database // libpq's default database is the user name: here, the ticket
	}
	if len(t.Databases) > 0 && !containsStr(t.Databases, db) {
		_, _ = conn.Write(pgFatal("3D000", fmt.Sprintf("Captivo Access: database %q is not open on this resource (allowed: %s)", db, strings.Join(t.Databases, ", "))))
		p.auditDeny(t, clientIP, params, "database_not_allowed")
		return
	}

	s, err := p.join(ticket, clientIP, t, params["application_name"])
	if err != nil {
		_, _ = conn.Write(pgFatal("08006", "Captivo Access: "+err.Error()))
		return
	}
	defer p.leave(s)
	sealed := ""
	for _, c := range t.Connectors {
		if c.ID == s.connectorID {
			sealed = c.SealedSecret
		}
	}
	fwd := map[string]string{}
	for k, v := range params {
		if k != "user" && k != "database" {
			fwd[k] = v
		}
	}
	port := strconv.Itoa(t.Port)
	up, resp, err := dialDb(p.d.session(s.connectorID), tunnel.DbDialRequest{
		Engine: "postgres", Host: t.Host, Port: port, Username: t.Username, Database: db,
		Sealed: sealed, TLS: t.TLS, CACertPEM: t.CACertPEM, Params: fwd,
	})
	if err != nil {
		_, _ = conn.Write(pgFatal("08006", "Captivo Access: "+err.Error()))
		return
	}
	if resp.Error != "" {
		code, msg := resp.Code, "Captivo Access: "+resp.Error
		if code == "" {
			code = "08006" // the connector could not get a sign-in at all
		} else {
			msg = "Captivo Access: the database refused the saved account: " + resp.Error
		}
		log.Printf("db proxy: site=%s user=%s sign-in to %s failed: %s", t.SiteID, t.UserID, t.Host, resp.Error)
		_, _ = conn.Write(pgFatal(code, msg))
		up.Close()
		return
	}
	defer up.Close()

	var hello []byte
	if minor > 0 || hasProtocolOptions(params) {
		// We speak 3.0: say so, and which _pq_ options are not taken.
		var opts []string
		for k := range params {
			if strings.HasPrefix(k, "_pq_.") {
				opts = append(opts, k)
			}
		}
		b := binary.BigEndian.AppendUint32(nil, 0)
		b = binary.BigEndian.AppendUint32(b, uint32(len(opts)))
		for _, o := range opts {
			b = append(append(b, o...), 0)
		}
		hello = append(hello, pgMsg('v', b)...)
	}
	hello = append(hello, pgMsg('R', []byte{0, 0, 0, 0})...) // AuthenticationOk
	if _, err := conn.Write(hello); err != nil {
		return
	}
	_ = conn.SetDeadline(time.Time{})
	started()

	var once sync.Once
	closeBoth := func() { once.Do(func() { conn.Close(); up.Close() }) }
	id := s.addConn(closeBoth)
	defer s.dropConn(id)
	s.event(fmt.Sprintf("Connection opened to %s%s", db, appSuffix(params["application_name"])))
	tr := newQueryTracker(s.start, db)
	var myKey uint64
	done := make(chan struct{}, 2)
	go func() {
		p.relayServer(bufio.NewReader(up), conn, tr, s, func(pid, secret uint32) uint64 {
			myKey = p.newCancelKey(dbCancel{connectorID: s.connectorID, host: t.Host, port: port, tls: t.TLS, ca: t.CACertPEM, pid: pid, secret: secret})
			return myKey
		})
		done <- struct{}{}
	}()
	go func() { p.relayClient(r, up, tr); done <- struct{}{} }()
	<-done
	closeBoth()
	<-done
	if myKey != 0 {
		p.mu.Lock()
		delete(p.cancels, myKey)
		p.mu.Unlock()
	}
}

func appSuffix(app string) string {
	if app == "" {
		return ""
	}
	return " (" + app + ")"
}

func hasProtocolOptions(params map[string]string) bool {
	for k := range params {
		if strings.HasPrefix(k, "_pq_.") {
			return true
		}
	}
	return false
}

func containsStr(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// newCancelKey stores where a cancel goes and returns the key handed to the
// client: its process id in the high half, its secret in the low half.
func (p *pgProxy) newCancelKey(c dbCancel) uint64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	for {
		var b [8]byte
		_, _ = rand.Read(b[:])
		k := binary.BigEndian.Uint64(b[:])
		if _, taken := p.cancels[k]; !taken && k != 0 {
			p.cancels[k] = c
			return k
		}
	}
}

// cancel forwards a client's CancelRequest to the server it was meant for.
func (p *pgProxy) cancel(body []byte) {
	if len(body) < 8 {
		return
	}
	k := binary.BigEndian.Uint64(body[:8])
	p.mu.Lock()
	c, ok := p.cancels[k]
	p.mu.Unlock()
	if !ok {
		return
	}
	s := p.d.session(c.connectorID)
	if s == nil || s.mux == nil {
		return
	}
	st, err := s.mux.Open()
	if err != nil {
		return
	}
	defer st.Close()
	b, _ := json.Marshal(tunnel.DbCancelRequest{Kind: "db-cancel", Host: c.host, Port: c.port, TLS: c.tls, CACertPEM: c.ca, PID: c.pid, Secret: c.secret})
	_ = tunnel.WriteFrame(st, b)
}

// relayServer copies backend messages to the client. It reads the few it
// needs (the cancel key, completions, errors) and streams the rest, data rows
// included, without holding them.
func (p *pgProxy) relayServer(r *bufio.Reader, out io.Writer, tr *queryTracker, s *dbSession, rekey func(pid, secret uint32) uint64) {
	w := bufio.NewWriterSize(out, 64<<10)
	var h [5]byte
	for {
		if _, err := io.ReadFull(r, h[:]); err != nil {
			_ = w.Flush()
			return
		}
		t, n := h[0], int(binary.BigEndian.Uint32(h[1:]))-4
		if n < 0 {
			return
		}
		switch t {
		case 'K', 'C', 'E', 'Z', 'I', 's':
			if n > pgMessageKeep {
				return
			}
			body := make([]byte, n)
			if _, err := io.ReadFull(r, body); err != nil {
				return
			}
			if t == 'K' && n == 8 {
				// The client gets a key of ours; a cancel with it reaches this server.
				binary.BigEndian.PutUint64(body, rekey(binary.BigEndian.Uint32(body), binary.BigEndian.Uint32(body[4:])))
			}
			if evs := tr.server(t, body, p.d.now()); len(evs) > 0 {
				s.queries(evs)
			}
			_, _ = w.Write(pgMsg(t, body))
		default:
			if t == 'D' {
				tr.server(t, nil, time.Time{})
			}
			_, _ = w.Write(h[:])
			if _, err := io.CopyN(w, r, int64(n)); err != nil {
				_ = w.Flush()
				return
			}
		}
		if r.Buffered() == 0 {
			if w.Flush() != nil {
				return
			}
		}
	}
}

// relayClient copies frontend messages to the server, reading the statements
// (or the start of a very long one) into the tracker.
func (p *pgProxy) relayClient(r *bufio.Reader, out io.Writer, tr *queryTracker) {
	w := bufio.NewWriterSize(out, 64<<10)
	var h [5]byte
	for {
		if _, err := io.ReadFull(r, h[:]); err != nil {
			_ = w.Flush()
			return
		}
		t, n := h[0], int(binary.BigEndian.Uint32(h[1:]))-4
		if n < 0 {
			return
		}
		_, _ = w.Write(h[:])
		switch t {
		case 'Q', 'P', 'B', 'E', 'C':
			keep := n
			if keep > pgMessageKeep {
				keep = pgMessageKeep
			}
			body := make([]byte, keep)
			if _, err := io.ReadFull(r, body); err != nil {
				return
			}
			tr.client(t, body, p.d.now())
			_, _ = w.Write(body)
			if n > keep {
				if _, err := io.CopyN(w, r, int64(n-keep)); err != nil {
					return
				}
			}
		default:
			if _, err := io.CopyN(w, r, int64(n)); err != nil {
				return
			}
		}
		if r.Buffered() == 0 {
			if w.Flush() != nil {
				return
			}
		}
		if t == 'X' {
			return
		}
	}
}

// dialDb asks the connector to sign in to the server.
func dialDb(s *Session, req tunnel.DbDialRequest) (net.Conn, tunnel.DbDialResponse, error) {
	var resp tunnel.DbDialResponse
	if s == nil || s.mux == nil {
		return nil, resp, errors.New("the resource's connector is offline")
	}
	st, err := s.mux.Open()
	if err != nil {
		return nil, resp, errors.New("the resource's connector is offline")
	}
	req.Kind = "db"
	b, _ := json.Marshal(req)
	if err := tunnel.WriteFrame(st, b); err != nil {
		st.Close()
		return nil, resp, errors.New("the resource's connector is offline")
	}
	_ = st.SetReadDeadline(time.Now().Add(30 * time.Second))
	rb, err := tunnel.ReadFrame(st)
	if err != nil {
		st.Close()
		need := "2.46.0"
		if req.Engine == "mysql" {
			need = myMinConnector
		}
		return nil, resp, errors.New("the connector did not answer; it may need an update to " + need)
	}
	_ = st.SetReadDeadline(time.Time{})
	if err := json.Unmarshal(rb, &resp); err != nil {
		st.Close()
		return nil, resp, err
	}
	return st, resp, nil
}

func (p *pgProxy) auditDeny(t dbTarget, clientIP string, params map[string]string, reason string) {
	if p.d.audit == nil {
		return
	}
	p.d.audit.Enqueue(AuditEvent{
		Timestamp: time.Now(), UserID: t.UserID, SiteID: t.SiteID, Host: t.Host, Method: "DB", Path: "/" + params["database"],
		Status: 403, Decision: "DENY", Reason: reason, ClientIP: clientIP, UserAgent: params["application_name"],
	})
}

// dbSession is one ticket's connections from one address: one session in the
// console, one query log.
type dbSession struct {
	p                         *pgProxy
	key, id, connectorID, app string
	t                         dbTarget
	clientIP                  string
	start                     time.Time
	ls                        *liveSession
	log                       *queryLog

	mu     sync.Mutex
	conns  map[int]func() // open connections -> close
	nextID int
	linger *time.Timer
	ended  bool
	count  int // connections in progress, from the ticket check on
}

// join returns the session for this ticket and address, starting one when
// there is none: the connector is picked then and kept for every connection,
// so the query log stays on one connector.
func (p *pgProxy) join(ticket, clientIP string, t dbTarget, app string) (*dbSession, error) {
	key := ticket + "\x00" + clientIP
	p.mu.Lock()
	defer p.mu.Unlock()
	if s := p.sessions[key]; s != nil && !p.connected(s.connectorID) {
		// Its connector went away: the next connection starts a session on
		// another member instead of failing until this one lingers out.
		delete(p.sessions, key)
		go s.terminate()
	} else if s != nil {
		s.mu.Lock()
		if !s.ended {
			if s.linger != nil {
				s.linger.Stop()
				s.linger = nil
			}
			s.count++
			s.mu.Unlock()
			return s, nil
		}
		s.mu.Unlock()
	}
	if len(t.Connectors) == 0 {
		return nil, errors.New("no connector can carry this resource")
	}
	c := t.Connectors[0]
	if p.d.pick != nil {
		c = p.d.pick(t.Connectors)
	}
	now := p.d.now()
	s := &dbSession{p: p, key: key, id: newSessionID(), connectorID: c.ID, app: app, t: t, clientIP: clientIP, start: now, conns: map[int]func(){}, count: 1}
	if p.d.hub != nil {
		s.ls = p.d.hub.RegisterNative(s.id, t.engine(), t.SiteID, t.UserID, t.Host, now, c.ID, clientIP)
		s.ls.mu.Lock()
		s.ls.kind = "database"
		s.ls.mu.Unlock()
		s.ls.SetCapture(t.Record, true)
		p.d.hub.clearEnded(t.UserID, t.SiteID)
		p.d.hub.SetCloser(s.id, s.terminate)
	}
	if t.Record {
		recKey := newRecordingKey(t.SiteID, t.UserID)
		sess := func() *Session { return p.d.session(c.ID) }
		s.log = &queryLog{
			tenantID: t.TenantID, key: recKey,
			send:  func(req tunnel.RecWriteRequest) (int, error) { return writeRecChunk(sess(), req) },
			index: &recIndexReporter{send: p.d.recIndex, userID: t.UserID, siteID: t.SiteID, host: t.Host, format: "sql", proto: t.engine(), connectorID: c.ID},
			done:  func() { notifyRecDone(sess(), t.TenantID, recKey) },
		}
		s.log.start()
	}
	s.enqueue("ALLOW", "session_open database", 0)
	log.Printf("db proxy: site=%s user=%s session %s started via connector %s", t.SiteID, t.UserID, s.id, c.ID)
	p.sessions[key] = s
	return s, nil
}

func (p *pgProxy) connected(connectorID string) bool {
	s := p.d.session(connectorID)
	return s != nil && s.mux != nil && !s.mux.IsClosed()
}

// leave ends a connection's part in the session. The session itself lingers
// a minute for the client's next connection before it ends.
func (p *pgProxy) leave(s *dbSession) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.count--
	if s.count > 0 || s.ended {
		return
	}
	s.linger = time.AfterFunc(dbSessionLinger, func() {
		s.mu.Lock()
		idle := s.count == 0
		s.mu.Unlock()
		if idle {
			s.end()
		}
	})
}

func (s *dbSession) addConn(fn func()) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextID++
	s.conns[s.nextID] = fn
	return s.nextID
}

func (s *dbSession) dropConn(id int) {
	s.mu.Lock()
	delete(s.conns, id)
	s.mu.Unlock()
	s.event("Connection closed")
}

// terminate closes every connection now (an admin's Terminate, a recheck)
// and ends the session.
func (s *dbSession) terminate() {
	s.mu.Lock()
	var closers []func()
	for _, c := range s.conns {
		closers = append(closers, c)
	}
	s.mu.Unlock()
	for _, c := range closers {
		c()
	}
	s.end()
}

func (s *dbSession) end() {
	s.mu.Lock()
	if s.ended {
		s.mu.Unlock()
		return
	}
	s.ended = true
	if s.linger != nil {
		s.linger.Stop()
	}
	s.mu.Unlock()
	p := s.p
	p.mu.Lock()
	if p.sessions[s.key] == s {
		delete(p.sessions, s.key)
	}
	p.mu.Unlock()
	if p.d.hub != nil {
		p.d.hub.Remove(s.id)
	}
	dur := p.d.now().Sub(s.start)
	if s.log != nil {
		s.log.add(queryEvent{AtMs: dur.Milliseconds(), Kind: "session", Text: "Session ended"})
		s.log.stop()
	}
	s.enqueue("ALLOW", "session_close "+compactDur(dur), 0)
	log.Printf("db proxy: site=%s user=%s session %s closed after %s", s.t.SiteID, s.t.UserID, s.id, compactDur(dur))
}

func (s *dbSession) event(text string) {
	if s.ls == nil {
		return
	}
	s.ls.mu.Lock()
	s.ls.act.addEvent("text", text, time.Now())
	s.ls.mu.Unlock()
}

// queries feeds finished statements to the console's live feed and the log.
func (s *dbSession) queries(evs []queryEvent) {
	if s.ls != nil {
		now := time.Now()
		s.ls.mu.Lock()
		s.ls.act.shift(now)
		for _, e := range evs {
			s.ls.act.buckets[activityBuckets-1]++
			text := e.Text
			if e.Error != "" {
				text += "  ✗ " + e.Error
			}
			s.ls.act.addEvent("command", text, now)
		}
		s.ls.mu.Unlock()
	}
	if s.log != nil {
		for _, e := range evs {
			s.log.add(e)
		}
	}
}

func (s *dbSession) enqueue(decision, reason string, status int) {
	if s.p.d.audit == nil {
		return
	}
	s.p.d.audit.Enqueue(AuditEvent{
		Timestamp: time.Now(), UserID: s.t.UserID, SiteID: s.t.SiteID, Host: s.t.Host,
		Method: "DB", Path: "/" + s.t.Database, Status: status, Decision: decision, Reason: reason,
		ClientIP: s.clientIP, UserAgent: s.app,
	})
}

// recheck ends sessions whose ticket no longer holds: the user signed out
// (the ticket goes with the browser session) or it expired. A grant that ends
// is the hub's every-minute check (recheck.go), as for every native session.
// An unreachable control plane ends nothing.
func (p *pgProxy) recheck() {
	t := time.NewTicker(dbRecheckEvery)
	defer t.Stop()
	for range t.C {
		p.mu.Lock()
		list := make([]*dbSession, 0, len(p.sessions))
		for _, s := range p.sessions {
			list = append(list, s)
		}
		p.mu.Unlock()
		for _, s := range list {
			ticket := s.key[:strings.IndexByte(s.key, 0)]
			if _, err := p.d.ctrl.DatabaseTarget(ticket, s.clientIP); httpStatus(err) != 404 {
				continue
			}
			s.mu.Lock()
			ended := s.ended
			s.mu.Unlock()
			if ended {
				continue
			}
			reason := "ticket_ended"
			if p.d.hub != nil {
				p.d.hub.noteEnded(s.t.UserID, s.t.SiteID, reason)
			}
			s.enqueue("DENY", "session_end_policy "+reason, 403)
			s.terminate()
		}
	}
}

// queryLog batches statements into "keys" chunks on the session's connector,
// next to where a gateway session's keystrokes go, and reports the index so
// the console lists the recording.
type queryLog struct {
	tenantID, key string
	send          func(tunnel.RecWriteRequest) (int, error)
	index         *recIndexReporter
	done          func()

	mu      sync.Mutex
	buf     []queryEvent
	seq     int
	stopped bool
	quit    chan struct{}
	wg      sync.WaitGroup
}

func (l *queryLog) start() {
	l.quit = make(chan struct{})
	l.wg.Add(1)
	go func() {
		defer l.wg.Done()
		t := time.NewTicker(dbLogFlushEvery)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				l.flush()
			case <-l.quit:
				return
			}
		}
	}()
}

func (l *queryLog) add(e queryEvent) {
	l.mu.Lock()
	if l.stopped {
		l.mu.Unlock()
		return
	}
	l.buf = append(l.buf, e)
	full := len(l.buf) >= dbLogFlushCount
	l.mu.Unlock()
	if full {
		l.flush()
	}
}

func (l *queryLog) flush() {
	l.mu.Lock()
	evs := l.buf
	l.buf = nil
	seq := l.seq
	if len(evs) > 0 {
		l.seq++
	}
	l.mu.Unlock()
	if len(evs) == 0 {
		return
	}
	payload, err := json.Marshal(evs)
	if err != nil {
		return
	}
	data := append(payload, '\n')
	if _, err := l.send(tunnel.RecWriteRequest{TenantID: l.tenantID, RecordingKey: l.key, Seq: seq, Format: "keys", Data: data}); err != nil {
		log.Printf("db proxy: query log key=%s seq=%d: connector write failed: %v", l.key, seq, err)
		return
	}
	l.index.report(l.key, seq, len(data))
}

func (l *queryLog) stop() {
	l.mu.Lock()
	if l.stopped {
		l.mu.Unlock()
		return
	}
	l.mu.Unlock()
	close(l.quit)
	l.wg.Wait()
	l.flush()
	l.mu.Lock()
	l.stopped = true
	l.mu.Unlock()
	if l.done != nil {
		l.done()
	}
}
