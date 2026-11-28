package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

func statOf(t *testing.T, store *recStore, key string) tunnel.RecStatResponse {
	t.Helper()
	req, _ := json.Marshal(tunnel.RecStatRequest{Kind: "recstat", TenantID: "t1", RecordingKey: key})
	c := newRWC()
	handleRecStat(c, store, req)
	b, err := tunnel.ReadFrame(c.out)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var resp tunnel.RecStatResponse
	if err := json.Unmarshal(b, &resp); err != nil {
		t.Fatal(err)
	}
	return resp
}

func TestRecStatReportsStreamsLengthsAndNextSeq(t *testing.T) {
	store := newRecStore(t.TempDir(), testKey())
	for seq, p := range []string{"aaaa", "bbbbbb", "cc"} {
		if _, err := store.Append("t1", "r1", "guac", seq, []byte(p)); err != nil {
			t.Fatal(err)
		}
	}
	store.NoteProtocol("t1", "r1", "guac", "ssh")
	if _, err := store.Append("t1", "r1", "keys", 0, []byte("[]")); err != nil {
		t.Fatal(err)
	}
	got := statOf(t, store, "r1")
	if got.Error != "" || got.Protocol != "ssh" {
		t.Fatalf("stat %+v", got)
	}
	want := map[string]tunnel.RecStatStream{"guac": {Format: "guac", Bytes: 12, NextSeq: 3}, "keys": {Format: "keys", Bytes: 2, NextSeq: 1}}
	if len(got.Streams) != 2 {
		t.Fatalf("streams %+v", got.Streams)
	}
	for _, s := range got.Streams {
		if s != want[s.Format] {
			t.Fatalf("stream %+v, want %+v", s, want[s.Format])
		}
	}
	if got.Complete {
		t.Fatal("a recording just written to is not complete")
	}
}

func TestRecStatOfAnUnknownRecordingIsEmptyAndTraversalIsRefused(t *testing.T) {
	store := newRecStore(t.TempDir(), testKey())
	if got := statOf(t, store, "nope"); got.Error != "" || len(got.Streams) != 0 || got.Complete {
		t.Fatalf("unknown recording: %+v", got)
	}
	req, _ := json.Marshal(tunnel.RecStatRequest{Kind: "recstat", TenantID: "../x", RecordingKey: "r"})
	c := newRWC()
	handleRecStat(c, store, req)
	b, _ := tunnel.ReadFrame(c.out)
	var resp tunnel.RecStatResponse
	_ = json.Unmarshal(b, &resp)
	if resp.Error == "" {
		t.Fatal("want an error for a traversing tenant id")
	}
}

func TestRecStatCompleteByMarkerOrByQuiet(t *testing.T) {
	store := newRecStore(t.TempDir(), testKey())
	if _, err := store.Append("t1", "r1", "guac", 0, []byte("x")); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if store.Stat("t1", "r1", now).Complete {
		t.Fatal("complete too early")
	}
	if !store.Stat("t1", "r1", now.Add(completeQuiet+time.Minute)).Complete {
		t.Fatal("a recording quiet for a long while should be called complete")
	}
	store.MarkComplete("t1", "r1")
	got := store.Stat("t1", "r1", now)
	if !got.Complete {
		t.Fatal("RecDone should make it complete at once")
	}
	// The marker is not a stream.
	if len(got.Streams) != 1 {
		t.Fatalf("streams %+v", got.Streams)
	}
}

func TestMarkersDoNotMakeARecordingYounger(t *testing.T) {
	store := newRecStore(t.TempDir(), testKey())
	if _, err := store.Append("t1", "r1", "guac", 0, []byte("x")); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-48 * time.Hour)
	if err := store.setModTimeForTest("t1", "r1", old); err != nil {
		t.Fatal(err)
	}
	if err := store.Hold("t1", "r1"); err != nil {
		t.Fatal(err)
	}
	store.MarkComplete("t1", "r1")
	store.Release("t1", "r1")
	d, _ := store.recDir("t1", "r1")
	info, _ := os.Stat(d)
	if !info.ModTime().Equal(old) {
		t.Fatalf("directory time moved to %v: retention would count from the marker", info.ModTime())
	}
	if n, _ := store.Purge("t1", time.Now().Add(-24*time.Hour)); n != 1 {
		t.Fatalf("retention removed %d, want 1", n)
	}
}

