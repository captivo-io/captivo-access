package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"io"
	"net"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hashicorp/yamux"
	"github.com/kurtserdar/captivo-access/tunnel"
	"golang.org/x/crypto/ssh"
)

// fakeSSHConnector stands in for connector/sshproxy.go and the recording
// store: an "ssh" stream answers the sign-in and then serves a small shell
// (it echoes what is typed, except after a password prompt) and exec; a
// "recwrite" stream keeps the chunk.
type fakeSSHConnector struct {
	mu     sync.Mutex
	dials  []tunnel.SshDialRequest
	chunks map[string]*bytes.Buffer // by format
}

func (f *fakeSSHConnector) stream(t *testing.T) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if b := f.chunks[termFormat]; b != nil {
		return b.String()
	}
	return ""
}

func (f *fakeSSHConnector) keys() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if b := f.chunks["keys"]; b != nil {
		return b.String()
	}
	return ""
}

func newFakeSSHConnector(t *testing.T) (*Session, *fakeSSHConnector) {
	t.Helper()
	a, b := net.Pipe()
	dp, err := yamux.Client(a, nil)
	if err != nil {
		t.Fatal(err)
	}
	cn, err := yamux.Server(b, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { dp.Close(); cn.Close() })
	f := &fakeSSHConnector{chunks: map[string]*bytes.Buffer{}}
	go func() {
		for {
			st, err := cn.AcceptStream()
			if err != nil {
				return
			}
			go f.serve(st)
		}
	}()
	s := &Session{mux: dp}
	s.SetTelemetry(&tunnel.Telemetry{Version: sshRecMinConnector})
	return s, f
}

func (f *fakeSSHConnector) serve(st *yamux.Stream) {
	defer st.Close()
	b, err := tunnel.ReadFrame(st)
	if err != nil {
		return
	}
	var peek struct{ Kind string }
	_ = json.Unmarshal(b, &peek)
	switch peek.Kind {
	case "recwrite":
		var req tunnel.RecWriteRequest
		_ = json.Unmarshal(b, &req)
		f.mu.Lock()
		if f.chunks[req.Format] == nil {
			f.chunks[req.Format] = &bytes.Buffer{}
		}
		f.chunks[req.Format].Write(req.Data)
		f.mu.Unlock()
		rb, _ := json.Marshal(tunnel.RecWriteResponse{Written: len(req.Data)})
		_ = tunnel.WriteFrame(st, rb)
	case "ssh":
		var req tunnel.SshDialRequest
		_ = json.Unmarshal(b, &req)
		f.mu.Lock()
		f.dials = append(f.dials, req)
		f.mu.Unlock()
		if req.PinnedHostKey != "" && req.PinnedHostKey != "SHA256:server" {
			rb, _ := json.Marshal(tunnel.SshDialResponse{Error: "changed", HostKey: "SHA256:server", HostKeyChanged: true})
			_ = tunnel.WriteFrame(st, rb)
			return
		}
		rb, _ := json.Marshal(tunnel.SshDialResponse{HostKey: "SHA256:server"})
		if tunnel.WriteFrame(st, rb) != nil {
			return
		}
		cfg := &ssh.ServerConfig{NoClientAuth: true}
		cfg.AddHostKey(testSigner())
		_, chans, reqs, err := ssh.NewServerConn(st, cfg)
		if err != nil {
			return
		}
		go ssh.DiscardRequests(reqs)
		for nc := range chans {
			ch, creqs, err := nc.Accept()
			if err != nil {
				continue
			}
			go fakeShell(ch, creqs)
		}
	}
}

var testSigner = sync.OnceValue(func() ssh.Signer {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		panic(err)
	}
	s, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		panic(err)
	}
	return s
})

