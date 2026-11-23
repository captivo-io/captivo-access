package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"crypto/tls"
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// The database proxy for MySQL and MariaDB clients (mysql, DBeaver, DataGrip,
// MySQL Workbench) on its own port, as the server speaks first in MySQL:
//
//	mysql -h <console host> -P 13306 -u <ticket> --ssl-mode=REQUIRED <db>
//
// The proxy greets the client, requires TLS, and takes the user name as the
// connection ticket; the password is ignored (the client leaves it empty).
// The resource's connector signs in with the saved account and the flags the
// client agreed to here (connector/mysql.go); from then on the proxy relays
// packet by packet, logging each statement (mysqlwire.go). Sessions, the
// minute-by-minute recheck and the query log are the PostgreSQL proxy's.

const (
	myMinConnector  = "2.51.0"
	myGreetVersion  = "8.0.36-Captivo-Access"
	myHeadKeep      = 1024     // the start of a server packet, enough to read what it is
	myCommandKeep   = 64 << 10 // the start of a command, enough for the log
	myClientMaxAuth = 1 << 16

	myCapLongPassword  = 0x00000001
	myCapFoundRows     = 0x00000002
	myCapLongFlag      = 0x00000004
	myCapConnectWithDB = 0x00000008
	myCapNoSchema      = 0x00000010
	myCapODBC          = 0x00000040
	myCapIgnoreSpace   = 0x00000100
	myCapProtocol41    = 0x00000200
	myCapInteractive   = 0x00000400
	myCapSSL           = 0x00000800
	myCapTransactions  = 0x00002000
	myCapSecureConn    = 0x00008000
	myCapMultiStmts    = 0x00010000
	myCapMultiResults  = 0x00020000
	myCapPSMulti       = 0x00040000
	myCapPluginAuth    = 0x00080000
	myCapConnectAttrs  = 0x00100000
	myCapAuthLenenc    = 0x00200000

	// What the proxy offers a client. Nothing that changes how later packets
	// are laid out beyond what every MySQL 5.5+ and MariaDB server sends
	// (no DEPRECATE_EOF, SESSION_TRACK, QUERY_ATTRIBUTES, compression), and no
	// LOCAL INFILE, so any server behind it answers the way the client reads.
	myGreetCaps = myCapLongPassword | myCapFoundRows | myCapLongFlag | myCapConnectWithDB | myCapNoSchema |
		myCapODBC | myCapIgnoreSpace | myCapProtocol41 | myCapInteractive | myCapSSL | myCapTransactions |
		myCapSecureConn | myCapMultiStmts | myCapMultiResults | myCapPSMulti | myCapPluginAuth |
		myCapConnectAttrs | myCapAuthLenenc
	// Flags that only shape this sign-in, never what follows it.
	mySignInOnly = myCapSSL | myCapConnectWithDB | myCapConnectAttrs | myCapAuthLenenc | myCapPluginAuth | myCapSecureConn
)

// myConnRef is where a KILL naming the id a client was given goes.
type myConnRef struct {
	session string // the dbSession key: only its own connections can be named
	real    uint32
}

// myClientConn reads MySQL packets from the client.
type myClientConn struct {
	conn net.Conn
	r    *bufio.Reader
}

func (c *myClientConn) readPacket(max int) (byte, []byte, error) {
	var h [4]byte
	if _, err := io.ReadFull(c.r, h[:]); err != nil {
		return 0, nil, err
	}
	n := int(h[0]) | int(h[1])<<8 | int(h[2])<<16
	if n > max {
		return 0, nil, fmt.Errorf("packet too long")
	}
	b := make([]byte, n)
	if _, err := io.ReadFull(c.r, b); err != nil {
		return 0, nil, err
	}
	return h[3], b, nil
}

// myHello is what the client's HandshakeResponse41 says.
type myHello struct {
	caps      uint32
	collation uint8
	user, db  string
	app       string
}

