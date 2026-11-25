package main

import (
	"bytes"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"encoding/pem"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
	"golang.org/x/crypto/ssh"
)

// sshTarget is a small SSH server standing in for a resource: it accepts one
// password or one key, answers `exec` by echoing the command, and reports an
// exit status.
type sshTarget struct {
	addr     string
	hostKey  ssh.Signer
	password string
	userKey  ssh.PublicKey
	ln       net.Listener
	// ca, when set, makes the server accept user certificates that authority signed.
	ca     ssh.PublicKey
	mu     sync.Mutex
	keyIDs []string
}

func newSSHTarget(t *testing.T, password string, userKey ssh.PublicKey) *sshTarget {
	t.Helper()
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	hk, _ := ssh.NewSignerFromKey(priv)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &sshTarget{addr: ln.Addr().String(), hostKey: hk, password: password, userKey: userKey, ln: ln}
	cfg := &ssh.ServerConfig{
		PasswordCallback: func(cm ssh.ConnMetadata, pw []byte) (*ssh.Permissions, error) {
			if cm.User() == "ops" && string(pw) == s.password && s.password != "" {
				return nil, nil
			}
			return nil, io.EOF
		},
		PublicKeyCallback: func(cm ssh.ConnMetadata, k ssh.PublicKey) (*ssh.Permissions, error) {
			if cert, ok := k.(*ssh.Certificate); ok && s.ca != nil {
				chk := &ssh.CertChecker{IsUserAuthority: func(a ssh.PublicKey) bool { return bytes.Equal(a.Marshal(), s.ca.Marshal()) }}
				if _, err := chk.Authenticate(cm, k); err != nil {
					return nil, err
				}
				s.mu.Lock()
				s.keyIDs = append(s.keyIDs, cert.KeyId)
				s.mu.Unlock()
				return nil, nil
			}
			if s.userKey != nil && bytes.Equal(k.Marshal(), s.userKey.Marshal()) {
				return nil, nil
			}
			return nil, io.EOF
		},
	}
	cfg.AddHostKey(hk)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				_, chans, reqs, err := ssh.NewServerConn(c, cfg)
				if err != nil {
					return
				}
				go ssh.DiscardRequests(reqs)
				for nc := range chans {
					if nc.ChannelType() != "session" {
						_ = nc.Reject(ssh.UnknownChannelType, "no")
						continue
					}
					ch, creqs, _ := nc.Accept()
					go func() {
						for r := range creqs {
							if r.Type == "exec" {
								var p struct{ Cmd string }
								_ = ssh.Unmarshal(r.Payload, &p)
								_ = r.Reply(true, nil)
								_, _ = io.WriteString(ch, "ran: "+p.Cmd+"\n")
								_, _ = io.WriteString(ch.Stderr(), "warn\n")
								_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{3}))
								ch.Close()
								return
							}
							_ = r.Reply(r.Type == "env", nil)
						}
					}()
				}
			}()
		}
	}()
	t.Cleanup(func() { ln.Close() })
	return s
}

// dialThroughConnector plays the data plane: it opens a stream to handleSsh
// with the request and, when the sign-in worked, speaks SSH on it.
func dialThroughConnector(t *testing.T, req tunnel.SshDialRequest) (tunnel.SshDialResponse, *ssh.Client) {
	t.Helper()
	dp, cn := tcpPair(t)
	allow := &TargetMatcher{open: true}
	req.Kind = "ssh"
	b, _ := json.Marshal(req)
	go handleSsh(cn, allow, b)
	_ = dp.SetDeadline(time.Now().Add(10 * time.Second))
	rb, err := tunnel.ReadFrame(dp)
	if err != nil {
		t.Fatal(err)
	}
	var resp tunnel.SshDialResponse
	_ = json.Unmarshal(rb, &resp)
	if resp.Error != "" {
		dp.Close()
		return resp, nil
	}
	cc, chans, reqs, err := ssh.NewClientConn(dp, "connector", &ssh.ClientConfig{User: "captivo", HostKeyCallback: ssh.InsecureIgnoreHostKey()}) // #nosec G106 -- test of the trusted tunnel
	if err != nil {
		t.Fatal(err)
	}
	_ = dp.SetDeadline(time.Time{})
	return resp, ssh.NewClient(cc, chans, reqs)
}

