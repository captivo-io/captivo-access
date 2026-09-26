package main

import (
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// sendRecorder captures what recWriter would ship to the connector, standing in
// for writeRecChunk so the recorder can be tested without a tunnel.
type sendRecorder struct {
	mu   sync.Mutex
	reqs []tunnel.RecWriteRequest
	err  error
}

func (s *sendRecorder) send(req tunnel.RecWriteRequest) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reqs = append(s.reqs, req)
	if s.err != nil {
		return 0, s.err
	}
	return len(req.Data), nil
}

func (s *sendRecorder) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.reqs)
}

func newTestRecWriter(send func(tunnel.RecWriteRequest) (int, error), capBytes int) *recWriter {
	return newRecWriter(send, "acme", "rec-key", "site-1", "user-1", "host", "ssh", capBytes)
}

func TestRecWriterFlushesOnByteThreshold(t *testing.T) {
	rec := &sendRecorder{}
	w := newTestRecWriter(rec.send, 10<<20)
	w.Write([]byte(strings.Repeat("A", recFlushBytes+1)))
	if rec.count() != 1 {
		t.Fatalf("want one flush at the byte threshold, got %d", rec.count())
	}
	got := rec.reqs[0]
	if got.TenantID != "acme" || got.RecordingKey != "rec-key" || got.Format != "guac" || got.Protocol != "ssh" {
		t.Fatalf("chunk lost its addressing: %+v", got)
	}
}

func TestRecWriterStopsAtSizeCap(t *testing.T) {
	rec := &sendRecorder{}
	// Cap of 256 KiB: the first 300 KiB write flushes once, then total > cap stops
	// capture, so the second write is dropped.
	w := newTestRecWriter(rec.send, 256*1024)
	w.Write([]byte(strings.Repeat("B", 300*1024)))
	w.Write([]byte(strings.Repeat("C", 300*1024)))
	if rec.count() != 1 {
		t.Fatalf("expected exactly 1 chunk before the cap, got %d", rec.count())
	}
}

func TestRecWriterSurvivesSendFailure(t *testing.T) {
	// Recording is best-effort: a connector that refuses the chunk must not stop
	// the writer, because the live session depends on this goroutine.
	rec := &sendRecorder{err: errors.New("connector offline")}
	w := newTestRecWriter(rec.send, 10<<20)
	w.Write([]byte(strings.Repeat("A", recFlushBytes+1)))
	w.Write([]byte(strings.Repeat("A", recFlushBytes+1)))
	if rec.count() != 2 {
		t.Fatalf("writer stopped after a failed send: %d attempts", rec.count())
	}
}

func TestRecWriterAdvancesSeqAcrossChunks(t *testing.T) {
	rec := &sendRecorder{}
	w := newTestRecWriter(rec.send, 10<<20)
	w.Write([]byte(strings.Repeat("A", recFlushBytes+1)))
	w.Write([]byte(strings.Repeat("A", recFlushBytes+1)))
	if rec.reqs[0].Seq != 0 || rec.reqs[1].Seq != 1 {
		t.Fatalf("seq must advance so the connector can order chunks: %d,%d", rec.reqs[0].Seq, rec.reqs[1].Seq)
	}
}

func TestRecWriterLogsUnsupportedOnlyOnce(t *testing.T) {
	// errRecUnsupported means an old connector. At 256 KiB / 2 s this would
	// otherwise fill the log with one line per chunk for the whole session.
	rec := &sendRecorder{err: errRecUnsupported}
	w := newTestRecWriter(rec.send, 10<<20)
	for i := 0; i < 3; i++ {
		w.Write([]byte(strings.Repeat("A", recFlushBytes+1)))
	}
	if w.unsupportedLogged != 1 {
		t.Fatalf("want the unsupported notice logged once, got %d", w.unsupportedLogged)
	}
}
