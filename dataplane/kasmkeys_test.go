package main

import (
	"bytes"
	"io"
	"strings"
	"testing"
)

type fakeBroker struct {
	io.Reader
	sent bytes.Buffer
}

func (f *fakeBroker) Write(p []byte) (int, error) { return f.sent.Write(p) }

// The isolated browser's typed input comes from the broker at session end; the
// data-plane re-checks what it is handed before it joins the recording.
func TestPullKasmKeys(t *testing.T) {
	body := `[{"atMs":1200,"kind":"text","text":"Search: x","masked":false},{"atMs":2000,"text":"leak","masked":true},{"atMs":-1,"text":"bad"}]`
	b := &fakeBroker{Reader: strings.NewReader("HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n" + body)}
	got := pullKasmKeys(b, "captivo-kasm:7900", "s1-1")
	if !strings.HasPrefix(b.sent.String(), "GET /session/s1-1/keys HTTP/1.0\r\n") {
		t.Fatalf("wrong request: %q", b.sent.String())
	}
	if len(got) != 2 || got[0].Text != "Search: x" || got[1].Text != "••••" {
		t.Fatalf("events not cleaned: %+v", got)
	}

	nf := &fakeBroker{Reader: strings.NewReader("HTTP/1.0 404 Not Found\r\n\r\n{}")}
	if got := pullKasmKeys(nf, "h", "s"); got != nil {
		t.Fatalf("a missing session must yield nothing, got %+v", got)
	}
}
