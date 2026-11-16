package main

import (
	"testing"
	"time"
)

func TestSessionHubTerminate(t *testing.T) {
	h := NewSessionHub()
	h.Register("s1", "site", "user", "rdp", "host", time.Now(), "", "", "")
	ran := 0
	h.SetCloser("s1", func() { ran++ })
	if !h.Terminate("s1") {
		t.Fatal("expected Terminate to find s1")
	}
	if ran != 1 {
		t.Fatalf("closer ran %d times, want 1", ran)
	}
	if h.Terminate("missing") {
		t.Fatal("Terminate of unknown id should return false")
	}
}

func TestRegisterIsolatedKindAndTerminate(t *testing.T) {
	h := NewSessionHub()
	ls := h.RegisterIsolated("s1", "site1", "user1", "https://example.com", time.Now(), "conn1", "10.0.0.1:6901", 6902, "bsid1", "10.0.0.1:7900", "allow", "captivo:pw")
	list := h.List()
	if len(list) != 1 || list[0].Kind != "isolated" || list[0].Protocol != "isolated" {
		t.Fatalf("expected one isolated session with kind/protocol=isolated, got %+v", list)
	}
	if cid, addr, port, auth := ls.kasmAttach(); cid != "conn1" || addr != "10.0.0.1:6901" || port != 6902 || auth != "captivo:pw" {
		t.Fatalf("kasmAttach mismatch: %s %s %d %s", cid, addr, port, auth)
	}
	called := false
	h.SetCloser("s1", func() { called = true })
	if !h.Terminate("s1") || !called {
		t.Fatalf("terminate did not invoke the closer")
	}
}

func TestIsolatedFileTarget(t *testing.T) {
	h := NewSessionHub()
	h.RegisterIsolated("s1", "site1", "user1", "https://x.test", time.Now(), "conn1", "10.0.0.1:6901", 6902, "bsid1", "10.0.0.1:7900", "no_upload", "")
	conn, ctrl, sid, mode, host, ok := h.IsolatedFileTarget("user1", "site1")
	if !ok || conn != "conn1" || ctrl != "10.0.0.1:7900" || sid != "bsid1" || mode != "no_upload" || host != "https://x.test" {
		t.Fatalf("unexpected: %v %q %q %q %q %q", ok, conn, ctrl, sid, mode, host)
	}
	if _, _, _, _, _, ok := h.IsolatedFileTarget("user1", "other"); ok {
		t.Fatal("expected no match for other site")
	}
}
