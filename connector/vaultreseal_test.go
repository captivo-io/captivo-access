package main

import (
	"crypto/ecdh"
	"crypto/rand"
	"testing"

	"github.com/kurtserdar/captivo-access/tunnel"
)

func TestResealCopiesASecretToOtherMembersForTheSameTarget(t *testing.T) {
	src, _ := ecdh.X25519().GenerateKey(rand.Reader)
	dst, _ := ecdh.X25519().GenerateKey(rand.Reader)
	aad := vaultTargetAAD("10.0.0.5", "3389", "admin")
	sealed := sealForTest(t, src.PublicKey(), "pw-Ü", aad)
	out := reseal(src, tunnel.ResealRequest{Items: []tunnel.ResealItem{
		{ID: "a", Sealed: sealed, Host: "10.0.0.5", Port: "3389", Username: "admin", To: []string{vaultPublicKeyB64(dst), vaultPublicKeyB64(src)}},
		// Claimed for another target: the seal does not open, nothing is copied.
		{ID: "b", Sealed: sealed, Host: "203.0.113.9", Port: "3389", Username: "admin", To: []string{vaultPublicKeyB64(dst)}},
	}})
	if out.Error != "" || len(out.Items) != 2 {
		t.Fatalf("unexpected response %+v", out)
	}
	a := out.Items[0]
	if a.Error != "" || len(a.Seals) != 1 {
		t.Fatalf("item a: %+v (its own key is skipped)", a)
	}
	got, err := openSealed(dst, a.Seals[vaultPublicKeyB64(dst)], aad)
	if err != nil || got != "pw-Ü" {
		t.Fatalf("the copy opens for the newcomer: %q %v", got, err)
	}
	if _, err := openSealed(dst, a.Seals[vaultPublicKeyB64(dst)], vaultTargetAAD("203.0.113.9", "3389", "admin")); err == nil {
		t.Fatal("the copy stays bound to its target")
	}
	if b := out.Items[1]; b.Error == "" || len(b.Seals) != 0 {
		t.Fatalf("item b must be refused: %+v", b)
	}
}

func TestResealRefusesWithoutAKeyAndBadRecipients(t *testing.T) {
	if out := reseal(nil, tunnel.ResealRequest{}); out.Error == "" {
		t.Fatal("no vault key: refused")
	}
	k, _ := ecdh.X25519().GenerateKey(rand.Reader)
	aad := vaultTargetAAD("h", "22", "u")
	sealed := sealForTest(t, k.PublicKey(), "x", aad)
	out := reseal(k, tunnel.ResealRequest{Items: []tunnel.ResealItem{{ID: "a", Sealed: sealed, Host: "h", Port: "22", Username: "u", To: []string{"not-a-key"}}}})
	if out.Items[0].Error == "" || out.Items[0].Seals != nil {
		t.Fatalf("a bad recipient key fails the item: %+v", out.Items[0])
	}
	many := make([]string, maxResealTo+1)
	out = reseal(k, tunnel.ResealRequest{Items: []tunnel.ResealItem{{ID: "a", Sealed: sealed, Host: "h", Port: "22", Username: "u", To: many}}})
	if out.Items[0].Error == "" {
		t.Fatal("too many recipients: refused")
	}
}
