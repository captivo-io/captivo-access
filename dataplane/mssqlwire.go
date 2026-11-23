package main

import (
	"encoding/binary"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// The query log of a SQL Server connection (mssqlproxy.go), the same events
// as PostgreSQL's and MySQL's: which statement ran, when, for how long, how
// many rows it touched and whether it failed. A client sends one request at a
// time (MARS is not offered) and the server answers each with one message, so
// the tracker pairs them in turn. Statements come from SQL batches and from
// the statement text of sp_executesql and its relatives; parameter values are
// never kept.

const (
	msRequestKeep = 64 << 10 // the start of a request, enough for the log
	msReplyKeep   = 4 << 10  // the start and the end of a reply
)

// The RPCs that carry statement text, and which parameter holds it.
var msTextParam = map[uint16]int{
	2:  1, // sp_cursoropen (cursor, stmt, ...)
	3:  2, // sp_cursorprepare (handle, params, stmt, ...)
	5:  3, // sp_cursorprepexec (handle, cursor, params, stmt, ...)
	10: 0, // sp_executesql (stmt, params, values...)
	11: 2, // sp_prepare (handle, params, stmt, ...)
	13: 2, // sp_prepexec (handle, params, stmt, values...)
}

// RPCs that only move a cursor or free a statement: not statements of their own.
var msHousekeeping = map[uint16]bool{1: true, 6: true, 7: true, 8: true, 9: true, 15: true}

var msProcNames = map[uint16]string{
	1: "sp_cursor", 2: "sp_cursoropen", 3: "sp_cursorprepare", 4: "sp_cursorexecute", 5: "sp_cursorprepexec",
	6: "sp_cursorunprepare", 7: "sp_cursorfetch", 8: "sp_cursoroption", 9: "sp_cursorclose", 10: "sp_executesql",
	11: "sp_prepare", 12: "sp_execute", 13: "sp_prepexec", 14: "sp_prepexecrpc", 15: "sp_unprepare",
}

type msPending struct {
	text      string
	logged    bool
	at        time.Time
	cancelled bool
	useDB     string
}

type msTracker struct {
	mu      sync.Mutex
	start   time.Time
	db      string
	pending *msPending

	req     []byte // the client's request so far
	reqOver bool
	head    []byte // the start of the server's reply so far
	tail    []byte // its end
	inReply bool
}

func newMsTracker(start time.Time, db string) *msTracker {
	return &msTracker{start: start, db: db}
}

var msUseRE = regexp.MustCompile(`(?i)^\s*use\s+\[?([^\];\s]+)\]?\s*;?\s*$`)

// client sees one packet the client sent.
func (q *msTracker) client(typ, status byte, payload []byte, now time.Time) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if typ == tunnel.TDSAttention {
		if q.pending != nil {
			q.pending.cancelled = true
		}
		return
	}
	if room := msRequestKeep - len(q.req); room > 0 {
		q.req = append(q.req, payload[:min(len(payload), room)]...)
	} else {
		q.reqOver = true
	}
	if status&tunnel.TDSStatusEOM == 0 {
		return
	}
	req, over := q.req, q.reqOver
	q.req, q.reqOver = nil, false
	p := &msPending{at: now}
	switch typ {
	case tunnel.TDSBatch:
		p.text, p.logged = msBatchText(req), true
		if m := msUseRE.FindStringSubmatch(p.text); m != nil {
			p.useDB = m[1]
		}
	case tunnel.TDSRPC:
		p.text, p.logged = msRPCText(req, over)
	case tunnel.TDSTransMgr:
		p.text, p.logged = msTransText(req)
	case tunnel.TDSBulk:
		p.text, p.logged = "(bulk load data: rows not logged)", true
	default:
		return
	}
	q.pending = p
}

