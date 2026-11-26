package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
	"golang.org/x/crypto/ssh"
)

func TestGeneratePasswordHasEveryClass(t *testing.T) {
	for i := 0; i < 200; i++ {
		p, err := generatePassword(rotatedPassLen)
		if err != nil {
			t.Fatal(err)
		}
		if len(p) != rotatedPassLen {
			t.Fatalf("length %d", len(p))
		}
		for _, set := range []string{passUpper, passLower, passDigit, passSymbol} {
			if !strings.ContainsAny(p, set) {
				t.Fatalf("%q lacks one of %q", p, set)
			}
		}
		if strings.ContainsAny(p, "\"'\\: 0O1lI") {
			t.Fatalf("%q has an awkward character", p)
		}
	}
}

// fakeAccount is an accountTarget with a password and rules.
type fakeAccount struct {
	pw          string
	refuseSelf  bool // the target refuses a self-change (password age)
	reconcile   bool
	dropOnApply bool // the change goes through but the answer is lost
	unreachable bool
	resets      int
}

func (f *fakeAccount) check(_ context.Context, pw string) authResult {
	if f.unreachable {
		return authResult{kind: authOther, detail: "unreachable"}
	}
	if pw == f.pw {
		return authResult{kind: authOK}
	}
	return authResult{kind: authBad}
}

func (f *fakeAccount) selfChange(_ context.Context, cur, next string) error {
	if cur != f.pw {
		return errors.New("bad current")
	}
	if f.refuseSelf {
		return errors.New("minimum password age")
	}
	f.pw = next
	if f.dropOnApply {
		return errors.New("connection reset")
	}
	return nil
}

func (f *fakeAccount) reset(_ context.Context, next string) error {
	if !f.reconcile {
		return errNoReconcile
	}
	f.resets++
	f.pw = next
	return nil
}

func (f *fakeAccount) canReset() bool { return f.reconcile }

func TestApplyRotation(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		name       string
		acct       fakeAccount
		outcome    string
		reconciled bool
		outOfSync  bool
		final      string
	}{
		{"self change", fakeAccount{pw: "old"}, "rotated", false, false, "new"},
		{"refused, reconcile resets", fakeAccount{pw: "old", refuseSelf: true, reconcile: true}, "rotated", true, false, "new"},
		{"refused, no reconcile", fakeAccount{pw: "old", refuseSelf: true}, "failed", false, false, "old"},
		{"earlier apply got through", fakeAccount{pw: "new"}, "already", false, false, "new"},
		{"changed outside, reconcile resets", fakeAccount{pw: "someone-else", reconcile: true}, "rotated", true, true, "new"},
		{"changed outside, no reconcile", fakeAccount{pw: "someone-else"}, "failed", false, true, "someone-else"},
		{"answer lost but changed", fakeAccount{pw: "old", dropOnApply: true}, "rotated", false, false, "new"},
		{"unreachable touches nothing", fakeAccount{pw: "old", unreachable: true}, "failed", false, false, "old"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			a := c.acct
			r := applyRotation(ctx, &a, "old", "new")
			if r.Outcome != c.outcome || r.Reconciled != c.reconciled || r.OutOfSync != c.outOfSync {
				t.Fatalf("got %+v", r)
			}
			if a.pw != c.final {
				t.Fatalf("target ended on %q, want %q", a.pw, c.final)
			}
		})
	}
}

func TestVerifyAccount(t *testing.T) {
	ctx := context.Background()
	if r := verifyAccount(ctx, &fakeAccount{pw: "old"}, "old", ""); r.Outcome != "ok" {
		t.Fatal(r)
	}
	if r := verifyAccount(ctx, &fakeAccount{pw: "new"}, "old", "new"); r.Outcome != "pending" {
		t.Fatal(r)
	}
	if r := verifyAccount(ctx, &fakeAccount{pw: "x"}, "old", "new"); r.Outcome != "mismatch" || !r.OutOfSync {
		t.Fatal(r)
	}
}

