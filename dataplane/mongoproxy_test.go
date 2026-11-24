package main

import (
	"bufio"
	"crypto/tls"
	"encoding/binary"
	"encoding/json"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hashicorp/yamux"
	"github.com/kurtserdar/captivo-access/tunnel"
)

// fakeMongoConnector is the connector's end and the server behind it: a few
// commands answered the way mongod does.
type fakeMongoConnector struct {
	mu  sync.Mutex
	req tunnel.DbDialRequest
	got []string // command names the server received
}

func (f *fakeMongoConnector) run(conn *yamux.Session) {
	for {
		st, err := conn.AcceptStream()
		if err != nil {
			return
		}
		go f.stream(st)
	}
}

func (f *fakeMongoConnector) stream(st net.Conn) {
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
	resp, _ := json.Marshal(tunnel.DbDialResponse{ServerVersion: "7.0.14"})
	if tunnel.WriteFrame(st, resp) != nil {
		return
	}
	r := bufio.NewReader(st)
	for {
		h, payload, err := readMongoMsg(r, 8<<20)
		if err != nil {
			return
		}
		doc, _, err := tunnel.MongoMsgBody(payload)
		if err != nil {
			return
		}
		name, _, _, _ := tunnel.BSONFirst(doc)
		f.mu.Lock()
		f.got = append(f.got, name)
		f.mu.Unlock()
		var ans []byte
		switch name {
		case "find":
			ans = tunnel.BSONDoc(tunnel.BSONSub("cursor", tunnel.BSONInt64Elem("id", 0), tunnel.BSONStr("ns", "shop.orders"),
				bsonArr("firstBatch", tunnel.BSONSub("0", tunnel.BSONInt32Elem("a", 1)), tunnel.BSONSub("1", tunnel.BSONInt32Elem("a", 2)), tunnel.BSONSub("2", tunnel.BSONInt32Elem("a", 3)))), tunnel.BSONDoubleElem("ok", 1))
		case "insert":
			ans = tunnel.BSONDoc(tunnel.BSONInt32Elem("n", 2), tunnel.BSONDoubleElem("ok", 1))
		case "delete":
			ans = tunnel.BSONDoc(tunnel.BSONInt32Elem("n", 0), bsonArr("writeErrors", tunnel.BSONSub("0", tunnel.BSONInt32Elem("index", 0), tunnel.BSONInt32Elem("code", 121), tunnel.BSONStr("errmsg", "Document failed validation"))), tunnel.BSONDoubleElem("ok", 1))
		case "boom":
			ans = tunnel.BSONDoc(tunnel.BSONDoubleElem("ok", 0), tunnel.BSONStr("errmsg", "no such command: 'boom'"), tunnel.BSONInt32Elem("code", 59), tunnel.BSONStr("codeName", "CommandNotFound"))
		default:
			ans = tunnel.BSONDoc(tunnel.BSONDoubleElem("ok", 1))
		}
		if _, err := st.Write(tunnel.MongoMsg(900, h.RequestID, 0, ans)); err != nil {
			return
		}
	}
}

func bsonArr(key string, elems ...tunnel.BSONElem) tunnel.BSONElem {
	e := tunnel.BSONSub(key, elems...)
	e[0] = tunnel.BSONArray
	return e
}

type mongoTestClient struct {
	conn net.Conn
	r    *bufio.Reader
	id   int32
}

func (c *mongoTestClient) msg(t *testing.T, doc []byte, extra ...byte) tunnel.MongoHeader {
	t.Helper()
	c.id++
	m := tunnel.MongoMsg(c.id, 0, 0, doc)
	if len(extra) > 0 { // a kind-1 section after the body
		m = append(m, extra...)
		binary.LittleEndian.PutUint32(m, uint32(len(m)))
	}
	if _, err := c.conn.Write(m); err != nil {
		t.Fatal(err)
	}
	return tunnel.MongoHeader{RequestID: c.id}
}

