package main

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestVaultPublicKeyFromHeaderAcceptsOnlyA32ByteKey(t *testing.T) {
	ok := base64.StdEncoding.EncodeToString(make([]byte, 32))
	if vaultPublicKeyFromHeader(ok) != ok {
		t.Fatal("a 32-byte key is kept")
	}
	for _, bad := range []string{"", "x", base64.StdEncoding.EncodeToString(make([]byte, 31)), ok + "\r\nX: y"} {
		if vaultPublicKeyFromHeader(bad) != "" {
			t.Fatalf("accepted %q", bad)
		}
	}
}

func TestVaultPlaceholderIsUniqueAndUnmistakable(t *testing.T) {
	a, b := vaultPlaceholder(), vaultPlaceholder()
	if a == b || !strings.HasPrefix(a, "\x00captivo-vault:") || len(a) != len("\x00captivo-vault:")+32 {
		t.Fatalf("%q %q", a, b)
	}
}

// With a sealed secret the connect instruction carries the placeholder, never
// a secret the data-plane could hold.
func TestBuildConnectUsesThePlaceholderForASealedSecret(t *testing.T) {
	ph := vaultPlaceholder()
	got := string(buildConnect([]string{"hostname", "password"}, GuacConn{Hostname: "h", Secret: ph, SealedSecret: "cv1:x", SecretKind: "PASSWORD"}))
	if !strings.Contains(got, ph) {
		t.Fatalf("%q", got)
	}
}
