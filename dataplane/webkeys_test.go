package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Typed input from a web app page lands as a "keys" chunk under the page's
// recording key -- the stream the gateway already fills -- so one timeline and
// one search serve every kind of session.
func TestWebKeyChunk_ShapesAndMasks(t *testing.T) {
	body := []byte(`{"recordingKey":"k1","seq":3,"events":[
		{"atMs":1200,"kind":"command","text":"Search: invoices","masked":false},
		{"atMs":2400,"text":"hunter2","masked":true},
		{"atMs":-5,"text":"bad time"}
	]}`)
	req, ok := webKeyChunk("acme", body)
	if !ok {
		t.Fatal("well-formed batch refused")
	}
	if req.Format != "keys" || req.RecordingKey != "k1" || req.Seq != 3 || req.TenantID != "acme" {
		t.Fatalf("wrong chunk addressing: %+v", req)
	}
	got := string(req.Data)
	if strings.Contains(got, "hunter2") {
		t.Fatalf("a masked event kept its text: %s", got)
	}
	if !strings.Contains(got, `"text":"••••"`) || !strings.Contains(got, `"text":"Search: invoices"`) {
		t.Fatalf("events not kept as expected: %s", got)
	}
	if strings.Contains(got, "bad time") || strings.Contains(got, `"kind":"command"`) {
		t.Fatalf("page-supplied shape trusted: %s", got)
	}
	if !strings.HasSuffix(got, "\n") {
		t.Fatal("chunk must be newline-terminated (NDJSON on replay)")
	}
	for _, b := range []string{`{}`, `{"recordingKey":"","seq":0,"events":[{"atMs":1,"text":"x"}]}`, `{"recordingKey":"k","seq":-1,"events":[{"atMs":1,"text":"x"}]}`, `{"recordingKey":"k","seq":0,"events":[]}`, `nope`} {
		if _, ok := webKeyChunk("acme", []byte(b)); ok {
			t.Fatalf("accepted %s", b)
		}
	}
}

func TestServeRecording_KeysOnlyWhenLoggingIsOn(t *testing.T) {
	p := &BrowserProxy{ctrl: &fakeControl{}}
	body := []byte(`{"recordingKey":"k","seq":0,"events":[{"atMs":1,"text":"x"}]}`)

	rec := httptest.NewRecorder()
	p.serveRecording(rec, httptest.NewRequest(http.MethodPost, "/__captivo/keys", bytes.NewReader(body)), "u1", "s1", "host", "c1", "acme", true, false)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("keystroke logging off: status = %d, want 404", rec.Code)
	}

	rec = httptest.NewRecorder()
	p.serveRecording(rec, httptest.NewRequest(http.MethodPost, "/__captivo/keys", bytes.NewReader(body)), "u1", "s1", "host", "c1", "acme", true, true)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("keystroke logging on: status = %d, want 204", rec.Code)
	}

	rec = httptest.NewRecorder()
	big := bytes.Repeat([]byte("x"), maxKeyBatchBytes+1)
	p.serveRecording(rec, httptest.NewRequest(http.MethodPost, "/__captivo/keys", bytes.NewReader(big)), "u1", "s1", "host", "c1", "acme", true, true)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("oversize batch: status = %d, want 204 (dropped silently)", rec.Code)
	}
}

func TestRecorderTag_CarriesTheKeysFlag(t *testing.T) {
	got := string(injectBeforeBody([]byte("<html><head></head><body></body></html>"), []byte(recorderScriptTagKeys)))
	if !strings.Contains(got, `src="/__captivo/rec.js" data-keys="1"`) {
		t.Fatalf("keys tag not injected: %s", got)
	}
	if strings.Contains(recorderScriptTag, "data-keys") {
		t.Fatal("the plain recorder tag must not ask for keystrokes")
	}
}
