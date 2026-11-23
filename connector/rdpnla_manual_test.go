package main

import (
	"os"
	"testing"
)

// Against a real RDP server: RDP_TEST_ADDR=host:port RDP_TEST_USER=... RDP_TEST_PASS=...
func TestManualRDPSignIn(t *testing.T) {
	addr := os.Getenv("RDP_TEST_ADDR")
	if addr == "" {
		t.Skip("RDP_TEST_ADDR not set")
	}
	if _, err := rdpSignIn(addr, os.Getenv("RDP_TEST_USER"), "wrong-password"); err == nil {
		t.Fatal("a wrong password was accepted")
	} else {
		t.Logf("wrong password: %v", err)
	}
	s, err := rdpSignIn(addr, os.Getenv("RDP_TEST_USER"), os.Getenv("RDP_TEST_PASS"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.conn.Close()
	t.Logf("signed in, protocol %d, flags %#x, certificate %s", s.selected, s.negFlags, s.fingerprint)
}
