package main

import (
	"bufio"
	"crypto/tls"
	"io"
	"log"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// The database proxy for Redis clients (redis-cli, RedisInsight, DBeaver,
// application drivers) on its own port:
//
//	redis-cli --tls -h <console host> -p 16379 --user <ticket> --pass x
//
// The proxy ends the client's TLS (a plain connection is told how to connect)
// and takes the connection ticket from AUTH: the user name when the client
// sends one, else the password. The resource's connector signs in with the
// saved account (connector/redis.go); from then on the proxy relays RESP2
// reply by reply, logging each command's name and first argument (redisresp.go)
// and never a value. Sessions, the minute-by-minute recheck and the query log
// are the PostgreSQL proxy's.

const redisMinConnector = "2.64.0"

// handleRedis runs one Redis client connection.
func (p *pgProxy) handleRedis(raw net.Conn, started func()) {
	var once sync.Once
	release := func() { once.Do(started) }
	defer release()
	clientIP, _, _ := net.SplitHostPort(raw.RemoteAddr().String())
	_ = raw.SetDeadline(time.Now().Add(pgHandshakeLimit))
	br := bufio.NewReader(raw)
	first, err := br.Peek(1)
	if err != nil {
		raw.Close()
		return
	}
	if first[0] != 0x16 { // not a TLS ClientHello
		_, _ = raw.Write([]byte("-ERR Captivo Access requires an encrypted connection: connect with TLS (redis-cli --tls)\r\n"))
		raw.Close()
		return
	}
	conn := tls.Server(&bufConn{Conn: raw, r: br}, p.myTLS)
	defer conn.Close()
	if conn.Handshake() != nil {
		return
	}
	r := bufio.NewReader(conn)
	for {
		c, err := readRedisCmd(r, 4) // before AUTH nothing is relayed: a command is read whole
		if err != nil {
			return
		}
		if err := c.rest(r, nil); err != nil {
			return
		}
		switch c.name() {
		case "AUTH":
			ticket := ""
			switch len(c.args) {
			case 2:
				ticket = string(c.args[1])
			case 3:
				ticket = string(c.args[1])
				if ticket == "" || ticket == "default" {
					ticket = string(c.args[2])
				}
			default:
				_, _ = conn.Write([]byte("-ERR syntax error\r\n"))
				continue
			}
			p.openRedis(conn, r, ticket, clientIP, release)
			return
		case "HELLO":
			// RESP2 only: a client that asked for 3 falls back to AUTH.
			_, _ = conn.Write([]byte("-NOPROTO sorry, this protocol version is not supported\r\n"))
		case "QUIT":
			_, _ = conn.Write([]byte("+OK\r\n"))
			return
		case "":
		default:
			_, _ = conn.Write([]byte("-NOAUTH Authentication required.\r\n"))
		}
	}
}

func redisFail(w io.Writer, code, msg string) {
	_, _ = w.Write([]byte("-" + code + " Captivo Access: " + strings.NewReplacer("\r", " ", "\n", " ").Replace(msg) + "\r\n"))
}

func (p *pgProxy) openRedis(conn net.Conn, r *bufio.Reader, ticket, clientIP string, started func()) {
	t, err := p.d.ctrl.DatabaseTarget(ticket, clientIP)
	if err != nil {
		code, msg := "ERR", "could not check your access; try again"
		switch httpStatus(err) {
		case 404:
			time.Sleep(500 * time.Millisecond) // a guess costs time
			code, msg = "WRONGPASS", "this connection ticket is unknown or has expired. Get a new one from My access in your Captivo portal."
		case 403:
			code, msg = "NOPERM", "your access to this resource is not active"
		case 409:
			msg = "this resource can't be opened as a database right now; ask your administrator"
		}
		redisFail(conn, code, msg)
		return
	}
	if t.engine() != "redis" {
		redisFail(conn, "ERR", wrongEngine(t))
		return
	}
	s, err := p.join(ticket, clientIP, t, "")
	if err != nil {
		redisFail(conn, "ERR", err.Error())
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
		Engine: "redis", Host: t.Host, Port: strconv.Itoa(t.Port), Username: t.Username, Database: t.Database,
		Sealed: sealed, TLS: t.TLS, CACertPEM: t.CACertPEM,
	})
	if err != nil {
		redisFail(conn, "ERR", err.Error())
		return
	}
	if resp.Error != "" {
		log.Printf("db proxy: site=%s user=%s redis sign-in to %s failed: %s", t.SiteID, t.UserID, t.Host, resp.Error)
		redisFail(conn, "ERR", "the database refused the saved account: "+resp.Error)
		up.Close()
		return
	}
	defer up.Close()
	if _, err := conn.Write([]byte("+OK\r\n")); err != nil {
		return
	}
	_ = conn.SetDeadline(time.Time{})
	started()

	var once sync.Once
	closeBoth := func() { once.Do(func() { conn.Close(); up.Close() }) }
	id := s.addConn(closeBoth)
	defer s.dropConn(id)
	version := ""
	if resp.ServerVersion != "" {
		version = " (server " + resp.ServerVersion + ")"
	}
	where := "Redis"
	if t.Database != "" {
		where += " database " + t.Database
	}
	s.event("Connection opened to " + where + version)
	f := &redisFlow{start: s.start, now: p.d.now, s: s, db: t.Database, out: &myClientOut{w: bufio.NewWriterSize(conn, 64<<10)}}
	done := make(chan struct{}, 2)
	go func() { f.relayServer(bufio.NewReader(up)); done <- struct{}{} }()
	go func() { f.relayClient(r, up); done <- struct{}{} }()
	<-done
	closeBoth()
	<-done
}

