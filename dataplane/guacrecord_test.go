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
	return newRecWriter(send, nil, "acme", "rec-key", "site-1", "user-1", "host", "ssh", capBytes)
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

func TestRecWriterHasNoCapByDefault(t *testing.T) {
	// No RECORDING_MAX_BYTES means no cap: the recording runs as long as the
	// session. The 500 MiB default that shipped until 2.1.3 cut recordings short
	// without a word in the console; nothing may reintroduce a silent default.
	t.Setenv("RECORDING_MAX_BYTES", "")
	if got := recordingMaxBytes(); got != 0 {
		t.Fatalf("default cap must be 0 (unlimited), got %d", got)
	}
	t.Setenv("RECORDING_MAX_BYTES", "not-a-number")
	if got := recordingMaxBytes(); got != 0 {
		t.Fatalf("an unparsable cap must mean no cap, got %d", got)
	}
	t.Setenv("RECORDING_MAX_BYTES", "4096")
	if got := recordingMaxBytes(); got != 4096 {
		t.Fatalf("an explicit cap must be honoured, got %d", got)
	}
}

func TestRecWriterWithZeroCapNeverStops(t *testing.T) {
	rec := &sendRecorder{}
	spy := &indexSpy{}
	w := newRecWriter(rec.send, &recIndexReporter{send: spy.send, format: "guac"},
		"acme", "k", "s", "u", "h", "ssh", 0)
	for i := 0; i < 5; i++ {
		w.Write([]byte(strings.Repeat("A", recFlushBytes+1)))
	}
	if rec.count() != 5 {
		t.Fatalf("cap 0 must mean unlimited: want 5 chunks, got %d", rec.count())
	}
	for _, b := range spy.bodies {
		if strings.Contains(b, `"truncated":true`) {
			t.Fatalf("an uncapped recording must never be marked truncated: %s", b)
		}
	}
}

func TestRecWriterStopsAtSizeCapAndSaysSo(t *testing.T) {
	rec := &sendRecorder{}
	spy := &indexSpy{}
	// Cap of 256 KiB: the first 300 KiB write flushes once, then total > cap stops
	// capture, so the second write is dropped -- and the index is told, because a
	// recording that ends before its session must not look like the session ended.
	w := newRecWriter(rec.send, &recIndexReporter{send: spy.send, format: "guac", proto: "rdp"},
		"acme", "k", "s", "u", "h", "rdp", 256*1024)
	w.Write([]byte(strings.Repeat("B", 300*1024)))
	w.Write([]byte(strings.Repeat("C", 300*1024)))
	if rec.count() != 1 {
		t.Fatalf("expected exactly 1 chunk before the cap, got %d", rec.count())
	}
	var marked int
	for _, b := range spy.bodies {
		if strings.Contains(b, `"truncated":true`) && strings.Contains(b, `"recordingKey":"k"`) {
			marked++
		}
	}
	if marked != 1 {
		t.Fatalf("want exactly one truncated report for the index, got %d in %v", marked, spy.bodies)
	}
}

func TestRecWriterStopsAtSizeCapWithoutAnIndex(t *testing.T) {
	// A nil index reporter (older call sites, tests) must not panic at the cap.
	rec := &sendRecorder{}
	w := newTestRecWriter(rec.send, 10)
	w.Write([]byte(strings.Repeat("B", recFlushBytes+1)))
	w.Write([]byte(strings.Repeat("C", recFlushBytes+1)))
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

// indexSpy observes what the recorder reports to the control plane, so the Slice-B
// regression -- bytes on the connector with NO index row, leaving the recording
// invisible in the list -- cannot return unnoticed.
type indexSpy struct {
	bodies []string
}

func (s *indexSpy) send(_, _, _ string, body []byte) error {
	s.bodies = append(s.bodies, string(body))
	return nil
}

func TestRecWriterReportsAnIndexForEveryChunk(t *testing.T) {
	rec := &sendRecorder{}
	spy := &indexSpy{}
	w := newRecWriter(rec.send, &recIndexReporter{send: spy.send, format: "guac", proto: "ssh"},
		"acme", "k", "s", "u", "h", "ssh", 10<<20)

	w.Write([]byte(strings.Repeat("A", recFlushBytes+1)))
	w.Write([]byte(strings.Repeat("B", recFlushBytes+1)))

	if len(spy.bodies) != 2 {
		t.Fatalf("want one index report per chunk, got %d", len(spy.bodies))
	}
	if !strings.Contains(spy.bodies[0], `"format":"guac"`) {
		t.Fatalf("index lost the format, so the UI cannot pick a player: %s", spy.bodies[0])
	}
	if !strings.Contains(spy.bodies[0], `"recordingKey":"k"`) {
		t.Fatalf("index lost the recording key: %s", spy.bodies[0])
	}
}

func TestRecWriterReportsTheIndexEvenWhenTheChunkFails(t *testing.T) {
	// An admin must be able to see that a session was recorded even when the
	// connector refused the bytes; otherwise a failed write looks like no session.
	rec := &sendRecorder{err: errors.New("connector offline")}
	spy := &indexSpy{}
	w := newRecWriter(rec.send, &recIndexReporter{send: spy.send, format: "guac"},
		"acme", "k", "s", "u", "h", "ssh", 10<<20)
	w.Write([]byte(strings.Repeat("A", recFlushBytes+1)))
	if len(spy.bodies) != 1 {
		t.Fatalf("no index reported for a failed chunk: %d", len(spy.bodies))
	}
}