func parseMyHello(b []byte) (myHello, bool) {
	var h myHello
	if len(b) < 32 {
		return h, false
	}
	h.caps = binary.LittleEndian.Uint32(b)
	h.collation = b[8]
	b = b[32:]
	user, rest, ok := bytes.Cut(b, []byte{0})
	if !ok {
		return h, false
	}
	h.user, b = string(user), rest
	switch {
	case h.caps&myCapAuthLenenc != 0:
		n, k := lenenc(b)
		if k == 0 || uint64(len(b)-k) < n {
			return h, false
		}
		b = b[k+int(n):]
	case h.caps&myCapSecureConn != 0:
		if len(b) < 1 || len(b) < 1+int(b[0]) {
			return h, false
		}
		b = b[1+int(b[0]):]
	default:
		_, rest, _ := bytes.Cut(b, []byte{0})
		b = rest
	}
	if h.caps&myCapConnectWithDB != 0 {
		db, rest, _ := bytes.Cut(b, []byte{0})
		h.db, b = string(db), rest
	}
	if h.caps&myCapPluginAuth != 0 {
		_, rest, _ := bytes.Cut(b, []byte{0})
		b = rest
	}
	if h.caps&myCapConnectAttrs != 0 {
		total, k := lenenc(b)
		if k > 0 && uint64(len(b)-k) >= total {
			attrs := b[k : k+int(total)]
			for len(attrs) > 0 {
				kn, a := lenenc(attrs)
				if a == 0 || uint64(len(attrs)-a) < kn {
					break
				}
				key := string(attrs[a : a+int(kn)])
				attrs = attrs[a+int(kn):]
				vn, c := lenenc(attrs)
				if c == 0 || uint64(len(attrs)-c) < vn {
					break
				}
				val := string(attrs[c : c+int(vn)])
				attrs = attrs[c+int(vn):]
				if key == "program_name" || (key == "_client_name" && h.app == "") {
					h.app = val
				}
			}
		}
	}
	return h, true
}

// myGreeting is the proxy's HandshakeV10, offering caching_sha2_password
// (every current client has it; the answer to an empty password is empty).
func myGreeting(connID uint32) []byte {
	scramble := make([]byte, 20)
	_, _ = rand.Read(scramble)
	for i := range scramble {
		scramble[i] = scramble[i]%94 + 33 // printable and never NUL, as servers send it
	}
	b := []byte{10}
	b = append(append(b, myGreetVersion...), 0)
	b = binary.LittleEndian.AppendUint32(b, connID)
	b = append(append(b, scramble[:8]...), 0)
	b = binary.LittleEndian.AppendUint16(b, uint16(myGreetCaps&0xffff))
	b = append(b, 45) // utf8mb4_general_ci
	b = binary.LittleEndian.AppendUint16(b, myStatusAutoCmt)
	b = binary.LittleEndian.AppendUint16(b, uint16(myGreetCaps>>16))
	b = append(b, 21)
	b = append(b, make([]byte, 10)...)
	b = append(append(b, scramble[8:]...), 0)
	b = append(append(b, "caching_sha2_password"...), 0)
	return myPacket(0, b)
}

// newMyConnID picks the id a client is given, out of the range servers count
// up from, so a KILL naming it is told apart from one naming a real thread.
func (p *pgProxy) newMyConnID() uint32 {
	p.mu.Lock()
	defer p.mu.Unlock()
	for {
		var b [4]byte
		_, _ = rand.Read(b[:])
		id := binary.LittleEndian.Uint32(b[:])&0x3fffffff | 0x40000000
		if _, taken := p.myConns[id]; !taken {
			p.myConns[id] = myConnRef{}
			return id
		}
	}
}

// handleMySQL runs one MySQL client connection; started frees its pending
// slot once it is past the handshake and the ticket check (or gave up).
func (p *pgProxy) handleMySQL(raw net.Conn, started func()) {
	var once sync.Once
	release := func() { once.Do(started) }
	defer release()
	clientIP, _, _ := net.SplitHostPort(raw.RemoteAddr().String())
	_ = raw.SetDeadline(time.Now().Add(pgHandshakeLimit))
	var conn net.Conn = raw
	defer func() { conn.Close() }()
	connID := p.newMyConnID()
	defer func() {
		p.mu.Lock()
		delete(p.myConns, connID)
		p.mu.Unlock()
	}()
	if _, err := raw.Write(myGreeting(connID)); err != nil {
		return
	}
	c := &myClientConn{conn: raw, r: bufio.NewReader(raw)}
	seq, body, err := c.readPacket(myClientMaxAuth)
	if err != nil {
		return
	}
	if len(body) == 32 && binary.LittleEndian.Uint32(body)&myCapSSL != 0 {
		tc := tls.Server(&bufConn{Conn: raw, r: c.r}, p.myTLS)
		if tc.Handshake() != nil {
			return
		}
		conn = tc
		c = &myClientConn{conn: tc, r: bufio.NewReader(tc)}
		if seq, body, err = c.readPacket(myClientMaxAuth); err != nil {
			return
		}
	} else {
		_, _ = conn.Write(myErr(seq+1, 3159, "HY000", "Captivo Access requires an encrypted connection: connect with --ssl-mode=REQUIRED (the MariaDB client: --ssl)"))
		return
	}
	hello, ok := parseMyHello(body)
	if !ok || hello.caps&myCapProtocol41 == 0 {
		_, _ = conn.Write(myErr(seq+1, 1043, "08S01", "Captivo Access: this client is too old (it needs the MySQL 4.1 protocol)"))
		return
	}
	p.openMySQL(c, seq+1, hello, connID, clientIP, release)
}

