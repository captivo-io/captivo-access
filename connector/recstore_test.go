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
	n, err := s.Append("t1", "rec-1", "guac", 0, []byte("hello guac"))
	if err != nil {
		t.Fatalf("append: %v", err)
	}
	if n != len("hello guac") {
		t.Fatalf("want %d bytes written, got %d", len("hello guac"), n)
	}
	got, err := s.Read("t1", "rec-1", "guac", 0)
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
	if _, err := s.Append("t1", "rec-1", "guac", 0, []byte("SUPERSECRET")); err != nil {
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
		if _, err := s.Append("t1", "rec-1", "guac", i, []byte(part)); err != nil {
			t.Fatalf("append %d: %v", i, err)
		}
	}
	got, err := s.Read("t1", "rec-1", "guac", 1)
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
	if _, err := s.Append("t1", "rec-1", "guac", 0, []byte("tenant one")); err != nil {
		t.Fatalf("append: %v", err)
	}
	got, err := s.Read("t2", "rec-1", "guac", 0)
	if err == nil && len(got) != 0 {
		// Same recordingKey under a different tenant must not resolve.
		t.Fatalf("tenant leak: %+v", got)
	}
}

func TestStoreRejectsPathTraversal(t *testing.T) {
	s := newRecStore(t.TempDir(), testKey())
	if _, err := s.Append("../../etc", "rec", "guac", 0, []byte("x")); err == nil {
		t.Fatal("want error for a traversing tenant id")
	}
	if _, err := s.Append("t1", "../../rec", "guac", 0, []byte("x")); err == nil {
		t.Fatal("want error for a traversing recording key")
	}
}

