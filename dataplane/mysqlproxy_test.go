package main

import (
	"bufio"
	"bytes"
	"crypto/tls"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hashicorp/yamux"
	"github.com/kurtserdar/captivo-access/tunnel"
)

type fakeDbCtrl struct{ t dbTarget }

func (f fakeDbCtrl) DatabaseTarget(ticket, _ string) (dbTarget, error) {
	switch ticket {
	case "goodticket":
		return f.t, nil
	case "pgticket":
		t := f.t
		t.Engine = "postgres"
		return t, nil
	}
	return dbTarget{}, &httpError{code: 404}
}

// fakeMyConnector is the connector's end: it takes the sign-in request and
// then answers as the server would after its OK.
type fakeMyConnector struct {
	mu    sync.Mutex
	req   tunnel.DbDialRequest
	got   []string // statements the server received
	kills int
}

func (f *fakeMyConnector) run(t *testing.T, conn *yamux.Session) {
	for {
		st, err := conn.AcceptStream()
		if err != nil {
			return
		}
		go f.stream(st)
	}
}

func (f *fakeMyConnector) stream(st net.Conn) {
	defer st.Close()
	b, err := tunnel.ReadFrame(st)
	if err != nil {
		return
	}
	var req tunnel.DbDialRequest
	_ = json.Unmarshal(b, &req)
	f.mu.Lock()
	f.req = req
	f.mu.Unlock()
	resp, _ := json.Marshal(tunnel.DbDialResponse{ConnID: 77, ServerVersion: "8.4.0", Capabilities: req.Capabilities})
	if tunnel.WriteFrame(st, resp) != nil {
		return
	}
	r := bufio.NewReader(st)
	for {
		var h [4]byte
		if _, err := io.ReadFull(r, h[:]); err != nil {
			return
		}
		n := int(h[0]) | int(h[1])<<8 | int(h[2])<<16
		body := make([]byte, n)
		if _, err := io.ReadFull(r, body); err != nil {
			return
		}
		if len(body) == 0 || body[0] == myComQuit {
			return
		}
		stmt := string(body[1:])
		f.mu.Lock()
		f.got = append(f.got, stmt)
		f.mu.Unlock()
		var out []byte
		if stmt == "select a from t" {
			out = append(out, myPacket(1, []byte{1})...)
			out = append(out, myPacket(2, myColDef)...)
			out = append(out, myPacket(3, myEOF)...)
			out = append(out, myPacket(4, []byte("\x011"))...)
			out = append(out, myPacket(5, []byte("\x012"))...)
			out = append(out, myPacket(6, myEOF)...)
		} else {
			out = myOK(1)
		}
		if _, err := st.Write(out); err != nil {
			return
		}
	}
}

// myTestClient is enough of a MySQL client to sign in and run statements.
type myTestClient struct {
	conn   net.Conn
	r      *bufio.Reader
	connID uint32
}

func (c *myTestClient) read(t *testing.T) []byte {
	t.Helper()
	var h [4]byte
	if _, err := io.ReadFull(c.r, h[:]); err != nil {
		t.Fatalf("read: %v", err)
	}
	b := make([]byte, int(h[0])|int(h[1])<<8|int(h[2])<<16)
	if _, err := io.ReadFull(c.r, b); err != nil {
		t.Fatalf("read: %v", err)
	}
	return b
}

func dialMy(t *testing.T, addr, ticket string, useTLS bool) (*myTestClient, []byte) {
	t.Helper()
	raw, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { raw.Close() })
	_ = raw.SetDeadline(time.Now().Add(10 * time.Second))
	c := &myTestClient{conn: raw, r: bufio.NewReader(raw)}
	g := c.read(t)
	if g[0] != 10 {
		t.Fatalf("greeting %q", g)
	}
	v := bytes.IndexByte(g[1:], 0)
	c.connID = binary.LittleEndian.Uint32(g[2+v:])
	caps := uint32(myCapProtocol41 | myCapSecureConn | myCapConnectWithDB | myCapPluginAuth | myCapMultiResults | myCapAuthLenenc)
	head := func(caps uint32) []byte {
		b := binary.LittleEndian.AppendUint32(nil, caps)
		b = binary.LittleEndian.AppendUint32(b, 1<<24)
		return append(append(b, 45), make([]byte, 23)...)
	}
	seq := byte(1)
	if useTLS {
		_, _ = raw.Write(myPacket(seq, head(caps|myCapSSL)))
		tc := tls.Client(raw, &tls.Config{InsecureSkipVerify: true})
		if err := tc.Handshake(); err != nil {
			t.Fatal(err)
		}
		c.conn, c.r = tc, bufio.NewReader(tc)
		seq++
		caps |= myCapSSL
	}
	b := head(caps)
	b = append(append(b, ticket...), 0)
	b = append(b, 0)
	b = append(append(b, "crm"...), 0)
	b = append(append(b, "caching_sha2_password"...), 0)
	_, _ = c.conn.Write(myPacket(seq, b))
	return c, c.read(t)
}

func (c *myTestClient) query(t *testing.T, cmd byte, stmt string) []byte {
	t.Helper()
	_, _ = c.conn.Write(myPacket(0, append([]byte{cmd}, stmt...)))
	return c.read(t)
}

