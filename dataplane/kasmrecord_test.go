package main

import (
	"errors"
	"strings"
	"testing"

	"github.com/kurtserdar/captivo-access/tunnel"
)

func newTestKasmWriter(send func(tunnel.RecWriteRequest) (int, error), capBytes int) *kasmRecWriter {
	return newKasmRecWriter(send, "acme", "k1", "site1", "user1", "host1", capBytes)
}

func TestKasmRecWriterFlushesToConnector(t *testing.T) {
	rec := &sendRecorder{}
	w := newTestKasmWriter(rec.send, 1<<20)
	w.Write([]byte(strings.Repeat("A", recFlushBytes+1)))
	if rec.count() != 1 {
		t.Fatalf("want one chunk, got %d", rec.count())
	}
	got := rec.reqs[0]
	if got.Format != "video" {
		// The connector stores by format; "guac" here would mis-assemble on replay.
		t.Fatalf("want format video, got %q", got.Format)
	}
	if got.TenantID != "acme" || got.RecordingKey != "k1" {
		t.Fatalf("chunk lost its addressing: %+v", got)
	}
}

func TestKasmRecWriterStopsAtSizeCap(t *testing.T) {
	rec := &sendRecorder{}
	w := newTestKasmWriter(rec.send, 10) // 10-byte cap
	w.Write([]byte(strings.Repeat("A", recFlushBytes+1)))
	w.Write([]byte(strings.Repeat("B", recFlushBytes+1)))
	if rec.count() != 1 {
		t.Fatalf("expected exactly 1 chunk before the cap, got %d", rec.count())
	}
}

func TestKasmRecWriterSurvivesSendFailure(t *testing.T) {
	rec := &sendRecorder{err: errors.New("connector offline")}
	w := newTestKasmWriter(rec.send, 1<<20)
	w.Write([]byte(strings.Repeat("A", recFlushBytes+1)))
	w.Write([]byte(strings.Repeat("A", recFlushBytes+1)))
	if rec.count() != 2 {
		t.Fatalf("writer stopped after a failed send: %d attempts", rec.count())
	}
}

func TestSendFinalizedVideoGoesToTheConnector(t *testing.T) {
	rec := &sendRecorder{}
	sendFinalizedVideo(rec.send, "acme", "k1", 4, []byte("webm"))
	if rec.count() != 1 {
		t.Fatalf("want one chunk, got %d", rec.count())
	}
	if rec.reqs[0].Seq != 4 || rec.reqs[0].Format != "video" {
		t.Fatalf("finalized chunk wrong: %+v", rec.reqs[0])
	}
}

func TestSendFinalizedVideoToleratesNilSend(t *testing.T) {
	// The finalize path runs after the session ends; a torn-down recorder must not
	// panic the goroutine.
	sendFinalizedVideo(nil, "acme", "k1", 0, []byte("x"))
}
