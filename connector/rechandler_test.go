package main

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// rwc pairs a request buffer with a response buffer so a handler can be driven
// without a real stream.
type rwc struct {
	in  *bytes.Buffer
	out *bytes.Buffer
}

func (c *rwc) Read(p []byte) (int, error)  { return c.in.Read(p) }
func (c *rwc) Write(p []byte) (int, error) { return c.out.Write(p) }
func (c *rwc) Close() error                { return nil }

func newRWC() *rwc { return &rwc{in: &bytes.Buffer{}, out: &bytes.Buffer{}} }

func TestHandleRecWriteStoresAndAcks(t *testing.T) {
	store := newRecStore(t.TempDir(), testKey())
	req, _ := json.Marshal(tunnel.RecWriteRequest{
		Kind: "recwrite", TenantID: "t1", RecordingKey: "rec-1", Seq: 0,
		Format: "guac", Protocol: "ssh", Data: []byte("payload"),
	})
	c := newRWC()
	handleRecWrite(c, store, req)

	respBytes, err := tunnel.ReadFrame(c.out)
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	var resp tunnel.RecWriteResponse
	if err := json.Unmarshal(respBytes, &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.Error != "" || resp.Written != len("payload") {
		t.Fatalf("unexpected ack: %+v", resp)
	}
	got, _ := store.Read("t1", "rec-1", "guac", 0)
	if len(got) != 1 || string(got[0].Data) != "payload" {
		t.Fatalf("not stored: %+v", got)
	}
}

func TestHandleRecWriteRejectsTraversal(t *testing.T) {
	store := newRecStore(t.TempDir(), testKey())
	req, _ := json.Marshal(tunnel.RecWriteRequest{
		Kind: "recwrite", TenantID: "../../etc", RecordingKey: "rec", Data: []byte("x"),
	})
	c := newRWC()
	handleRecWrite(c, store, req)
	respBytes, _ := tunnel.ReadFrame(c.out)
	var resp tunnel.RecWriteResponse
	_ = json.Unmarshal(respBytes, &resp)
	if resp.Error == "" {
		t.Fatal("want an error for a traversing tenant id")
	}
}

func TestHandleRecSearchReturnsMatches(t *testing.T) {
	store := newRecStore(t.TempDir(), testKey())
	if _, err := store.Append("t1", "rec-1", "keys", 0, keysChunk(t,
		keyEventPayload{AtMs: 1, Kind: "command", Text: "sudo rm -rf /"},
	)); err != nil {
		t.Fatalf("seed: %v", err)
	}
	req, _ := json.Marshal(tunnel.RecSearchRequest{
		Kind: "recsearch", TenantID: "t1", Query: "RM -RF", RecordingKeys: []string{"rec-1"}, MaxDecrypt: 10,
	})
	c := newRWC()
	handleRecSearch(c, store, req)
	respBytes, _ := tunnel.ReadFrame(c.out)
	var resp tunnel.RecSearchResponse
	_ = json.Unmarshal(respBytes, &resp)
	if len(resp.Matches) != 1 {
		t.Fatalf("want one match, got %+v", resp)
	}
}

func TestHandleRecFetchStreamsChunks(t *testing.T) {
	store := newRecStore(t.TempDir(), testKey())
	for i, p := range []string{"one", "two"} {
		if _, err := store.Append("t1", "rec-1", "guac", i, []byte(p)); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	req, _ := json.Marshal(tunnel.RecFetchRequest{
		Kind: "recfetch", TenantID: "t1", RecordingKey: "rec-1", Format: "guac", FromSeq: 0,
	})
	c := newRWC()
	handleRecFetch(c, store, req)

	head, err := tunnel.ReadFrame(c.out)
	if err != nil {
		t.Fatalf("read head: %v", err)
	}
	var resp tunnel.RecFetchResponse
	_ = json.Unmarshal(head, &resp)
	if resp.Error != "" {
		t.Fatalf("unexpected error: %s", resp.Error)
	}
	var assembled []byte
	for {
		b, err := tunnel.ReadFrame(c.out)
		if err != nil || len(b) == 0 {
			break
		}
		assembled = append(assembled, b...)
	}
	if string(assembled) != "onetwo" {
		t.Fatalf("want onetwo, got %q", assembled)
	}
}

func TestHandleRecFetchHonoursAByteRange(t *testing.T) {
	store := newRecStore(t.TempDir(), testKey())
	for i, p := range []string{"abc", "def", "ghi"} {
		if _, err := store.Append("t1", "rec-1", "guac", i, []byte(p)); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	req, _ := json.Marshal(tunnel.RecFetchRequest{
		Kind: "recfetch", TenantID: "t1", RecordingKey: "rec-1", Format: "guac", FromByte: 2, ToByte: 5,
	})
	c := newRWC()
	handleRecFetch(c, store, req)

	head, _ := tunnel.ReadFrame(c.out)
	var resp tunnel.RecFetchResponse
	_ = json.Unmarshal(head, &resp)
	if resp.Error != "" {
		t.Fatalf("unexpected error: %s", resp.Error)
	}
	if resp.TotalBytes != 9 {
		// Content-Range cannot be built without the total, and the player needs it
		// to know the timeline length.
		t.Fatalf("want total 9, got %d", resp.TotalBytes)
	}
	body, err := tunnel.ReadFrame(c.out)
	if err != nil {
		t.Fatalf("body: %v", err)
	}
	if string(body) != "cdef" {
		t.Fatalf("want cdef, got %q", body)
	}
}

func TestHandleRecFetchOpenEndedRangeReachesTheEnd(t *testing.T) {
	store := newRecStore(t.TempDir(), testKey())
	if _, err := store.Append("t1", "rec-1", "guac", 0, []byte("abcdef")); err != nil {
		t.Fatalf("seed: %v", err)
	}
	// "bytes=3-" is what a browser sends when it resumes; ToByte arrives as 0.
	req, _ := json.Marshal(tunnel.RecFetchRequest{
		Kind: "recfetch", TenantID: "t1", RecordingKey: "rec-1", Format: "guac", FromByte: 3,
	})
	c := newRWC()
	handleRecFetch(c, store, req)
	_, _ = tunnel.ReadFrame(c.out)
	body, _ := tunnel.ReadFrame(c.out)
	if string(body) != "def" {
		t.Fatalf("want def, got %q", body)
	}
}

func TestHandleRecFetchRefusesAnUnsatisfiableRange(t *testing.T) {
	store := newRecStore(t.TempDir(), testKey())
	if _, err := store.Append("t1", "rec-1", "guac", 0, []byte("abc")); err != nil {
		t.Fatalf("seed: %v", err)
	}
	req, _ := json.Marshal(tunnel.RecFetchRequest{
		Kind: "recfetch", TenantID: "t1", RecordingKey: "rec-1", Format: "guac", FromByte: 99, ToByte: 200,
	})
	c := newRWC()
	handleRecFetch(c, store, req)
	head, _ := tunnel.ReadFrame(c.out)
	var resp tunnel.RecFetchResponse
	_ = json.Unmarshal(head, &resp)
	if resp.Error == "" {
		// Streaming nothing with a 200 would show as a silently empty video.
		t.Fatal("want an error for a range past the end")
	}
}
