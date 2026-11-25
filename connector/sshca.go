package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/binary"
	"encoding/pem"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
	"golang.org/x/crypto/ssh"
)

// SSH certificate sign-in (zero standing credential). A resource set to "sign
// in with a certificate" has no password or key anywhere: this connector holds
// a certificate authority key, the resource's sshd trusts its public half
// (TrustedUserCAKeys), and every sign-in gets a fresh key pair and a
// certificate that is valid for a couple of minutes, for that one account.
// Nothing a person could copy exists before or after the session.
//
// The CA key never leaves this host, like the vault key; losing the /data
// volume means the servers must be told the new public key.

var sshCA ssh.Signer // set in main; nil = certificate sign-in is refused

const (
	// A certificate only has to outlive the handshake; the session goes on after it expires.
	sshCertValidFor = 2 * time.Minute
	sshCertSkew     = time.Minute
	// What the "sshca" reference seals: it names the sign-in, there is nothing to look up.
	sshCAMarker = "captivo-sshca1"
)

// loadOrCreateSSHCA returns the connector's CA key, generating it on first
// use. A malformed file is an error rather than something to replace: a new
// key would silently stop every server that trusts the old one.
func loadOrCreateSSHCA(path string) (ssh.Signer, error) {
	b, err := os.ReadFile(path)
	if err == nil {
		blk, _ := pem.Decode(b)
		if blk == nil {
			return nil, fmt.Errorf("ssh CA key %s is not PEM: refusing to replace it (servers trust its public half)", path)
		}
		k, kerr := x509.ParsePKCS8PrivateKey(blk.Bytes)
		if kerr != nil {
			return nil, fmt.Errorf("ssh CA key %s is malformed (%v): refusing to replace it (servers trust its public half)", path, kerr)
		}
		return ssh.NewSignerFromKey(k)
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0o600); err != nil {
		return nil, err
	}
	return ssh.NewSignerFromKey(priv)
}

// sshCAPublicLine is the CA's public key as one authorized_keys-style line,
// what an admin puts in the server's TrustedUserCAKeys file. "" without a CA.
func sshCAPublicLine() string {
	if sshCA == nil {
		return ""
	}
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(sshCA.PublicKey())))
}

// sshCertAuth signs a fresh key pair as a certificate for user, good for a
// couple of minutes. keyID is what the server's log shows for the sign-in
// ("Accepted publickey for deploy ... ID captivo:ana@acme.com").
func sshCertAuth(user, keyID string) ([]ssh.AuthMethod, error) {
	if sshCA == nil {
		return nil, errors.New("this connector has no SSH certificate authority; update it")
	}
	if user == "" {
		return nil, errors.New("no account name to sign a certificate for")
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	pk, err := ssh.NewPublicKey(pub)
	if err != nil {
		return nil, err
	}
	var serial [8]byte
	if _, err := rand.Read(serial[:]); err != nil {
		return nil, err
	}
	now := time.Now()
	cert := &ssh.Certificate{
		Key:             pk,
		Serial:          binary.BigEndian.Uint64(serial[:]),
		CertType:        ssh.UserCert,
		KeyId:           certKeyID(keyID),
		ValidPrincipals: []string{user},
		ValidAfter:      uint64(now.Add(-sshCertSkew).Unix()),
		ValidBefore:     uint64(now.Add(sshCertValidFor).Unix()),
		// A terminal and nothing else: no agent, X11 or port forwarding. The data
		// plane refuses those anyway; the certificate does not offer them either.
		Permissions: ssh.Permissions{Extensions: map[string]string{"permit-pty": ""}},
	}
	if err := cert.SignCert(rand.Reader, sshCA); err != nil {
		return nil, err
	}
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		return nil, err
	}
	cs, err := ssh.NewCertSigner(cert, signer)
	if err != nil {
		return nil, err
	}
	return []ssh.AuthMethod{ssh.PublicKeys(cs)}, nil
}

// certKeyID keeps the identity short and printable: it lands in the server's log.
func certKeyID(s string) string {
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s)
	if len(s) > 120 {
		s = s[:120]
	}
	if s == "" {
		return "captivo"
	}
	return s
}

// verifyCertSignIn is "Check now" for a certificate sign-in: sign a
// certificate and really sign in with it, then leave. The server's host key
// is not pinned here; the check says only whether the CA is trusted.
func verifyCertSignIn(allow *TargetMatcher, req tunnel.RotateRequest) tunnel.RotateResponse {
	addr := net.JoinHostPort(req.Host, req.Port)
	if !egressAllowed(allow, addr) {
		return tunnel.RotateResponse{Outcome: "mismatch", Detail: "target not allowed by this connector"}
	}
	auth, err := sshCertAuth(req.Username, "captivo:check")
	if err != nil {
		return tunnel.RotateResponse{Outcome: "mismatch", Detail: err.Error()}
	}
	c, _, err := sshSignIn(addr, req.Username, auth, "")
	if err != nil {
		if strings.Contains(err.Error(), "unable to authenticate") {
			return tunnel.RotateResponse{Outcome: "mismatch", Detail: "the server did not accept the certificate: it must list this connector's CA in TrustedUserCAKeys and allow the account " + req.Username}
		}
		return tunnel.RotateResponse{Outcome: "mismatch", Detail: sshSignInError(err)}
	}
	c.Close()
	return tunnel.RotateResponse{Outcome: "ok"}
}
