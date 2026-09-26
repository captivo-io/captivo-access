package main

import (
	"encoding/json"
	"testing"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// TestRecordingLifecycleStaysLocal is the slice-level proof: a chunk written over
// the tunnel lands encrypted on this host, is findable by search, and comes back
// intact on fetch -- without any control-plane involvement.
func TestRecordingLifecycleStaysLocal(t *testing.T) {
	root := t.TempDir()
	store := newRecStore(root, testKey())

	payload := keysChunk(t, keyEventPayload{AtMs: 12, Kind: "command", Text: "admin@host:~$ sudo rm -rf /var/tmp"})
	w, _ := json.Marshal(tunnel.RecWriteRequest{
		Kind: "recwrite", TenantID: "acme", RecordingKey: "s1-u1-9-ab",
		Seq: 0, Format: "keys", Protocol: "ssh", Data: payload,
	})
	handleRecWrite(newRWC(), store, w)

	if grepTree(t, root, "sudo rm -rf") {
		t.Fatal("plaintext on disk")
	}

	sq, _ := json.Marshal(tunnel.RecSearchRequest{
		Kind: "recsearch", TenantID: "acme", Query: "SUDO RM",
		RecordingKeys: []string{"s1-u1-9-ab"}, MaxDecrypt: 50,
	})
	sc := newRWC()
	handleRecSearch(sc, store, sq)
	sb, _ := tunnel.ReadFrame(sc.out)
	var sr tunnel.RecSearchResponse
	_ = json.Unmarshal(sb, &sr)
	if len(sr.Matches) != 1 {
		t.Fatalf("search missed it: %+v", sr)
	}

	fq, _ := json.Marshal(tunnel.RecFetchRequest{
		Kind: "recfetch", TenantID: "acme", RecordingKey: "s1-u1-9-ab",
	})
	fc := newRWC()
	handleRecFetch(fc, store, fq)
	if _, err := tunnel.ReadFrame(fc.out); err != nil {
		t.Fatalf("fetch head: %v", err)
	}
	body, err := tunnel.ReadFrame(fc.out)
	if err != nil {
		t.Fatalf("fetch body: %v", err)
	}
	if string(body) != string(payload) {
		t.Fatalf("fetch corrupted: %q", body)
	}
}