func TestMySQLProxyEndToEnd(t *testing.T) {
	dir := t.TempDir()
	certFile, keyFile, err := selfSignedDbCert(dir)
	if err != nil {
		t.Fatal(err)
	}
	cert, _ := tls.LoadX509KeyPair(certFile, keyFile)
	a, b := net.Pipe()
	dp, _ := yamux.Client(a, nil)
	cs, _ := yamux.Server(b, nil)
	t.Cleanup(func() { dp.Close(); cs.Close() })
	fc := &fakeMyConnector{}
	go fc.run(t, cs)
	hub := NewSessionHub()
	p := &pgProxy{
		d: pgProxyDeps{
			ctrl: fakeDbCtrl{t: dbTarget{
				Engine: "mysql", SiteID: "s1", UserID: "u1", Host: "10.0.0.9", Port: 3306, Username: "app", Database: "crm", TLS: "disable",
				Connectors: []routeCandidate{{ID: "c1", SealedSecret: "sealed"}},
			}},
			session: func(string) *Session { return &Session{mux: dp} },
			hub:     hub, now: time.Now,
		},
		sessions: map[string]*dbSession{}, cancels: map[uint64]dbCancel{}, myConns: map[uint32]myConnRef{},
		myTLS: &tls.Config{Certificates: []tls.Certificate{cert}},
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go p.serve(ln, p.handleMySQL)
	addr := ln.Addr().String()

	// Without TLS: refused, with the setting to change.
	if _, ans := dialMy(t, addr, "goodticket", false); ans[0] != 0xff || !strings.Contains(string(ans), "--ssl-mode=REQUIRED") {
		t.Fatalf("plain connection: %q", ans)
	}
	if _, ans := dialMy(t, addr, "nosuchticket", true); ans[0] != 0xff || !strings.Contains(string(ans), "unknown or has expired") {
		t.Fatalf("unknown ticket: %q", ans)
	}
	if _, ans := dialMy(t, addr, "pgticket", true); ans[0] != 0xff || !strings.Contains(string(ans), "PostgreSQL") {
		t.Fatalf("a PostgreSQL resource: %q", ans)
	}

	c1, ans := dialMy(t, addr, "goodticket", true)
	if ans[0] != 0 {
		t.Fatalf("sign-in: %q", ans)
	}
	fc.mu.Lock()
	req := fc.req
	fc.mu.Unlock()
	if req.Engine != "mysql" || req.Username != "app" || req.Database != "crm" || req.Sealed != "sealed" {
		t.Fatalf("connector asked %+v", req)
	}
	if req.Capabilities&(myCapSSL|myCapConnectAttrs|myCapAuthLenenc) != 0 || req.Capabilities&myCapMultiResults == 0 {
		t.Fatalf("capabilities passed on: %#x", req.Capabilities)
	}

	// A result set comes through whole, and is logged with its row count.
	if p := c1.query(t, myComQuery, "select a from t"); p[0] != 1 {
		t.Fatalf("column count %q", p)
	}
	for _, want := range [][]byte{myColDef, myEOF, []byte("\x011"), []byte("\x012"), myEOF} {
		if got := c1.read(t); !bytes.Equal(got, want) {
			t.Fatalf("got %q want %q", got, want)
		}
	}
	// Changing the user is refused by the proxy; the server never sees it.
	if p := c1.query(t, myComChangeUser, "root\x00"); p[0] != 0xff || !strings.Contains(string(p), "changing the user") {
		t.Fatalf("change user: %q", p)
	}
	// Ctrl-C in the mysql client: a second connection kills the first's query
	// by the id it was given; the server gets its own id.
	c2, _ := dialMy(t, addr, "goodticket", true)
	if p := c2.query(t, myComQuery, "KILL QUERY "+strconv.FormatUint(uint64(c1.connID), 10)); p[0] != 0 {
		t.Fatalf("kill: %q", p)
	}
	if p := c2.query(t, myComQuery, "KILL QUERY 12345"); p[0] != 0 {
		t.Fatalf("kill: %q", p)
	}
	fc.mu.Lock()
	got := strings.Join(fc.got, "|")
	fc.mu.Unlock()
	if !strings.Contains(got, "KILL QUERY 77") || !strings.Contains(got, "KILL QUERY 12345") || strings.Contains(got, "root") {
		t.Fatalf("server received %q", got)
	}

	// One session for both connections, with the statements in its feed.
	list := hub.List()
	if len(list) != 1 || list[0].Protocol != "mysql" {
		t.Fatalf("sessions %+v", list)
	}
	ls := hub.Get(list[0].SessionID)
	deadline := time.Now().Add(2 * time.Second)
	for {
		ls.mu.Lock()
		var texts []string
		for _, e := range ls.act.events {
			texts = append(texts, e.Type+":"+e.Text)
		}
		ls.mu.Unlock()
		feed := strings.Join(texts, "\n")
		if strings.Contains(feed, "command:select a from t") && strings.Contains(feed, "Connection opened to crm (server 8.4.0)") && strings.Contains(feed, "Refused a change of user") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("feed:\n%s", feed)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
