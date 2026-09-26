package main

import (
	"testing"

	"github.com/kurtserdar/captivo-access/tunnel"
)

func seedSearch(t *testing.T) *recStore {
	t.Helper()
	s := newRecStore(t.TempDir(), testKey())
	if _, err := s.Append("t1", "rec-a", 0, []byte("ls -la /etc")); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, err := s.Append("t1", "rec-b", 0, []byte("sudo RM -RF /tmp/x")); err != nil {
		t.Fatalf("seed: %v", err)
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
		// Without this signal a partial answer reads as "no match", which is the
		// difference between "we did not find it" and "it did not happen".
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
