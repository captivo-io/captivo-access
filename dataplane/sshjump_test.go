package main

import (
	"bytes"
	"errors"
	"io"
	"net"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

type fakeSSHCtrl struct {
	allow  bool
	native error
	// A connector-group resource: its members, and how the dataplane picks.
	cands []routeCandidate
	pick  func([]routeCandidate) routeCandidate
	// A recorded resource: what the target carries besides where it is.
	recorded *sshTarget
}

func (f *fakeSSHCtrl) CheckAccess(userID, siteID, clientIP string) (bool, string, error) {
	if f.allow {
		return true, "", nil
	}
	return false, "no grant", nil
}

func (f *fakeSSHCtrl) NativeSshTarget(userID, siteID string) (sshTarget, error) {
	if f.native != nil {
		return sshTarget{}, f.native
	}
	t := sshTarget{rdpTarget: rdpTarget{Host: "10.0.0.5", Port: "22", ConnectorID: "c1", TenantID: "t1", SiteName: "Build box", Candidates: f.cands}}
	if f.recorded != nil {
		r := *f.recorded
		r.rdpTarget = t.rdpTarget
		return r, nil
	}
	return t, nil
}

// jumpRig starts a jump host on a loopback port whose "connector" is an echo server.
func jumpRig(t *testing.T, ctrl *fakeSSHCtrl) (addr string, tickets *sshTickets, hub *SessionHub, audit *AuditQueue, dialed *[]string) {
	t.Helper()
	tickets = newSSHTickets()
	hub = NewSessionHub()
	audit = NewAuditQueue(100)
	var targets []string
	d := sshJumpDeps{
		ctrl: ctrl, hub: hub, audit: audit, tickets: tickets, now: time.Now, pick: ctrl.pick,
		dial: func(connectorID, target string) (net.Conn, error) {
			targets = append(targets, connectorID+"/"+target)
			a, b := net.Pipe()
			go func() { _, _ = io.Copy(b, b) }() // echo
			return a, nil
		},
	}
	key, err := loadOrCreateHostKey(filepath.Join(t.TempDir(), "host_key"))
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go serveSSHJump(ln, d, sshServerConfig(d, key))
	return ln.Addr().String(), tickets, hub, audit, &targets
}

func dialJump(addr, user string) (*ssh.Client, error) {
	return ssh.Dial("tcp", addr, &ssh.ClientConfig{User: user, HostKeyCallback: ssh.InsecureIgnoreHostKey(), Timeout: 5 * time.Second})
}

func addTicket(tk *sshTickets, code string) {
	tk.Add(sshTicket{Code: code, TenantID: "t1", SiteID: "s1", UserID: "u1", Exp: time.Now().Add(time.Minute)})
}

func TestSSHJumpRelaysToTheResource(t *testing.T) {
	addr, tickets, hub, audit, dialed := jumpRig(t, &fakeSSHCtrl{allow: true})
	addTicket(tickets, "k7f3q9wz2m4x")
	c, err := dialJump(addr, "K7F3Q9WZ2M4X") // case doesn't matter
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	// The command may name the server differently; the ticket's resource wins.
	conn, err := c.Dial("tcp", "build.corp.local:22")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Write([]byte("SSH-2.0-test\r\n")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 14)
	if _, err := io.ReadFull(conn, buf); err != nil || string(buf) != "SSH-2.0-test\r\n" {
		t.Fatalf("echo %q err %v", buf, err)
	}
	if strings.Join(*dialed, ",") != "c1/10.0.0.5:22" {
		t.Fatalf("dialed %v", *dialed)
	}
	list := hub.List()
	if len(list) != 1 || list[0].Protocol != "ssh" || !list[0].Native || list[0].SiteID != "s1" {
		t.Fatalf("hub %+v", list)
	}
	conn.Close()
	deadline := time.Now().Add(3 * time.Second)
	for len(hub.List()) > 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if len(hub.List()) != 0 {
		t.Fatal("session still listed after close")
	}
	evs := audit.drain(10)
	if len(evs) != 2 || evs[0].Reason != "session_open native_ssh" || !strings.HasPrefix(evs[1].Reason, "session_close ") || evs[0].Method != "SSH" || evs[0].ClientIP != "127.0.0.1" || evs[1].BytesOut != 14 {
		t.Fatalf("audit %+v", evs)
	}
}

func TestSSHJumpRefusesAnUnknownTicket(t *testing.T) {
	addr, tickets, _, _, _ := jumpRig(t, &fakeSSHCtrl{allow: true})
	tickets.Add(sshTicket{Code: "expired00000", SiteID: "s1", UserID: "u1", Exp: time.Now().Add(-time.Second)})
	for _, user := range []string{"nope00000000", "expired00000"} {
		if c, err := dialJump(addr, user); err == nil {
			c.Close()
			t.Fatalf("%s got in", user)
		}
	}
}

func TestSSHJumpChecksTheGrantPerChannel(t *testing.T) {
	ctrl := &fakeSSHCtrl{allow: false}
	addr, tickets, hub, audit, dialed := jumpRig(t, ctrl)
	addTicket(tickets, "k7f3q9wz2m4x")
	c, err := dialJump(addr, "k7f3q9wz2m4x")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := c.Dial("tcp", "10.0.0.5:22"); err == nil || !strings.Contains(err.Error(), "not active") {
		t.Fatalf("err = %v", err)
	}
	ctrl.allow, ctrl.native = true, errors.New("409")
	if _, err := c.Dial("tcp", "10.0.0.5:22"); err == nil || !strings.Contains(err.Error(), "own SSH app") {
		t.Fatalf("err = %v", err)
	}
	if len(*dialed) != 0 || len(hub.List()) != 0 {
		t.Fatal("a refused jump reached the connector")
	}
	evs := audit.drain(10)
	if len(evs) != 2 || evs[0].Decision != "DENY" || evs[0].Reason != "native_ssh_no_grant" || evs[1].Reason != "native_ssh_not_allowed" {
		t.Fatalf("audit %+v", evs)
	}
}

func TestSSHJumpAdminCanEndTheSession(t *testing.T) {
	addr, tickets, hub, _, _ := jumpRig(t, &fakeSSHCtrl{allow: true})
	addTicket(tickets, "k7f3q9wz2m4x")
	c, err := dialJump(addr, "k7f3q9wz2m4x")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	conn, err := c.Dial("tcp", "10.0.0.5:22")
	if err != nil {
		t.Fatal(err)
	}
	var id string
	for i := 0; i < 50 && id == ""; i++ {
		if l := hub.List(); len(l) == 1 {
			id = l[0].SessionID
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !hub.Terminate(id) {
		t.Fatal("terminate failed")
	}
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, err := conn.Read(make([]byte, 1)); err == nil {
		t.Fatal("channel still open after terminate")
	}
}

func TestSSHJumpExplainsItselfWithoutAShell(t *testing.T) {
	addr, tickets, _, _, dialed := jumpRig(t, &fakeSSHCtrl{allow: true})
	addTicket(tickets, "k7f3q9wz2m4x")
	c, err := dialJump(addr, "k7f3q9wz2m4x")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	s, err := c.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	s.Stdout = &out
	err = s.Run("id")
	var exit *ssh.ExitError
	if !errors.As(err, &exit) || exit.ExitStatus() != 1 {
		t.Fatalf("err = %v", err)
	}
	if !strings.Contains(out.String(), "ssh -J k7f3q9wz2m4x@") || len(*dialed) != 0 {
		t.Fatalf("out %q dialed %v", out.String(), *dialed)
	}
	// Remote forwarding is refused.
	if _, err := c.Listen("tcp", "0.0.0.0:8080"); err == nil {
		t.Fatal("remote forward accepted")
	}
}

func TestSSHHostKeySurvivesARestart(t *testing.T) {
	p := filepath.Join(t.TempDir(), "k")
	a, err := loadOrCreateHostKey(p)
	if err != nil {
		t.Fatal(err)
	}
	b, err := loadOrCreateHostKey(p)
	if err != nil {
		t.Fatal(err)
	}
	if ssh.FingerprintSHA256(a.PublicKey()) != ssh.FingerprintSHA256(b.PublicKey()) {
		t.Fatal("host key changed")
	}
}

func TestSSHTicketEndpoint(t *testing.T) {
	tickets := newSSHTickets()
	h := serveSSHTicket(sshJumpInfo{Enabled: true, Fingerprint: "SHA256:x"}, tickets, "s")
	post := func(secret, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/ssh-ticket", strings.NewReader(body))
		r.Header.Set("x-dataplane-secret", secret)
		w := httptest.NewRecorder()
		h(w, r)
		return w
	}
	if w := post("wrong", `{}`); w.Code != 403 {
		t.Fatalf("code %d", w.Code)
	}
	// A ticket asked to live an hour still starts connections for two minutes at most.
	w := post("s", `{"code":"abcdefghjk23","tenantId":"t","siteId":"s1","userId":"u1","expiresAt":"`+time.Now().Add(time.Hour).Format(time.RFC3339)+`"}`)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"fingerprint":"SHA256:x"`) {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	if _, ok := tickets.Get("abcdefghjk23", time.Now().Add(sshTicketMaxAge+time.Second)); ok {
		t.Fatal("ticket outlived its two minutes")
	}
	if w := post("s", `{"code":"short","tenantId":"t","siteId":"s1","userId":"u1"}`); w.Code != 400 {
		t.Fatalf("short code accepted: %d", w.Code)
	}
	off := serveSSHTicket(sshJumpInfo{}, tickets, "s")
	r := httptest.NewRequest("POST", "/ssh-ticket", strings.NewReader(`{}`))
	r.Header.Set("x-dataplane-secret", "s")
	rec := httptest.NewRecorder()
	off(rec, r)
	if !strings.Contains(rec.Body.String(), "ssh_off") {
		t.Fatal(rec.Body.String())
	}
}

func TestSSHJumpGoesThroughThePickedGroupMember(t *testing.T) {
	reg := liveReg(t, "c2") // c1 is down
	ctrl := &fakeSSHCtrl{allow: true, cands: []routeCandidate{{ID: "c1"}, {ID: "c2"}},
		pick: func(c []routeCandidate) routeCandidate { p, _ := pickLeastLoaded(reg, nil, c); return p }}
	addr, tickets, hub, _, dialed := jumpRig(t, ctrl)
	addTicket(tickets, "k7f3q9wz2m4x")
	c, err := dialJump(addr, "k7f3q9wz2m4x")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	conn, err := c.Dial("tcp", "x:22")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	// One echo round trip: the jump lists the session once the relay runs.
	if _, err := conn.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadFull(conn, make([]byte, 4)); err != nil {
		t.Fatal(err)
	}
	if strings.Join(*dialed, ",") != "c2/10.0.0.5:22" {
		t.Fatalf("dialed %v, want the online member", *dialed)
	}
	if l := hub.List(); len(l) != 1 || l[0].ConnectorID != "c2" {
		t.Fatalf("hub %+v", l)
	}
}
