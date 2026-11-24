package main

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// Against real targets, when they are given: an OpenSSH server with the
// account and a sudo account (ROT_LINUX_ADDR, ROT_LINUX_PASS, ROT_LINUX_SUDO_PASS),
// and a Samba / Active Directory DC on LDAPS (ROT_AD_HOST, ROT_AD_PORT,
// ROT_AD_PASS for CORP\bob, ROT_AD_RESET_PASS for CORP\svc-reset), and a
// Windows or Samba SMB server with a local account alice and an admin
// (ROT_WIN_ADDR host:port, ROT_WIN_PASS, ROT_WIN_ADMIN, ROT_WIN_ADMIN_PASS).
// Each test leaves the account on the password it reports in its log.

func TestRotateRealLinux(t *testing.T) {
	addr := os.Getenv("ROT_LINUX_ADDR")
	if addr == "" {
		t.Skip("ROT_LINUX_ADDR not set")
	}
	ctx := context.Background()
	cur := os.Getenv("ROT_LINUX_PASS")
	lt := &linuxTarget{addr: addr, username: "alice"}
	next, _ := generatePassword(rotatedPassLen)
	if os.Getenv("ROT_LINUX_MIN_DAYS") == "" {
		r := applyRotation(ctx, lt, cur, next)
		t.Logf("self change: %+v (host key %s)", r, lt.seen)
		if r.Outcome != "rotated" || r.Reconciled {
			t.Fatalf("self change: %+v", r)
		}
		t.Logf("alice now: %s", next)
		return
	}
	// passwd refuses (chage -m): the sudo account resets it.
	lt.check(ctx, cur)
	alone := applyRotation(ctx, &linuxTarget{addr: addr, username: "alice", pinned: lt.seen}, cur, next)
	if alone.Outcome != "failed" || !strings.Contains(alone.Detail, "wait") {
		t.Fatalf("refused self change: %+v", alone)
	}
	t.Logf("refused: %s", alone.Detail)
	withSudo := &linuxTarget{addr: addr, username: "alice", pinned: lt.seen, reconcile: &reconcileSecret{username: "ops", secret: os.Getenv("ROT_LINUX_SUDO_PASS")}}
	r := applyRotation(ctx, withSudo, cur, next)
	if r.Outcome != "rotated" || !r.Reconciled {
		t.Fatalf("sudo reset: %+v", r)
	}
	t.Logf("alice now: %s", next)
}

func TestRotateRealAD(t *testing.T) {
	host := os.Getenv("ROT_AD_HOST")
	if host == "" {
		t.Skip("ROT_AD_HOST not set")
	}
	ctx := context.Background()
	dir := tunnel.RotateDirectory{Host: host, Port: os.Getenv("ROT_AD_PORT"), Security: "LDAPS", InsecureSkipVerify: true, BaseDN: "DC=corp,DC=test"}
	cur := os.Getenv("ROT_AD_PASS")
	next, _ := generatePassword(rotatedPassLen)
	at, err := newADTarget(dir, `CORP\bob`, nil)
	if err != nil {
		t.Fatal(err)
	}
	if r := at.check(ctx, "wrong-password"); r.kind != authBad {
		t.Fatalf("wrong password: %+v", r)
	}
	r := applyRotation(ctx, at, cur, next)
	t.Logf("self change: %+v", r)
	if os.Getenv("ROT_AD_EXPECT_REFUSED") != "" {
		if r.Outcome != "failed" {
			t.Fatalf("expected the minimum age to refuse it: %+v", r)
		}
		withReset, _ := newADTarget(dir, `CORP\bob`, &reconcileSecret{username: `CORP\svc-reset`, secret: os.Getenv("ROT_AD_RESET_PASS")})
		r = applyRotation(ctx, withReset, cur, next)
		t.Logf("reset: %+v", r)
		if r.Outcome != "rotated" || !r.Reconciled {
			t.Fatalf("reset: %+v", r)
		}
	} else if r.Outcome != "rotated" {
		t.Fatalf("self change: %+v", r)
	}
	t.Logf("bob now: %s", next)
}