func (p *pgProxy) openMySQL(c *myClientConn, seq byte, hello myHello, connID uint32, clientIP string, started func()) {
	conn := c.conn
	ticket := hello.user
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
		_, _ = conn.Write(myErr(seq, 1045, "28000", msg))
		return
	}
	if t.engine() != "mysql" {
		_, _ = conn.Write(myErr(seq, 1045, "28000", "Captivo Access: "+wrongEngine(t)))
		return
	}
	db := hello.db
	if db == "" {
		db = t.Database
	}
	if len(t.Databases) > 0 && db != "" && !containsStr(t.Databases, db) {
		_, _ = conn.Write(myErr(seq, 1044, "42000", fmt.Sprintf("Captivo Access: database %q is not open on this resource (allowed: %s)", db, strings.Join(t.Databases, ", "))))
		p.auditDeny(t, clientIP, map[string]string{"database": db, "application_name": hello.app}, "database_not_allowed")
		return
	}

	s, err := p.join(ticket, clientIP, t, hello.app)
	if err != nil {
		_, _ = conn.Write(myErr(seq, 2013, "HY000", "Captivo Access: "+err.Error()))
		return
	}
	defer p.leave(s)
	sealed := ""
	for _, cand := range t.Connectors {
		if cand.ID == s.connectorID {
			sealed = cand.SealedSecret
		}
	}
	up, resp, err := dialDb(p.d.session(s.connectorID), tunnel.DbDialRequest{
		Engine: "mysql", Host: t.Host, Port: strconv.Itoa(t.Port), Username: t.Username, Database: db,
		Sealed: sealed, TLS: t.TLS, CACertPEM: t.CACertPEM,
		Capabilities: hello.caps & myGreetCaps &^ mySignInOnly, Collation: hello.collation,
	})
	if err != nil {
		_, _ = conn.Write(myErr(seq, 2013, "HY000", "Captivo Access: "+err.Error()))
		return
	}
	if resp.Error != "" {
		number, state, msg := uint16(2013), "HY000", "Captivo Access: "+resp.Error
		if n, st, ok := strings.Cut(resp.Code, ":"); ok {
			if v, err := strconv.ParseUint(n, 10, 16); err == nil {
				number, state = uint16(v), st
				msg = "Captivo Access: the database refused the saved account: " + resp.Error
			}
		}
		log.Printf("db proxy: site=%s user=%s mysql sign-in to %s failed: %s", t.SiteID, t.UserID, t.Host, resp.Error)
		_, _ = conn.Write(myErr(seq, number, state, msg))
		up.Close()
		return
	}
	defer up.Close()
	if _, err := conn.Write(myOK(seq)); err != nil {
		return
	}
	_ = conn.SetDeadline(time.Time{})
	started()

	p.mu.Lock()
	p.myConns[connID] = myConnRef{session: s.key, real: resp.ConnID}
	p.mu.Unlock()
	var once sync.Once
	closeBoth := func() { once.Do(func() { conn.Close(); up.Close() }) }
	id := s.addConn(closeBoth)
	defer s.dropConn(id)
	where := db
	if where == "" {
		where = "the server"
	}
	version := ""
	if resp.ServerVersion != "" {
		version = " (server " + resp.ServerVersion + ")"
	}
	s.event(fmt.Sprintf("Connection opened to %s%s%s", where, version, appSuffix(hello.app)))
	tr := newMyTracker(s.start, db)
	out := &myClientOut{w: bufio.NewWriterSize(conn, 64<<10)}
	done := make(chan struct{}, 2)
	go func() { p.relayMyServer(bufio.NewReader(up), out, tr, s); done <- struct{}{} }()
	go func() { p.relayMyClient(c.r, up, out, tr, s); done <- struct{}{} }()
	<-done
	closeBoth()
	<-done
}

