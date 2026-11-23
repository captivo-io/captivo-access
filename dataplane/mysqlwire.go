package main

import (
	"encoding/binary"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// MySQL wire protocol pieces for the database proxy (mysqlproxy.go), and the
// query log it keeps, the same events as PostgreSQL's (pgwire.go): which
// statement ran, when, for how long, how many rows it touched and whether it
// failed. Rows and statement parameters are never kept.

const (
	myComQuit         = 0x01
	myComInitDB       = 0x02
	myComQuery        = 0x03
	myComFieldList    = 0x04
	myComStatistics   = 0x09
	myComProcessInfo  = 0x0a
	myComChangeUser   = 0x11
	myComStmtPrepare  = 0x16
	myComStmtExecute  = 0x17
	myComStmtLongData = 0x18
	myComStmtClose    = 0x19
	myComStmtFetch    = 0x1c

	myMoreResults   = 0x0008 // SERVER_MORE_RESULTS_EXISTS
	myCursorExists  = 0x0040 // SERVER_STATUS_CURSOR_EXISTS
	myMaxPayload    = 0xffffff
	myStatusAutoCmt = 0x0002
)

// What the server's answer to a command looks like.
const (
	myAnsResult  = iota // OK, ERR, or result sets
	myAnsPrepare        // COM_STMT_PREPARE_OK and its definitions, or ERR
	myAnsRows           // rows up to EOF (COM_STMT_FETCH), or ERR
	myAnsDefs           // definitions up to EOF (COM_FIELD_LIST), or ERR
	myAnsOne            // one packet (OK, ERR, EOF, or COM_STATISTICS's string)
)

type myPending struct {
	ans       int
	text      string
	logged    bool // a statement for the log
	at        time.Time
	rows      int64
	counted   bool
	err, code string
	useDB     string // a USE that takes effect on success

	// Where in the answer the tracker is.
	state    int // 0 first packet, 1 definitions, 2 rows
	left     int // definitions still to come (then an EOF)
	nextDefs int // prepare: column definitions after the parameters'
}

// myTracker pairs a MySQL client's commands with the server's answers. A
// connection runs one command at a time, so a queue is plenty; a tracker
// that loses its place stops logging rather than guessing.
type myTracker struct {
	mu      sync.Mutex
	start   time.Time
	db      string
	stmts   map[uint32]string // prepared statement -> text
	pending []*myPending
	lost    bool
}

func newMyTracker(start time.Time, db string) *myTracker {
	return &myTracker{start: start, db: db, stmts: map[uint32]string{}}
}

var myUseRE = regexp.MustCompile("(?i)^\\s*use\\s+`?([^`;\\s]+)`?\\s*;?\\s*$")

// client sees the start of one command packet.
func (q *myTracker) client(body []byte, now time.Time) {
	if len(body) == 0 {
		return
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.lost {
		return
	}
	p := &myPending{at: now}
	switch body[0] {
	case myComQuery:
		p.ans, p.text, p.logged = myAnsResult, string(body[1:]), true
		if m := myUseRE.FindStringSubmatch(p.text); m != nil {
			p.useDB = m[1]
		}
	case myComStmtPrepare:
		p.ans, p.text = myAnsPrepare, string(body[1:])
	case myComStmtExecute:
		p.ans, p.logged = myAnsResult, true
		if len(body) >= 5 {
			p.text = q.stmts[binary.LittleEndian.Uint32(body[1:5])]
		}
	case myComStmtFetch:
		p.ans = myAnsRows
	case myComFieldList:
		p.ans = myAnsDefs
	case myComProcessInfo:
		p.ans = myAnsResult
	case myComInitDB:
		p.ans, p.useDB = myAnsOne, string(body[1:])
	case myComStmtClose:
		if len(body) >= 5 {
			delete(q.stmts, binary.LittleEndian.Uint32(body[1:5]))
		}
		return // no answer
	case myComStmtLongData, myComQuit:
		return
	case myComStatistics, 0x0c /* PROCESS_KILL */, 0x0d /* DEBUG */, 0x0e /* PING */, 0x07 /* REFRESH */, 0x1a /* STMT_RESET */, 0x1b /* SET_OPTION */, 0x1f /* RESET_CONNECTION */ :
		p.ans = myAnsOne
	default:
		// A command whose answer this tracker can't follow (replication, ...).
		q.lost, q.pending = true, nil
		return
	}
	q.pending = append(q.pending, p)
}

// lenenc reads a length-encoded integer.
func lenenc(b []byte) (uint64, int) {
	if len(b) == 0 {
		return 0, 0
	}
	switch c := b[0]; {
	case c < 0xfb:
		return uint64(c), 1
	case c == 0xfc && len(b) >= 3:
		return uint64(binary.LittleEndian.Uint16(b[1:])), 3
	case c == 0xfd && len(b) >= 4:
		return uint64(b[1]) | uint64(b[2])<<8 | uint64(b[3])<<16, 4
	case c == 0xfe && len(b) >= 9:
		return binary.LittleEndian.Uint64(b[1:]), 9
	}
	return 0, 0
}

// myOKStatus reads an OK packet's affected rows and status flags.
func myOKStatus(b []byte) (int64, uint16) {
	rows, n := lenenc(b[1:])
	if n == 0 {
		return 0, 0
	}
	_, m := lenenc(b[1+n:])
	at := 1 + n + m
	if m == 0 || len(b) < at+2 {
		return int64(rows), 0
	}
	return int64(rows), binary.LittleEndian.Uint16(b[at:])
}

// myErrFields reads an ERR packet's number, SQL state and message.
func myErrFields(b []byte) (code, msg string) {
	if len(b) < 3 {
		return "", ""
	}
	code = strconv.Itoa(int(binary.LittleEndian.Uint16(b[1:3])))
	rest := b[3:]
	if len(rest) >= 6 && rest[0] == '#' {
		code += " " + string(rest[1:6])
		rest = rest[6:]
	}
	return code, string(rest)
}

// isEOF: an EOF packet (a result set's terminator). A row can start with
// 0xfe too, but then it is at least nine bytes long.
func isEOF(head []byte, n int) bool { return len(head) > 0 && head[0] == 0xfe && n < 9 }

// server sees the start (head) of one answer packet n bytes long, and
// returns the statements it completes.
func (q *myTracker) server(head []byte, n int, now time.Time) []queryEvent {
	if len(head) == 0 {
		return nil
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.lost || len(q.pending) == 0 {
		return nil
	}
	p := q.pending[0]
	done := func() []queryEvent {
		q.pending = q.pending[1:]
		if p.err == "" && p.useDB != "" {
			q.db = p.useDB
		}
		if !p.logged {
			return nil
		}
		return []queryEvent{q.event(p, now)}
	}
	fail := func() []queryEvent {
		p.code, p.err = myErrFields(head)
		return done()
	}
	switch p.ans {
	case myAnsOne:
		if head[0] == 0xff {
			return fail()
		}
		return done()
	case myAnsPrepare:
		switch p.state {
		case 0:
			if head[0] == 0xff {
				p.logged = true // it never runs: the log shows the failure
				return fail()
			}
			if head[0] != 0 || len(head) < 9 {
				q.lost, q.pending = true, nil
				return nil
			}
			q.stmts[binary.LittleEndian.Uint32(head[1:5])] = p.text
			cols, params := int(binary.LittleEndian.Uint16(head[5:7])), int(binary.LittleEndian.Uint16(head[7:9]))
			p.left, p.nextDefs, p.state = params, cols, 1
			if p.left == 0 {
				p.left, p.nextDefs = p.nextDefs, 0
			}
			if p.left == 0 {
				return done()
			}
		case 1:
			if p.left > 0 {
				p.left--
				return nil
			}
			// The EOF after a block of definitions.
			if p.nextDefs > 0 {
				p.left, p.nextDefs = p.nextDefs, 0
				return nil
			}
			return done()
		}
		return nil
	case myAnsDefs:
		if head[0] == 0xff {
			return fail()
		}
		if isEOF(head, n) {
			return done()
		}
		return nil
	case myAnsRows:
		if head[0] == 0xff {
			return fail()
		}
		if isEOF(head, n) {
			return done()
		}
		return nil
	}
	// A statement's answer: OK, ERR, or result sets.
	switch p.state {
	case 0:
		switch head[0] {
		case 0x00:
			rows, status := myOKStatus(head)
			p.rows += rows
			p.counted = true
			if status&myMoreResults != 0 {
				return nil
			}
			return done()
		case 0xff:
			return fail()
		case 0xfb: // LOCAL INFILE: not offered to clients, so not followed
			q.lost, q.pending = true, nil
			return nil
		}
		cols, k := lenenc(head)
		if k == 0 || cols == 0 {
			q.lost, q.pending = true, nil
			return nil
		}
		p.state, p.left = 1, int(cols)
	case 1:
		if p.left > 0 {
			p.left--
			return nil
		}
		// The EOF after the column definitions.
		if len(head) >= 5 && binary.LittleEndian.Uint16(head[3:5])&myCursorExists != 0 {
			p.counted = true
			return done() // a cursor: the rows come with COM_STMT_FETCH
		}
		p.state = 2
	case 2:
		if head[0] == 0xff {
			return fail()
		}
		if isEOF(head, n) {
			p.counted = true
			if len(head) >= 5 && binary.LittleEndian.Uint16(head[3:5])&myMoreResults != 0 {
				p.state = 0
				return nil
			}
			return done()
		}
		p.rows++
	}
	return nil
}

func (q *myTracker) event(p *myPending, now time.Time) queryEvent {
	e := queryEvent{
		AtMs: p.at.Sub(q.start).Milliseconds(), Kind: "query", Text: maskQuery(p.text),
		Ms: now.Sub(p.at).Milliseconds(), Error: p.err, Code: p.code, Db: q.db,
	}
	if p.counted && p.err == "" {
		n := p.rows
		e.Rows = &n
	}
	return e
}

// myPacket frames one packet.
func myPacket(seq byte, body []byte) []byte {
	n := len(body)
	return append([]byte{byte(n), byte(n >> 8), byte(n >> 16), seq}, body...)
}

// myErr is an ERR packet.
func myErr(seq byte, number uint16, state, msg string) []byte {
	b := binary.LittleEndian.AppendUint16([]byte{0xff}, number)
	b = append(append(append(b, '#'), state...), msg...)
	return myPacket(seq, b)
}

// myOK is an OK packet with nothing to report.
func myOK(seq byte) []byte {
	b := []byte{0, 0, 0}
	b = binary.LittleEndian.AppendUint16(b, myStatusAutoCmt)
	return myPacket(seq, append(b, 0, 0))
}

// myKillRE matches the statement a client sends to stop a running query
// (the mysql client's Ctrl-C): the connection id is the one this proxy gave.
var myKillRE = regexp.MustCompile(`(?i)^(\s*kill\s+(?:query\s+|connection\s+)?)(\d+)(\s*;?\s*)$`)

// myKillTarget returns the id a KILL statement names.
func myKillTarget(stmt string) (uint32, bool) {
	m := myKillRE.FindStringSubmatch(stmt)
	if m == nil {
		return 0, false
	}
	n, err := strconv.ParseUint(m[2], 10, 32)
	return uint32(n), err == nil
}

// myKillRewrite puts the server's connection id in a KILL statement.
func myKillRewrite(stmt string, real uint32) string {
	m := myKillRE.FindStringSubmatch(stmt)
	if m == nil {
		return stmt
	}
	return m[1] + strconv.FormatUint(uint64(real), 10) + strings.TrimRight(m[3], " ")
}