// redisCall is one command the client sent that the proxy is waiting on an
// answer to, or a refusal that waits its turn among the server's answers.
type redisCall struct {
	text  string
	at    time.Time
	local []byte // the proxy's own answer, for a refused command
}

// redisFlow pairs a client's commands with the server's replies, which come
// in the same order. A refused command never reaches the server, so its
// answer is written when the replies before it are done.
type redisFlow struct {
	start time.Time
	now   func() time.Time
	s     *dbSession
	db    string
	out   *myClientOut

	mu     sync.Mutex
	q      []*redisCall
	lost   bool // replies no longer pair with commands (a subscription): stop logging
	closed bool
}

// add queues a command; a refusal with nothing before it is answered at once.
func (f *redisFlow) add(c *redisCall) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.lost {
		if c.local != nil {
			_ = f.out.write(c.local, true)
		}
		return
	}
	if c.local != nil && len(f.q) == 0 {
		_ = f.out.write(c.local, true)
		return
	}
	f.q = append(f.q, c)
}

// done is called when a reply to the oldest command has been copied.
func (f *redisFlow) done(info replyInfo) {
	f.mu.Lock()
	if len(f.q) == 0 || f.lost { // a push the client did not ask for
		f.mu.Unlock()
		return
	}
	head := f.q[0]
	f.q = f.q[1:]
	var ev *queryEvent
	if head.text != "" {
		now := f.now()
		e := queryEvent{AtMs: head.at.Sub(f.start).Milliseconds(), Kind: "query", Text: head.text, Ms: now.Sub(head.at).Milliseconds(), Db: f.db}
		if info.err != "" {
			e.Error, e.Code = clipText(info.err, 200), redisErrCode(info.err)
		}
		ev = &e
	}
	for len(f.q) > 0 && f.q[0].local != nil {
		_ = f.out.write(f.q[0].local, false)
		f.q = f.q[1:]
	}
	f.mu.Unlock()
	if ev != nil {
		f.s.queries([]queryEvent{*ev})
	}
}

func clipText(s string, n int) string {
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}

func (f *redisFlow) relayServer(r *bufio.Reader) {
	for {
		var info replyInfo
		if err := copyRedisReply(r, f.out, &info, 0); err != nil {
			_ = f.out.flush()
			return
		}
		f.done(info)
		if r.Buffered() == 0 && f.out.flush() != nil {
			return
		}
	}
}

func (f *redisFlow) relayClient(r *bufio.Reader, up io.Writer) {
	w := bufio.NewWriterSize(up, 64<<10)
	for {
		c, err := readRedisCmd(r, respHeadArgs)
		if err != nil {
			_ = w.Flush()
			return
		}
		if len(c.args) == 0 { // an empty command: nothing to do
			if err := c.rest(r, nil); err != nil {
				return
			}
			continue
		}
		if why := redisBlocked(c); why != "" {
			if c.rest(r, nil) != nil {
				return
			}
			f.s.event("Refused " + c.name())
			f.add(&redisCall{local: []byte("-ERR Captivo Access: " + why + "\r\n")})
			continue
		}
		if c.name() == "HELLO" {
			if c.rest(r, nil) != nil {
				return
			}
			f.add(&redisCall{local: []byte("-NOPROTO sorry, this protocol version is not supported\r\n")})
			continue
		}
		if redisUnpaired(c) {
			f.mu.Lock()
			f.lost = true
			f.q = nil
			f.mu.Unlock()
			f.s.event("Subscribed to channels (commands are not logged from here on)")
		} else {
			f.add(&redisCall{text: redisLogText(c), at: f.now()})
		}
		_, _ = w.Write(c.head)
		if err := c.rest(r, w); err != nil {
			return
		}
		if r.Buffered() == 0 {
			if w.Flush() != nil {
				return
			}
		}
	}
}
