package main

import (
	"bufio"
	"crypto/tls"
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

// fakeRedisConnector is the connector's end and the server behind it: a few
// commands answered the way Redis does.
type fakeRedisConnector struct {
	mu   sync.Mutex
	req  tunnel.DbDialRequest
	got  []string // the commands the server received, first two words
	data map[string]string
}

func (f *fakeRedisConnector) run(conn *yamux.Session) {
	for {
		st, err := conn.AcceptStream()
		if err != nil {
			return
		}
		go f.stream(st)
	}
}

func (f *fakeRedisConnector) stream(st net.Conn) {
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
	resp, _ := json.Marshal(tunnel.DbDialResponse{ServerVersion: "7.4.1"})
	if tunnel.WriteFrame(st, resp) != nil {
		return
	}
	r := bufio.NewReader(st)
	for {
		c, err := readRedisCmd(r, respHeadArgs)
		if err != nil {
			return
		}
		var big strings.Builder
		if c.left > 0 {
			var sink strings.Builder
			_ = c.rest(r, &sink)
			big.WriteString(sink.String())
		}
		name := c.name()
		f.mu.Lock()
		f.got = append(f.got, name)
		f.mu.Unlock()
		switch name {
		case "GET":
			v, ok := f.data[string(c.args[1])]
			if !ok {
				_, _ = st.Write([]byte("$-1\r\n"))
			} else {
				_, _ = st.Write([]byte("$" + strconv.Itoa(len(v)) + "\r\n" + v + "\r\n"))
			}
		case "SET":
			f.mu.Lock()
			f.data[string(c.args[1])] = "stored"
			f.mu.Unlock()
			_, _ = st.Write([]byte("+OK\r\n"))
		case "KEYS":
			_, _ = st.Write([]byte("*2\r\n$1\r\na\r\n*1\r\n:7\r\n"))
		case "BOOM":
			_, _ = st.Write([]byte("-WRONGTYPE Operation against a key holding the wrong kind of value\r\n"))
		case "QUIT":
			_, _ = st.Write([]byte("+OK\r\n"))
			return
		default:
			_, _ = st.Write([]byte("+PONG\r\n"))
		}
	}
}

type redisTestClient struct {
	conn net.Conn
	r    *bufio.Reader
}

func (c *redisTestClient) send(args ...string) {
	b := "*" + strconv.Itoa(len(args)) + "\r\n"
	for _, a := range args {
		b += "$" + strconv.Itoa(len(a)) + "\r\n" + a + "\r\n"
	}
	_, _ = c.conn.Write([]byte(b))
}

// reply reads one reply back as text, nested replies flattened with spaces.
func (c *redisTestClient) reply(t *testing.T) string {
	t.Helper()
	line, err := readRespLine(c.r)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	s := strings.TrimRight(string(line), "\r\n")
	switch s[0] {
	case '$':
		n, _ := strconv.Atoi(s[1:])
		if n < 0 {
			return "$nil"
		}
		b := make([]byte, n+2)
		if _, err := io.ReadFull(c.r, b); err != nil {
			t.Fatal(err)
		}
		return "$" + string(b[:n])
	case '*':
		n, _ := strconv.Atoi(s[1:])
		parts := []string{}
		for i := 0; i < n; i++ {
			parts = append(parts, c.reply(t))
		}
		return "[" + strings.Join(parts, " ") + "]"
	}
	return s
}

func dialRedis(t *testing.T, addr string, useTLS bool) *redisTestClient {
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
	return &redisTestClient{conn: conn, r: bufio.NewReader(conn)}
}

func TestRedisProxyEndToEnd(t *testing.T) {
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
	fc := &fakeRedisConnector{data: map[string]string{"a": "alpha", "b": "beta"}}
	go fc.run(cs)
	hub := NewSessionHub()
	p := &pgProxy{
		d: pgProxyDeps{
			ctrl: fakeDbCtrl{t: dbTarget{
				Engine: "redis", SiteID: "s1", UserID: "u1", Host: "10.0.0.9", Port: 6379, Username: "default", Database: "3", TLS: "disable",
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
	go p.serve(ln, p.handleRedis)
	addr := ln.Addr().String()

	// Without TLS: told how to connect.
	pc := dialRedis(t, addr, false)
	pc.send("AUTH", "goodticket")
	if got := pc.reply(t); !strings.Contains(got, "requires an encrypted connection") {
		t.Fatalf("plain connection: %q", got)
	}

	// Before AUTH: nothing runs, and HELLO 3 is turned down so a client falls back.
	c0 := dialRedis(t, addr, true)
	c0.send("GET", "a")
	if got := c0.reply(t); !strings.HasPrefix(got, "-NOAUTH") {
		t.Fatalf("before auth: %q", got)
	}
	c0.send("HELLO", "3")
	if got := c0.reply(t); !strings.HasPrefix(got, "-NOPROTO") {
		t.Fatalf("hello: %q", got)
	}
	c0.send("AUTH", "nosuchticket", "x")
	if got := c0.reply(t); !strings.HasPrefix(got, "-WRONGPASS") || !strings.Contains(got, "unknown or has expired") {
		t.Fatalf("unknown ticket: %q", got)
	}
	c9 := dialRedis(t, addr, true)
	c9.send("AUTH", "pgticket", "x")
	if got := c9.reply(t); !strings.Contains(got, "PostgreSQL") {
		t.Fatalf("a PostgreSQL resource: %q", got)
	}

	// The ticket as the user name, and as the lone password.
	c1 := dialRedis(t, addr, true)
	c1.send("AUTH", "goodticket", "anything")
	if got := c1.reply(t); got != "+OK" {
		t.Fatalf("sign-in: %q", got)
	}
	c2 := dialRedis(t, addr, true)
	c2.send("AUTH", "goodticket")
	if got := c2.reply(t); got != "+OK" {
		t.Fatalf("sign-in with the password form: %q", got)
	}
	c3 := dialRedis(t, addr, true)
	c3.send("AUTH", "default", "goodticket")
	if got := c3.reply(t); got != "+OK" {
		t.Fatalf("sign-in as default: %q", got)
	}
	fc.mu.Lock()
	req := fc.req
	fc.mu.Unlock()
	if req.Engine != "redis" || req.Username != "default" || req.Database != "3" || req.Sealed != "sealed" {
		t.Fatalf("connector asked %+v", req)
	}

	// Pipelined, with a refusal in the middle: the answers keep their order.
	c1.send("GET", "a")
	c1.send("CONFIG", "GET", "requirepass")
	c1.send("GET", "zz")
	c1.send("AUTH", "root", "x")
	c1.send("KEYS", "*")
	c1.send("BOOM")
	want := []string{"$alpha", "-ERR Captivo Access: CONFIG is not available", "$nil", "-ERR Captivo Access: changing the user", "[$a [:7]]", "-WRONGTYPE"}
	for i, w := range want {
		if got := c1.reply(t); !strings.HasPrefix(got, w) {
			t.Fatalf("reply %d: %q, want %q", i, got, w)
		}
	}
	// A refusal with nothing outstanding is answered at once.
	c1.send("MONITOR")
	if got := c1.reply(t); !strings.Contains(got, "MONITOR is not available") {
		t.Fatalf("monitor: %q", got)
	}
	// A big value streams through and is not kept.
	big := strings.Repeat("x", 3<<20)
	c1.send("SET", "bigkey", big)
	if got := c1.reply(t); got != "+OK" {
		t.Fatalf("big set: %q", got)
	}
	fc.mu.Lock()
	seen := strings.Join(fc.got, "|")
	fc.mu.Unlock()
	if strings.Contains(seen, "CONFIG") || strings.Contains(seen, "AUTH") || strings.Contains(seen, "MONITOR") {
		t.Fatalf("the server received a refused command: %q", seen)
	}

	// One session, with names and first arguments in the feed and no values.
	list := hub.List()
	if len(list) != 1 || list[0].Protocol != "redis" {
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
		if strings.Contains(feed, "command:GET a") && strings.Contains(feed, "command:SET bigkey") && strings.Contains(feed, "command:BOOM") &&
			strings.Contains(feed, "Connection opened to Redis database 3 (server 7.4.1)") && strings.Contains(feed, "Refused CONFIG") {
			if strings.Contains(feed, "xxxx") || strings.Contains(feed, "requirepass") {
				t.Fatalf("a value or a refused argument reached the feed:\n%s", feed)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("feed:\n%s", feed)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestRedisLogText(t *testing.T) {
	cmd := func(args ...string) *redisCmd {
		c := &redisCmd{}
		for _, a := range args {
			c.args = append(c.args, []byte(a))
		}
		return c
	}
	for want, c := range map[string]*redisCmd{
		"GET user:1":    cmd("get", "user:1"),
		"SET k":         cmd("SET", "k", "secret value"),
		"EVAL":          cmd("EVAL", "return redis.call('get', KEYS[1])", "1", "a"),
		"PING":          cmd("ping"),
		`HGET "a\r\nb"`: cmd("HGET", "a\r\nb", "f"),
		"DEL " + strings.Repeat("k", 100) + "…": cmd("DEL", strings.Repeat("k", 120)),
	} {
		if got := redisLogText(c); got != want {
			t.Errorf("got %q want %q", got, want)
		}
	}
	for _, blocked := range []*redisCmd{cmd("config", "get", "requirepass"), cmd("AUTH", "x"), cmd("acl", "setuser", "x"), cmd("client", "reply", "off"), cmd("replicaof", "h", "1")} {
		if redisBlocked(blocked) == "" {
			t.Errorf("%s should be refused", blocked.name())
		}
	}
	for _, ok := range []*redisCmd{cmd("get", "k"), cmd("acl", "whoami"), cmd("client", "list"), cmd("select", "2"), cmd("flushdb")} {
		if why := redisBlocked(ok); why != "" {
			t.Errorf("%s refused: %s", ok.name(), why)
		}
	}
}
