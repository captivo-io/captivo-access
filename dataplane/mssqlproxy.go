package main

import (
	"bufio"
	"crypto/tls"
	"fmt"
	"io"
	"log"
	"net"
	"strconv"
	"sync"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// The database proxy for SQL Server clients (SSMS, sqlcmd, Azure Data Studio,
// DBeaver, DataGrip) on its own port:
//
//	sqlcmd -S tcp:<console host>,11433 -U <ticket> -P x
//
// It answers PRELOGIN requiring encryption, ends the client's TLS (carried in
// PRELOGIN packets, then on the wire), and takes LOGIN7's user name as the
// connection ticket; the password is ignored. The resource's connector signs
// in with the saved login and the client's own LOGIN7 options
// (connector/mssql.go); the client gets the server's answer to that sign-in
// as the answer to its own, then the proxy relays packet by packet, logging
// each statement (mssqlwire.go). Sessions, the minute-by-minute recheck and
// the query log are the PostgreSQL proxy's. Windows (SSPI) and Entra ID
// sign-in are not offered: the ticket is a SQL Server login name.

const (
	msMinConnector = "2.56.0"
	msMaxLogin     = 64 << 10
)

// msLoginError answers a LOGIN7 with an error, the way SQL Server refuses one.
func msLoginError(number uint32, msg string) []byte {
	body := append(tunnel.TDSErrorToken(number, 1, 14, msg, "Captivo Access"), tunnel.TDSDoneToken(tunnel.DoneError, 0)...)
	return tunnel.TDSPackets(tunnel.TDSReply, body, tunnel.TDSDefaultPkt)
}

// msPrelogin is the proxy's answer to the client's PRELOGIN: encryption
// required, no MARS.
func msPrelogin() []byte {
	return tunnel.TDSPackets(tunnel.TDSReply, tunnel.BuildPrelogin([]tunnel.PreloginOption{
		{Token: tunnel.PreloginVersion, Data: []byte{16, 0, 0x03, 0xE8, 0, 0}},
		{Token: tunnel.PreloginEncryption, Data: []byte{tunnel.EncryptReq}},
		{Token: tunnel.PreloginInstOpt, Data: []byte{0}},
		{Token: tunnel.PreloginThreadID, Data: nil},
		{Token: tunnel.PreloginMARS, Data: []byte{0}},
	}), tunnel.TDSDefaultPkt)
}

// handleMSSQL runs one SQL Server client connection; started frees its
// pending slot once it is past the handshake and the ticket check.
func (p *pgProxy) handleMSSQL(raw net.Conn, started func()) {
	var once sync.Once
	release := func() { once.Do(started) }
	defer release()
	clientIP, _, _ := net.SplitHostPort(raw.RemoteAddr().String())
	_ = raw.SetDeadline(time.Now().Add(pgHandshakeLimit))
	defer raw.Close()
	br := bufio.NewReader(raw)
	if b, err := br.Peek(1); err != nil || b[0] != tunnel.TDSPrelogin {
		// TDS 8 (Encrypt=Strict) starts with TLS itself; anything else is not a client.
		return
	}
	typ, pre, err := tunnel.ReadTDSMessage(br, 4096)
	if err != nil || typ != tunnel.TDSPrelogin {
		return
	}
	opts, err := tunnel.ParsePrelogin(pre)
	if err != nil {
		return
	}
	if _, err := raw.Write(msPrelogin()); err != nil {
		return
	}
	if e := opts[tunnel.PreloginEncryption]; len(e) == 1 && e[0] == tunnel.EncryptNotSup {
		return // a client that can't encrypt ends here, as SQL Server's rule says
	}
	hc := &tunnel.TDSHandshakeConn{Conn: raw, R: br}
	tc := tls.Server(hc, p.msTLS)
	if tc.Handshake() != nil {
		return
	}
	hc.Passthrough = true
	cr := bufio.NewReader(tc)
	typ, body, err := tunnel.ReadTDSMessage(cr, msMaxLogin)
	if err != nil {
		return
	}
	if typ != tunnel.TDSLogin7 {
		_, _ = tc.Write(msLoginError(18456, "Captivo Access: sign in with SQL Server authentication, the connection ticket as the login name"))
		return
	}
	login, err := tunnel.ParseLogin7(body)
	if err != nil || login.UserName == "" {
		_, _ = tc.Write(msLoginError(18456, "Captivo Access: sign in with SQL Server authentication, the connection ticket as the login name (Windows and Entra ID sign-in are not offered)"))
		return
	}
	p.openMSSQL(tc, cr, login, clientIP, release)
}

func (p *pgProxy) openMSSQL(conn net.Conn, cr *bufio.Reader, login tunnel.Login7, clientIP string, started func()) {
	ticket := login.UserName
	t, err := p.d.ctrl.DatabaseTarget(ticket, clientIP)
	if err != nil {
		msg := "Captivo Access could not check your access; try again"
		switch httpStatus(err) {
		case 404:
			time.Sleep(500 * time.Millisecond) // a guess costs time
			msg = "Captivo Access: this connection ticket is unknown or has expired. Get a new one from My access in your Captivo portal."
		case 403:
			msg = "Captivo Access: your access to this resource is not active"
		case 409:
			msg = "Captivo Access: this resource can't be opened as a database right now; ask your administrator"
		}
		_, _ = conn.Write(msLoginError(18456, msg))
		return
	}
	if t.engine() != "mssql" {
		_, _ = conn.Write(msLoginError(18456, "Captivo Access: "+wrongEngine(t)))
		return
	}
	db := login.Database
	if db == "" {
		db = t.Database
	}
	s, err := p.join(ticket, clientIP, t, login.AppName)
	if err != nil {
		_, _ = conn.Write(msLoginError(18456, "Captivo Access: "+err.Error()))
		return
	}
	defer p.leave(s)
	sealed := ""
	for _, cand := range t.Connectors {
		if cand.ID == s.connectorID {
			sealed = cand.SealedSecret
		}
	}
	options := login
	options.UserName, options.Database = "", ""
	up, resp, err := dialDb(p.d.session(s.connectorID), tunnel.DbDialRequest{
		Engine: "mssql", Host: t.Host, Port: strconv.Itoa(t.Port), Username: t.Username, Database: db,
		Sealed: sealed, TLS: t.TLS, CACertPEM: t.CACertPEM, MSSQL: &options,
	})
	if err != nil {
		_, _ = conn.Write(msLoginError(18456, "Captivo Access: "+err.Error()))
		return
	}
	if resp.Error != "" {
		number, msg := uint32(18456), "Captivo Access: "+resp.Error
		if n, err := strconv.ParseUint(resp.Code, 10, 32); err == nil {
			number, msg = uint32(n), "Captivo Access: the database refused the saved account: "+resp.Error
		}
		log.Printf("db proxy: site=%s user=%s mssql sign-in to %s failed: %s", t.SiteID, t.UserID, t.Host, resp.Error)
		_, _ = conn.Write(msLoginError(number, msg))
		up.Close()
		return
	}
	defer up.Close()
	r, _ := tunnel.ParseLoginResponse(resp.LoginReply)
	packetSize := int(login.PacketSize)
	if n, err := strconv.Atoi(r.PacketSize); err == nil {
		packetSize = n
	}
	if packetSize < tunnel.TDSMinPacket || packetSize > tunnel.TDSMaxPacket {
		packetSize = tunnel.TDSDefaultPkt
	}
	if _, err := conn.Write(tunnel.TDSPackets(tunnel.TDSReply, resp.LoginReply, packetSize)); err != nil {
		return
	}
	_ = conn.SetDeadline(time.Time{})
	started()

	var once sync.Once
	closeBoth := func() { once.Do(func() { conn.Close(); up.Close() }) }
	id := s.addConn(closeBoth)
	defer s.dropConn(id)
	if r.Database != "" {
		db = r.Database
	}
	where := db
	if where == "" {
		where = "the server"
	}
	version := ""
	if resp.ServerVersion != "" {
		version = " (server " + resp.ServerVersion + ")"
	}
	s.event(fmt.Sprintf("Connection opened to %s%s%s", where, version, appSuffix(login.AppName)))
	tr := newMsTracker(s.start, db)
	done := make(chan struct{}, 2)
	go func() { p.relayMsPackets(bufio.NewReader(up), conn, tr, s, false); done <- struct{}{} }()
	go func() { p.relayMsPackets(cr, up, tr, s, true); done <- struct{}{} }()
	<-done
	closeBoth()
	<-done
}

// relayMsPackets copies TDS packets one way, showing each to the tracker.
func (p *pgProxy) relayMsPackets(r *bufio.Reader, w io.Writer, tr *msTracker, s *dbSession, fromClient bool) {
	bw := bufio.NewWriterSize(w, 64<<10)
	var h [tunnel.TDSHeaderLen]byte
	for {
		if _, err := io.ReadFull(r, h[:]); err != nil {
			_ = bw.Flush()
			return
		}
		n := int(h[2])<<8 | int(h[3])
		if n < tunnel.TDSHeaderLen {
			_ = bw.Flush()
			return
		}
		payload := make([]byte, n-tunnel.TDSHeaderLen)
		if _, err := io.ReadFull(r, payload); err != nil {
			_ = bw.Flush()
			return
		}
		if fromClient {
			tr.client(h[0], h[1], payload, p.d.now())
		} else if evs := tr.server(h[1], payload, p.d.now()); len(evs) > 0 {
			s.queries(evs)
		}
		_, _ = bw.Write(h[:])
		if _, err := bw.Write(payload); err != nil {
			return
		}
		if r.Buffered() == 0 && bw.Flush() != nil {
			return
		}
	}
}

// wrongEngine tells a user which client the resource needs.
func wrongEngine(t dbTarget) string {
	switch t.engine() {
	case "mysql":
		return "this resource is a MySQL database; connect with a MySQL client (the Connect details in your portal)"
	case "mssql":
		return "this resource is a SQL Server database; connect with a SQL Server client (the Connect details in your portal)"
	case "redis":
		return "this resource is a Redis database; connect with a Redis client (the Connect details in your portal)"
	case "mongodb":
		return "this resource is a MongoDB database; connect with a MongoDB client (the Connect details in your portal)"
	}
	return "this resource is a PostgreSQL database; connect with a PostgreSQL client (the Connect details in your portal)"
}