// answer reads one message back and returns its body document.
func (c *mongoTestClient) answer(t *testing.T, want int32) []byte {
	t.Helper()
	h, b, err := readMongoMsg(c.r, 8<<20)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if want != 0 && h.ResponseTo != want {
		t.Fatalf("answer to %d, want %d", h.ResponseTo, want)
	}
	var doc []byte
	if h.OpCode == tunnel.MongoOpReply {
		doc = b[20:]
	} else if doc, _, err = tunnel.MongoMsgBody(b); err != nil {
		t.Fatal(err)
	}
	return doc
}

func str(t *testing.T, doc []byte, key string) string {
	t.Helper()
	typ, v, ok := tunnel.BSONGet(doc, key)
	if !ok || typ != tunnel.BSONString {
		return ""
	}
	s, _ := tunnel.BSONStringValue(v)
	return s
}

func plainStart(ticket string) []byte {
	return tunnel.BSONDoc(tunnel.BSONInt32Elem("saslStart", 1), tunnel.BSONStr("mechanism", "PLAIN"), tunnel.BSONBin("payload", []byte("\x00"+ticket+"\x00x")), tunnel.BSONStr("$db", "$external"))
}

func dialMongo(t *testing.T, addr string, useTLS bool) *mongoTestClient {
	t.Helper()
	raw, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { raw.Close() })
	_ = raw.SetDeadline(time.Now().Add(10 * time.Second))
	var conn net.Conn = raw
	if useTLS {
		tc := tls.Client(raw, &tls.Config{InsecureSkipVerify: true})
		if err := tc.Handshake(); err != nil {
			t.Fatal(err)
		}
		conn = tc
	}
	return &mongoTestClient{conn: conn, r: bufio.NewReader(conn)}
}