func TestStorePurgeRemovesOldRecordingsOnly(t *testing.T) {
	s := newRecStore(t.TempDir(), testKey())
	if _, err := s.Append("t1", "old", "guac", 0, []byte("x")); err != nil {
		t.Fatalf("append: %v", err)
	}
	if _, err := s.Append("t1", "fresh", "guac", 0, []byte("y")); err != nil {
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
	if got, _ := s.Read("t1", "fresh", "guac", 0); len(got) != 1 {
		t.Fatal("purge removed a fresh recording")
	}
}

func TestStoreTotalPlaintextBytes(t *testing.T) {
	s := newRecStore(t.TempDir(), testKey())
	for i, part := range []string{"aaa", "bb", "c"} {
		if _, err := s.Append("t1", "rec-1", "guac", i, []byte(part)); err != nil {
			t.Fatalf("append: %v", err)
		}
	}
	// A Range response needs the PLAINTEXT length, not the sealed size on disk:
	// the player's byte offsets are over what it receives.
	got, err := s.TotalPlaintextBytes("t1", "rec-1", "guac")
	if err != nil {
		t.Fatalf("total: %v", err)
	}
	if got != 6 {
		t.Fatalf("want 6, got %d", got)
	}
}

func TestStoreReadRangeSlicesAcrossChunks(t *testing.T) {
	s := newRecStore(t.TempDir(), testKey())
	for i, part := range []string{"abc", "def", "ghi"} {
		if _, err := s.Append("t1", "rec-1", "guac", i, []byte(part)); err != nil {
			t.Fatalf("append: %v", err)
		}
	}
	// bytes 2..5 inclusive of "abcdefghi" is "cdef" -- it must span three chunks'
	// worth of arithmetic: tail of #0, all of #1, nothing of #2.
	got, err := s.ReadRange("t1", "rec-1", "guac", 2, 5)
	if err != nil {
		t.Fatalf("range: %v", err)
	}
	if string(got) != "cdef" {
		t.Fatalf("want cdef, got %q", got)
	}
}

func TestStoreReadRangeClampsToTheEnd(t *testing.T) {
	s := newRecStore(t.TempDir(), testKey())
	if _, err := s.Append("t1", "rec-1", "guac", 0, []byte("abc")); err != nil {
		t.Fatalf("append: %v", err)
	}
	// A player may ask for more than exists (open-ended Range); clamping beats
	// erroring, which would show as a broken video.
	got, err := s.ReadRange("t1", "rec-1", "guac", 1, 999)
	if err != nil {
		t.Fatalf("range: %v", err)
	}
	if string(got) != "bc" {
		t.Fatalf("want bc, got %q", got)
	}
}

func TestStoreReadRangeRejectsAnInvertedRange(t *testing.T) {
	s := newRecStore(t.TempDir(), testKey())
	if _, err := s.Append("t1", "rec-1", "guac", 0, []byte("abc")); err != nil {
		t.Fatalf("append: %v", err)
	}
	if _, err := s.ReadRange("t1", "rec-1", "guac", 5, 2); err == nil {
		t.Fatal("want an error for from > to")
	}
}

func TestStoreRefusesAnEmptyTenantEverywhere(t *testing.T) {
	// This is the real enforcement behind applyRecordingPolicy's fail-fast: an empty
	// tenant must never resolve to a path, or a sweep would walk the whole store
	// root and a purge would delete across tenants.
	s := newRecStore(t.TempDir(), testKey())
	if _, err := s.Append("", "k", "guac", 0, []byte("x")); err == nil {
		t.Fatal("Append accepted an empty tenant")
	}
	if _, err := s.Purge("", time.Now()); err == nil {
		t.Fatal("Purge accepted an empty tenant")
	}
	if err := s.Delete("", "k"); err == nil {
		t.Fatal("Delete accepted an empty tenant")
	}
	if _, err := s.ReadRange("", "k", "guac", 0, 1); err == nil {
		t.Fatal("ReadRange accepted an empty tenant")
	}
}

// One recording key, two concurrent writers, each numbering its chunks from zero.
// This is not hypothetical: dataplane/guactunnel.go starts a recWriter for the guac
// instruction stream and a keyWriter for keystrokes under the SAME key, and both
// begin at seq 0. When a chunk was addressed by seq alone they overwrote each other
// file for file -- the player received keystroke JSON where guac instructions should
// have been and never started, showing "Loading..." forever.
func TestStreamsUnderOneKeyDoNotOverwriteEachOther(t *testing.T) {
	s := newRecStore(t.TempDir(), testKey())
	guac := []byte("4.size,1.0,4.1024,3.768;")
	keys := []byte(`[{"atMs":7,"kind":"command","text":"sudo bash"}]` + "\n")

	for i, part := range []string{"g0", "g1"} {
		if _, err := s.Append("t1", "rec-1", "guac", i, []byte(part)); err != nil {
			t.Fatalf("guac seed: %v", err)
		}
	}
	if _, err := s.Append("t1", "rec-1", "guac", 2, guac); err != nil {
		t.Fatalf("guac seed: %v", err)
	}
	if _, err := s.Append("t1", "rec-1", "keys", 0, keys); err != nil {
		t.Fatalf("keys seed: %v", err)
	}

	gotGuac, err := s.Read("t1", "rec-1", "guac", 0)
	if err != nil {
		t.Fatalf("read guac: %v", err)
	}
	var joined []byte
	for _, c := range gotGuac {
		joined = append(joined, c.Data...)
	}
	if string(joined) != "g0g1"+string(guac) {
		t.Fatalf("guac stream corrupted by the keystroke writer: %q", joined)
	}

	gotKeys, err := s.Read("t1", "rec-1", "keys", 0)
	if err != nil {
		t.Fatalf("read keys: %v", err)
	}
	if len(gotKeys) != 1 || string(gotKeys[0].Data) != string(keys) {
		t.Fatalf("keystroke stream corrupted by the guac writer: %+v", gotKeys)
	}
}

// Erasure must take every stream with it. Addressing streams by a separate
// recording key (rec-1 plus rec-1:keys, say) would have been a one-line fix and
// would have left the keystroke log -- the most sensitive thing recorded here --
// on disk after the recording it belongs to was erased.
func TestDeleteRemovesEveryStreamOfARecording(t *testing.T) {
	s := newRecStore(t.TempDir(), testKey())
	if _, err := s.Append("t1", "rec-1", "guac", 0, []byte("frames")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Append("t1", "rec-1", "keys", 0, []byte(`[{"atMs":1,"text":"secret"}]`)); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete("t1", "rec-1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	for _, format := range []string{"guac", "keys"} {
		got, _ := s.Read("t1", "rec-1", format, 0)
		if len(got) != 0 {
			t.Errorf("%s stream survived erasure: %+v", format, got)
		}
	}
}

// A format arrives over the tunnel like the other segments, so it is untrusted.
func TestAppendRejectsATraversingFormat(t *testing.T) {
	s := newRecStore(t.TempDir(), testKey())
	if _, err := s.Append("t1", "rec-1", "../../etc", 0, []byte("x")); err == nil {
		t.Fatal("want an error for a traversing format")
	}
	if _, err := s.Append("t1", "rec-1", "", 0, []byte("x")); err == nil {
		t.Fatal("want an error for an empty format")
	}
}

// Bytes underpins disk accounting, and a recording's cost is every stream it holds.
func TestBytesCountsEveryStream(t *testing.T) {
	s := newRecStore(t.TempDir(), testKey())
	if _, err := s.Append("t1", "rec-1", "guac", 0, []byte("aaaa")); err != nil {
		t.Fatal(err)
	}
	guacOnly, err := s.Bytes("t1", "rec-1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Append("t1", "rec-1", "keys", 0, []byte("bbbb")); err != nil {
		t.Fatal(err)
	}
	both, err := s.Bytes("t1", "rec-1")
	if err != nil {
		t.Fatal(err)
	}
	if both <= guacOnly {
		t.Fatalf("keystroke stream not counted: guac=%d both=%d", guacOnly, both)
	}
}
