package main

import (
	"net/http"
	"strings"
	"testing"
)

// The broker's control service now requires the token the connector read from
// the broker's own volume; every relayed call must carry it.
func TestKasmAuth(t *testing.T) {
	if kasmAuth(nil) != "" || kasmAuth(&Session{}) != "" {
		t.Fatal("no token, no header (older connector and broker)")
	}
	s := &Session{kasmToken: "abc123"}
	if got := kasmAuth(s); got != "X-Kasm-Token: abc123\r\n" {
		t.Fatalf("header = %q", got)
	}
	req := buildKasmCloseRequest("captivo-kasm:7900", kasmAuth(s), "s1-2")
	if !strings.Contains(req, "Host: captivo-kasm:7900\r\nX-Kasm-Token: abc123\r\nContent-Length: 0") {
		t.Fatalf("close request = %q", req)
	}
}

// The token is written into raw HTTP requests to the broker: nothing but hex.
func TestKasmTokenFromHeader(t *testing.T) {
	if kasmTokenFromHeader("a1b2C3") != "a1b2C3" {
		t.Fatal("a hex token must be kept")
	}
	for _, bad := range []string{"", "abc\r\nX-Evil: 1", "abc def", strings.Repeat("a", 257), "zz"} {
		if kasmTokenFromHeader(bad) != "" {
			t.Fatalf("accepted %q", bad)
		}
	}
}

// A session's VNC websocket needs that session's password; the browser's own
// Authorization never reaches KasmVNC.
func TestSetKasmVNCAuth(t *testing.T) {
	r, _ := http.NewRequest(http.MethodGet, "http://x/websockify", nil)
	r.Header.Set("Authorization", "Basic forged")
	setKasmVNCAuth(r, true, "captivo:pw")
	if got := r.Header.Get("Authorization"); got != "Basic Y2FwdGl2bzpwdw==" {
		t.Fatalf("session request: %q", got)
	}
	r.Header.Set("Authorization", "Basic forged")
	setKasmVNCAuth(r, false, "captivo:pw")
	if r.Header.Get("Authorization") != "" {
		t.Fatal("the hub's static client gets no credential, and the browser's is dropped")
	}
}
