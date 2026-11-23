package main

import (
	"encoding/binary"
	"strings"
	"testing"
	"time"
)

func myCom(cmd byte, rest string) []byte { return append([]byte{cmd}, rest...) }

// feed hands the tracker whole server packets.
func feed(tr *myTracker, pkts ...[]byte) []queryEvent {
	var out []queryEvent
	for _, p := range pkts {
		out = append(out, tr.server(p, len(p), time.Now())...)
	}
	return out
}

var (
	myColDef  = []byte("\x03def\x00\x00\x00\x01a\x00\x0c\x3f\x00\x01\x00\x00\x00\x08\x81\x00\x00\x00\x00")
	myEOF     = []byte{0xfe, 0, 0, 0x02, 0}
	myEOFMore = []byte{0xfe, 0, 0, 0x0a, 0}
)

func TestMyTrackerResultSetCountsRows(t *testing.T) {
	tr := newMyTracker(time.Now(), "crm")
	tr.client(myCom(myComQuery, "select a from t"), time.Now())
	evs := feed(tr, []byte{1}, myColDef, myEOF, []byte("\x011"), []byte("\x012"), []byte("\xfe"+strings.Repeat("x", 20)), myEOF)
	if len(evs) != 1 || evs[0].Text != "select a from t" || evs[0].Rows == nil || *evs[0].Rows != 3 || evs[0].Db != "crm" {
		t.Fatalf("got %+v", evs)
	}
}

func TestMyTrackerOKErrAndUse(t *testing.T) {
	tr := newMyTracker(time.Now(), "")
	tr.client(myCom(myComQuery, "update t set a=1"), time.Now())
	evs := feed(tr, []byte{0, 7, 0, 2, 0, 0, 0})
	if len(evs) != 1 || *evs[0].Rows != 7 {
		t.Fatalf("got %+v", evs)
	}
	tr.client(myCom(myComQuery, "selec 1"), time.Now())
	evs = feed(tr, append([]byte{0xff, 0x28, 0x04}, "#42000You have an error in your SQL syntax"...))
	if len(evs) != 1 || evs[0].Code != "1064 42000" || !strings.Contains(evs[0].Error, "SQL syntax") || evs[0].Rows != nil {
		t.Fatalf("got %+v", evs)
	}
	tr.client(myCom(myComQuery, "USE `billing`;"), time.Now())
	feed(tr, []byte{0, 0, 0, 2, 0, 0, 0})
	tr.client(myCom(myComInitDB, "hr"), time.Now())
	if evs := feed(tr, []byte{0, 0, 0, 2, 0, 0, 0}); len(evs) != 0 {
		t.Fatalf("COM_INIT_DB logged: %+v", evs)
	}
	tr.client(myCom(myComQuery, "select 1"), time.Now())
	evs = feed(tr, []byte{1}, myColDef, myEOF, []byte("\x011"), myEOF)
	if evs[0].Db != "hr" {
		t.Fatalf("db %q, want hr after USE billing and COM_INIT_DB hr", evs[0].Db)
	}
}

func TestMyTrackerMultipleResults(t *testing.T) {
	tr := newMyTracker(time.Now(), "")
	tr.client(myCom(myComQuery, "call p()"), time.Now())
	evs := feed(tr, []byte{1}, myColDef, myEOF, []byte("\x011"), myEOFMore, []byte{1}, myColDef, myEOF, []byte("\x012"), []byte("\x013"), myEOFMore)
	if len(evs) != 0 {
		t.Fatalf("ended early: %+v", evs)
	}
	evs = feed(tr, []byte{0, 0, 0, 2, 0, 0, 0})
	if len(evs) != 1 || *evs[0].Rows != 3 {
		t.Fatalf("got %+v", evs)
	}
}