func TestWriteWithHoldKeepsMaintenanceAwayUntilRecDone(t *testing.T) {
	f := newMaintFixture(t)
	req, _ := json.Marshal(tunnel.RecWriteRequest{Kind: "recwrite", TenantID: "t1", RecordingKey: "r1", Seq: 0, Format: "guac", Protocol: "ssh", Data: []byte("0123456789"), Hold: true})
	c := newRWC()
	handleRecWrite(c, f.store, req)
	if !f.store.Held("t1", "r1", f.clock) {
		t.Fatal("a held write should mark the recording")
	}
	// Long quiet, but a copy is in progress: maintenance must not touch it.
	f.clock = f.clock.Add(time.Hour)
	f.m.cycle(context.Background())
	if st := f.state("r1"); st.Compressed {
		t.Fatalf("maintenance ran on a copy in progress: %+v", st)
	}
	// RecDone: the hold goes and the worker may start.
	f.store.MarkComplete("t1", "r1")
	f.store.Release("t1", "r1")
	if f.store.Held("t1", "r1", f.clock) {
		t.Fatal("still held after release")
	}
	f.m.cycle(context.Background())
	if st := f.state("r1"); !st.Compressed {
		t.Fatalf("maintenance did not run after the copy was complete: %+v", st)
	}
}

func TestAHoldNobodyRenewsIsAbandoned(t *testing.T) {
	store := newRecStore(t.TempDir(), testKey())
	if _, err := store.Append("t1", "r1", "guac", 0, []byte("x")); err != nil {
		t.Fatal(err)
	}
	if err := store.Hold("t1", "r1"); err != nil {
		t.Fatal(err)
	}
	if !store.Held("t1", "r1", time.Now()) {
		t.Fatal("fresh hold not seen")
	}
	if store.Held("t1", "r1", time.Now().Add(holdStale+time.Minute)) {
		t.Fatal("a hold older than holdStale must not block maintenance forever")
	}
}

func TestNextSeqFollowsTheLastChunkEvenAfterARepack(t *testing.T) {
	store := newRecStore(t.TempDir(), testKey())
	if n, _ := store.NextSeq("t1", "r1", "guac"); n != 0 {
		t.Fatalf("empty stream next seq %d", n)
	}
	for seq := 0; seq < 3; seq++ {
		if _, err := store.Append("t1", "r1", "guac", seq, []byte("abc")); err != nil {
			t.Fatal(err)
		}
	}
	if n, _ := store.NextSeq("t1", "r1", "guac"); n != 3 {
		t.Fatalf("next seq %d, want 3", n)
	}
	// A repacked stream has fewer, bigger chunks: the next seq follows what is there.
	d, _ := store.dir("t1", "r1", "guac")
	_ = os.Remove(filepath.Join(d, "1.bin"))
	_ = os.Remove(filepath.Join(d, "2.bin"))
	_ = os.Remove(filepath.Join(d, "0.bin"))
	if _, err := store.Append("t1", "r1", "guac", 0, []byte("abcabcabc")); err != nil {
		t.Fatal(err)
	}
	if n, _ := store.NextSeq("t1", "r1", "guac"); n != 1 {
		t.Fatalf("after a repack next seq %d, want 1", n)
	}
}