// tcpPair is two ends of a loopback connection. Buffered, like a tunnel
// stream; net.Pipe is not, and both SSH sides write their banner at once.
func tcpPair(t *testing.T) (net.Conn, net.Conn) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	acc := make(chan net.Conn, 1)
	go func() { c, _ := ln.Accept(); acc <- c }()
	a, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	b := <-acc
	t.Cleanup(func() { a.Close(); b.Close() })
	return a, b
}

func runExec(t *testing.T, c *ssh.Client, cmd string) (string, string, int) {
	t.Helper()
	s, err := c.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	var out, errb bytes.Buffer
	s.Stdout, s.Stderr = &out, &errb
	err = s.Run(cmd)
	code := 0
	if ee, ok := err.(*ssh.ExitError); ok {
		code = ee.ExitStatus()
	} else if err != nil {
		t.Fatal(err)
	}
	return out.String(), errb.String(), code
}

func TestSshSignsInWithTheSealedPasswordAndCarriesTheSession(t *testing.T) {
	k, _ := ecdh.X25519().GenerateKey(rand.Reader)
	old := vaultKey
	vaultKey = k
	defer func() { vaultKey = old }()
	tg := newSSHTarget(t, "s3cret", nil)
	host, port, _ := net.SplitHostPort(tg.addr)
	sealed := sealForTest(t, k.PublicKey(), "s3cret", vaultTargetAAD(host, port, "ops"))

	resp, c := dialThroughConnector(t, tunnel.SshDialRequest{Host: host, Port: port, Username: "ops", Sealed: sealed, SecretKind: "PASSWORD"})
	if c == nil {
		t.Fatalf("refused: %+v", resp)
	}
	defer c.Close()
	if resp.HostKey != ssh.FingerprintSHA256(tg.hostKey.PublicKey()) {
		t.Fatalf("host key %q, want the server's", resp.HostKey)
	}
	out, errOut, code := runExec(t, c, "uptime")
	if out != "ran: uptime\n" || errOut != "warn\n" || code != 3 {
		t.Fatalf("got %q %q %d", out, errOut, code)
	}
	// A second channel on the same connection.
	if out, _, _ := runExec(t, c, "id"); out != "ran: id\n" {
		t.Fatalf("second exec %q", out)
	}
}

func TestSshSignsInWithAKey(t *testing.T) {
	_, upriv, _ := ed25519.GenerateKey(rand.Reader)
	usigner, _ := ssh.NewSignerFromKey(upriv)
	block, _ := ssh.MarshalPrivateKey(upriv, "")
	tg := newSSHTarget(t, "", usigner.PublicKey())
	host, port, _ := net.SplitHostPort(tg.addr)
	resp, c := dialThroughConnector(t, tunnel.SshDialRequest{Host: host, Port: port, Username: "ops", Secret: string(pem.EncodeToMemory(block)), SecretKind: "KEY"})
	if c == nil {
		t.Fatalf("refused: %+v", resp)
	}
	c.Close()
}

func TestSshRefusesAChangedHostKeyAndAWrongPassword(t *testing.T) {
	tg := newSSHTarget(t, "right", nil)
	host, port, _ := net.SplitHostPort(tg.addr)
	resp, c := dialThroughConnector(t, tunnel.SshDialRequest{Host: host, Port: port, Username: "ops", Secret: "right", SecretKind: "PASSWORD", PinnedHostKey: "SHA256:somethingelse"})
	if c != nil || !resp.HostKeyChanged || resp.HostKey != ssh.FingerprintSHA256(tg.hostKey.PublicKey()) {
		t.Fatalf("changed key not refused: %+v", resp)
	}
	resp, c = dialThroughConnector(t, tunnel.SshDialRequest{Host: host, Port: port, Username: "ops", Secret: "wrong", SecretKind: "PASSWORD"})
	if c != nil || !strings.Contains(resp.Error, "refused the saved account") || strings.Contains(resp.Error, "wrong") {
		t.Fatalf("wrong password: %+v", resp)
	}
}

func TestSshRefusesATargetOutsideTheAllowList(t *testing.T) {
	dp, cn := net.Pipe()
	defer dp.Close()
	b, _ := json.Marshal(tunnel.SshDialRequest{Kind: "ssh", Host: "169.254.169.254", Port: "22", Username: "x", Secret: "x"})
	go handleSsh(cn, &TargetMatcher{open: true}, b)
	rb, err := tunnel.ReadFrame(dp)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(rb), "target not allowed") {
		t.Fatalf("got %s", rb)
	}
}