func newVaultTestKey(t *testing.T) *ecdh.PrivateKey {
	t.Helper()
	k, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func TestRotatePrepareAndRevealKeepTheTarget(t *testing.T) {
	k := newVaultTestKey(t)
	other := newVaultTestKey(t)
	aad := vaultTargetAAD("10.0.0.5", "22", "alice")
	cur, _ := sealToKey(vaultPublicKeyB64(k), "old-pass", aad)
	req := tunnel.RotateRequest{Op: "prepare", Method: "linux", Host: "10.0.0.5", Port: "22", Username: "alice", Current: cur, To: []string{vaultPublicKeyB64(k), vaultPublicKeyB64(other)}}
	r := rotate(context.Background(), k, nil, req)
	if r.Error != "" || len(r.Seals) != 2 {
		t.Fatalf("prepare: %+v", r)
	}
	mine, err := openSealed(k, r.Seals[vaultPublicKeyB64(k)], aad)
	if err != nil {
		t.Fatal(err)
	}
	theirs, err := openSealed(other, r.Seals[vaultPublicKeyB64(other)], aad)
	if err != nil || theirs != mine || mine == "old-pass" || len(mine) != rotatedPassLen {
		t.Fatalf("prepared %q / %q (%v)", mine, theirs, err)
	}
	if _, err := openSealed(other, r.Seals[vaultPublicKeyB64(other)], vaultTargetAAD("10.0.0.6", "22", "alice")); err == nil {
		t.Fatal("a prepared password opened for another host")
	}

	// Pointed at another host, the current seal does not open: nothing is made.
	moved := req
	moved.Host = "10.0.0.6"
	if r := rotate(context.Background(), k, nil, moved); r.Error == "" {
		t.Fatal("prepare for another host succeeded")
	}

	browser := newVaultTestKey(t)
	rv := rotate(context.Background(), k, nil, tunnel.RotateRequest{Op: "reveal", Host: "10.0.0.5", Port: "22", Username: "alice", Current: cur, To: []string{vaultPublicKeyB64(browser)}})
	if got, err := openSealed(browser, rv.Seals[vaultPublicKeyB64(browser)], aad); err != nil || got != "old-pass" {
		t.Fatalf("reveal: %q %v %+v", got, err, rv)
	}
	if r := rotate(context.Background(), k, nil, tunnel.RotateRequest{Op: "reveal", Host: "10.0.0.5", Port: "22", Username: "alice", Current: cur, To: []string{vaultPublicKeyB64(browser), vaultPublicKeyB64(other)}}); r.Error == "" {
		t.Fatal("reveal to two keys")
	}
}

func TestRetargetMovesASealToANewTargetWithoutShowingIt(t *testing.T) {
	k := newVaultTestKey(t)
	other := newVaultTestKey(t)
	oldAAD := vaultTargetAAD("10.0.0.5", "22", "alice")
	cur, err := sealToKey(vaultPublicKeyB64(k), "old-pass", oldAAD)
	if err != nil {
		t.Fatal(err)
	}
	req := tunnel.RotateRequest{
		Op: "retarget", Host: "10.0.0.5", Port: "22", Username: "alice", Current: cur,
		NewHost: "10.0.0.9", NewPort: "2222", NewUsername: "bob",
		To: []string{vaultPublicKeyB64(k), vaultPublicKeyB64(other)},
	}
	r := rotate(context.Background(), k, nil, req)
	if r.Error != "" {
		t.Fatalf("retarget: %+v", r)
	}
	newAAD := vaultTargetAAD("10.0.0.9", "2222", "bob")
	for name, key := range map[string]*ecdh.PrivateKey{"own": k, "other": other} {
		got, err := openSealed(key, r.Seals[vaultPublicKeyB64(key)], newAAD)
		if err != nil || got != "old-pass" {
			t.Fatalf("%s key: %q %v", name, got, err)
		}
		if _, err := openSealed(key, r.Seals[vaultPublicKeyB64(key)], oldAAD); err == nil {
			t.Fatalf("%s key: the new seal still opens for the old target", name)
		}
	}
	if len(r.Detail) > 0 || r.Outcome != "" {
		t.Fatalf("a retarget answers with seals only: %+v", r)
	}

	// Pointed at a target the current seal was not entered for, nothing opens.
	wrong := req
	wrong.Host = "10.0.0.6"
	if r := rotate(context.Background(), k, nil, wrong); r.Error == "" {
		t.Fatal("retarget from a target the password was not entered for succeeded")
	}
	// A new target is required, and so is at least one recipient.
	for name, mut := range map[string]func(*tunnel.RotateRequest){
		"no host":      func(q *tunnel.RotateRequest) { q.NewHost = "" },
		"no port":      func(q *tunnel.RotateRequest) { q.NewPort = "" },
		"no user":      func(q *tunnel.RotateRequest) { q.NewUsername = " " },
		"no recipient": func(q *tunnel.RotateRequest) { q.To = nil },
	} {
		q := req
		mut(&q)
		if r := rotate(context.Background(), k, nil, q); r.Error == "" {
			t.Fatalf("%s: retarget succeeded", name)
		}
	}
}

func TestReconcileSealIsBoundAndNotAGatewaySecret(t *testing.T) {
	k := newVaultTestKey(t)
	pub := vaultPublicKeyB64(k)
	rec, _ := sealToKey(pub, "root-pass", vaultReconcileAAD("10.0.0.5", "22", "root"))
	// The gateway opens only "target" seals: a reconcile seal never signs a session in.
	if _, err := openSealed(k, rec, vaultTargetAAD("10.0.0.5", "22", "root")); err == nil {
		t.Fatal("a reconcile seal opened as a target secret")
	}
	cur, _ := sealToKey(pub, "old", vaultTargetAAD("10.0.0.5", "22", "alice"))
	req := tunnel.RotateRequest{Op: "verify", Method: "linux", Host: "10.0.0.5", Port: "22", Username: "alice", Current: cur,
		Reconcile: &tunnel.RotateReconcile{Host: "10.0.0.9", Port: "22", Username: "root", Sealed: rec}}
	if r := rotate(context.Background(), k, nil, req); !strings.Contains(r.Error, "another host") {
		t.Fatalf("reconcile account for another host: %+v", r)
	}
}

func TestADAccountNames(t *testing.T) {
	for _, c := range []struct{ in, domain, bind, filter string }{
		{`CORP\alice`, "", `CORP\alice`, "(sAMAccountName=alice)"},
		{"alice@corp.example", "", "alice@corp.example", "(|(userPrincipalName=alice@corp.example)(sAMAccountName=alice))"},
		{"alice", "CORP", `CORP\alice`, "(sAMAccountName=alice)"},
		{"a*)(x", "CORP", `CORP\a*)(x`, `(sAMAccountName=a\2a\29\28x)`},
	} {
		b, f, err := adAccount(c.in, c.domain)
		if err != nil || b != c.bind || f != c.filter {
			t.Fatalf("%q: %q %q %v", c.in, b, f, err)
		}
	}
	for _, bad := range []string{"alice", `.\admin`} {
		if _, _, err := adAccount(bad, ""); err == nil {
			t.Fatalf("%q accepted", bad)
		}
	}
	if _, err := newADTarget(tunnel.RotateDirectory{Host: "dc", Port: "389", Security: "PLAIN", BaseDN: "dc=x"}, `X\a`, nil); err == nil {
		t.Fatal("plain LDAP accepted")
	}
}

func TestADPasswordEncoding(t *testing.T) {
	got := []byte(adPassword("Ab1"))
	want := []byte{'"', 0, 'A', 0, 'b', 0, '1', 0, '"', 0}
	if !bytes.Equal(got, want) {
		t.Fatalf("%v", got)
	}
}

func TestRotatedRecordAndShowPassword(t *testing.T) {
	dir := t.TempDir()
	keyFile := filepath.Join(dir, "vault.key")
	k, err := loadOrCreateVaultKey(keyFile)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("VAULT_KEY_FILE", keyFile)
	t.Setenv(rotateRecordEnv, filepath.Join(dir, "rotated.json"))
	sealed, _ := sealToKey(vaultPublicKeyB64(k), "S3cret-new", vaultTargetAAD("db1", "22", "alice"))
	if err := writeRotated(rotatedFile(), tunnel.RotateRequest{Label: "Billing DB", Host: "db1", Port: "22", Username: "alice", Pending: sealed}, time.Now()); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if code := showPassword(&out, nil); code != 0 || strings.Contains(out.String(), "S3cret-new") || !strings.Contains(out.String(), "Billing DB") {
		t.Fatalf("list: %d %q", code, out.String())
	}
	out.Reset()
	if code := showPassword(&out, []string{"billing"}); code != 0 || !strings.Contains(out.String(), "S3cret-new") {
		t.Fatalf("show: %d %q", code, out.String())
	}
	out.Reset()
	if code := showPassword(&out, []string{"nothing"}); code != 1 {
		t.Fatalf("no match: %d %q", code, out.String())
	}
}

// --- an SSH server with passwd, chpasswd and sudo, for linuxTarget ---

type fakeSSHD struct {
	t        *testing.T
	addr     string
	mu       sync.Mutex
	pw       map[string]string
	keys     map[string]ssh.PublicKey
	refuse   string // passwd prints this and fails (e.g. "BAD PASSWORD: too short")
	noSudoPW bool   // sudo -n works for non-root
}

func (s *fakeSSHD) password(u string) string { s.mu.Lock(); defer s.mu.Unlock(); return s.pw[u] }

func startFakeSSHD(t *testing.T, pw map[string]string) *fakeSSHD {
	t.Helper()
	_, hostPriv, _ := ed25519.GenerateKey(rand.Reader)
	signer, err := ssh.NewSignerFromKey(hostPriv)
	if err != nil {
		t.Fatal(err)
	}
	srv := &fakeSSHD{t: t, pw: pw, keys: map[string]ssh.PublicKey{}}
	cfg := &ssh.ServerConfig{
		PasswordCallback: func(c ssh.ConnMetadata, p []byte) (*ssh.Permissions, error) {
			if want := srv.password(c.User()); want != "" && want == string(p) {
				return nil, nil
			}
			return nil, errors.New("denied")
		},
		PublicKeyCallback: func(c ssh.ConnMetadata, k ssh.PublicKey) (*ssh.Permissions, error) {
			srv.mu.Lock()
			defer srv.mu.Unlock()
			if want, ok := srv.keys[c.User()]; ok && bytes.Equal(want.Marshal(), k.Marshal()) {
				return nil, nil
			}
			return nil, errors.New("denied")
		},
	}
	cfg.AddHostKey(signer)
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	srv.addr = l.Addr().String()
	go func() {
		for {
			nc, err := l.Accept()
			if err != nil {
				return
			}
			go srv.serve(nc, cfg)
		}
	}()
	return srv
}

func (s *fakeSSHD) serve(nc net.Conn, cfg *ssh.ServerConfig) {
	conn, chans, reqs, err := ssh.NewServerConn(nc, cfg)
	if err != nil {
		nc.Close()
		return
	}
	defer conn.Close()
	go ssh.DiscardRequests(reqs)
	for nch := range chans {
		ch, creqs, err := nch.Accept()
		if err != nil {
			continue
		}
		go func() {
			defer ch.Close()
			for r := range creqs {
				switch r.Type {
				case "pty-req":
					_ = r.Reply(true, nil)
				case "exec":
					_ = r.Reply(true, nil)
					cmd := string(r.Payload[4:])
					code := s.run(conn.User(), cmd, ch)
					_, _ = ch.SendRequest("exit-status", false, binary.BigEndian.AppendUint32(nil, uint32(code)))
					return
				default:
					_ = r.Reply(false, nil)
				}
			}
		}()
	}
}

func (s *fakeSSHD) setPassword(u, p string) { s.mu.Lock(); s.pw[u] = p; s.mu.Unlock() }

func (s *fakeSSHD) run(user, cmd string, ch ssh.Channel) int {
	in := bufio.NewReader(ch)
	readLine := func() string { l, _ := in.ReadString('\n'); return strings.TrimRight(l, "\r\n") }
	chpasswd := func() int {
		for {
			l, err := in.ReadString('\n')
			l = strings.TrimRight(l, "\n")
			if u, p, ok := strings.Cut(l, ":"); ok {
				s.setPassword(u, p)
			}
			if err != nil {
				return 0
			}
		}
	}
	switch cmd {
	case "LC_ALL=C LANG=C passwd":
		fmt.Fprintf(ch, "Changing password for %s.\r\nCurrent password: ", user)
		if readLine() != s.password(user) {
			fmt.Fprint(ch, "\r\npasswd: Authentication token manipulation error\r\n")
			return 1
		}
		fmt.Fprint(ch, "\r\nNew password: ")
		a := readLine()
		fmt.Fprint(ch, "\r\nRetype new password: ")
		b := readLine()
		if s.refuse != "" {
			fmt.Fprintf(ch, "\r\n%s\r\npasswd: Have exhausted maximum number of retries for service\r\n", s.refuse)
			return 1
		}
		if a != b {
			fmt.Fprint(ch, "\r\nSorry, passwords do not match.\r\n")
			return 1
		}
		s.setPassword(user, a)
		fmt.Fprint(ch, "\r\npasswd: password updated successfully\r\n")
		return 0
	case "chpasswd":
		if user != "root" {
			fmt.Fprint(ch, "chpasswd: Permission denied.\n")
			return 1
		}
		return chpasswd()
	case "sudo -n true":
		if s.noSudoPW {
			return 0
		}
		fmt.Fprint(ch, "sudo: a password is required\n")
		return 1
	case "sudo -n chpasswd":
		if !s.noSudoPW {
			return 1
		}
		return chpasswd()
	case "sudo -S -p '' chpasswd":
		if readLine() != s.password(user) {
			fmt.Fprint(ch, "Sorry, try again.\n")
			return 1
		}
		return chpasswd()
	}
	_, _ = io.WriteString(ch, "unknown command\n")
	return 127
}

func TestLinuxTargetSelfChangeAndPinnedHostKey(t *testing.T) {
	srv := startFakeSSHD(t, map[string]string{"alice": "old-pass"})
	ctx := context.Background()
	lt := &linuxTarget{addr: srv.addr, username: "alice"}
	if r := lt.check(ctx, "wrong"); r.kind != authBad {
		t.Fatalf("wrong password: %+v", r)
	}
	r := applyRotation(ctx, lt, "old-pass", "New-pass-24")
	if r.Outcome != "rotated" || srv.password("alice") != "New-pass-24" {
		t.Fatalf("%+v, server has %q", r, srv.password("alice"))
	}
	if !strings.HasPrefix(lt.seen, "SHA256:") {
		t.Fatalf("host key not reported: %q", lt.seen)
	}
	// Another server at the same address: the pinned key refuses it.
	other := startFakeSSHD(t, map[string]string{"alice": "New-pass-24"})
	pinned := &linuxTarget{addr: other.addr, username: "alice", pinned: lt.seen}
	if r := pinned.check(ctx, "New-pass-24"); r.kind != authOther || !strings.Contains(r.detail, "host key") {
		t.Fatalf("changed host key: %+v", r)
	}
}

func TestLinuxTargetRefusedSelfChangeUsesReconcile(t *testing.T) {
	srv := startFakeSSHD(t, map[string]string{"alice": "old-pass", "ops": "ops-pass"})
	srv.refuse = "BAD PASSWORD: The password fails the dictionary check"
	ctx := context.Background()

	alone := &linuxTarget{addr: srv.addr, username: "alice"}
	r := applyRotation(ctx, alone, "old-pass", "New-pass-24")
	if r.Outcome != "failed" || !strings.Contains(r.Detail, "dictionary") || srv.password("alice") != "old-pass" {
		t.Fatalf("%+v", r)
	}
	if strings.Contains(r.Detail, "New-pass-24") || strings.Contains(r.Detail, "old-pass") {
		t.Fatal("a password leaked into the detail")
	}

	// sudo with the reconcile account's password.
	withSudo := &linuxTarget{addr: srv.addr, username: "alice", reconcile: &reconcileSecret{username: "ops", secret: "ops-pass"}}
	r = applyRotation(ctx, withSudo, "old-pass", "New-pass-24")
	if r.Outcome != "rotated" || !r.Reconciled || srv.password("alice") != "New-pass-24" {
		t.Fatalf("sudo: %+v", r)
	}

	// Changed outside Captivo; root with a key resets it.
	srv.setPassword("alice", "set-by-someone")
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	signer, _ := ssh.NewSignerFromKey(priv)
	srv.keys["root"] = signer.PublicKey()
	pemKey, err := ssh.MarshalPrivateKey(priv, "")
	if err != nil {
		t.Fatal(err)
	}
	var pemBuf bytes.Buffer
	_ = pem.Encode(&pemBuf, pemKey)
	root := &linuxTarget{addr: srv.addr, username: "alice", reconcile: &reconcileSecret{username: "root", secret: pemBuf.String(), isKey: true}}
	r = applyRotation(ctx, root, "New-pass-24", "Newer-pass-24")
	if r.Outcome != "rotated" || !r.Reconciled || !r.OutOfSync || srv.password("alice") != "Newer-pass-24" {
		t.Fatalf("root key: %+v", r)
	}
}
