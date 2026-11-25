package main

import (
	"crypto/ecdh"
	"crypto/rand"
	"errors"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

const (
	testPasswd = "root:x:0:0:root:/root:/bin/bash\n" +
		"daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\n" +
		"ana:x:1000:1000:Ana:/home/ana:/bin/bash\n" +
		"deploy:x:1001:1001::/home/deploy:/bin/bash\n" +
		"svc-app:x:998:998::/var/lib/app:/usr/sbin/nologin\n" +
		"ops:x:1002:27::/home/ops:/bin/sh\n" +
		"bad name:x:1003:1003::/home/x:/bin/sh\n"
	testGroup  = "root:x:0:\nsudo:x:27:ana\nwheel:x:10:\nusers:x:100:deploy\n"
	testShadow = "root:$6$abc$hash:19000:0:99999:7:::\nana:$6$x$y:19800:0:99999:7:::\ndeploy:!:19900::::::\nops::19990:0:99999:7:::\ndaemon:*:19000:0:99999:7:::\n"
)

func TestParseAccountsReportsWhatItSaysAboutEachAccountAndNeverAHash(t *testing.T) {
	now := time.Unix(20000*86400, 0)
	got := parseAccounts(testPasswd, testGroup, testShadow, now)
	by := map[string]tunnel.DiscoveredAccount{}
	for _, a := range got {
		by[a.Name] = a
	}
	if len(got) != 6 || by["bad name"].Name != "" {
		t.Fatalf("accounts %d (a name with a space is not an account)", len(got))
	}
	if a := by["ana"]; !a.Admin || !a.Login || a.Locked || a.PassAgeDays != 200 {
		t.Fatalf("ana %+v", a)
	}
	if a := by["root"]; !a.Admin || a.PassAgeDays != 1000 {
		t.Fatalf("root %+v", a)
	}
	if a := by["ops"]; !a.Admin || !a.NoPass {
		t.Fatalf("ops is in the sudo group by gid and has an empty password: %+v", a)
	}
	if a := by["deploy"]; a.Admin || !a.Locked || !a.Login {
		t.Fatalf("deploy %+v", a)
	}
	if a := by["daemon"]; a.Login || !a.Locked {
		t.Fatalf("daemon %+v", a)
	}
	if a := by["svc-app"]; a.PassAgeDays != -1 {
		t.Fatalf("an account without a shadow line has an unknown age: %+v", a)
	}
	// People first, system accounts last.
	if got[0].Name != "ana" || got[len(got)-1].Name != "svc-app" && got[len(got)-1].Name != "daemon" {
		t.Fatalf("order %v", names(got))
	}
}

func names(a []tunnel.DiscoveredAccount) []string {
	var o []string
	for _, x := range a {
		o = append(o, x.Name)
	}
	return o
}

func TestDiscoverNeedsTheAdministratorAccountForTheSameHost(t *testing.T) {
	k, _ := ecdh.X25519().GenerateKey(rand.Reader)
	if r := discoverAccounts(t.Context(), k, &TargetMatcher{open: true}, tunnel.RotateRequest{Op: "discover", Method: "windows", Host: "h", Port: "22"}); r.Error == "" {
		t.Fatal("Linux only")
	}
	if r := discoverAccounts(t.Context(), k, &TargetMatcher{open: true}, tunnel.RotateRequest{Op: "discover", Method: "linux", Host: "h", Port: "22"}); r.Error == "" {
		t.Fatal("no administrator account")
	}
	r := discoverAccounts(t.Context(), k, &TargetMatcher{open: true}, tunnel.RotateRequest{Op: "discover", Method: "linux", Host: "h", Port: "22", Reconcile: &tunnel.RotateReconcile{Host: "other", Port: "22", Username: "root"}})
	if !strings.Contains(r.Error, "another host") {
		t.Fatalf("%q", r.Error)
	}
}

// Real sshd (the rig image): ELEV_ADDR, ELEV_ADMIN, ELEV_ADMIN_PASS, and an account ELEV_USER that must show up.
func TestDiscoverE2E(t *testing.T) {
	addr := os.Getenv("ELEV_ADDR")
	if addr == "" {
		t.Skip("ELEV_ADDR not set")
	}
	host, port, _ := net.SplitHostPort(addr)
	admin, pass := os.Getenv("ELEV_ADMIN"), os.Getenv("ELEV_ADMIN_PASS")
	k, _ := ecdh.X25519().GenerateKey(rand.Reader)
	sealed := sealForTest(t, k.PublicKey(), pass, vaultReconcileAAD(host, port, admin))
	r := discoverAccounts(t.Context(), k, &TargetMatcher{open: true}, tunnel.RotateRequest{Op: "discover", Method: "linux", Host: host, Port: port, Reconcile: &tunnel.RotateReconcile{Host: host, Port: port, Username: admin, Sealed: sealed}})
	if r.Error != "" {
		t.Fatal(r.Error)
	}
	found := map[string]tunnel.DiscoveredAccount{}
	for _, a := range r.Accounts {
		found[a.Name] = a
	}
	u := found[os.Getenv("ELEV_USER")]
	if u.Name == "" || !u.Login || u.PassAgeDays < 0 {
		t.Fatalf("the ordinary account is missing or unread: %+v (of %d)", u, len(r.Accounts))
	}
	if !found["root"].Admin {
		t.Fatal("root is not reported as an administrator")
	}
	for _, a := range r.Accounts {
		if strings.Contains(a.Shell+a.Home+a.Name, "$6$") {
			t.Fatal("a hash got through")
		}
	}
}

// Taking an account over: its saved password is a placeholder that does not
// sign in, so the rotation resets it through the administrator account, and
// the account then signs in with the new one.
func TestTakeOverE2E(t *testing.T) {
	addr := os.Getenv("ELEV_ADDR")
	if addr == "" {
		t.Skip("ELEV_ADDR not set")
	}
	host, port, _ := net.SplitHostPort(addr)
	user, admin, adminPass := os.Getenv("ELEV_USER"), os.Getenv("ELEV_ADMIN"), os.Getenv("ELEV_ADMIN_PASS")
	k, _ := ecdh.X25519().GenerateKey(rand.Reader)
	pub := vaultPublicKeyB64(k)
	aad := vaultTargetAAD(host, port, user)
	cur := sealForTest(t, k.PublicKey(), "placeholder-not-the-password", aad)
	rec := &tunnel.RotateReconcile{Host: host, Port: port, Username: admin, Sealed: sealForTest(t, k.PublicKey(), adminPass, vaultReconcileAAD(host, port, admin))}
	base := tunnel.RotateRequest{Method: "linux", Host: host, Port: port, Username: user, Current: cur, Reconcile: rec}
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
	next, err := openSealed(k, p.Seals[pub], aad)
	if err != nil {
		t.Fatal(err)
	}
	c, _, err := sshSignIn(addr, user, passwordAuth(next), "")
	if err != nil {
		t.Fatalf("the account does not sign in with the new password: %v", err)
	}
	c.Close()
	if c2, _, err := sshSignIn(addr, user, passwordAuth("placeholder-not-the-password"), ""); err == nil {
		c2.Close()
		t.Fatal("the placeholder still signs in")
	}
}

func TestAuthRefusedCoversServersThatAnswerKeyboardInteractiveWithAFailure(t *testing.T) {
	for _, m := range []string{"ssh: handshake failed: ssh: unable to authenticate, attempted methods [none password]", "ssh: handshake failed: ssh: unexpected message type 51 (expected 60)"} {
		if !isAuthRefused(errors.New(m)) {
			t.Errorf("%q is the server saying no", m)
		}
	}
	for _, m := range []string{"ssh: handshake failed: EOF", "dial tcp: i/o timeout", "ssh: unexpected message type 20"} {
		if isAuthRefused(errors.New(m)) {
			t.Errorf("%q is not a refusal", m)
		}
	}
}