func fakeShell(ch ssh.Channel, reqs <-chan *ssh.Request) {
	defer ch.Close()
	for q := range reqs {
		switch q.Type {
		case "pty-req", "env", "window-change":
			_ = q.Reply(true, nil)
		case "exec":
			var p struct{ Command string }
			_ = ssh.Unmarshal(q.Payload, &p)
			_ = q.Reply(true, nil)
			_, _ = io.WriteString(ch, "ran: "+p.Command+"\n")
			_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{0}))
			return
		case "shell":
			_ = q.Reply(true, nil)
			go func() {
				_, _ = io.WriteString(ch, "ops@box:~$ ")
				var line []byte
				secret := false
				buf := make([]byte, 1)
				for {
					if _, err := ch.Read(buf); err != nil {
						return
					}
					c := buf[0]
					if c != '\r' {
						line = append(line, c)
						if !secret {
							_, _ = ch.Write(buf)
						}
						continue
					}
					_, _ = io.WriteString(ch, "\r\n")
					cmd := string(line)
					line = nil
					switch {
					case secret:
						secret = false
						_, _ = io.WriteString(ch, "done\r\nops@box:~$ ")
					case strings.HasPrefix(cmd, "sudo"):
						secret = true
						_, _ = io.WriteString(ch, "[sudo] password for ops: ")
					case cmd == "vim":
						_, _ = io.WriteString(ch, "\x1b[?1049h\x1b[HVIM SCREEN")
					case cmd == ":q":
						_, _ = io.WriteString(ch, "\x1b[?1049lops@box:~$ ")
					case cmd == "exit":
						_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{0}))
						ch.Close()
						return
					default:
						_, _ = io.WriteString(ch, "out of "+cmd+"\r\nops@box:~$ ")
					}
				}
			}()
		default:
			_ = q.Reply(false, nil)
		}
	}
}

type recRig struct {
	addr    string
	tickets *sshTickets
	hub     *SessionHub
	audit   *AuditQueue
	conn    *fakeSSHConnector
	key     ssh.Signer
	noted   chan string
	indexes chan string
}

func recordedJumpRig(t *testing.T, target sshTarget) *recRig {
	t.Helper()
	sess, fc := newFakeSSHConnector(t)
	r := &recRig{tickets: newSSHTickets(), hub: NewSessionHub(), audit: NewAuditQueue(200), conn: fc, noted: make(chan string, 4), indexes: make(chan string, 200)}
	key, err := loadOrCreateHostKey(filepath.Join(t.TempDir(), "host_key"))
	if err != nil {
		t.Fatal(err)
	}
	r.key = key
	d := sshJumpDeps{
		ctrl: &fakeSSHCtrl{allow: true, recorded: &target}, hub: r.hub, audit: r.audit, tickets: r.tickets, now: time.Now,
		dial: func(string, string) (net.Conn, error) {
			t.Error("a recorded session must not be relayed raw")
			return nil, io.EOF
		},
		rec: sshRecDeps{hostKey: key, session: func(string) *Session { return sess }, recIndex: func(_, _, _ string, body []byte) error {
			r.indexes <- string(body)
			return nil
		}},
		noteHostKey: func(_, fp string) { r.noted <- fp },
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go serveSSHJump(ln, d, sshServerConfig(d, key))
	r.addr = ln.Addr().String()
	addTicket(r.tickets, "k7f3q9wz2m4x")
	return r
}

// innerClient connects the way `ssh -J ticket@jump user@server` does.
func (r *recRig) innerClient(t *testing.T) (*ssh.Client, string, error) {
	t.Helper()
	jump, err := dialJump(r.addr, "k7f3q9wz2m4x")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { jump.Close() })
	conn, err := jump.Dial("tcp", "10.0.0.5:22")
	if err != nil {
		return nil, "", err
	}
	var banner string
	cc, chans, reqs, err := ssh.NewClientConn(conn, "10.0.0.5:22", &ssh.ClientConfig{
		User: "whoever",
		HostKeyCallback: func(_ string, _ net.Addr, k ssh.PublicKey) error {
			if ssh.FingerprintSHA256(k) != ssh.FingerprintSHA256(r.key.PublicKey()) {
				t.Errorf("inner host key is not the jump host's")
			}
			return nil
		},
		BannerCallback: func(m string) error { banner = m; return nil },
		Timeout:        5 * time.Second,
	})
	if err != nil {
		return nil, banner, err
	}
	return ssh.NewClient(cc, chans, reqs), banner, nil
}

func auditReasons(q *AuditQueue) []string {
	var out []string
	for _, e := range q.drain(1000) {
		out = append(out, e.Decision+" "+e.Method+" "+e.Reason)
	}
	return out
}

