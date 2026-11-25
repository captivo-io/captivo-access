package main

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jfjallid/go-smb/msdtyp"
	"github.com/kurtserdar/captivo-access/tunnel"
)

func TestFiletimeToTime(t *testing.T) {
	if !filetimeToTime(msdtypFiletime(0)).IsZero() || !filetimeToTime(msdtypFiletime(0x7fffffffffffffff)).IsZero() {
		t.Fatal("zero and never are no time")
	}
	// 2020-01-01T00:00:00Z
	got := filetimeToTime(msdtypFiletime(132223104000000000))
	if got.UTC().Format(time.RFC3339) != "2020-01-01T00:00:00Z" {
		t.Fatalf("%s", got.UTC())
	}
}

func TestWindowsElevationRefusesWhatItCannotDo(t *testing.T) {
	old := vaultKey
	vaultKey = nil
	defer func() { vaultKey = old }()
	allow := &TargetMatcher{open: true}
	if _, err := elevateAccount(t.Context(), allow, elevSpec{platform: "windows", host: "h", port: "3389", account: "alice"}); err == nil {
		t.Fatal("no administrator account")
	}
	if _, err := elevateAccount(t.Context(), allow, elevSpec{platform: "windows", host: "h", port: "3389", account: "alice", admin: &tunnel.RotateReconcile{Host: "other", Port: "3389", Username: "Administrator"}}); err == nil || !strings.Contains(err.Error(), "another host") {
		t.Fatalf("a seal for another host must be refused: %v", err)
	}
	if _, err := elevateAccount(t.Context(), allow, elevSpec{platform: "plan9", host: "h", port: "1", account: "a", admin: &tunnel.RotateReconcile{Host: "h", Port: "1", Username: "x"}}); err == nil {
		t.Fatal("unknown platform")
	}
}

// A Windows (or Samba) SMB server with a local account and an administrator:
// ROT_WIN_ADDR host:port (the SMB port), ROT_WIN_USER, ROT_WIN_ADMIN, ROT_WIN_ADMIN_PASS.
func TestWindowsDiscoverAndElevateE2E(t *testing.T) {
	addr := os.Getenv("ROT_WIN_ADDR")
	if addr == "" {
		t.Skip("ROT_WIN_ADDR not set")
	}
	host, port, _ := net.SplitHostPort(addr)
	windowsSMBPort = port
	user, admin, pass := os.Getenv("ROT_WIN_USER"), os.Getenv("ROT_WIN_ADMIN"), os.Getenv("ROT_WIN_ADMIN_PASS")
	rec := &reconcileSecret{username: admin, secret: pass}
	ctx := context.Background()

	r := discoverWindows(ctx, &windowsTarget{host: host, port: port, reconcile: rec})
	if r.Error != "" {
		t.Fatal(r.Error)
	}
	var found *tunnel.DiscoveredAccount
	for i := range r.Accounts {
		if r.Accounts[i].Name == user {
			found = &r.Accounts[i]
		}
	}
	if found == nil || !found.Login || found.Admin {
		t.Fatalf("the ordinary account is missing or already an administrator: %+v of %d", found, len(r.Accounts))
	}

	wt, _ := newWindowsTarget(host, user, rec)
	e := &windowsElev{t: wt}
	had, err := e.grant(ctx)
	if err != nil || had {
		t.Fatalf("grant: %v (had %v)", err, had)
	}
	after := discoverWindows(ctx, &windowsTarget{host: host, port: port, reconcile: rec})
	isAdmin := false
	for _, a := range after.Accounts {
		if a.Name == user {
			isAdmin = a.Admin
		}
	}
	if !isAdmin {
		t.Fatal("the account is not an administrator during the session")
	}
	// Granting twice (a second session) finds it already a member.
	if had, err := e.grant(ctx); err != nil || !had {
		t.Fatalf("second grant: %v (had %v)", err, had)
	}
	if err := e.revoke(ctx); err != nil {
		t.Fatal(err)
	}
	final := discoverWindows(ctx, &windowsTarget{host: host, port: port, reconcile: rec})
	for _, a := range final.Accounts {
		if a.Name == user && a.Admin {
			t.Fatal("still an administrator after the session")
		}
	}
	if err := e.revoke(ctx); err != nil {
		t.Fatalf("taking away what is not there is not an error: %v", err)
	}
}

