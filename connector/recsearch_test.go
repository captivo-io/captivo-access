package main

import (
	"encoding/json"
	"testing"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// keysChunk builds the plaintext of a "keys" chunk: the JSON batch the dataplane
// reconstructs from a session's keystrokes.
func keysChunk(t *testing.T, evs ...keyEventPayload) []byte {
	t.Helper()
	b, err := json.Marshal(evs)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}

func seedSearch(t *testing.T) *recStore {
	t.Helper()
	s := newRecStore(t.TempDir(), testKey())
	if _, err := s.Append("t1", "rec-a", 0, keysChunk(t,
		keyEventPayload{AtMs: 10, Kind: "command", Text: "ls -la /etc"},
	)); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := s.SetFormat("t1", "rec-a", "keys"); err != nil {
		t.Fatalf("format: %v", err)
	}
	if _, err := s.Append("t1", "rec-b", 0, keysChunk(t,
		keyEventPayload{AtMs: 20, Kind: "command", Text: "sudo RM -RF /tmp/x"},
	)); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := s.SetFormat("t1", "rec-b", "keys"); err != nil {
		t.Fatalf("format: %v", err)
	}
	return s
}

func TestSearchIsCaseInsensitiveSubstring(t *testing.T) {
	s := seedSearch(t)
	res := searchStore(s, tunnel.RecSearchRequest{
		TenantID: "t1", Query: "rm -rf", RecordingKeys: []string{"rec-a", "rec-b"}, MaxDecrypt: 100,
	})
	if len(res.Matches) != 1 || res.Matches[0].RecordingKey != "rec-b" {
		t.Fatalf("want one hit on rec-b, got %+v", res.Matches)
	}
	if res.Matches[0].Snippet == "" {
		t.Fatal("want a snippet")
	}
}

func TestSearchEmptyQueryNeverMatches(t *testing.T) {
	s := seedSearch(t)
	res := searchStore(s, tunnel.RecSearchRequest{
		TenantID: "t1", Query: "", RecordingKeys: []string{"rec-a", "rec-b"}, MaxDecrypt: 100,
	})
	if len(res.Matches) != 0 {
		t.Fatalf("empty query matched %d recordings", len(res.Matches))
	}
}

func TestSearchRespectsDecryptBudget(t *testing.T) {
	s := seedSearch(t)
	res := searchStore(s, tunnel.RecSearchRequest{
		TenantID: "t1", Query: "rm -rf", RecordingKeys: []string{"rec-a", "rec-b"}, MaxDecrypt: 1,
	})
	if !res.Truncated {
		t.Fatal("want Truncated when the budget runs out")
	}
}

func TestSearchOnlySearchesRequestedKeys(t *testing.T) {
	s := seedSearch(t)
	res := searchStore(s, tunnel.RecSearchRequest{
		TenantID: "t1", Query: "rm -rf", RecordingKeys: []string{"rec-a"}, MaxDecrypt: 100,
	})
	if len(res.Matches) != 0 {
		t.Fatalf("searched outside the requested key set: %+v", res.Matches)
	}
}

func TestSearchSkipsMaskedText(t *testing.T) {
	// The central search only ever scanned `masked: false` rows; a masked line is
	// masked because it is a password prompt. Matching it here would leak exactly
	// what masking exists to hide.
	s := newRecStore(t.TempDir(), testKey())
	if _, err := s.Append("t1", "rec-m", 0, keysChunk(t,
		keyEventPayload{AtMs: 5, Kind: "text", Text: "hunter2", Masked: true},
	)); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := s.SetFormat("t1", "rec-m", "keys"); err != nil {
		t.Fatalf("format: %v", err)
	}
	res := searchStore(s, tunnel.RecSearchRequest{
		TenantID: "t1", Query: "hunter2", RecordingKeys: []string{"rec-m"}, MaxDecrypt: 100,
	})
	if len(res.Matches) != 0 {
		t.Fatalf("masked text was searchable: %+v", res.Matches)
	}
}

func TestSearchIgnoresNonKeystrokeFormats(t *testing.T) {
	// A guac chunk is a protocol stream, not text. Substring-matching it produces
	// meaningless hits (and could match a query against binary), which the central
	// search never did because it only read keystroke rows.
	s := newRecStore(t.TempDir(), testKey())
	if _, err := s.Append("t1", "rec-v", 0, []byte("4.sync,13.rm -rf /tmp/x;")); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := s.SetFormat("t1", "rec-v", "guac"); err != nil {
		t.Fatalf("format: %v", err)
	}
	res := searchStore(s, tunnel.RecSearchRequest{
		TenantID: "t1", Query: "rm -rf", RecordingKeys: []string{"rec-v"}, MaxDecrypt: 100,
	})
	if len(res.Matches) != 0 {
		t.Fatalf("searched a non-keystroke format: %+v", res.Matches)
	}
}

func TestSearchFormatGateIsLoadBearingForRrweb(t *testing.T) {
	// The format gate is not redundant. A guac chunk is skipped anyway because it is
	// not JSON, but an rrweb batch IS valid JSON and rrweb records typed text -- so
	// without the gate a web-app recording's keystrokes would be searchable through
	// a path that has no masking concept at all. This chunk parses cleanly into
	// keyEventPayload with a populated Text field.
	s := newRecStore(t.TempDir(), testKey())
	rrweb := []byte(`[{"atMs":1,"kind":"text","text":"hunter2","masked":false}]`)
	if _, err := s.Append("t1", "rec-w", 0, rrweb); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := s.SetFormat("t1", "rec-w", "rrweb"); err != nil {
		t.Fatalf("format: %v", err)
	}
	res := searchStore(s, tunnel.RecSearchRequest{
		TenantID: "t1", Query: "hunter2", RecordingKeys: []string{"rec-w"}, MaxDecrypt: 100,
	})
	if len(res.Matches) != 0 {
		t.Fatalf("a non-keystroke format was searched: %+v", res.Matches)
	}
}
