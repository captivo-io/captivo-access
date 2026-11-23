package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"os"
	"strings"
	"testing"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// A server holding the verifier accepts the proof the SCRAM client (dbproxy.go)
// computes from the password: the check PostgreSQL makes at sign-in.
func TestScramVerifierAcceptsTheClientsProof(t *testing.T) {
	v, err := scramVerifier("Röt4ted-pässword", []byte("0123456789abcdef"))
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(strings.TrimPrefix(v, "SCRAM-SHA-256$"), "$")
	iterSalt, keys := strings.Split(parts[0], ":"), strings.Split(parts[1], ":")
	if iterSalt[0] != "4096" || len(keys) != 2 {
		t.Fatalf("verifier %q", v)
	}
	stored, _ := base64.StdEncoding.DecodeString(keys[0])
	serverKey, _ := base64.StdEncoding.DecodeString(keys[1])

	c := newScramClient("Röt4ted-pässword")
	first := c.clientFirst()
	serverFirst := "r=" + c.nonce + "srv,s=" + iterSalt[1] + ",i=4096"
	final, err := c.clientFinal(serverFirst)
	if err != nil {
		t.Fatal(err)
	}
	proof, _ := base64.StdEncoding.DecodeString(final[strings.Index(final, ",p=")+3:])
	authMessage := strings.TrimPrefix(first, "n,,") + "," + serverFirst + "," + final[:strings.Index(final, ",p=")]
	sig := hmacSHA256(stored, authMessage)
	clientKey := make([]byte, len(proof))
	for i := range proof {
		clientKey[i] = proof[i] ^ sig[i]
	}
	if h := sha256.Sum256(clientKey); !hmac.Equal(h[:], stored) {
		t.Fatal("the stored key does not match the password")
	}
	if err := c.verify("v=" + base64.StdEncoding.EncodeToString(hmacSHA256(serverKey, authMessage))); err != nil {
		t.Fatal("the server key does not match the password")
	}
}

func TestMyStringQuotes(t *testing.T) {
	for in, want := range map[string]string{`plain`: `'plain'`, `it's`: `'it''s'`, `back\slash`: `'back\\slash'`} {
		if got := myString(in); got != want {
			t.Fatalf("%s -> %s", in, got)
		}
	}
	if pgIdent(`we"ird`) != `"we""ird"` {
		t.Fatal(pgIdent(`we"ird`))
	}
}

// Against real servers, when given: ROT_DB_ENGINE (postgres|mysql), ROT_DB_ADDR,
// ROT_DB_USER/ROT_DB_PASS (the account), ROT_DB_ADMIN/ROT_DB_ADMIN_PASS (the
// reconcile account), ROT_DB_TLS, ROT_DB_NAME. The account ends on the password
// the log names.
func TestRotateRealDatabase(t *testing.T) {
	addr := os.Getenv("ROT_DB_ADDR")
	if addr == "" {
		t.Skip("ROT_DB_ADDR not set")
	}
	ctx := context.Background()
	host, port, _ := strings.Cut(addr, ":")
	db := tunnel.RotateDB{Database: os.Getenv("ROT_DB_NAME"), TLS: os.Getenv("ROT_DB_TLS")}
	user, cur := os.Getenv("ROT_DB_USER"), os.Getenv("ROT_DB_PASS")
	target := func(rec *reconcileSecret) *dbAccountTarget {
		return &dbAccountTarget{engine: os.Getenv("ROT_DB_ENGINE"), host: host, port: port, username: user, db: db, reconcile: rec}
	}
	admin := &reconcileSecret{username: os.Getenv("ROT_DB_ADMIN"), secret: os.Getenv("ROT_DB_ADMIN_PASS")}

	// 1. The account changes its own password.
	next, _ := generatePassword(rotatedPassLen)
	r := applyRotation(ctx, target(nil), cur, next)
	if r.Outcome != "rotated" || r.Reconciled {
		t.Fatalf("self change: %+v", r)
	}
	if target(nil).check(ctx, cur).kind != authBad {
		t.Fatal("the old password still signs in")
	}
	t.Logf("self change: rotated")

	// 2. Changed outside Captivo: out of sync, and the reconcile account resets it.
	outside, _ := generatePassword(rotatedPassLen)
	if err := target(admin).reset(ctx, outside); err != nil {
		t.Fatal(err)
	}
	if v := verifyAccount(ctx, target(nil), next, ""); v.Outcome != "mismatch" || !v.OutOfSync {
		t.Fatalf("verify after an outside change: %+v", v)
	}
	if r := applyRotation(ctx, target(nil), next, cur); r.Outcome != "failed" || !r.OutOfSync {
		t.Fatalf("without a reconcile account: %+v", r)
	}
	final, _ := generatePassword(rotatedPassLen)
	r = applyRotation(ctx, target(admin), next, final)
	if r.Outcome != "rotated" || !r.Reconciled || !r.OutOfSync {
		t.Fatalf("reconcile: %+v", r)
	}
	t.Logf("reconciled; %s now: %s", user, final)
}
