package main

import (
	"bufio"
	"crypto/tls"
	"encoding/binary"
	"io"
	"log"
	"net"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// The database proxy for MongoDB clients (mongosh, Compass, drivers) on its
// own port:
//
//	mongosh "mongodb://<ticket>:x@<console host>:17017/?tls=true&authMechanism=PLAIN&authSource=$external"
//
// The proxy ends the client's TLS, answers the driver's handshake itself and
// takes the connection ticket as the user name of a PLAIN sign-in (SCRAM
// would need the client's password; there is none). The resource's connector
// signs in with the saved account (connector/mongo.go); from then on the proxy
// relays OP_MSG message by message, logging each command's name and
// collection (never a filter or a document) with its duration, the server's
// error and how many documents came back. Sessions, the minute-by-minute
// recheck and the query log are the PostgreSQL proxy's.

const (
	mongoMinConnector = "2.64.0"
	mongoPreAuthMax   = 1 << 20
	mongoParseMax     = 64 << 10 // a command or answer read whole to log it; a longer one is streamed
	mongoWireVersion  = 17       // MongoDB 6.0: new enough for current drivers
)

var mongoConnIDs atomic.Int32

// mongoHello is the answer to a driver's handshake.
func mongoHello() []byte {
	return tunnel.BSONDoc(
		tunnel.BSONBoolElem("helloOk", true), tunnel.BSONBoolElem("ismaster", true), tunnel.BSONBoolElem("isWritablePrimary", true),
		tunnel.BSONInt32Elem("maxBsonObjectSize", 16777216), tunnel.BSONInt32Elem("maxMessageSizeBytes", tunnel.MongoMaxMessage),
		tunnel.BSONInt32Elem("maxWriteBatchSize", 100000), tunnel.BSONDateTime("localTime", time.Now().UnixMilli()),
		tunnel.BSONInt32Elem("logicalSessionTimeoutMinutes", 30), tunnel.BSONInt32Elem("connectionId", mongoConnIDs.Add(1)),
		tunnel.BSONInt32Elem("minWireVersion", 0), tunnel.BSONInt32Elem("maxWireVersion", mongoWireVersion),
		tunnel.BSONBoolElem("readOnly", false), tunnel.BSONDoubleElem("ok", 1))
}

// mongoErrDoc is an error answer.
func mongoErrDoc(msg string, code int32, name string) []byte {
	return tunnel.BSONDoc(tunnel.BSONDoubleElem("ok", 0), tunnel.BSONStr("errmsg", "Captivo Access: "+msg), tunnel.BSONInt32Elem("code", code), tunnel.BSONStr("codeName", name))
}

// mongoAnswer writes doc as the answer to a request, in the request's own
// message format.
func mongoAnswer(w io.Writer, h tunnel.MongoHeader, doc []byte, failure bool) error {
	if h.OpCode == tunnel.MongoOpQuery {
		_, err := w.Write(tunnel.MongoReply(0, h.RequestID, doc, failure))
		return err
	}
	_, err := w.Write(tunnel.MongoMsg(0, h.RequestID, 0, doc))
	return err
}

func readMongoMsg(r io.Reader, max int) (tunnel.MongoHeader, []byte, error) {
	h, err := tunnel.ReadMongoHeader(r)
	if err != nil {
		return h, nil, err
	}
	if int(h.Len) > max {
		return h, nil, tunnel.ErrMongoMsg
	}
	b := make([]byte, h.Len-16)
	if _, err := io.ReadFull(r, b); err != nil {
		return h, nil, err
	}
	return h, b, nil
}

// mongoCommandDoc is the command a request carries, in either message format.
func mongoCommandDoc(h tunnel.MongoHeader, payload []byte) ([]byte, error) {
	switch h.OpCode {
	case tunnel.MongoOpMsg:
		d, _, err := tunnel.MongoMsgBody(payload)
		return d, err
	case tunnel.MongoOpQuery:
		_, d, err := tunnel.MongoQueryDoc(payload)
		return d, err
	}
	return nil, tunnel.ErrMongoMsg
}

func (p *pgProxy) handleMongo(raw net.Conn, started func()) {
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
	if first[0] != 0x16 { // not a TLS ClientHello: say so in a form a driver shows
		if h, _, err := readMongoMsg(br, mongoPreAuthMax); err == nil {
			_ = mongoAnswer(raw, h, mongoErrDoc("this proxy requires an encrypted connection: turn TLS on (tls=true)", 13, "Unauthorized"), true)
		}
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
		h, b, err := readMongoMsg(r, mongoPreAuthMax)
		if err != nil {
			return
		}
		doc, err := mongoCommandDoc(h, b)
		if err != nil {
			return
		}
		name, _, _, _ := tunnel.BSONFirst(doc)
		switch strings.ToLower(name) {
		case "hello", "ismaster":
			if mongoAnswer(conn, h, mongoHello(), false) != nil {
				return
			}
		case "ping":
			if mongoAnswer(conn, h, tunnel.BSONDoc(tunnel.BSONDoubleElem("ok", 1)), false) != nil {
				return
			}
		case "saslstart":
			ticket, why := mongoPlainTicket(doc)
			if why != "" {
				_ = mongoAnswer(conn, h, mongoErrDoc(why, 18, "AuthenticationFailed"), true)
				return
			}
			p.openMongo(conn, r, h, ticket, clientIP, release)
			return
		default:
			if mongoAnswer(conn, h, mongoErrDoc("command "+name+" requires authentication", 13, "Unauthorized"), true) != nil {
				return
			}
		}
	}
}

// mongoPlainTicket takes the ticket out of a PLAIN saslStart: the user name,
// or the password when no user name came.
func mongoPlainTicket(doc []byte) (ticket, why string) {
	t, v, _ := tunnel.BSONGet(doc, "mechanism")
	mech, _ := tunnel.BSONStringValue(v)
	if t != tunnel.BSONString || mech != "PLAIN" {
		return "", "connect with authMechanism=PLAIN (and authSource=$external); the connection string in your portal has it"
	}
	t, v, _ = tunnel.BSONGet(doc, "payload")
	payload, ok := tunnel.BSONBinaryValue(v)
	if t != tunnel.BSONBinary || !ok {
		return "", "the sign-in has no payload"
	}
	parts := strings.Split(string(payload), "\x00") // authzid, user, password
	if len(parts) != 3 {
		return "", "the sign-in payload is not PLAIN"
	}
	if parts[1] != "" {
		return parts[1], ""
	}
	return parts[2], ""
}

func (p *pgProxy) openMongo(conn net.Conn, r *bufio.Reader, h tunnel.MongoHeader, ticket, clientIP string, started func()) {
	fail := func(msg string) {
		_ = mongoAnswer(conn, h, mongoErrDoc(msg, 18, "AuthenticationFailed"), true)
	}
	t, err := p.d.ctrl.DatabaseTarget(ticket, clientIP)
	if err != nil {
		msg := "could not check your access; try again"
		switch httpStatus(err) {
		case 404:
			time.Sleep(500 * time.Millisecond) // a guess costs time
			msg = "this connection ticket is unknown or has expired. Get a new one from My access in your Captivo portal."
		case 403:
			msg = "your access to this resource is not active"
		case 409:
			msg = "this resource can't be opened as a database right now; ask your administrator"
		}
		fail(msg)
		return
	}
	if t.engine() != "mongodb" {
		fail(wrongEngine(t))
		return
	}
	s, err := p.join(ticket, clientIP, t, "")
	if err != nil {
		fail(err.Error())
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
		Engine: "mongodb", Host: t.Host, Port: strconv.Itoa(t.Port), Username: t.Username, Database: t.Database,
		Sealed: sealed, TLS: t.TLS, CACertPEM: t.CACertPEM,
	})
	if err != nil {
		fail(err.Error())
		return
	}
	if resp.Error != "" {
		log.Printf("db proxy: site=%s user=%s mongodb sign-in to %s failed: %s", t.SiteID, t.UserID, t.Host, resp.Error)
		fail("the database refused the saved account: " + resp.Error)
		up.Close()
		return
	}
	defer up.Close()
	ok := tunnel.BSONDoc(tunnel.BSONInt32Elem("conversationId", 1), tunnel.BSONBoolElem("done", true), tunnel.BSONBin("payload", nil), tunnel.BSONDoubleElem("ok", 1))
	if mongoAnswer(conn, h, ok, false) != nil {
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
	db := t.Database
	if db == "" {
		db = "admin"
	}
	s.event("Connection opened to MongoDB, signed in to " + db + version)
	f := &mongoFlow{start: s.start, now: p.d.now, s: s, calls: map[int32]*mongoCall{}, out: &myClientOut{w: bufio.NewWriterSize(conn, 64<<10)}}
	done := make(chan struct{}, 2)
	go func() { f.relayServer(bufio.NewReader(up)); done <- struct{}{} }()
	go func() { f.relayClient(r, up); done <- struct{}{} }()
	<-done
	closeBoth()
	<-done
}

type mongoCall struct {
	text string
	db   string
	at   time.Time
}

// mongoFlow pairs requests with answers by request id (the answer's
// responseTo); an exhaust cursor streams several answers to one request.
type mongoFlow struct {
	start time.Time
	now   func() time.Time
	s     *dbSession
	out   *myClientOut

	mu    sync.Mutex
	calls map[int32]*mongoCall
}

// mongoBlocked says why a command is refused, or "".
func mongoBlocked(name string) string {
	switch strings.ToLower(name) {
	case "saslstart", "saslcontinue", "authenticate", "logout":
		return "signing in again on a connection is not allowed; connect again instead"
	case "createuser", "updateuser", "dropuser", "dropallusersfromdatabase", "grantrolestouser", "revokerolesfromuser",
		"createrole", "updaterole", "droprole", "dropallrolesfromdatabase", "grantprivilegestorole", "revokeprivilegesfromrole",
		"grantrolestorole", "revokerolesfromrole":
		return "managing users and roles is not available through Captivo Access"
	case "shutdown", "setparameter", "getcmdlineopts", "replsetreconfig", "replsetinitiate", "replsetstepdown", "replsetfreeze",
		"fsync", "fsyncunlock", "setfeaturecompatibilityversion", "setclusterparameter":
		return name + " is not available through Captivo Access"
	}
	return ""
}

// mongoQuiet commands are handshakes and keep-alives a driver sends on its own.
func mongoQuiet(name string) bool {
	switch strings.ToLower(name) {
	case "hello", "ismaster", "ping", "endsessions", "buildinfo", "getlasterror":
		return true
	}
	return false
}

// mongoLogText is a command's name and what it works on: db.collection, or
// the database for a command that names none. Filters and documents stay out.
func mongoLogText(doc []byte) (text, db string) {
	name, typ, val, ok := tunnel.BSONFirst(doc)
	if !ok {
		return "", ""
	}
	if t, v, ok := tunnel.BSONGet(doc, "$db"); ok && t == tunnel.BSONString {
		db, _ = tunnel.BSONStringValue(v)
	}
	coll := ""
	if typ == tunnel.BSONString {
		coll, _ = tunnel.BSONStringValue(val)
	} else if strings.EqualFold(name, "getMore") {
		if t, v, ok := tunnel.BSONGet(doc, "collection"); ok && t == tunnel.BSONString {
			coll, _ = tunnel.BSONStringValue(v)
		}
	}
	where := db
	if coll != "" {
		where = coll
		if db != "" {
			where = db + "." + coll
		}
	}
	return strings.TrimSpace(name + " " + where), db
}

func (f *mongoFlow) relayClient(r *bufio.Reader, up io.Writer) {
	w := bufio.NewWriterSize(up, 64<<10)
	defer w.Flush()
	for {
		h, err := tunnel.ReadMongoHeader(r)
		if err != nil {
			return
		}
		rest := int(h.Len) - 16
		if h.OpCode != tunnel.MongoOpMsg {
			// A driver's legacy handshake on a connection that is already signed in.
			if h.OpCode != tunnel.MongoOpQuery || rest > mongoParseMax {
				return
			}
			b := make([]byte, rest)
			if _, err := io.ReadFull(r, b); err != nil {
				return
			}
			_, _ = w.Write(append(h.Bytes(), b...))
			if w.Flush() != nil {
				return
			}
			continue
		}
		// flags (4), the first section's kind (1) and its document's size (4).
		var pre [9]byte
		if rest < len(pre) {
			return
		}
		if _, err := io.ReadFull(r, pre[:]); err != nil {
			return
		}
		flags := binary.LittleEndian.Uint32(pre[:4])
		docSize := int(binary.LittleEndian.Uint32(pre[5:]))
		head := pre[:]
		var doc []byte
		if pre[4] == 0 && docSize >= 5 && docSize <= mongoParseMax && docSize <= rest-5 {
			d := make([]byte, docSize)
			copy(d, pre[5:9])
			if _, err := io.ReadFull(r, d[4:]); err != nil {
				return
			}
			doc = d
			head = append(append([]byte{}, pre[:5]...), d...)
		}
		if doc != nil {
			name, _, _, _ := tunnel.BSONFirst(doc)
			if why := mongoBlocked(name); why != "" {
				if _, err := io.CopyN(io.Discard, r, int64(rest-len(head))); err != nil {
					return
				}
				f.s.event("Refused " + name)
				if f.out.write(tunnel.MongoMsg(0, h.RequestID, 0, mongoErrDoc(why, 13, "Unauthorized")), true) != nil {
					return
				}
				continue
			}
			if !mongoQuiet(name) && flags&tunnel.MongoMsgMoreToCome == 0 {
				text, db := mongoLogText(doc)
				f.mu.Lock()
				f.calls[h.RequestID] = &mongoCall{text: text, db: db, at: f.now()}
				f.mu.Unlock()
			} else if !mongoQuiet(name) { // no answer comes: log it as it goes
				text, _ := mongoLogText(doc)
				f.s.queries([]queryEvent{{AtMs: f.now().Sub(f.start).Milliseconds(), Kind: "query", Text: text}})
			}
		}
		_, _ = w.Write(h.Bytes())
		_, _ = w.Write(head)
		if _, err := io.CopyN(w, r, int64(rest-len(head))); err != nil {
			return
		}
		if r.Buffered() == 0 {
			if w.Flush() != nil {
				return
			}
		}
	}
}

func (f *mongoFlow) relayServer(r *bufio.Reader) {
	for {
		h, err := tunnel.ReadMongoHeader(r)
		if err != nil {
			_ = f.out.flush()
			return
		}
		rest := int(h.Len) - 16
		var ev *queryEvent
		var more bool
		if h.OpCode == tunnel.MongoOpMsg && rest <= mongoParseMax && rest >= 5 {
			b := make([]byte, rest)
			if _, err := io.ReadFull(r, b); err != nil {
				return
			}
			doc, flags, derr := tunnel.MongoMsgBody(b)
			more = flags&tunnel.MongoMsgMoreToCome != 0
			if derr == nil {
				ev = f.finish(h.ResponseTo, doc, more)
			}
			if f.out.write(append(h.Bytes(), b...), false) != nil {
				return
			}
		} else {
			// Too long to read whole (a big batch of documents): streamed, answered ok.
			if h.OpCode == tunnel.MongoOpMsg {
				var fl [4]byte
				if _, err := io.ReadFull(r, fl[:]); err != nil {
					return
				}
				more = binary.LittleEndian.Uint32(fl[:])&tunnel.MongoMsgMoreToCome != 0
				ev = f.finish(h.ResponseTo, nil, more)
				if f.out.write(append(h.Bytes(), fl[:]...), false) != nil {
					return
				}
				rest -= 4
			}
			if f.out.copyN(r, int64(rest)) != nil {
				return
			}
		}
		if ev != nil {
			f.s.queries([]queryEvent{*ev})
		}
		if r.Buffered() == 0 && f.out.flush() != nil {
			return
		}
	}
}

// finish completes the request an answer belongs to; nil when it is logged
// later (more answers follow) or was not logged at all.
func (f *mongoFlow) finish(responseTo int32, doc []byte, more bool) *queryEvent {
	f.mu.Lock()
	c := f.calls[responseTo]
	if c != nil && !more {
		delete(f.calls, responseTo)
	}
	f.mu.Unlock()
	if c == nil || more {
		return nil
	}
	now := f.now()
	e := &queryEvent{AtMs: c.at.Sub(f.start).Milliseconds(), Kind: "query", Text: c.text, Ms: now.Sub(c.at).Milliseconds(), Db: c.db}
	if doc == nil {
		return e
	}
	if t, v, ok := tunnel.BSONGet(doc, "ok"); ok {
		if n, _ := tunnel.BSONInt(t, v); n == 0 {
			e.Error, e.Code = "the server refused the command", ""
			if t, v, ok := tunnel.BSONGet(doc, "errmsg"); ok && t == tunnel.BSONString {
				e.Error, _ = tunnel.BSONStringValue(v)
				e.Error = clipText(e.Error, 200)
			}
			if t, v, ok := tunnel.BSONGet(doc, "codeName"); ok && t == tunnel.BSONString {
				e.Code, _ = tunnel.BSONStringValue(v)
			}
			return e
		}
	}
	if t, v, ok := tunnel.BSONGet(doc, "writeErrors"); ok && t == tunnel.BSONArray {
		_ = tunnel.BSONEach(v, func(t byte, _ string, v []byte) bool {
			if t == tunnel.BSONDocument {
				if et, ev, ok := tunnel.BSONGet(v, "errmsg"); ok && et == tunnel.BSONString {
					e.Error, _ = tunnel.BSONStringValue(ev)
					e.Error = clipText(e.Error, 200)
				}
			}
			return false
		})
		if e.Error != "" {
			return e
		}
	}
	rows := int64(-1)
	if t, v, ok := tunnel.BSONGet(doc, "n"); ok {
		if n, ok := tunnel.BSONInt(t, v); ok {
			rows = n
		}
	}
	if t, v, ok := tunnel.BSONGet(doc, "cursor"); ok && t == tunnel.BSONDocument {
		for _, k := range []string{"firstBatch", "nextBatch"} {
			if t, b, ok := tunnel.BSONGet(v, k); ok && t == tunnel.BSONArray {
				rows = int64(tunnel.BSONCount(b))
			}
		}
	}
	if rows >= 0 {
		e.Rows = &rows
	}
	return e
}
