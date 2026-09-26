package main

import (
	"bytes"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testKey() []byte { return []byte("0123456789abcdef0123456789abcdef") }

func grepTree(t *testing.T, root, needle string) bool {
	t.Helper()
	found := false
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		if bytes.Contains(b, []byte(needle)) {
			found = true
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	return found
}

func TestStoreRoundTripsAChunk(t *testing.T) {
	s := newRecStore(t.TempDir(), testKey())
	n, err := s.Append("t1", "rec-1", 0, []byte("hello guac"))
	if err != nil {
		t.Fatalf("append: %v", err)
	}
	if n != len("hello guac") {
		t.Fatalf("want %d bytes written, got %d", len("hello guac"), n)
	}
	got, err := s.Read("t1", "rec-1", 0)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(got) != 1 || string(got[0].Data) != "hello guac" {
		t.Fatalf("round trip lost data: %+v", got)
	}
}

func TestStoreEncryptsOnDisk(t *testing.T) {
	root := t.TempDir()
	s := newRecStore(root, testKey())
	if _, err := s.Append("t1", "rec-1", 0, []byte("SUPERSECRET")); err != nil {
		t.Fatalf("append: %v", err)
	}
	// The plaintext must not appear anywhere under the store root. This is the
	// assertion that makes the whole design meaningful.
	if grepTree(t, root, "SUPERSECRET") {
		t.Fatal("plaintext found on disk")
	}
}

func TestStoreReadsFromSeqOnward(t *testing.T) {
	s := newRecStore(t.TempDir(), testKey())
	for i, part := range []string{"a", "b", "c"} {
		if _, err := s.Append("t1", "rec-1", i, []byte(part)); err != nil {
			t.Fatalf("append %d: %v", i, err)
		}
	}
	got, err := s.Read("t1", "rec-1", 1)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var b strings.Builder
	for _, c := range got {
		b.WriteString(string(c.Data))
	}
	if b.String() != "bc" {
		t.Fatalf("want bc, got %q", b.String())
	}
}

func TestStoreIsolatesTenants(t *testing.T) {
	s := newRecStore(t.TempDir(), testKey())
	if _, err := s.Append("t1", "rec-1", 0, []byte("tenant one")); err != nil {
		t.Fatalf("append: %v", err)
	}
	got, err := s.Read("t2", "rec-1", 0)
	if err == nil && len(got) != 0 {
		// Same recordingKey under a different tenant must not resolve.
		t.Fatalf("tenant leak: %+v", got)
	}
}

func TestStoreRejectsPathTraversal(t *testing.T) {
	s := newRecStore(t.TempDir(), testKey())
	if _, err := s.Append("../../etc", "rec", 0, []byte("x")); err == nil {
		t.Fatal("want error for a traversing tenant id")
	}
	if _, err := s.Append("t1", "../../rec", 0, []byte("x")); err == nil {
		t.Fatal("want error for a traversing recording key")
	}
}

func TestStorePurgeRemovesOldRecordingsOnly(t *testing.T) {
	s := newRecStore(t.TempDir(), testKey())
	if _, err := s.Append("t1", "old", 0, []byte("x")); err != nil {
		t.Fatalf("append: %v", err)
	}
	if _, err := s.Append("t1", "fresh", 0, []byte("y")); err != nil {
		t.Fatalf("append: %v", err)
	}
	if err := s.setModTimeForTest("t1", "old", time.Now().Add(-48*time.Hour)); err != nil {
		t.Fatalf("age: %v", err)
	}
	removed, err := s.Purge("t1", time.Now().Add(-24*time.Hour))
	if err != nil {
		t.Fatalf("purge: %v", err)
	}
	if removed != 1 {
		t.Fatalf("want 1 removed, got %d", removed)
	}
	if got, _ := s.Read("t1", "fresh", 0); len(got) != 1 {
		t.Fatal("purge removed a fresh recording")
	}
}