func TestMongoProxyEndToEnd(t *testing.T) {
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
	fc := &fakeMongoConnector{}
	go fc.run(cs)
	hub := NewSessionHub()
	p := &pgProxy{
		d: pgProxyDeps{
			ctrl: fakeDbCtrl{t: dbTarget{
				Engine: "mongodb", SiteID: "s1", UserID: "u1", Host: "10.0.0.9", Port: 27017, Username: "app", Database: "shop", TLS: "disable",
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
	go p.serve(ln, p.handleMongo)
	addr := ln.Addr().String()

	// Without TLS: a driver gets an error it shows.
	pc := dialMongo(t, addr, false)
	pc.msg(t, tunnel.BSONDoc(tunnel.BSONInt32Elem("hello", 1), tunnel.BSONStr("$db", "admin")))
	if got := str(t, pc.answer(t, 0), "errmsg"); !strings.Contains(got, "requires an encrypted connection") {
		t.Fatalf("plain connection: %q", got)
	}

	// The handshake of a driver: the legacy OP_QUERY first, then OP_MSG.
	c := dialMongo(t, addr, true)
	q := binary.LittleEndian.AppendUint32(nil, 0)
	q = append(q, "admin.$cmd\x00"...)
	q = binary.LittleEndian.AppendUint32(q, 0)
	q = binary.LittleEndian.AppendUint32(q, 0xffffffff)
	q = append(q, tunnel.BSONDoc(tunnel.BSONInt32Elem("isMaster", 1), tunnel.BSONBoolElem("helloOk", true))...)
	hdr := tunnel.MongoHeader{Len: int32(16 + len(q)), RequestID: 77, OpCode: tunnel.MongoOpQuery}
	_, _ = c.conn.Write(append(hdr.Bytes(), q...))
	hello := c.answer(t, 77)
	if tt, v, ok := tunnel.BSONGet(hello, "maxWireVersion"); !ok || func() int64 { n, _ := tunnel.BSONInt(tt, v); return n }() < 6 {
		t.Fatalf("hello: %v", hello)
	}
	h := c.msg(t, tunnel.BSONDoc(tunnel.BSONInt32Elem("hello", 1), tunnel.BSONStr("$db", "admin")))
	c.answer(t, h.RequestID)

	// Before signing in, nothing runs; SCRAM is told to use PLAIN.
	h = c.msg(t, tunnel.BSONDoc(tunnel.BSONStr("find", "orders"), tunnel.BSONStr("$db", "shop")))
	if got := str(t, c.answer(t, h.RequestID), "errmsg"); !strings.Contains(got, "requires authentication") {
		t.Fatalf("before sign-in: %q", got)
	}
	sc := dialMongo(t, addr, true)
	h = sc.msg(t, tunnel.BSONDoc(tunnel.BSONInt32Elem("saslStart", 1), tunnel.BSONStr("mechanism", "SCRAM-SHA-256"), tunnel.BSONBin("payload", []byte("n,,n=x,r=y")), tunnel.BSONStr("$db", "admin")))
	if got := str(t, sc.answer(t, h.RequestID), "errmsg"); !strings.Contains(got, "authMechanism=PLAIN") {
		t.Fatalf("scram: %q", got)
	}
	bad := dialMongo(t, addr, true)
	h = bad.msg(t, plainStart("nosuchticket"))
	if got := str(t, bad.answer(t, h.RequestID), "errmsg"); !strings.Contains(got, "unknown or has expired") {
		t.Fatalf("unknown ticket: %q", got)
	}
	pg := dialMongo(t, addr, true)
	h = pg.msg(t, plainStart("pgticket"))
	if got := str(t, pg.answer(t, h.RequestID), "errmsg"); !strings.Contains(got, "PostgreSQL") {
		t.Fatalf("a PostgreSQL resource: %q", got)
	}

	h = c.msg(t, plainStart("goodticket"))
	ok := c.answer(t, h.RequestID)
	if tt, v, found := tunnel.BSONGet(ok, "done"); !found || tt != tunnel.BSONBool || v[0] != 1 {
		t.Fatalf("sign-in: %v", ok)
	}
	fc.mu.Lock()
	req := fc.req
	fc.mu.Unlock()
	if req.Engine != "mongodb" || req.Username != "app" || req.Database != "shop" || req.Sealed != "sealed" {
		t.Fatalf("connector asked %+v", req)
	}

	// A find comes back whole.
	h = c.msg(t, tunnel.BSONDoc(tunnel.BSONStr("find", "orders"), tunnel.BSONStr("filter", "secret-filter"), tunnel.BSONStr("$db", "shop")))
	if tt, _, found := tunnel.BSONGet(c.answer(t, h.RequestID), "cursor"); !found || tt != tunnel.BSONDocument {
		t.Fatal("no cursor")
	}
	// An insert whose documents come in a second section.
	seq := append([]byte{1}, binary.LittleEndian.AppendUint32(nil, 4+10+2*5)...)
	seq = append(seq, "documents\x00"...)
	seq = append(seq, tunnel.BSONDoc()...)
	seq = append(seq, tunnel.BSONDoc()...)
	h = c.msg(t, tunnel.BSONDoc(tunnel.BSONStr("insert", "orders"), tunnel.BSONStr("$db", "shop")), seq...)
	c.answer(t, h.RequestID)
	// A write error inside a successful answer, and a failed command.
	h = c.msg(t, tunnel.BSONDoc(tunnel.BSONStr("delete", "orders"), tunnel.BSONStr("$db", "shop")))
	c.answer(t, h.RequestID)
	h = c.msg(t, tunnel.BSONDoc(tunnel.BSONStr("boom", "x"), tunnel.BSONStr("$db", "shop")))
	c.answer(t, h.RequestID)
	// Managing users and signing in again are refused; the server never sees them.
	for _, name := range []string{"createUser", "dropUser", "saslStart", "shutdown", "setParameter"} {
		h = c.msg(t, tunnel.BSONDoc(tunnel.BSONStr(name, "x"), tunnel.BSONStr("$db", "admin")))
		if got := str(t, c.answer(t, h.RequestID), "errmsg"); !strings.Contains(got, "Captivo Access") {
			t.Fatalf("%s: %q", name, got)
		}
	}
	fc.mu.Lock()
	seen := strings.Join(fc.got, "|")
	fc.mu.Unlock()
	if seen != "find|insert|delete|boom" {
		t.Fatalf("the server received %q", seen)
	}

	list := hub.List()
	if len(list) != 1 || list[0].Protocol != "mongodb" {
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
		if strings.Contains(feed, "command:find shop.orders") && strings.Contains(feed, "command:insert shop.orders") && strings.Contains(feed, "command:boom shop.x  ✗ no such command") &&
			strings.Contains(feed, "Connection opened to MongoDB, signed in to shop (server 7.0.14)") && strings.Contains(feed, "Refused createUser") {
			if strings.Contains(feed, "secret-filter") {
				t.Fatalf("a filter reached the feed:\n%s", feed)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("feed:\n%s", feed)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestMongoLogTextAndFinish(t *testing.T) {
	doc := tunnel.BSONDoc(tunnel.BSONStr("find", "orders"), tunnel.BSONStr("$db", "shop"))
	if text, db := mongoLogText(doc); text != "find shop.orders" || db != "shop" {
		t.Fatalf("%q %q", text, db)
	}
	if text, _ := mongoLogText(tunnel.BSONDoc(tunnel.BSONInt32Elem("listDatabases", 1), tunnel.BSONStr("$db", "admin"))); text != "listDatabases admin" {
		t.Fatalf("%q", text)
	}
	if text, _ := mongoLogText(tunnel.BSONDoc(tunnel.BSONInt64Elem("getMore", 99), tunnel.BSONStr("collection", "orders"), tunnel.BSONStr("$db", "shop"))); text != "getMore shop.orders" {
		t.Fatalf("%q", text)
	}
	for _, n := range []string{"createUser", "SASLSTART", "shutdown"} {
		if mongoBlocked(n) == "" {
			t.Errorf("%s should be refused", n)
		}
	}
	for _, n := range []string{"find", "insert", "listCollections", "aggregate", "killCursors", "endSessions"} {
		if mongoBlocked(n) != "" {
			t.Errorf("%s refused", n)
		}
	}
}

func TestMongoFinishReadsRowsAndErrors(t *testing.T) {
	f := &mongoFlow{start: time.Now(), now: time.Now, calls: map[int32]*mongoCall{}}
	call := func(id int32) { f.calls[id] = &mongoCall{text: "find shop.orders", db: "shop", at: time.Now()} }

	call(1)
	find := tunnel.BSONDoc(tunnel.BSONSub("cursor", tunnel.BSONInt64Elem("id", 0), bsonArr("firstBatch", tunnel.BSONSub("0"), tunnel.BSONSub("1"), tunnel.BSONSub("2"))), tunnel.BSONDoubleElem("ok", 1))
	if e := f.finish(1, find, false); e == nil || e.Rows == nil || *e.Rows != 3 || e.Error != "" {
		t.Fatalf("find: %+v", e)
	}
	call(2)
	if e := f.finish(2, tunnel.BSONDoc(tunnel.BSONInt32Elem("n", 5), tunnel.BSONDoubleElem("ok", 1)), false); e == nil || e.Rows == nil || *e.Rows != 5 {
		t.Fatalf("write: %+v", e)
	}
	call(3)
	if e := f.finish(3, tunnel.BSONDoc(tunnel.BSONDoubleElem("ok", 0), tunnel.BSONStr("errmsg", "not authorized"), tunnel.BSONStr("codeName", "Unauthorized")), false); e == nil || e.Error != "not authorized" || e.Code != "Unauthorized" || e.Rows != nil {
		t.Fatalf("failed: %+v", e)
	}
	call(4)
	if e := f.finish(4, tunnel.BSONDoc(bsonArr("writeErrors", tunnel.BSONSub("0", tunnel.BSONStr("errmsg", "E11000 duplicate key"))), tunnel.BSONDoubleElem("ok", 1)), false); e == nil || !strings.HasPrefix(e.Error, "E11000") {
		t.Fatalf("write error: %+v", e)
	}
	// An exhaust cursor's answers are one command: logged with the last.
	call(5)
	if e := f.finish(5, find, true); e != nil {
		t.Fatalf("a streaming answer was logged early: %+v", e)
	}
	if e := f.finish(5, find, false); e == nil {
		t.Fatal("the last streaming answer was not logged")
	}
	if e := f.finish(99, find, false); e != nil {
		t.Fatalf("an answer to nothing was logged: %+v", e)
	}
}
