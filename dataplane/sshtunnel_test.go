package main

import (
	"bytes"
	"fmt"
	"io"
	"net"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

func tunnelCtrl() *fakeSSHCtrl {
	return &fakeSSHCtrl{allow: true, recorded: &sshTarget{Tunnel: true}}
}

func echoOnce(t *testing.T, c *ssh.Client, asked, msg string) {
	t.Helper()
	conn, err := c.Dial("tcp", asked)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte(msg)); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, len(msg))
	if _, err := io.ReadFull(conn, buf); err != nil || string(buf) != msg {
		t.Fatalf("echo %q err %v", buf, err)
	}
}

func waitHub(t *testing.T, hub *SessionHub, n int) []SessionInfo {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		l := hub.List()
		if len(l) == n || time.Now().After(deadline) {
			if len(l) != n {
				t.Fatalf("hub has %d sessions, want %d: %+v", len(l), n, l)
			}
			return l
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestSSHTunnelCarriesEveryConnectionAsOneSession(t *testing.T) {
	addr, tickets, hub, audit, dialed := jumpRig(t, tunnelCtrl())
	addTicket(tickets, "k7f3q9wz2m4x")
	c, err := dialJump(addr, "k7f3q9wz2m4x")
	if err != nil {
		t.Fatal(err)
	}
	// The app's connections: whatever the command names, they go to the resource.
	echoOnce(t, c, "redis.corp:6379", "PING\r\n")
	echoOnce(t, c, "elsewhere:1", "INFO\r\n")
	if strings.Join(*dialed, ",") != "c1/10.0.0.5:22,c1/10.0.0.5:22" {
		t.Fatalf("dialed %v", *dialed)
	}
	l := waitHub(t, hub, 1)
	if l[0].Protocol != "tcp" || !l[0].Native || l[0].SiteID != "s1" {
		t.Fatalf("hub %+v", l)
	}
	c.Close()
	waitHub(t, hub, 0)
	var evs []AuditEvent
	for deadline := time.Now().Add(3 * time.Second); len(evs) < 2 && time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		evs = append(evs, audit.drain(10)...)
	}
	if len(evs) != 2 || evs[0].Reason != "session_open native_tcp" || !strings.HasPrefix(evs[1].Reason, "session_close ") || evs[1].BytesOut != 12 || evs[1].Host != "10.0.0.5" {
		t.Fatalf("audit %+v", evs)
	}
}

func TestSSHTunnelEndsEveryConnectionWhenTheSessionIsEnded(t *testing.T) {
	addr, tickets, hub, _, _ := jumpRig(t, tunnelCtrl())
	addTicket(tickets, "k7f3q9wz2m4x")
	c, err := dialJump(addr, "k7f3q9wz2m4x")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	conn, err := c.Dial("tcp", "x:1")
	if err != nil {
		t.Fatal(err)
	}
	l := waitHub(t, hub, 1)
	if !hub.Terminate(l[0].SessionID) {
		t.Fatal("terminate failed")
	}
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, err := conn.Read(make([]byte, 1)); err == nil {
		t.Fatal("tunnel connection still open")
	}
	if _, err := c.Dial("tcp", "x:1"); err == nil {
		t.Fatal("the ended tunnel took a new connection")
	}
}

func TestSSHTunnelWindowSaysItIsOpenAndClosesOnCtrlC(t *testing.T) {
	addr, tickets, hub, _, _ := jumpRig(t, tunnelCtrl())
	addTicket(tickets, "k7f3q9wz2m4x")
	c, err := dialJump(addr, "k7f3q9wz2m4x")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	sess, err := c.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	if err := sess.RequestPty("xterm", 24, 80, ssh.TerminalModes{}); err != nil {
		t.Fatal(err)
	}
	in, _ := sess.StdinPipe()
	out, _ := sess.StdoutPipe()
	if err := sess.Shell(); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 512)
	n, _ := io.ReadAtLeast(out, buf, 30)
	if !strings.Contains(string(buf[:n]), "tunnel to Build box is open") {
		t.Fatalf("window said %q", buf[:n])
	}
	// Listed as soon as the window opens, before the app connects.
	waitHub(t, hub, 1)
	_, _ = in.Write([]byte{0x03})
	done := make(chan error, 1)
	go func() { done <- c.Wait() }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("Ctrl+C left the tunnel open")
	}
	waitHub(t, hub, 0)
}

// The command the portal shows, run with the real OpenSSH client: its -L
// listener carries an app's connection, and Ctrl+C in its window ends it.
func TestSSHTunnelWithOpenSSH(t *testing.T) {
	bin, err := exec.LookPath("ssh")
	if err != nil {
		t.Skip("no OpenSSH client")
	}
	addr, tickets, hub, _, _ := jumpRig(t, tunnelCtrl())
	addTicket(tickets, "k7f3q9wz2m4x")
	host, port, _ := net.SplitHostPort(addr)
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	local := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	cmd := exec.Command(bin, "-tt", "-L", fmt.Sprintf("%d:redis.corp:6379", local), "-o", "ExitOnForwardFailure=yes",
		"-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR", "-F", "/dev/null",
		"-p", port, "k7f3q9wz2m4x@"+host)
	stdin, _ := cmd.StdinPipe()
	var out safeBuffer
	cmd.Stdout = &out
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill() }()
	for deadline := time.Now().Add(5 * time.Second); !strings.Contains(out.String(), "tunnel to Build box is open"); time.Sleep(20 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("window said %q", out.String())
		}
	}
	conn, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", local))
	if err != nil {
		t.Fatal(err)
	}
	_, _ = conn.Write([]byte("PING\r\n"))
	buf := make([]byte, 6)
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, err := io.ReadFull(conn, buf); err != nil || string(buf) != "PING\r\n" {
		t.Fatalf("echo %q err %v", buf, err)
	}
	conn.Close()
	waitHub(t, hub, 1)
	_, _ = stdin.Write([]byte{0x03})
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Ctrl+C left ssh running")
	}
	waitHub(t, hub, 0)
	if !strings.Contains(out.String(), "tunnel closed") {
		t.Fatalf("window said %q", out.String())
	}
}

type safeBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *safeBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *safeBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// A local port already in use stops the command at once instead of leaving a
// window open that forwards nothing (ExitOnForwardFailure).
func TestSSHTunnelCommandStopsWhenTheLocalPortIsTaken(t *testing.T) {
	bin, err := exec.LookPath("ssh")
	if err != nil {
		t.Skip("no OpenSSH client")
	}
	addr, tickets, _, _, _ := jumpRig(t, tunnelCtrl())
	addTicket(tickets, "k7f3q9wz2m4x")
	host, port, _ := net.SplitHostPort(addr)
	busy, _ := net.Listen("tcp", "127.0.0.1:0")
	defer busy.Close()
	local := busy.Addr().(*net.TCPAddr).Port
	cmd := exec.Command(bin, "-tt", "-L", fmt.Sprintf("127.0.0.1:%d:redis.corp:6379", local), "-o", "ExitOnForwardFailure=yes",
		"-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-F", "/dev/null", "-p", port, "k7f3q9wz2m4x@"+host)
	var out safeBuffer
	cmd.Stdout, cmd.Stderr = &out, &out
	_ = cmd.Start()
	defer func() { _ = cmd.Process.Kill() }()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err == nil || !strings.Contains(out.String(), "forwarding") {
			t.Fatalf("err %v, said %q", err, out.String())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("ssh kept running with its port taken")
	}
}
