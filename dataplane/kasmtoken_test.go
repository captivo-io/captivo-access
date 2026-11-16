package main

import (
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