// server sees one packet of the server's reply; at its end it returns the
// event for the request it answered.
func (q *msTracker) server(status byte, payload []byte, now time.Time) []queryEvent {
	q.mu.Lock()
	defer q.mu.Unlock()
	if !q.inReply {
		q.head, q.tail, q.inReply = nil, nil, true
	}
	if room := msReplyKeep - len(q.head); room > 0 {
		q.head = append(q.head, payload[:min(len(payload), room)]...)
	}
	q.tail = append(q.tail, payload...)
	if len(q.tail) > msReplyKeep {
		q.tail = append([]byte(nil), q.tail[len(q.tail)-msReplyKeep:]...)
	}
	if status&tunnel.TDSStatusEOM == 0 {
		return nil
	}
	q.inReply = false
	p := q.pending
	q.pending = nil
	if p == nil || !p.logged {
		return nil
	}
	e := queryEvent{AtMs: p.at.Sub(q.start).Milliseconds(), Kind: "query", Text: maskQuery(p.text), Ms: now.Sub(p.at).Milliseconds(), Db: q.db}
	done, rows, ok := msFinalDone(q.tail)
	failed := ok && done&(tunnel.DoneError|tunnel.DoneServerError) != 0
	switch {
	case p.cancelled || (ok && done&tunnel.DoneAttn != 0):
		e.Error = "cancelled"
	case failed:
		e.Error = "the statement failed"
		if se, found := msFindError(q.head); found {
			e.Error, e.Code = se.Msg, msCode(se.Number)
		} else if se, found := msFindError(q.tail); found {
			e.Error, e.Code = se.Msg, msCode(se.Number)
		}
	case ok && done&tunnel.DoneCount != 0:
		n := int64(rows)
		e.Rows = &n
	}
	if e.Error == "" && p.useDB != "" {
		q.db = p.useDB
	}
	return []queryEvent{e}
}

func msCode(n uint32) string { return strconv.FormatUint(uint64(n), 10) }

// msFinalDone reads the DONE token a reply ends with. A procedure's reply
// (sp_executesql and the like) ends with DONEPROC, which counts nothing; the
// rows are in the DONEINPROC before it (and its RETURNSTATUS).
func msFinalDone(tail []byte) (status uint16, rows uint64, ok bool) {
	done := func(at int) (uint16, uint64, bool) {
		if at < 0 || at+13 > len(tail) {
			return 0, 0, false
		}
		d := tail[at:]
		if d[0] != tunnel.TokenDone && d[0] != tunnel.TokenDoneProc && d[0] != tunnel.TokenDoneInProc {
			return 0, 0, false
		}
		return binary.LittleEndian.Uint16(d[1:]), binary.LittleEndian.Uint64(d[5:]), true
	}
	at := len(tail) - 13
	status, rows, ok = done(at)
	if !ok || tail[at] != tunnel.TokenDoneProc || status&tunnel.DoneCount != 0 {
		return status, rows, ok
	}
	if at >= 5 && tail[at-5] == 0x79 { // RETURNSTATUS
		at -= 5
	}
	if inner, n, found := done(at - 13); found && inner&tunnel.DoneCount != 0 {
		return status | tunnel.DoneCount, n, true
	}
	return status, rows, ok
}

// msFindError finds the first ERROR token in a piece of a reply. Rows can hold
// any bytes, so a candidate counts only when its lengths add up exactly.
func msFindError(b []byte) (tunnel.TDSServerError, bool) {
	for i := 0; i+3 < len(b); i++ {
		if b[i] != tunnel.TokenError {
			continue
		}
		n := int(binary.LittleEndian.Uint16(b[i+1:]))
		if n < 15 || i+3+n > len(b) {
			continue
		}
		body := b[i+3 : i+3+n]
		e, ok := tunnel.ParseErrorToken(body)
		if !ok || e.Class < 11 {
			continue
		}
		at := 8 + 2*int(binary.LittleEndian.Uint16(body[6:]))
		if at >= len(body) {
			continue
		}
		at += 1 + 2*int(body[at]) // server name
		if at >= len(body) {
			continue
		}
		at += 1 + 2*int(body[at]) // procedure name
		if at+4 == len(body) {
			return e, true
		}
	}
	return tunnel.TDSServerError{}, false
}

// msSkipHeaders skips a request's ALL_HEADERS (TDS 7.2 and later).
func msSkipHeaders(b []byte) []byte {
	if len(b) < 4 {
		return b
	}
	total := int(binary.LittleEndian.Uint32(b))
	if total < 4 || total > len(b) || total > 1024 {
		return b
	}
	return b[total:]
}

func msBatchText(b []byte) string {
	b = msSkipHeaders(b)
	return strings.TrimSpace(tunnel.FromUCS2(b[:len(b)&^1]))
}

