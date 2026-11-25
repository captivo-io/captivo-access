package main

import (
	"crypto/ecdh"
	"crypto/rand"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// A real OpenSSH server that trusts the connector's CA (TrustedUserCAKeys).
// Run by hand against a container:
//
//	SSHCA_E2E_KEY=/tmp/ca.key go test -run SSHCAE2E     # writes /tmp/ca.key.pub and stops
//	... start sshd with that line in TrustedUserCAKeys ...
//	SSHCA_E2E_KEY=/tmp/ca.key SSHCA_E2E_ADDR=127.0.0.1:2222 SSHCA_E2E_USER=tester go test -run SSHCAE2E -v
func TestSSHCAE2E(t *testing.T) {
	keyFile := os.Getenv("SSHCA_E2E_KEY")
	if keyFile == "" {
		t.Skip("SSHCA_E2E_KEY not set")
	}
	ca, err := loadOrCreateSSHCA(keyFile)
	if err != nil {
		t.Fatal(err)
	}
	old := sshCA
	sshCA = ca
	defer func() { sshCA = old }()
	if err := os.WriteFile(keyFile+".pub", []byte(sshCAPublicLine()+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	addr := os.Getenv("SSHCA_E2E_ADDR")
	if addr == "" {
		t.Skip("wrote " + filepath.Base(keyFile) + ".pub; start the server, then set SSHCA_E2E_ADDR")
	}
	user := os.Getenv("SSHCA_E2E_USER")
	host, port, _ := net.SplitHostPort(addr)
	k, _ := ecdh.X25519().GenerateKey(rand.Reader)
	oldKey := vaultKey
	vaultKey = k
	defer func() { vaultKey = oldKey }()
	sealed := sealForTest(t, k.PublicKey(), refPrefix+`{"provider":"sshca"}`, vaultTargetAAD(host, port, user))

	resp, c := dialThroughConnector(t, tunnel.SshDialRequest{Host: host, Port: port, Username: user, Sealed: sealed, KeyID: "captivo:ana@acme.com"})
	if c == nil {
		t.Fatalf("the server refused the certificate: %+v", resp)
	}
	defer c.Close()
	out, _, code := runExec(t, c, "id -un")
	if code != 0 || strings.TrimSpace(out) != user {
		t.Fatalf("ran as %q (exit %d), want %q", out, code, user)
	}

	// A certificate from a CA the server does not trust is refused.
	stranger, err := loadOrCreateSSHCA(filepath.Join(t.TempDir(), "other.key"))
	if err != nil {
		t.Fatal(err)
	}
	sshCA = stranger
	r2, c2 := dialThroughConnector(t, tunnel.SshDialRequest{Host: host, Port: port, Username: user, Sealed: sealed})
	if c2 != nil {
		c2.Close()
		t.Fatal("a certificate from an untrusted CA must be refused")
	}
	if r2.Error == "" {
		t.Fatal("expected an error")
	}
}
