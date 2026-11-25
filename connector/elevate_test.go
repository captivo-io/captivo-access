package main

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/json"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

func TestElevateRefusesWhatItCouldNotWriteSafely(t *testing.T) {
	for _, u := range []string{"root", "Ana", "a.b", "a b", "a;b", "a$", "", strings.Repeat("a", 40)} {
		if u == "root" || !elevateUserRe.MatchString(u) {
			continue
		}
		t.Errorf("%q should not match", u)
	}
	for _, u := range []string{"deploy", "_svc", "web-1", "a_b"} {
		if !elevateUserRe.MatchString(u) {
			t.Errorf("%q should match", u)
		}
	}
	old := vaultKey
	vaultKey = nil
	defer func() { vaultKey = old }()
	_, err := elevateAccount(t.Context(), &TargetMatcher{open: true}, elevSpec{platform: "linux", host: "h", port: "22", account: "root", admin: &tunnel.RotateReconcile{Host: "h", Port: "22", Username: "root"}})
	if err == nil {
		t.Fatal("root is never elevated")
	}
	_, err = elevateAccount(t.Context(), &TargetMatcher{open: true}, elevSpec{platform: "linux", host: "h", port: "22", account: "deploy", admin: &tunnel.RotateReconcile{Host: "other", Port: "22", Username: "root"}})
	if err == nil || !strings.Contains(err.Error(), "another host") {
		t.Fatalf("a seal for another host must be refused: %v", err)
	}
}

func TestElevateSudoersLine(t *testing.T) {
	l := elevateLine("deploy")
	if !strings.Contains(l, "\ndeploy ALL=(ALL:ALL) NOPASSWD: ALL\n") || !strings.HasPrefix(l, "#") {
		t.Fatalf("%q", l)
	}
	if !strings.Contains(elevateWriteCmd("deploy"), "visudo -cf") || !strings.Contains(elevateWriteCmd("deploy"), "/etc/sudoers.d/captivo-deploy") {
		t.Fatal(elevateWriteCmd("deploy"))
	}
}

// A real sshd with sudo installed. Set ELEV_ADDR, ELEV_USER / ELEV_PASS (the
// ordinary account), ELEV_ADMIN / ELEV_ADMIN_PASS (root, or a sudoer).
func TestElevateE2E(t *testing.T) {
	addr := os.Getenv("ELEV_ADDR")
	if addr == "" {
		t.Skip("ELEV_ADDR not set")
	}
	host, port, _ := net.SplitHostPort(addr)
	user, pass := os.Getenv("ELEV_USER"), os.Getenv("ELEV_PASS")
	admin, adminPass := os.Getenv("ELEV_ADMIN"), os.Getenv("ELEV_ADMIN_PASS")
	k, _ := ecdh.X25519().GenerateKey(rand.Reader)
	old := vaultKey
	vaultKey = k
	defer func() { vaultKey = old }()
	sealed := sealForTest(t, k.PublicKey(), pass, vaultTargetAAD(host, port, user))
	adminSealed := sealForTest(t, k.PublicKey(), adminPass, vaultReconcileAAD(host, port, admin))
	req := tunnel.SshDialRequest{Host: host, Port: port, Username: user, Sealed: sealed, SecretKind: "PASSWORD", Elevate: &tunnel.RotateReconcile{Host: host, Port: port, Username: admin, Sealed: adminSealed}}

	resp, c := dialThroughConnector(t, req)
	if c == nil || !resp.Elevated {
		t.Fatalf("elevated sign-in refused: %+v", resp)
	}
	out, _, code := runExec(t, c, "sudo -n id -u")
	if code != 0 || strings.TrimSpace(out) != "0" {
		t.Fatalf("during the session sudo gave %q (exit %d)", out, code)
	}
	// A second session on the same account shares the entry and keeps it.
	_, c2 := dialThroughConnector(t, req)
	c2.Close()
	time.Sleep(time.Second)
	if _, _, code := runExec(t, c, "sudo -n true"); code != 0 {
		t.Fatal("the first session lost its rights when the second ended")
	}
	c.Close()
	time.Sleep(2 * time.Second)

	// Afterwards the account is an ordinary user again.
	cl, _, err := sshSignIn(addr, user, passwordAuth(pass), "")
	if err != nil {
		t.Fatal(err)
	}
	defer cl.Close()
	if err := runWithInput(cl, "sudo -n true", ""); err == nil {
		t.Fatal("sudo still works after the last session closed")
	}
	if err := runWithInput(cl, "test ! -e /etc/sudoers.d/captivo-"+user, ""); err != nil {
		t.Fatal("the sudoers entry is still there")
	}
}

// A browser session (guacd) and a recorded RDP session raise the rights first,
// and when that cannot be done nothing is dialled.
func TestGuacdStreamFailsClosedWhenTheRightsCannotBeGiven(t *testing.T) {
	dp, cn := tcpPair(t)
	req := tunnel.GuacdDialRequest{Kind: "guacd", Target: "127.0.0.1:1", Elevate: &tunnel.ElevateRequest{Platform: "linux", Host: "10.0.0.5", Port: "22", Account: "deploy", Admin: tunnel.RotateReconcile{Host: "other", Port: "22", Username: "root"}}}
	b, _ := json.Marshal(req)
	go handleGuacd(cn, &TargetMatcher{open: true}, b)
	_ = dp.SetDeadline(time.Now().Add(5 * time.Second))
	rb, err := tunnel.ReadFrame(dp)
	if err != nil {
		t.Fatal(err)
	}
	var resp tunnel.GuacdDialResponse
	_ = json.Unmarshal(rb, &resp)
	if !strings.Contains(resp.Error, "another host") {
		t.Fatalf("answer %+v", resp)
	}
}

func TestRdpRecStreamFailsClosedWhenTheRightsCannotBeGiven(t *testing.T) {
	dp, cn := tcpPair(t)
	req := tunnel.RdpRecRequest{Kind: "rdp-rec", Host: "10.0.0.5", Port: "3389", Username: "alice", Secret: "x", Elevate: &tunnel.ElevateRequest{Platform: "windows", Host: "10.0.0.5", Port: "3389", Account: "alice", Admin: tunnel.RotateReconcile{Host: "other", Port: "3389", Username: "Administrator"}}}
	b, _ := json.Marshal(req)
	go handleRdpRec(cn, &TargetMatcher{open: true}, b)
	_ = dp.SetDeadline(time.Now().Add(5 * time.Second))
	rb, err := tunnel.ReadFrame(dp)
	if err != nil {
		t.Fatal(err)
	}
	var resp tunnel.RdpRecResponse
	_ = json.Unmarshal(rb, &resp)
	if !strings.Contains(resp.Error, "another host") {
		t.Fatalf("answer %+v", resp)
	}
}