func msdtypFiletime(v uint64) msdtyp.Filetime {
	return msdtyp.Filetime{LowDateTime: uint32(v), HighDateTime: uint32(v >> 32)}
}

// A connector that stopped with rights given takes them away when it starts.
func TestElevationJournalRecoversRightsAStoppedConnectorLeft(t *testing.T) {
	addr := os.Getenv("ROT_WIN_ADDR")
	if addr == "" {
		t.Skip("ROT_WIN_ADDR not set")
	}
	host, port, _ := net.SplitHostPort(addr)
	windowsSMBPort = port
	user, admin, pass := os.Getenv("ROT_WIN_USER"), os.Getenv("ROT_WIN_ADMIN"), os.Getenv("ROT_WIN_ADMIN_PASS")
	k, _ := ecdh.X25519().GenerateKey(rand.Reader)
	old, oldPath := vaultKey, journal.path
	vaultKey = k
	journal.path = t.TempDir() + "/elevations.json"
	defer func() { vaultKey, journal.path = old, oldPath }()

	sp := elevSpec{platform: "windows", host: host, port: "3389", account: user, admin: &tunnel.RotateReconcile{Host: host, Port: "3389", Username: admin, Sealed: sealForTest(t, k.PublicKey(), pass, vaultReconcileAAD(host, "3389", admin))}}
	allow := &TargetMatcher{open: true}
	ops, _, err := sp.ops(allow)
	if err != nil {
		t.Fatal(err)
	}
	if err := journalAdd(sp); err != nil {
		t.Fatal(err)
	}
	if _, err := ops.grant(t.Context()); err != nil { // ... and the connector stops here
		t.Fatal(err)
	}
	if n := len(journalRead()); n != 1 {
		t.Fatalf("journal has %d entries", n)
	}
	recoverElevations(allow)
	if n := len(journalRead()); n != 0 {
		t.Fatalf("the journal still has %d entries", n)
	}
	r := discoverWindows(t.Context(), &windowsTarget{host: host, port: port, reconcile: &reconcileSecret{username: admin, secret: pass}})
	for _, a := range r.Accounts {
		if a.Name == user && a.Admin {
			t.Fatal("still an administrator after the restart")
		}
	}
}

// Taking a Windows account over: its saved password is a placeholder, so the
// rotation resets it through the administrator account.
func TestTakeOverWindowsE2E(t *testing.T) {
	addr := os.Getenv("ROT_WIN_ADDR")
	if addr == "" {
		t.Skip("ROT_WIN_ADDR not set")
	}
	host, port, _ := net.SplitHostPort(addr)
	windowsSMBPort = port
	user, admin, pass := os.Getenv("ROT_WIN_USER"), os.Getenv("ROT_WIN_ADMIN"), os.Getenv("ROT_WIN_ADMIN_PASS")
	k, _ := ecdh.X25519().GenerateKey(rand.Reader)
	pub := vaultPublicKeyB64(k)
	aad := vaultTargetAAD(host, "3389", user)
	cur := sealForTest(t, k.PublicKey(), "placeholder-not-the-password", aad)
	rec := &tunnel.RotateReconcile{Host: host, Port: "3389", Username: admin, Sealed: sealForTest(t, k.PublicKey(), pass, vaultReconcileAAD(host, "3389", admin))}
	base := tunnel.RotateRequest{Method: "windows", Host: host, Port: "3389", Username: user, Current: cur, Reconcile: rec}
	allow := &TargetMatcher{open: true}
	prep := base
	prep.Op, prep.To = "prepare", []string{pub}
	p := rotate(t.Context(), k, allow, prep)
	if p.Error != "" {
		t.Fatal(p.Error)
	}
	apply := base
	apply.Op, apply.Pending = "apply", p.Seals[pub]
	r := rotate(t.Context(), k, allow, apply)
	if r.Outcome != "rotated" || !r.Reconciled || !r.OutOfSync {
		t.Fatalf("take-over: %+v", r)
	}
	next, _ := openSealed(k, p.Seals[pub], aad)
	wt, _ := newWindowsTarget(host, user, nil)
	if res := wt.check(t.Context(), next); res.kind != authOK {
		t.Fatalf("the new password does not sign in: %+v", res)
	}
	if res := wt.check(t.Context(), "placeholder-not-the-password"); res.kind == authOK {
		t.Fatal("the placeholder still signs in")
	}
}
