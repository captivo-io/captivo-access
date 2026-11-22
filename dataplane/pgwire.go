package main

import (
	"encoding/binary"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// PostgreSQL wire protocol pieces for the database proxy (pgproxy.go), and the
// query log it keeps: which statement ran, when, for how long, how many rows
// it touched and whether it failed. Rows and bind parameters are never kept;
// they are the customer's data.

const (
	pgSSLRequest    = 80877103
	pgGSSENCRequest = 80877104
	pgCancelRequest = 80877102
	pgProtocol3     = 3
	queryTextMax    = 16 << 10
)

// queryEvent is one statement in the log. It is stored with the keystroke
// timeline's events ("keys" chunks on the connector), so the connector's
// recording search finds queries by their text the same way.
type queryEvent struct {
	AtMs   int64  `json:"atMs"`
	Kind   string `json:"kind"` // "query" | "session"
	Text   string `json:"text"`
	Masked bool   `json:"masked"`
	Ms     int64  `json:"ms"`
	Rows   *int64 `json:"rows,omitempty"`
	Error  string `json:"error,omitempty"`
	Code   string `json:"code,omitempty"`
	Db     string `json:"db,omitempty"`
}

type pendingQuery struct {
	text      string
	at        time.Time
	simple    bool          // a Query message: complete at ReadyForQuery
	cont      *pendingQuery // more rows of a suspended portal: counted into that statement
	portal    string
	rows      int64 // from the CommandComplete tags
	counted   bool
	dataRows  int64 // DataRow messages, for a fetch the tags don't total
	err, code string
}

// queryTracker pairs the client's statements with the server's answers. The
// server answers in the order the client sent, so a queue is enough, even
// for pipelined clients (pgjdbc, psycopg 3).
type queryTracker struct {
	mu        sync.Mutex
	start     time.Time
	db        string
	stmts     map[string]string        // prepared statement -> text
	portals   map[string]string        // portal -> statement
	suspended map[string]*pendingQuery // portals that returned PortalSuspended -> their statement
	pending   []*pendingQuery
}

func newQueryTracker(start time.Time, db string) *queryTracker {
	return &queryTracker{start: start, db: db, stmts: map[string]string{}, portals: map[string]string{}, suspended: map[string]*pendingQuery{}}
}

// cstr reads one NUL-terminated string.
func cstr(b []byte) (string, []byte) {
	for i, c := range b {
		if c == 0 {
			return string(b[:i]), b[i+1:]
		}
	}
	return string(b), nil
}

// client sees one frontend message. body may be cut short (a huge statement):
// only its beginning is needed.
func (q *queryTracker) client(t byte, body []byte, now time.Time) {
	q.mu.Lock()
	defer q.mu.Unlock()
	switch t {
	case 'Q':
		text, _ := cstr(body)
		q.pending = append(q.pending, &pendingQuery{text: text, at: now, simple: true})
	case 'P':
		name, rest := cstr(body)
		text, _ := cstr(rest)
		q.stmts[name] = text
	case 'B':
		portal, rest := cstr(body)
		stmt, _ := cstr(rest)
		q.portals[portal] = stmt
		delete(q.suspended, portal)
	case 'E':
		portal, _ := cstr(body)
		q.pending = append(q.pending, &pendingQuery{text: q.stmts[q.portals[portal]], at: now, portal: portal, cont: q.suspended[portal]})
		delete(q.suspended, portal)
	case 'C':
		if len(body) > 1 {
			name, _ := cstr(body[1:])
			if body[0] == 'S' {
				delete(q.stmts, name)
			} else {
				delete(q.portals, name)
			}
		}
	}
}

// server sees one backend message and returns the statements it completes.
func (q *queryTracker) server(t byte, body []byte, now time.Time) []queryEvent {
	q.mu.Lock()
	defer q.mu.Unlock()
	var out []queryEvent
	head := func() *pendingQuery {
		if len(q.pending) == 0 {
			return nil
		}
		return q.pending[0]
	}
	// pop completes the head; more rows of a suspended portal complete the
	// statement they belong to.
	pop := func(p *pendingQuery) {
		q.pending = q.pending[1:]
		if p.cont != nil {
			c := p.cont
			c.rows, c.counted, c.dataRows = c.rows+p.rows, c.counted || p.counted, c.dataRows+p.dataRows
			if p.err != "" {
				c.err, c.code = p.err, p.code
			}
			p = c
		}
		out = append(out, q.event(p, now))
	}
	switch t {
	case 'D': // DataRow
		if p := head(); p != nil {
			p.dataRows++
		}
	case 'C': // CommandComplete
		if p := head(); p != nil {
			tag, _ := cstr(body)
			if n, ok := tagRows(tag); ok {
				p.rows += n
				p.counted = true
			}
			if !p.simple {
				pop(p)
			}
		}
	case 'I': // EmptyQueryResponse
		if p := head(); p != nil && !p.simple {
			pop(p)
		}
	case 's': // PortalSuspended: the client fetches the rest in pieces
		if p := head(); p != nil && !p.simple {
			q.pending = q.pending[1:]
			if p.cont != nil {
				c := p.cont
				c.dataRows += p.dataRows
				p = c
			}
			q.suspended[p.portal] = p
		}
	case 'E': // ErrorResponse
		code, msg := pgErrorFields(body)
		if p := head(); p != nil {
			p.err, p.code = msg, code
			if !p.simple {
				pop(p)
				// The server skips the rest of the batch until Sync.
				q.pending = keepSimple(q.pending)
			}
		}
	case 'Z': // ReadyForQuery
		for _, p := range q.pending {
			if p.simple {
				out = append(out, q.event(p, now))
				break
			}
		}
		q.pending = nil
	}
	return out
}

func keepSimple(ps []*pendingQuery) []*pendingQuery {
	var out []*pendingQuery
	for _, p := range ps {
		if p.simple {
			out = append(out, p)
		}
	}
	return out
}

func (q *queryTracker) event(p *pendingQuery, now time.Time) queryEvent {
	e := queryEvent{
		AtMs: p.at.Sub(q.start).Milliseconds(), Kind: "query", Text: maskQuery(p.text),
		Ms: now.Sub(p.at).Milliseconds(), Error: p.err, Code: p.code, Db: q.db,
	}
	if p.counted {
		n := p.rows
		if p.dataRows > n {
			n = p.dataRows // a fetch in pieces: the last tag counts only its piece
		}
		e.Rows = &n
	} else if p.dataRows > 0 {
		n := p.dataRows
		e.Rows = &n
	}
	return e
}

// tagRows reads the row count from a CommandComplete tag: "SELECT 5",
// "INSERT 0 1", "UPDATE 3", "COPY 10".
func tagRows(tag string) (int64, bool) {
	f := strings.Fields(tag)
	if len(f) < 2 {
		return 0, false
	}
	switch f[0] {
	case "SELECT", "INSERT", "UPDATE", "DELETE", "MERGE", "COPY", "FETCH", "MOVE":
		n, err := strconv.ParseInt(f[len(f)-1], 10, 64)
		return n, err == nil
	}
	return 0, false
}

func pgErrorFields(body []byte) (code, msg string) {
	for len(body) > 1 {
		f := body[0]
		v, rest := cstr(body[1:])
		switch f {
		case 'C':
			code = v
		case 'M':
			msg = v
		}
		body = rest
	}
	return code, msg
}

var passwordLiteral = regexp.MustCompile(`(?i)(password\s*=?\s*)('(?:[^']|'')*'|\$[A-Za-z0-9_]*\$.*?\$[A-Za-z0-9_]*\$)`)

// maskQuery hides password literals (CREATE ROLE ... PASSWORD '...', psql's
// \password) and cuts very long statements.
func maskQuery(s string) string {
	s = passwordLiteral.ReplaceAllString(s, "$1'***'")
	if len(s) > queryTextMax {
		cut := queryTextMax
		for cut > 0 && s[cut]&0xC0 == 0x80 {
			cut-- // not inside a UTF-8 sequence
		}
		s = s[:cut] + " …"
	}
	return s
}

// pgMsg frames one backend message.
func pgMsg(t byte, body []byte) []byte {
	out := append([]byte{t}, binary.BigEndian.AppendUint32(nil, uint32(len(body)+4))...)
	return append(out, body...)
}

// pgFatal is an ErrorResponse that ends the connection.
func pgFatal(code, msg string) []byte {
	var b []byte
	for _, f := range [][2]string{{"S", "FATAL"}, {"V", "FATAL"}, {"C", code}, {"M", msg}} {
		b = append(b, f[0][0])
		b = append(b, f[1]...)
		b = append(b, 0)
	}
	return pgMsg('E', append(b, 0))
}

// pgStartupParams reads a StartupMessage's parameters (after the version).
func pgStartupParams(b []byte) map[string]string {
	out := map[string]string{}
	for len(b) > 0 && b[0] != 0 {
		var k, v string
		k, b = cstr(b)
		v, b = cstr(b)
		out[k] = v
	}
	return out
}