func TestMyTrackerPreparedStatement(t *testing.T) {
	tr := newMyTracker(time.Now(), "")
	tr.client(myCom(myComStmtPrepare, "select a from t where id = ?"), time.Now())
	ok := []byte{0}
	ok = binary.LittleEndian.AppendUint32(ok, 9)
	ok = binary.LittleEndian.AppendUint16(ok, 1) // columns
	ok = binary.LittleEndian.AppendUint16(ok, 1) // params
	ok = append(ok, 0, 0, 0)
	if evs := feed(tr, ok, myColDef, myEOF, myColDef, myEOF); len(evs) != 0 {
		t.Fatalf("a prepare was logged: %+v", evs)
	}
	exec := binary.LittleEndian.AppendUint32([]byte{myComStmtExecute}, 9)
	tr.client(append(exec, 0, 1, 0, 0, 0), time.Now())
	evs := feed(tr, []byte{1}, myColDef, myEOF, []byte{0, 0, 1}, myEOF)
	if len(evs) != 1 || evs[0].Text != "select a from t where id = ?" || *evs[0].Rows != 1 {
		t.Fatalf("got %+v", evs)
	}
	// A prepare that fails never runs: its error is logged.
	tr.client(myCom(myComStmtPrepare, "selec ?"), time.Now())
	evs = feed(tr, append([]byte{0xff, 0x28, 0x04}, "#42000syntax"...))
	if len(evs) != 1 || evs[0].Error != "syntax" {
		t.Fatalf("got %+v", evs)
	}
	tr.client(binary.LittleEndian.AppendUint32([]byte{myComStmtClose}, 9), time.Now())
	tr.client(myCom(0x0e, ""), time.Now()) // ping
	if evs := feed(tr, []byte{0, 0, 0, 2, 0, 0, 0}); len(evs) != 0 || len(tr.pending) != 0 {
		t.Fatalf("ping: %+v, %d pending", evs, len(tr.pending))
	}
}

func TestMyTrackerGivesUpOnUnknownCommands(t *testing.T) {
	tr := newMyTracker(time.Now(), "")
	tr.client(myCom(0x12, "binlog"), time.Now())
	tr.client(myCom(myComQuery, "select 1"), time.Now())
	if evs := feed(tr, []byte{0, 0, 0, 2, 0, 0, 0}); len(evs) != 0 {
		t.Fatalf("a lost tracker logged %+v", evs)
	}
}

func TestMyKill(t *testing.T) {
	if id, ok := myKillTarget("KILL QUERY 1234567890"); !ok || id != 1234567890 {
		t.Fatal(id, ok)
	}
	if _, ok := myKillTarget("select 1"); ok {
		t.Fatal("not a kill")
	}
	if got := myKillRewrite("kill query 1234567890;", 77); got != "kill query 77;" {
		t.Fatalf("got %q", got)
	}
	if got := myKillRewrite("KILL 1234567890", 77); got != "KILL 77" {
		t.Fatalf("got %q", got)
	}
}

func TestMaskQueryMySQL(t *testing.T) {
	for _, q := range []string{
		"CREATE USER 'app'@'%' IDENTIFIED BY 'hunter2'",
		"alter user app identified with caching_sha2_password by \"hunter2\"",
		"SET PASSWORD FOR app = 'hunter2'",
		"select PASSWORD('hunter2')",
		"CREATE USER x IDENTIFIED BY 'a\\'hunter2'",
	} {
		if got := maskQuery(q); strings.Contains(got, "hunter2") {
			t.Fatalf("%q -> %q", q, got)
		}
	}
}

func TestParseMyHello(t *testing.T) {
	b := binary.LittleEndian.AppendUint32(nil, myCapProtocol41|myCapSecureConn|myCapConnectWithDB|myCapPluginAuth|myCapConnectAttrs|myCapAuthLenenc)
	b = binary.LittleEndian.AppendUint32(b, 1<<24)
	b = append(b, 255)
	b = append(b, make([]byte, 23)...)
	b = append(append(b, "ticket123"...), 0)
	b = append(b, 0) // empty auth answer (lenenc)
	b = append(append(b, "crm"...), 0)
	b = append(append(b, "caching_sha2_password"...), 0)
	attrs := []byte{}
	for _, kv := range [][2]string{{"_client_name", "libmysql"}, {"program_name", "mysql"}} {
		attrs = append(append(attrs, byte(len(kv[0]))), kv[0]...)
		attrs = append(append(attrs, byte(len(kv[1]))), kv[1]...)
	}
	b = append(append(b, byte(len(attrs))), attrs...)
	h, ok := parseMyHello(b)
	if !ok || h.user != "ticket123" || h.db != "crm" || h.app != "mysql" || h.collation != 255 {
		t.Fatalf("got %+v %v", h, ok)
	}
}
