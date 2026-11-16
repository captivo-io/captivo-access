package main

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestKasmTokenHeader(t *testing.T) {
	old := kasmTokenFile
	defer func() { kasmTokenFile = old }()

	kasmTokenFile = filepath.Join(t.TempDir(), "missing")
	if h := kasmTokenHeader(http.Header{}); h.Get("X-Kasm-Control-Token") != "" {
		t.Fatal("no file, no header")
	}
	kasmTokenFile = filepath.Join(t.TempDir(), "token")
	_ = os.WriteFile(kasmTokenFile, []byte("ab12cd\n"), 0o644)
	h := kasmTokenHeader(http.Header{"Authorization": {"Bearer x"}})
	if h.Get("X-Kasm-Control-Token") != "ab12cd" || h.Get("Authorization") != "Bearer x" {
		t.Fatalf("headers = %v", h)
	}
}