// pump does what the data plane's copier does, through the connector's own
// handlers: ask the target what it holds, ask the source for the rest of each
// stream as a byte range, append it to the target in chunks.
func pump(t *testing.T, src, dst *recStore, key string, chunk int) {
	t.Helper()
	ask := func(store *recStore) tunnel.RecStatResponse { return statOf(t, store, key) }
	have := map[string]tunnel.RecStatStream{}
	for _, s := range ask(dst).Streams {
		have[s.Format] = s
	}
	for _, s := range ask(src).Streams {
		h := have[s.Format]
		if h.Bytes >= s.Bytes {
			continue
		}
		req, _ := json.Marshal(tunnel.RecFetchRequest{Kind: "recfetch", TenantID: "t1", RecordingKey: key, Format: s.Format, FromByte: h.Bytes, ToByte: s.Bytes - 1})
		c := newRWC()
		handleRecFetch(c, src, req)
		if _, err := tunnel.ReadFrame(c.out); err != nil { // the head
			t.Fatal(err)
		}
		var data []byte
		for {
			b, err := tunnel.ReadFrame(c.out)
			if err != nil || len(b) == 0 {
				break
			}
			data = append(data, b...)
		}
		if int64(len(data)) != s.Bytes-h.Bytes {
			t.Fatalf("range answered %d bytes, want %d", len(data), s.Bytes-h.Bytes)
		}
		seq := h.NextSeq
		for len(data) > 0 {
			n := min(chunk, len(data))
			w, _ := json.Marshal(tunnel.RecWriteRequest{Kind: "recwrite", TenantID: "t1", RecordingKey: key, Seq: seq, Format: s.Format, Protocol: map[bool]string{true: "ssh"}[s.Format == "guac"], Data: data[:n], Hold: true})
			wc := newRWC()
			handleRecWrite(wc, dst, w)
			rb, _ := tunnel.ReadFrame(wc.out)
			var resp tunnel.RecWriteResponse
			_ = json.Unmarshal(rb, &resp)
			if resp.Error != "" {
				t.Fatalf("append: %s", resp.Error)
			}
			seq++
			data = data[n:]
		}
	}
}

func readAll(t *testing.T, s *recStore, key, format string) string {
	t.Helper()
	var out []byte
	if err := s.EachChunk("t1", key, format, 0, func(b []byte) error { out = append(out, b...); return nil }); err != nil {
		t.Fatal(err)
	}
	return string(out)
}

func TestACopyMadeThroughTheHandlersMatchesTheOriginalWhateverItsChunkLayout(t *testing.T) {
	src := newRecStore(t.TempDir(), testKey())
	dst := newRecStore(t.TempDir(), bytes32(7)) // a different key: each connector seals with its own
	// The original: uneven chunks, one repacked into a single big one later.
	parts := []string{"alpha-", "bravo-bravo-", "charlie-", "delta"}
	for seq, p := range parts {
		if _, err := src.Append("t1", "r1", "guac", seq, []byte(p)); err != nil {
			t.Fatal(err)
		}
	}
	src.NoteProtocol("t1", "r1", "guac", "ssh")
	if _, err := src.Append("t1", "r1", "keys", 0, []byte(`[{"atMs":1}]`)); err != nil {
		t.Fatal(err)
	}
	pump(t, src, dst, "r1", 5)
	want := "alpha-bravo-bravo-charlie-delta"
	if got := readAll(t, dst, "r1", "guac"); got != want {
		t.Fatalf("copy %q, want %q", got, want)
	}
	if got := readAll(t, dst, "r1", "keys"); got != `[{"atMs":1}]` {
		t.Fatalf("keys %q", got)
	}
	if !dst.Held("t1", "r1", time.Now()) {
		t.Fatal("a copy in progress must be held")
	}

	// The session goes on; the original is repacked underneath (as its own upkeep would); the copy catches up by position.
	if _, err := src.Append("t1", "r1", "guac", 4, []byte("-echo")); err != nil {
		t.Fatal(err)
	}
	m := newRecMaint(src, nil)
	src.MarkComplete("t1", "r1")
	m.markDone("t1", "r1")
	m.processDone(context.Background())
	pump(t, src, dst, "r1", 7)
	if got := readAll(t, dst, "r1", "guac"); got != want+"-echo" {
		t.Fatalf("after the original was repacked the copy is %q", got)
	}
	if st := statOf(t, dst, "r1"); st.Protocol != "ssh" {
		t.Fatalf("protocol %q did not reach the copy", st.Protocol)
	}

	// Done: the target is told, the hold goes, its own upkeep may run.
	dst.MarkComplete("t1", "r1")
	dst.Release("t1", "r1")
	if dst.Held("t1", "r1", time.Now()) || !dst.Stat("t1", "r1", time.Now()).Complete {
		t.Fatal("the copy was not released and completed")
	}
}

func bytes32(b byte) []byte {
	out := make([]byte, 32)
	for i := range out {
		out[i] = b
	}
	return out
}
