package main

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/kurtserdar/captivo-access/tunnel"
)

func TestKeyWriterSendsKeysChunksToTheConnector(t *testing.T) {
	rec := &sendRecorder{}
	w := newKeyWriter(rec.send, "acme", "rec-1")
	w.post([]keyEvent{{AtMs: 10, Kind: "command", Text: "sudo rm -rf /"}})

	if rec.count() != 1 {
		t.Fatalf("want one chunk, got %d", rec.count())
	}
	got := rec.reqs[0]
	if got.Format != "keys" {
		// Only "keys" chunks are searched on the connector; any other format makes
		// the keystroke log silently unsearchable.
		t.Fatalf("want format keys, got %q", got.Format)
	}
	if got.TenantID != "acme" || got.RecordingKey != "rec-1" {
		t.Fatalf("chunk lost its addressing: %+v", got)
	}
	var evs []keyEvent
	if err := json.Unmarshal(got.Data, &evs); err != nil {
		t.Fatalf("payload is not a keys batch: %v", err)
	}
	if len(evs) != 1 || evs[0].Text != "sudo rm -rf /" {
		t.Fatalf("payload lost the event: %+v", evs)
	}
}

func TestKeyWriterKeepsMaskedFlag(t *testing.T) {
	// Masking is what keeps a password prompt out of search results. If the flag
	// did not survive the hop, the connector would treat it as searchable text.
	rec := &sendRecorder{}
	w := newKeyWriter(rec.send, "acme", "rec-1")
	w.post([]keyEvent{{AtMs: 1, Kind: "text", Text: "hunter2", Masked: true}})

	var evs []keyEvent
	_ = json.Unmarshal(rec.reqs[0].Data, &evs)
	if !evs[0].Masked {
		t.Fatal("masked flag lost in transit")
	}
}

func TestKeyWriterAdvancesSeq(t *testing.T) {
	rec := &sendRecorder{}
	w := newKeyWriter(rec.send, "acme", "rec-1")
	w.post([]keyEvent{{Text: "a"}})
	w.post([]keyEvent{{Text: "b"}})
	if rec.reqs[0].Seq != 0 || rec.reqs[1].Seq != 1 {
		t.Fatalf("seq must advance: %d,%d", rec.reqs[0].Seq, rec.reqs[1].Seq)
	}
}

func TestKeyWriterStopsOnUnsupportedConnector(t *testing.T) {
	rec := &sendRecorder{err: errRecUnsupported}
	w := newKeyWriter(rec.send, "acme", "rec-1")
	for i := 0; i < 3; i++ {
		w.post([]keyEvent{{Text: "x"}})
	}
	if w.unsupportedLogged != 1 {
		t.Fatalf("want the notice logged once, got %d", w.unsupportedLogged)
	}
	if rec.count() != 1 {
		t.Fatalf("want one attempt then stop, got %d", rec.count())
	}
}

func TestKeyWriterSurvivesSendFailure(t *testing.T) {
	rec := &sendRecorder{err: errors.New("connector offline")}
	w := newKeyWriter(rec.send, "acme", "rec-1")
	w.post([]keyEvent{{Text: "a"}})
	w.post([]keyEvent{{Text: "b"}})
	if rec.count() != 2 {
		t.Fatalf("writer stopped after a failed send: %d", rec.count())
	}
}

func TestKeyWriterIgnoresEmptyBatch(t *testing.T) {
	rec := &sendRecorder{}
	w := newKeyWriter(rec.send, "acme", "rec-1")
	w.post(nil)
	if rec.count() != 0 {
		t.Fatal("an empty batch produced a chunk")
	}
}

var _ = tunnel.RecWriteRequest{}
