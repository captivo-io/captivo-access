package main

import (
	"encoding/binary"
	"testing"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

func msHeaders() []byte {
	h := binary.LittleEndian.AppendUint32(nil, 22)
	h = binary.LittleEndian.AppendUint32(h, 18)
	h = binary.LittleEndian.AppendUint16(h, 2)
	h = append(h, make([]byte, 8)...)
	return binary.LittleEndian.AppendUint32(h, 1)
}

// nvarcharParam is an RPC parameter: NVARCHAR(max) as PLP when plp, else NVARCHAR(4000).
func nvarcharParam(name, value string, plp bool) []byte {
	n := tunnel.UCS2(name)
	b := append([]byte{byte(len(n) / 2)}, n...)
	b = append(b, 0, 0xE7)
	v := tunnel.UCS2(value)
	if plp {
		b = append(b, 0xFF, 0xFF, 0x09, 0x04, 0xD0, 0x00, 0x34)
		b = binary.LittleEndian.AppendUint64(b, uint64(len(v)))
		b = binary.LittleEndian.AppendUint32(b, uint32(len(v)))
		b = append(b, v...)
		return binary.LittleEndian.AppendUint32(b, 0)
	}
	b = append(b, 0x40, 0x1F, 0x09, 0x04, 0xD0, 0x00, 0x34)
	b = binary.LittleEndian.AppendUint16(b, uint16(len(v)))
	return append(b, v...)
}

func intParam(v int32) []byte {
	b := []byte{0, 0, 0x26, 4, 4}
	return binary.LittleEndian.AppendUint32(b, uint32(v))
}

func rpc(procID uint16, params ...[]byte) []byte {
	b := append(msHeaders(), 0xFF, 0xFF)
	b = binary.LittleEndian.AppendUint16(b, procID)
	b = append(b, 0, 0)
	for _, p := range params {
		b = append(b, p...)
	}
	return b
}

func doneToken(tok byte, status uint16, rows uint64) []byte {
	b := binary.LittleEndian.AppendUint16([]byte{tok}, status)
	b = binary.LittleEndian.AppendUint16(b, 0)
	return binary.LittleEndian.AppendUint64(b, rows)
}

func TestMsTrackerLogsStatementsNotValues(t *testing.T) {
	now := time.Now()
	q := newMsTracker(now, "crm")
	eom := byte(tunnel.TDSStatusEOM)

	// A batch, answered with a count.
	q.client(tunnel.TDSBatch, eom, append(msHeaders(), tunnel.UCS2("SELECT name FROM t")...), now)
	ev := q.server(eom, doneToken(tunnel.TokenDone, tunnel.DoneCount, 2), now.Add(5*time.Millisecond))
	if len(ev) != 1 || ev[0].Text != "SELECT name FROM t" || ev[0].Rows == nil || *ev[0].Rows != 2 || ev[0].Ms != 5 || ev[0].Db != "crm" {
		t.Fatalf("%+v", ev)
	}

	// sp_executesql (PLP statement): the text, never the parameter values; the
	// rows come from DONEINPROC before RETURNSTATUS and DONEPROC.
	q.client(tunnel.TDSRPC, eom, rpc(10, nvarcharParam("", "UPDATE t SET name = @p1 WHERE id = @p2", true), nvarcharParam("", "@p1 nvarchar(4000),@p2 int", false), nvarcharParam("@p1", "secret value", false), intParam(2)), now)
	reply := append(doneToken(tunnel.TokenDoneInProc, tunnel.DoneCount, 1), 0x79, 0, 0, 0, 0)
	reply = append(reply, doneToken(tunnel.TokenDoneProc, 0, 0)...)
	ev = q.server(eom, reply, now)
	if len(ev) != 1 || ev[0].Text != "UPDATE t SET name = @p1 WHERE id = @p2" || ev[0].Rows == nil || *ev[0].Rows != 1 {
		t.Fatalf("%+v", ev)
	}

	// sp_prepexec: the statement is the third parameter.
	q.client(tunnel.TDSRPC, eom, rpc(13, intParam(0), nvarcharParam("", "@p1 int", false), nvarcharParam("", "SELECT * FROM t WHERE id = @p1", false), intParam(7)), now)
	if ev = q.server(eom, doneToken(tunnel.TokenDoneProc, 0, 0), now); len(ev) != 1 || ev[0].Text != "SELECT * FROM t WHERE id = @p1" {
		t.Fatalf("%+v", ev)
	}

	// sp_execute carries no text; sp_unprepare is housekeeping.
	q.client(tunnel.TDSRPC, eom, rpc(12, intParam(1), nvarcharParam("@p1", "secret value", false)), now)
	if ev = q.server(eom, doneToken(tunnel.TokenDoneProc, 0, 0), now); len(ev) != 1 || ev[0].Text != "EXEC sp_execute (a prepared statement)" {
		t.Fatalf("%+v", ev)
	}
	q.client(tunnel.TDSRPC, eom, rpc(15, intParam(1)), now)
	if ev = q.server(eom, doneToken(tunnel.TokenDoneProc, 0, 0), now); len(ev) != 0 {
		t.Fatalf("housekeeping logged: %+v", ev)
	}

	// An error: the ERROR token's text and number.
	q.client(tunnel.TDSBatch, eom, append(msHeaders(), tunnel.UCS2("SELECT * FROM nosuch")...), now)
	ev = q.server(eom, append(tunnel.TDSErrorToken(208, 1, 16, "Invalid object name 'nosuch'.", "db1"), doneToken(tunnel.TokenDone, tunnel.DoneError, 0)...), now)
	if len(ev) != 1 || ev[0].Error != "Invalid object name 'nosuch'." || ev[0].Code != "208" || ev[0].Rows != nil {
		t.Fatalf("%+v", ev)
	}

	// A cancel, and a USE that changes the database; a password is masked.
	q.client(tunnel.TDSBatch, eom, append(msHeaders(), tunnel.UCS2("WAITFOR DELAY '00:00:05'")...), now)
	q.client(tunnel.TDSAttention, eom, nil, now)
	if ev = q.server(eom, doneToken(tunnel.TokenDone, tunnel.DoneAttn, 0), now); len(ev) != 1 || ev[0].Error != "cancelled" {
		t.Fatalf("%+v", ev)
	}
	q.client(tunnel.TDSBatch, eom, append(msHeaders(), tunnel.UCS2("USE [sales]")...), now)
	q.server(eom, doneToken(tunnel.TokenDone, 0, 0), now)
	q.client(tunnel.TDSBatch, eom, append(msHeaders(), tunnel.UCS2("ALTER LOGIN app WITH PASSWORD = N'Hunter2!' OLD_PASSWORD = N'old'")...), now)
	ev = q.server(eom, doneToken(tunnel.TokenDone, 0, 0), now)
	if len(ev) != 1 || ev[0].Db != "sales" || ev[0].Text != "ALTER LOGIN app WITH PASSWORD = '***' OLD_PASSWORD = '***'" {
		t.Fatalf("%+v", ev)
	}

	// A request in several packets is read whole.
	full := append(msHeaders(), tunnel.UCS2("SELECT 1")...)
	q.client(tunnel.TDSBatch, 0, full[:10], now)
	q.client(tunnel.TDSBatch, eom, full[10:], now)
	q.server(0, []byte{0x81, 0, 0}, now) // a reply in two packets too
	if ev = q.server(eom, doneToken(tunnel.TokenDone, tunnel.DoneCount, 1), now); len(ev) != 1 || ev[0].Text != "SELECT 1" {
		t.Fatalf("%+v", ev)
	}
}

func TestMsFindErrorIgnoresLookalikes(t *testing.T) {
	row := []byte{0xD1, 0xAA, 0x40, 0x00, 1, 2, 3} // a row holding 0xAA
	if _, ok := msFindError(row); ok {
		t.Fatal("a row byte taken for an ERROR token")
	}
	e, ok := msFindError(append(row, tunnel.TDSErrorToken(547, 0, 16, "conflict", "db1")...))
	if !ok || e.Number != 547 {
		t.Fatalf("%+v %v", e, ok)
	}
}
