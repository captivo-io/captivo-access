package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// sealForTest mirrors src/lib/vault/seal.ts.
func sealForTest(t *testing.T, pub *ecdh.PublicKey, secret string, aad []byte) string {
	t.Helper()
	eph, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	shared, err := eph.ECDH(pub)
	if err != nil {
		t.Fatal(err)
	}
	salt := append(append([]byte{}, eph.PublicKey().Bytes()...), pub.Bytes()...)
	block, _ := aes.NewCipher(hkdfSHA256(shared, salt, []byte(vaultHKDFInfo)))
	gcm, _ := cipher.NewGCM(block)
	nonce := make([]byte, 12)
	_, _ = rand.Read(nonce)
	raw := append(append(eph.PublicKey().Bytes(), nonce...), gcm.Seal(nil, nonce, []byte(secret), aad)...)
	return vaultSealPrefix + base64.StdEncoding.EncodeToString(raw)
}

func TestVaultKeyIsKeptAcrossRestartsAndNeverReplaced(t *testing.T) {
	p := filepath.Join(t.TempDir(), "vault.key")
	a, err := loadOrCreateVaultKey(p)
	if err != nil {
		t.Fatal(err)
	}
	if fi, _ := os.Stat(p); fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", fi.Mode().Perm())
	}
	b, err := loadOrCreateVaultKey(p)
	if err != nil || !bytes.Equal(a.Bytes(), b.Bytes()) {
		t.Fatal("a restart must reuse the key")
	}
	_ = os.WriteFile(p, []byte("short"), 0o600)
	if _, err := loadOrCreateVaultKey(p); err == nil {
		t.Fatal("a malformed key file must be an error, not replaced")
	}
}

func TestSealedSecretOpensOnlyWithThisKeyAndForItsTarget(t *testing.T) {
	k, _ := ecdh.X25519().GenerateKey(rand.Reader)
	other, _ := ecdh.X25519().GenerateKey(rand.Reader)
	aad := vaultTargetAAD("10.0.0.5", "3389", "admin")
	sealed := sealForTest(t, k.PublicKey(), "s3cr3t-Ünïcode", aad)
	if got, err := openSealed(k, sealed, aad); err != nil || got != "s3cr3t-Ünïcode" {
		t.Fatalf("open: %q %v", got, err)
	}
	if _, err := openSealed(k, sealed, vaultTargetAAD("10.0.0.6", "3389", "admin")); err == nil {
		t.Fatal("a secret must not open for another host")
	}
	if _, err := openSealed(other, sealed, aad); err == nil {
		t.Fatal("another connector's key must not open it")
	}
	if _, err := openSealed(nil, sealed, aad); err == nil {
		t.Fatal("no key, no secret")
	}
	if _, err := openSealed(k, "plain", aad); err == nil {
		t.Fatal("unsealed input is refused")
	}
}

// runSealed drives one handshake through a sealedRelay: guacd's output and the
// data-plane's input are given, and what guacd receives is returned.
func runSealed(t *testing.T, k *ecdh.PrivateKey, sealed, ph string, fromGuacd, fromDataplane string) (string, error) {
	t.Helper()
	sr := newSealedRelay(k, sealed, ph)
	var toDP, toGuacd bytes.Buffer
	if err := sr.fromGuacd(&toDP, strings.NewReader(fromGuacd)); err != nil {
		t.Fatal(err)
	}
	if toDP.String() != fromGuacd {
		t.Fatalf("guacd's side must pass unchanged: %q", toDP.String())
	}
	err := sr.toGuacd(&toGuacd, strings.NewReader(fromDataplane))
	return toGuacd.String(), err
}

func TestSealedRelayOpensTheSecretForTheRealTargetOnly(t *testing.T) {
	k, _ := ecdh.X25519().GenerateKey(rand.Reader)
	ph := "\x00captivo-vault:abc"
	sealed := sealForTest(t, k.PublicKey(), "pässwörd,;.", vaultTargetAAD("10.0.0.5", "3389", "admin"))
	args := string(encodeGuacInstruction([]string{"args", "VERSION_1_5_0", "hostname", "port", "username", "password", "domain"})) + "4.sync,1.1;"
	head := string(encodeGuacInstruction([]string{"select", "rdp"})) + string(encodeGuacInstruction([]string{"size", "1280", "800", "96"}))
	tail := "4.sync,3.123;" + "3.key," + ph[:3] // later traffic passes untouched, even partial

	got, err := runSealed(t, k, sealed, ph, args, head+string(encodeGuacInstruction([]string{"connect", "VERSION_1_5_0", "10.0.0.5", "3389", "admin", ph, ""}))+tail)
	if err != nil {
		t.Fatal(err)
	}
	want := head + "7.connect,13.VERSION_1_5_0,8.10.0.0.5,4.3389,5.admin,11.pässwörd,;.,0.;" + tail
	if got != want {
		t.Fatalf("got  %q\nwant %q", got, want)
	}

	// A data-plane pointing the session at another host gets nothing to guacd.
	got, err = runSealed(t, k, sealed, ph, args, head+string(encodeGuacInstruction([]string{"connect", "VERSION_1_5_0", "203.0.113.9", "3389", "admin", ph, ""})))
	if err == nil || strings.Contains(got, "pässwörd") || strings.Contains(got, "connect") {
		t.Fatalf("other host: err=%v sent=%q", err, got)
	}
	// Nor one that puts the placeholder in a field guacd would echo or log.
	got, err = runSealed(t, k, sealed, ph, args, head+string(encodeGuacInstruction([]string{"connect", "VERSION_1_5_0", "10.0.0.5", "3389", "admin", "", ph})))
	if err == nil || strings.Contains(got, "pässwörd") {
		t.Fatalf("placeholder in domain: err=%v sent=%q", err, got)
	}
	// Nor a connect whose values do not line up with guacd's args.
	_, err = runSealed(t, k, sealed, ph, args, head+string(encodeGuacInstruction([]string{"connect", "10.0.0.5", "3389", "admin", ph})))
	if err == nil {
		t.Fatal("a misaligned connect must be refused")
	}
}

// testdata/vault_vector.json was sealed by src/lib/vault/seal.ts (the browser
// side) to a test key; this side must open it. Regenerate both together if the
// format changes.
func TestOpensASecretSealedByTheBrowserCode(t *testing.T) {
	raw, err := os.ReadFile("testdata/vault_vector.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		PrivateKeyHex, Sealed, Host, Port, Username, Secret string
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	b, _ := hex.DecodeString(v.PrivateKeyHex)
	k, err := ecdh.X25519().NewPrivateKey(b)
	if err != nil {
		t.Fatal(err)
	}
	got, err := openSealed(k, v.Sealed, vaultTargetAAD(v.Host, v.Port, v.Username))
	if err != nil || got != v.Secret {
		t.Fatalf("got %q err %v", got, err)
	}
}