func TestRotateRealWindows(t *testing.T) {
	addr := os.Getenv("ROT_WIN_ADDR")
	if addr == "" {
		t.Skip("ROT_WIN_ADDR not set")
	}
	host, port, _ := strings.Cut(addr, ":")
	defer func(p string) { windowsSMBPort = p }(windowsSMBPort)
	windowsSMBPort = port
	ctx := context.Background()
	cur := os.Getenv("ROT_WIN_PASS")
	wt, err := newWindowsTarget(host, `.\alice`, nil)
	if err != nil {
		t.Fatal(err)
	}
	if r := wt.check(ctx, "wrong-password"); r.kind != authBad {
		t.Fatalf("wrong password: %+v", r)
	}
	next, _ := generatePassword(rotatedPassLen)
	r := applyRotation(ctx, wt, cur, next)
	if r.Outcome != "rotated" || r.Reconciled {
		t.Fatalf("self change: %+v", r)
	}
	// Changed behind Captivo's back: the saved one no longer signs in, the
	// admin account resets it.
	withAdmin, _ := newWindowsTarget(host, "alice", &reconcileSecret{username: os.Getenv("ROT_WIN_ADMIN"), secret: os.Getenv("ROT_WIN_ADMIN_PASS")})
	again, _ := generatePassword(rotatedPassLen)
	r = applyRotation(ctx, withAdmin, cur, again)
	if r.Outcome != "rotated" || !r.Reconciled || !r.OutOfSync {
		t.Fatalf("reset: %+v", r)
	}
	if r := wt.check(ctx, next); r.kind != authBad {
		t.Fatalf("the replaced password still signs in: %+v", r)
	}
	t.Logf("alice now: %s", again)
}

// The whole request path for a local Windows account, as the control plane
// sends it: sealed passwords, prepare, apply through the reconcile account.
func TestRotateRequestRealWindows(t *testing.T) {
	addr := os.Getenv("ROT_WIN_ADDR")
	if addr == "" {
		t.Skip("ROT_WIN_ADDR not set")
	}
	host, port, _ := strings.Cut(addr, ":")
	defer func(p string) { windowsSMBPort = p }(windowsSMBPort)
	windowsSMBPort = port
	ctx := context.Background()
	open, _ := ParseAllowedTargets("")
	k := newVaultTestKey(t)
	me := vaultPublicKeyB64(k)
	aad := vaultTargetAAD(host, "3389", `.\alice`)
	cur, _ := sealToKey(me, os.Getenv("ROT_WIN_PASS"), aad)
	admin := os.Getenv("ROT_WIN_ADMIN")
	rec, _ := sealToKey(me, os.Getenv("ROT_WIN_ADMIN_PASS"), vaultReconcileAAD(host, "3389", admin))
	base := tunnel.RotateRequest{Method: "windows", Host: host, Port: "3389", Username: `.\alice`, Current: cur,
		Reconcile: &tunnel.RotateReconcile{Host: host, Port: "3389", Username: admin, Sealed: rec}}

	prep := base
	prep.Op, prep.To = "prepare", []string{me}
	p := rotate(ctx, k, open, prep)
	if p.Error != "" {
		t.Fatalf("prepare: %+v", p)
	}
	apply := base
	apply.Op, apply.Pending = "apply", p.Seals[me]
	r := rotate(ctx, k, open, apply)
	if r.Outcome != "rotated" {
		t.Fatalf("apply: %+v", r)
	}
	verify := base
	verify.Op, verify.Current = "verify", p.Seals[me]
	if v := rotate(ctx, k, open, verify); v.Outcome != "ok" {
		t.Fatalf("verify: %+v", v)
	}
	// A reconcile account sealed for another host is refused.
	moved := apply
	moved.Reconcile = &tunnel.RotateReconcile{Host: "10.9.9.9", Port: "3389", Username: admin, Sealed: rec}
	if m := rotate(ctx, k, open, moved); !strings.Contains(m.Error, "another host") {
		t.Fatalf("moved reconcile: %+v", m)
	}
	next, _ := openSealed(k, p.Seals[me], aad)
	t.Logf("alice now: %s", next)
}
