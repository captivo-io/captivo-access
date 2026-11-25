package main

import (
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
	"golang.org/x/crypto/ssh"
)

func withCA(t *testing.T) ssh.Signer {
	t.Helper()
	ca, err := loadOrCreateSSHCA(filepath.Join(t.TempDir(), "ssh-ca.key"))
	if err != nil {
		t.Fatal(err)
	}
	old := sshCA
	sshCA = ca
	t.Cleanup(func() { sshCA = old })
	return ca
}

func TestSSHCAKeyIsKeptAndNeverReplaced(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ca.key")
	a, err := loadOrCreateSSHCA(path)
	if err != nil {
		t.Fatal(err)
	}
	b, err := loadOrCreateSSHCA(path)
	if err != nil || string(a.PublicKey().Marshal()) != string(b.PublicKey().Marshal()) {
		t.Fatalf("a second load must return the same key: %v", err)
	}
	if err := os.WriteFile(path, []byte("garbage"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadOrCreateSSHCA(path); err == nil {
		t.Fatal("a malformed key file must be refused, not replaced")
	}
}

func TestSSHCAPublicLineIsAnAuthorizedKey(t *testing.T) {
	ca := withCA(t)
	line := sshCAPublicLine()
	if !strings.HasPrefix(line, "ssh-ed25519 ") || strings.ContainsAny(line, "\r\n") {
		t.Fatalf("line %q", line)
	}
	pk, _, _, _, err := ssh.ParseAuthorizedKey([]byte(line))
	if err != nil || string(pk.Marshal()) != string(ca.PublicKey().Marshal()) {
		t.Fatalf("does not round-trip: %v", err)
	}
}

func TestSshSignsInWithACertificateAndTheServerSeesWho(t *testing.T) {
	ca := withCA(t)
	k, _ := ecdh.X25519().GenerateKey(rand.Reader)
	old := vaultKey
	vaultKey = k
	defer func() { vaultKey = old }()
	tg := newSSHTarget(t, "", nil)
	tg.ca = ca.PublicKey()
	host, port, _ := net.SplitHostPort(tg.addr)
	sealed := sealForTest(t, k.PublicKey(), refPrefix+`{"provider":"sshca"}`, vaultTargetAAD(host, port, "ops"))

	resp, c := dialThroughConnector(t, tunnel.SshDialRequest{Host: host, Port: port, Username: "ops", Sealed: sealed, SecretKind: "PASSWORD", KeyID: "captivo:ana@acme.com"})
	if c == nil {
		t.Fatalf("refused: %+v", resp)
	}
	defer c.Close()
	if out, _, _ := runExec(t, c, "id"); out != "ran: id\n" {
		t.Fatalf("exec %q", out)
	}
	tg.mu.Lock()
	defer tg.mu.Unlock()
	if len(tg.keyIDs) != 1 || tg.keyIDs[0] != "captivo:ana@acme.com" {
		t.Fatalf("the server saw key ids %v", tg.keyIDs)
	}
}

func TestSshCertificateIsRefusedByAServerThatDoesNotTrustTheCA(t *testing.T) {
	withCA(t)
	k, _ := ecdh.X25519().GenerateKey(rand.Reader)
	old := vaultKey
	vaultKey = k
	defer func() { vaultKey = old }()
	other, _, _ := ed25519.GenerateKey(rand.Reader)
	otherPub, _ := ssh.NewPublicKey(other)
	tg := newSSHTarget(t, "", nil)
	tg.ca = otherPub
	host, port, _ := net.SplitHostPort(tg.addr)
	sealed := sealForTest(t, k.PublicKey(), refPrefix+`{"provider":"sshca"}`, vaultTargetAAD(host, port, "ops"))
	resp, c := dialThroughConnector(t, tunnel.SshDialRequest{Host: host, Port: port, Username: "ops", Sealed: sealed})
	if c != nil || resp.Error == "" {
		t.Fatalf("an untrusted CA must be refused: %+v", resp)
	}
}

func TestCertificateIsForOneAccountAndShortLived(t *testing.T) {
	ca := withCA(t)
	auth, err := sshCertAuth("deploy", "captivo:x\nforged")
	if err != nil || len(auth) != 1 {
		t.Fatal(err)
	}
	// Read the certificate back through a server that records it.
	var got *ssh.Certificate
	_, hpriv, _ := ed25519.GenerateKey(rand.Reader)
	hk, _ := ssh.NewSignerFromKey(hpriv)
	cfg := &ssh.ServerConfig{PublicKeyCallback: func(cm ssh.ConnMetadata, k ssh.PublicKey) (*ssh.Permissions, error) {
		got, _ = k.(*ssh.Certificate)
		return nil, nil
	}}
	cfg.AddHostKey(hk)
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	defer ln.Close()
	go func() {
		c, err := ln.Accept()
		if err == nil {
			_, _, _, _ = ssh.NewServerConn(c, cfg)
		}
	}()
	cl, _, err := sshSignIn(ln.Addr().String(), "deploy", auth, "")
	if err != nil {
		t.Fatal(err)
	}
	cl.Close()
	if got == nil {
		t.Fatal("no certificate offered")
	}
	if len(got.ValidPrincipals) != 1 || got.ValidPrincipals[0] != "deploy" || got.CertType != ssh.UserCert {
		t.Fatalf("principals %v type %d", got.ValidPrincipals, got.CertType)
	}
	if strings.ContainsAny(got.KeyId, "\n\r") {
		t.Fatalf("key id %q has a line break", got.KeyId)
	}
	life := time.Duration(got.ValidBefore-got.ValidAfter) * time.Second
	if life > sshCertValidFor+sshCertSkew+time.Second {
		t.Fatalf("valid for %s", life)
	}
	if string(got.SignatureKey.Marshal()) != string(ca.PublicKey().Marshal()) {
		t.Fatal("not signed by the CA")
	}
	if _, ok := got.Extensions["permit-agent-forwarding"]; ok {
		t.Fatal("agent forwarding must not be offered")
	}
}

func TestSecretOpenersKeepCertificateSignInToSSH(t *testing.T) {
	withCA(t)
	k, _ := ecdh.X25519().GenerateKey(rand.Reader)
	aad := vaultTargetAAD("10.0.0.5", "22", "ops")
	sealed := sealForTest(t, k.PublicKey(), refPrefix+`{"provider":"sshca"}`, aad)
	if _, err := openSecret(k, sealed, aad); err == nil {
		t.Fatal("a database, gateway or kubernetes sign-in must not take the certificate marker as a password")
	}
	if got, err := openSecretOrCA(k, sealed, aad); err != nil || got != sshCAMarker {
		t.Fatalf("got %q %v", got, err)
	}
}

func TestVerifyCertSignIn(t *testing.T) {
	ca := withCA(t)
	k, _ := ecdh.X25519().GenerateKey(rand.Reader)
	tg := newSSHTarget(t, "", nil)
	tg.ca = ca.PublicKey()
	host, port, _ := net.SplitHostPort(tg.addr)
	aad := vaultTargetAAD(host, port, "ops")
	cur := sealForTest(t, k.PublicKey(), refPrefix+`{"provider":"sshca"}`, aad)
	allow := &TargetMatcher{open: true}
	r := rotate(t.Context(), k, allow, tunnel.RotateRequest{Op: "verify", Method: "ref", Host: host, Port: port, Username: "ops", Current: cur})
	if r.Outcome != "ok" {
		t.Fatalf("a trusted CA must verify: %+v", r)
	}
	tg.ca = nil
	r = rotate(t.Context(), k, allow, tunnel.RotateRequest{Op: "verify", Method: "ref", Host: host, Port: port, Username: "ops", Current: cur})
	if r.Outcome != "mismatch" || !strings.Contains(r.Detail, "TrustedUserCAKeys") {
		t.Fatalf("an untrusting server must say how to fix it: %+v", r)
	}
	if r := rotate(t.Context(), k, allow, tunnel.RotateRequest{Op: "apply", Method: "ref", Host: host, Port: port, Username: "ops", Current: cur}); r.Error == "" {
		t.Fatal("a certificate sign-in is never rotated")
	}
}
