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

// A session is listed from Register, a moment before its tunnel can say how to
// close it. An admin ending it in that moment used to be told "ended" and nothing
// happened; now the end runs as soon as the closer is set, once.
func TestTerminateBeforeTheCloserIsSetStillEndsTheSession(t *testing.T) {
	h := NewSessionHub()
	h.RegisterNative("s1", "rdp", "site", "user", "10.0.0.5", time.Now(), "c1", "203.0.113.5")
	if !h.Terminate("s1") {
		t.Fatal("a listed session is ended")
	}
	n := 0
	h.SetCloser("s1", func() { n++ })
	if n != 1 {
		t.Fatalf("the end that was asked for runs when the closer is set: ran %d times", n)
	}
	// A session nobody asked to end is not closed by setting its closer.
	h.RegisterNative("s2", "rdp", "site", "user", "10.0.0.5", time.Now(), "c1", "203.0.113.5")
	m := 0
	h.SetCloser("s2", func() { m++ })
	if m != 0 {
		t.Fatalf("closed without being asked: %d", m)
	}
	if !h.Terminate("s2") || m != 1 {
		t.Fatalf("a session with its closer ends at once: %d", m)
	}
	if h.Terminate("nobody") {
		t.Fatal("there is no such session")
	}
}
