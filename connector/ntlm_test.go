package main

import (
	"encoding/hex"
	"testing"
)

func unhex(s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		panic(err)
	}
	return b
}

// The NTLMv2 example of MS-NLMP 4.2.4: user "User", domain "Domain",
// password "Password", the server's challenge 0123456789abcdef.
func TestNTLMv2SpecExample(t *testing.T) {
	key := ntowfv2("User", "Password", "Domain")
	if hex.EncodeToString(key) != "0c868a403bfd7a93a3001ef22ef02e3f" {
		t.Fatalf("NTOWFv2 %x", key)
	}
	temp := unhex("01010000000000000000000000000000aaaaaaaaaaaaaaaa00000000" +
		"02000c0044006f006d00610069006e0001000c005300650072007600650072000000000000000000")
	proof := hmacMD5(key, unhex("0123456789abcdef"), temp)
	if hex.EncodeToString(proof) != "68cd0ab851e51c96aabc927bebef6a1c" {
		t.Fatalf("NTProofStr %x", proof)
	}
	if base := hmacMD5(key, proof); hex.EncodeToString(base) != "8de40ccadbc14a82f15cb0ad0de95ca3" {
		t.Fatalf("SessionBaseKey %x", base)
	}
	n := &ntlmClient{}
	n.setKeys(unhex("55555555555555555555555555555555"))
	if hex.EncodeToString(n.signOut) != "4788dc861b4782f35d43fd98fe1a2d39" {
		t.Fatalf("signing key %x", n.signOut)
	}
	sealed := n.seal(utf16le("Plaintext"))
	if got := hex.EncodeToString(sealed[16:]); got != "54e50165bf1936dc996020c1811b0f06fb5f" {
		t.Fatalf("sealed %s", got)
	}
	if got := hex.EncodeToString(sealed[:16]); got != "010000007fb38ec5c55d497600000000" {
		t.Fatalf("signature %s", got)
	}
}

// Both ends with the same keys: what the client seals, a server with the
// mirrored keys opens, and a changed byte is caught.
func TestNTLMSealRoundTrip(t *testing.T) {
	c := &ntlmClient{}
	c.setKeys(unhex("00112233445566778899aabbccddeeff"))
	s := &ntlmClient{}
	s.setKeys(unhex("00112233445566778899aabbccddeeff"))
	s.sealIn, s.signIn = s.sealOut, s.signOut // the server reads with the client-to-server keys
	msg := c.seal([]byte("hello server"))
	got, err := s.unseal(msg)
	if err != nil || string(got) != "hello server" {
		t.Fatalf("%q %v", got, err)
	}
	bad := c.seal([]byte("second"))
	bad[20] ^= 1
	if _, err := s.unseal(bad); err == nil {
		t.Fatal("a changed message was accepted")
	}
}
