package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

func TestSSHCAKeyFromHeader(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	s, _ := ssh.NewSignerFromKey(priv)
	line := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(s.PublicKey())))
	if got := sshCAKeyFromHeader(line); got != line {
		t.Fatalf("a good key must pass: %q", got)
	}
	for name, v := range map[string]string{
		"empty":      "",
		"comment":    line + " ana@acme",
		"two keys":   line + "\n" + line,
		"garbage":    "ssh-ed25519 AAAA",
		"newline":    line + "\nssh-rsa AAAA",
		"other type": "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBAAA",
	} {
		if got := sshCAKeyFromHeader(v); got != "" {
			t.Errorf("%s must be refused, got %q", name, got)
		}
	}
}