// msRPCText names an RPC for the log: the statement it runs when it carries
// one, else EXEC and its name.
func msRPCText(b []byte, cut bool) (string, bool) {
	b = msSkipHeaders(b)
	if len(b) < 4 {
		return "", false
	}
	var id uint16
	name := ""
	if n := binary.LittleEndian.Uint16(b); n == 0xFFFF {
		id = binary.LittleEndian.Uint16(b[2:])
		name = msProcNames[id]
		b = b[4:]
	} else {
		if 2+2*int(n) > len(b) {
			return "", false
		}
		name = tunnel.FromUCS2(b[2 : 2+2*int(n)])
		b = b[2+2*int(n):]
	}
	if msHousekeeping[id] {
		return "", false
	}
	if name == "" {
		name = "a system procedure"
	}
	want, carries := msTextParam[id]
	if !carries {
		if id == 4 || id == 12 {
			return "EXEC " + name + " (a prepared statement)", true
		}
		return "EXEC " + name, true
	}
	if len(b) < 2 {
		return "EXEC " + name, true
	}
	b = b[2:] // option flags
	for i := 0; ; i++ {
		text, rest, ok := msParam(b)
		if !ok {
			break
		}
		if i == want {
			if text == nil {
				break
			}
			return strings.TrimSpace(*text), true
		}
		b = rest
	}
	if cut {
		return "EXEC " + name + " (statement too long to log)", true
	}
	return "EXEC " + name, true
}

// msParam reads one RPC parameter: its value when it is a string, and what
// follows it. Types it can't step over end the walk.
func msParam(b []byte) (*string, []byte, bool) {
	if len(b) < 1 {
		return nil, nil, false
	}
	nl := int(b[0])
	if 1+2*nl+2 > len(b) {
		return nil, nil, false
	}
	b = b[1+2*nl+1:] // name, status flags
	typ := b[0]
	b = b[1:]
	switch typ {
	case 0x26, 0x68, 0x6D, 0x6E, 0x6F, 0x24: // INTN, BITN, FLTN, MONEYN, DATETIMN, GUID
		if len(b) < 2 || 2+int(b[1]) > len(b) {
			return nil, nil, false
		}
		return nil, b[2+int(b[1]):], true
	case 0x30, 0x32: // INT1, BIT
		return msFixed(b, 1)
	case 0x34: // INT2
		return msFixed(b, 2)
	case 0x38: // INT4
		return msFixed(b, 4)
	case 0x7F: // INT8
		return msFixed(b, 8)
	case 0xE7, 0xEF, 0xA7, 0xAF, 0xA5, 0xAD: // NVARCHAR, NCHAR, VARCHAR, CHAR, VARBINARY, BINARY
		if len(b) < 2 {
			return nil, nil, false
		}
		max := binary.LittleEndian.Uint16(b)
		b = b[2:]
		if typ != 0xA5 && typ != 0xAD {
			if len(b) < 5 {
				return nil, nil, false
			}
			b = b[5:] // collation
		}
		var v []byte
		if max == 0xFFFF { // PLP: total length, then chunks up to a zero one
			if len(b) < 8 {
				return nil, nil, false
			}
			if binary.LittleEndian.Uint64(b) == ^uint64(0) {
				return nil, b[8:], true // NULL
			}
			b = b[8:]
			for {
				if len(b) < 4 {
					return nil, nil, false
				}
				n := int(binary.LittleEndian.Uint32(b))
				b = b[4:]
				if n == 0 {
					break
				}
				if n > len(b) {
					return nil, nil, false
				}
				v = append(v, b[:n]...)
				b = b[n:]
			}
		} else {
			if len(b) < 2 {
				return nil, nil, false
			}
			n := binary.LittleEndian.Uint16(b)
			b = b[2:]
			if n == 0xFFFF {
				return nil, b, true // NULL
			}
			if int(n) > len(b) {
				return nil, nil, false
			}
			v, b = b[:n], b[n:]
		}
		var s string
		switch typ {
		case 0xE7, 0xEF:
			s = tunnel.FromUCS2(v[:len(v)&^1])
		case 0xA7, 0xAF:
			s = string(v)
		default:
			return nil, b, true
		}
		return &s, b, true
	}
	return nil, nil, false
}

func msFixed(b []byte, n int) (*string, []byte, bool) {
	if len(b) < n {
		return nil, nil, false
	}
	return nil, b[n:], true
}

// msTransText names a transaction manager request.
func msTransText(b []byte) (string, bool) {
	b = msSkipHeaders(b)
	if len(b) < 2 {
		return "", false
	}
	switch binary.LittleEndian.Uint16(b) {
	case 5:
		return "BEGIN TRANSACTION", true
	case 7:
		return "COMMIT TRANSACTION", true
	case 8:
		return "ROLLBACK TRANSACTION", true
	case 9:
		return "SAVE TRANSACTION", true
	}
	return "", false
}