func TestRecordedSSHRecordsTheTerminalAndMasksThePassword(t *testing.T) {
	r := recordedJumpRig(t, sshTarget{Record: true, Keystrokes: true, FileTransfer: "none", Username: "ops", Secret: "pw", SecretKind: "PASSWORD", KeyID: "captivo:ana@acme.com"})
	c, banner, err := r.innerClient(t)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(banner, "this session is recorded") || !strings.Contains(banner, "as ops") {
		t.Fatalf("banner %q", banner)
	}
	if fp := <-r.noted; fp != "SHA256:server" {
		t.Fatalf("noted %q", fp)
	}
	s, err := c.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	if err := s.RequestPty("xterm", 40, 120, ssh.TerminalModes{}); err != nil {
		t.Fatal(err)
	}
	in, _ := s.StdinPipe()
	var out bytes.Buffer
	var outMu sync.Mutex
	s.Stdout = writerFunc(func(p []byte) (int, error) { outMu.Lock(); defer outMu.Unlock(); return out.Write(p) })
	if err := s.Shell(); err != nil {
		t.Fatal(err)
	}
	if len(r.hub.List()) != 1 || !r.hub.List()[0].Recording || !r.hub.List()[0].Keystrokes {
		t.Fatalf("live session %+v", r.hub.List())
	}
	for _, line := range []string{"ls -la", "sudo systemctl restart nginx", "hunter2", "exit"} {
		_, _ = io.WriteString(in, line+"\r")
		time.Sleep(50 * time.Millisecond)
	}
	_ = s.Wait()
	outMu.Lock()
	shown := out.String()
	outMu.Unlock()
	if !strings.Contains(shown, "out of ls -la") || strings.Contains(shown, "hunter2") {
		t.Fatalf("terminal %q", shown)
	}

	// A command without a terminal, port forwarding and SFTP on the same connection.
	s2, _ := c.NewSession()
	got, err := s2.Output("uptime")
	if err != nil || string(got) != "ran: uptime\n" {
		t.Fatalf("exec %q %v", got, err)
	}
	if _, err := c.Dial("tcp", "127.0.0.1:5432"); err == nil || !strings.Contains(err.Error(), "port forwarding is off") {
		t.Fatalf("port forward: %v", err)
	}
	s3, _ := c.NewSession()
	if err := s3.RequestSubsystem("sftp"); err == nil {
		t.Fatal("sftp allowed while file transfer is off")
	}
	c.Close()

	waitFor(t, func() bool { return len(r.hub.List()) == 0 })
	waitFor(t, func() bool { return strings.Contains(r.conn.stream(t), "Session ended") })
	rec := r.conn.stream(t)
	lines := strings.Split(strings.TrimSpace(rec), "\n")
	var hdr map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &hdr); err != nil || hdr["version"] != float64(2) || hdr["width"] != float64(120) || hdr["height"] != float64(40) {
		t.Fatalf("header %s", lines[0])
	}
	for _, want := range []string{"out of ls -la", "[sudo] password for ops", `"m","$ uptime"`, "ran: uptime", "Port forwarding refused", "File transfer (SFTP) refused"} {
		if !strings.Contains(rec, want) {
			t.Errorf("recording lacks %q", want)
		}
	}
	if strings.Contains(rec, "hunter2") {
		t.Error("the password is in the recording")
	}
	keys := r.conn.keys()
	for _, want := range []string{`"text":"ls -la"`, `"text":"sudo systemctl restart nginx"`, `"masked":true`, `"text":"uptime"`} {
		if !strings.Contains(keys, want) {
			t.Errorf("keys lack %s: %s", want, keys)
		}
	}
	if strings.Contains(keys, "hunter2") {
		t.Error("the password is in the keystroke log")
	}
	if d := r.conn.dials[0]; d.Username != "ops" || d.Secret != "pw" || d.PinnedHostKey != "" || d.KeyID != "captivo:ana@acme.com" {
		t.Errorf("dial %+v", d)
	}
	reasons := strings.Join(auditReasons(r.audit), "|")
	for _, want := range []string{"ALLOW SSH session_open native_ssh_recorded", "DENY SSH native_ssh_port_forward", "DENY SSH native_ssh_sftp_off", "ALLOW SSH session_close"} {
		if !strings.Contains(reasons, want) {
			t.Errorf("audit lacks %q: %s", want, reasons)
		}
	}
	idx := <-r.indexes
	if !strings.Contains(idx, `"format":"term"`) || !strings.Contains(idx, `"protocol":"ssh"`) {
		t.Errorf("index %s", idx)
	}
}

func TestRecordedSSHRefusesAChangedServerKey(t *testing.T) {
	r := recordedJumpRig(t, sshTarget{Record: true, FileTransfer: "none", Username: "ops", Secret: "pw", SecretKind: "PASSWORD", PinnedHostKey: "SHA256:before"})
	_, _, err := r.innerClient(t)
	if err == nil || !strings.Contains(err.Error(), "host key changed") {
		t.Fatalf("got %v", err)
	}
	if !strings.Contains(strings.Join(auditReasons(r.audit), "|"), "native_ssh_host_key_changed") {
		t.Error("no audit for the changed key")
	}
	select {
	case fp := <-r.noted:
		t.Fatalf("a changed key was kept: %s", fp)
	default:
	}
}