// myClientOut is the client's side of the connection: the server's packets
// and, now and then, an answer of the proxy's own go out one at a time.
type myClientOut struct {
	mu sync.Mutex
	w  *bufio.Writer
}

func (o *myClientOut) write(b []byte, flush bool) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	if _, err := o.w.Write(b); err != nil {
		return err
	}
	if flush {
		return o.w.Flush()
	}
	return nil
}

func (o *myClientOut) copyN(r io.Reader, n int64) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	_, err := io.CopyN(o.w, r, n)
	return err
}

func (o *myClientOut) flush() error {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.w.Flush()
}

// relayMyServer copies the server's packets to the client, reading the start
// of each into the tracker; rows are streamed, never held.
func (p *pgProxy) relayMyServer(r *bufio.Reader, out *myClientOut, tr *myTracker, s *dbSession) {
	var h [4]byte
	cont := false // the previous packet was full: this one continues it
	for {
		if _, err := io.ReadFull(r, h[:]); err != nil {
			_ = out.flush()
			return
		}
		n := int(h[0]) | int(h[1])<<8 | int(h[2])<<16
		keep := min(n, myHeadKeep)
		head := make([]byte, keep)
		if _, err := io.ReadFull(r, head); err != nil {
			_ = out.flush()
			return
		}
		if !cont {
			if evs := tr.server(head, n, p.d.now()); len(evs) > 0 {
				s.queries(evs)
			}
		}
		cont = n == myMaxPayload
		if out.write(append(h[:], head...), false) != nil {
			return
		}
		if n > keep {
			if out.copyN(r, int64(n-keep)) != nil {
				return
			}
		}
		if r.Buffered() == 0 && out.flush() != nil {
			return
		}
	}
}

// relayMyClient copies the client's commands to the server. A KILL naming a
// connection id this proxy gave goes to the server's own id; COM_CHANGE_USER,
// which would sign in as someone else, is refused.
func (p *pgProxy) relayMyClient(r *bufio.Reader, up io.Writer, out *myClientOut, tr *myTracker, s *dbSession) {
	w := bufio.NewWriterSize(up, 64<<10)
	var h [4]byte
	cont := false
	for {
		if _, err := io.ReadFull(r, h[:]); err != nil {
			_ = w.Flush()
			return
		}
		n := int(h[0]) | int(h[1])<<8 | int(h[2])<<16
		keep := min(n, myCommandKeep)
		body := make([]byte, keep)
		if _, err := io.ReadFull(r, body); err != nil {
			return
		}
		first := !cont
		cont = n == myMaxPayload
		if first && len(body) > 0 {
			switch body[0] {
			case myComChangeUser:
				if n > keep {
					if _, err := io.CopyN(io.Discard, r, int64(n-keep)); err != nil {
						return
					}
				}
				s.event("Refused a change of user on the connection")
				if out.write(myErr(h[3]+1, 1045, "28000", "Captivo Access: changing the user on a connection is not allowed; connect again instead"), true) != nil {
					return
				}
				continue
			case myComQuery:
				if n == keep {
					if b, ok := p.myKill(body, s); ok {
						body = b
						n = len(b)
						h[0], h[1], h[2] = byte(n), byte(n>>8), byte(n>>16)
					}
				}
			}
			tr.client(body, p.d.now())
		}
		_, _ = w.Write(h[:])
		_, _ = w.Write(body)
		if n > keep {
			if _, err := io.CopyN(w, r, int64(n-keep)); err != nil {
				return
			}
		}
		if r.Buffered() == 0 {
			if w.Flush() != nil {
				return
			}
		}
		if first && len(body) > 0 && body[0] == myComQuit {
			return
		}
	}
}

// myKill rewrites "KILL [QUERY] <id>" when the id is one this proxy gave to a
// connection of the same session.
func (p *pgProxy) myKill(body []byte, s *dbSession) ([]byte, bool) {
	stmt := string(body[1:])
	id, ok := myKillTarget(stmt)
	if !ok {
		return nil, false
	}
	p.mu.Lock()
	ref, found := p.myConns[id]
	p.mu.Unlock()
	if !found || ref.session != s.key || ref.real == 0 {
		return nil, false
	}
	return append([]byte{myComQuery}, myKillRewrite(stmt, ref.real)...), true
}
