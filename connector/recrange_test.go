package main

import (
	"bytes"
	"encoding/json"
	"math/rand"
	"os"
	"path/filepath"
	"testing"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// A video player scrubbing a recording asks for byte ranges. A range over 1 MiB
// used to go back as one tunnel frame, which the tunnel refuses: the player got a
// 206 with an empty body and stalled a few seconds in.
func TestRecFetch_LargeRangeArrivesWhole(t *testing.T) {
	store := newRecStore(t.TempDir(), testKey())
	var all []byte
	r := rand.New(rand.NewSource(1))
	for seq := 0; seq < 12; seq++ { // 12 x 256 KiB, like a finalized isolated-browser video
		chunk := make([]byte, 256<<10)
		r.Read(chunk)
		all = append(all, chunk...)
		if _, err := store.Append("t1", "rec-1", "video", seq, chunk); err != nil {
			t.Fatal(err)
		}
	}
	from, to := int64(1000), int64(len(all)-1)
	req, _ := json.Marshal(tunnel.RecFetchRequest{TenantID: "t1", RecordingKey: "rec-1", Format: "video", FromByte: from, ToByte: to})
	c := newRWC()
	handleRecFetch(c, store, req)

	head, err := tunnel.ReadFrame(c.out)
	if err != nil {
		t.Fatal(err)
	}
	var h tunnel.RecFetchResponse
	_ = json.Unmarshal(head, &h)
	if h.Error != "" || h.TotalBytes != int64(len(all)) {
		t.Fatalf("head = %+v, want total %d", h, len(all))
	}
	var got []byte
	frames := 0
	for {
		b, err := tunnel.ReadFrame(c.out)
		if err != nil {
			break
		}
		frames++
		got = append(got, b...)
	}
	if !bytes.Equal(got, all[from:to+1]) {
		t.Fatalf("range body: got %d bytes, want %d", len(got), to-from+1)
	}
	if frames < 2 {
		t.Fatalf("a %d-byte range must span several frames, got %d", len(got), frames)
	}
}

// Sizes come from the files, and a chunk that does not open keeps its place.
func TestRecStore_RangeUsesSizesAndKeepsOffsets(t *testing.T) {
	root := t.TempDir()
	store := newRecStore(root, testKey())
	for seq, s := range []string{"aaaa", "bbbb", "cccc"} {
		if _, err := store.Append("t1", "k", "video", seq, []byte(s)); err != nil {
			t.Fatal(err)
		}
	}
	if total, _ := store.TotalPlaintextBytes("t1", "k", "video"); total != 12 {
		t.Fatalf("total = %d, want 12", total)
	}
	got, err := store.ReadRange("t1", "k", "video", 2, 9)
	if err != nil || string(got) != "aabbbbcc" {
		t.Fatalf("range = %q err=%v", got, err)
	}
	// Corrupt the middle chunk: same size on disk, does not decrypt.
	d, _ := store.dir("t1", "k", "video")
	p := filepath.Join(d, "1.bin")
	b, _ := os.ReadFile(p)
	b[len(b)-1] ^= 0xff
	_ = os.WriteFile(p, b, 0o600)
	got, _ = store.ReadRange("t1", "k", "video", 2, 9)
	if string(got) != "aa\x00\x00\x00\x00cc" {
		t.Fatalf("corrupt chunk did not hold its place: %q", got)
	}
}
