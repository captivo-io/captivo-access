package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"regexp"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// A Linux account over SSH. The account changes its own password with passwd
// (no other account needed); the reconcile account, when there is one, sets
// it with chpasswd as root or through sudo.

const sshStepTimeout = 12 * time.Second

type linuxTarget struct {
	addr      string
	username  string
	pinned    string // "SHA256:..." from an earlier contact; "" = first contact
	reconcile *reconcileSecret

	mu   sync.Mutex
	seen string // the host key this contact saw
}

var errHostKeyChanged = errors.New("the server's SSH host key changed since the first rotation")

func (t *linuxTarget) canReset() bool { return t.reconcile != nil }

func (t *linuxTarget) hostKeyCallback(_ string, _ net.Addr, key ssh.PublicKey) error {
	fp := ssh.FingerprintSHA256(key)
	t.mu.Lock()
	t.seen = fp
	t.mu.Unlock()
	if t.pinned != "" && t.pinned != fp {
		return errHostKeyChanged
	}
	return nil
}

func (t *linuxTarget) dial(ctx context.Context, user string, auth []ssh.AuthMethod) (*ssh.Client, error) {
	d := net.Dialer{Timeout: 8 * time.Second}
	conn, err := d.DialContext(ctx, "tcp", t.addr)
	if err != nil {
		return nil, err
	}
	_ = conn.SetDeadline(time.Now().Add(sshStepTimeout))
	cc, chans, reqs, err := ssh.NewClientConn(conn, t.addr, &ssh.ClientConfig{
		User:            user,
		Auth:            auth,
		HostKeyCallback: t.hostKeyCallback,
		Timeout:         8 * time.Second,
	})
	if err != nil {
		conn.Close()
		return nil, err
	}
	_ = conn.SetDeadline(time.Time{})
	return ssh.NewClient(cc, chans, reqs), nil
}

// passwordAuth answers both password and keyboard-interactive (PAM) prompts.
func passwordAuth(pw string) []ssh.AuthMethod {
	return []ssh.AuthMethod{
		ssh.Password(pw),
		ssh.KeyboardInteractive(func(_, _ string, questions []string, _ []bool) ([]string, error) {
			out := make([]string, len(questions))
			for i := range out {
				out[i] = pw
			}
			return out, nil
		}),
	}
}

func (t *linuxTarget) check(ctx context.Context, pw string) authResult {
	c, err := t.dial(ctx, t.username, passwordAuth(pw))
	if err != nil {
		return sshAuthResult(err)
	}
	c.Close()
	return authResult{kind: authOK}
}

func sshAuthResult(err error) authResult {
	switch {
	case errors.Is(err, errHostKeyChanged):
		return authResult{kind: authOther, detail: errHostKeyChanged.Error()}
	case strings.Contains(err.Error(), "unable to authenticate"):
		return authResult{kind: authBad, detail: "the password was not accepted"}
	}
	return authResult{kind: authOther, detail: "could not reach the server over SSH: " + err.Error()}
}

// passwd's prompts across shadow-utils, Linux-PAM and busybox, in the C locale.
var (
	promptCurrent = regexp.MustCompile(`(?i)(current|old)[^\n]*password[^\n]*:\s*$`)
	promptNew     = regexp.MustCompile(`(?i)(new|retype|re-enter|again)[^\n]*password[^\n]*:\s*$`)
	passwdRefused = regexp.MustCompile(`(?i)(bad password|authentication token manipulation|authentication failure|you must wait|password unchanged|have exhausted|too (short|simple|similar)|is a palindrome|based on a dictionary)[^\n]*`)
)

func (t *linuxTarget) selfChange(ctx context.Context, cur, next string) error {
	c, err := t.dial(ctx, t.username, passwordAuth(cur))
	if err != nil {
		return err
	}
	defer c.Close()
	s, err := c.NewSession()
	if err != nil {
		return err
	}
	defer s.Close()
	if err := s.RequestPty("xterm", 40, 200, ssh.TerminalModes{ssh.ECHO: 0}); err != nil {
		return err
	}
	in, err := s.StdinPipe()
	if err != nil {
		return err
	}
	out := &lockedBuffer{}
	s.Stdout, s.Stderr = out, out
	if err := s.Start("LC_ALL=C LANG=C passwd"); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- s.Wait() }()

	deadline := time.NewTimer(sshStepTimeout)
	defer deadline.Stop()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	answered := 0 // characters of output already answered
	for {
		select {
		case err := <-done:
			if err == nil {
				return nil
			}
			text := out.String()
			if m := passwdRefused.FindString(text); m != "" {
				return fmt.Errorf("passwd refused: %s", strings.TrimSpace(redact(m, cur, next)))
			}
			return fmt.Errorf("passwd failed: %s", lastLine(redact(text, cur, next)))
		case <-deadline.C:
			return errors.New("passwd did not finish in time")
		case <-ctx.Done():
			return ctx.Err()
		case <-tick.C:
			text := out.String()
			if len(text) == answered {
				continue
			}
			pending := text[answered:]
			switch {
			case promptCurrent.MatchString(pending):
				_, err = fmt.Fprintf(in, "%s\n", cur)
			case promptNew.MatchString(pending):
				_, err = fmt.Fprintf(in, "%s\n", next)
			default:
				continue // not a prompt yet (or one we don't answer: it times out)
			}
			if err != nil {
				return err
			}
			answered = len(text)
		}
	}
}

// Linux user names as useradd accepts them: nothing that could end a line or
// a chpasswd field.
var linuxUserRe = regexp.MustCompile(`^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}\$?$`)

func (t *linuxTarget) reset(ctx context.Context, next string) error {
	r := t.reconcile
	if r == nil {
		return errNoReconcile
	}
	if !linuxUserRe.MatchString(t.username) {
		return errors.New("the account name is not a Linux user name")
	}
	var auth []ssh.AuthMethod
	if r.isKey {
		signer, err := ssh.ParsePrivateKey([]byte(r.secret))
		if err != nil {
			return errors.New("the reconcile account's private key does not parse (keys with a passphrase are not supported)")
		}
		auth = []ssh.AuthMethod{ssh.PublicKeys(signer)}
	} else {
		auth = passwordAuth(r.secret)
	}
	c, err := t.dial(ctx, r.username, auth)
	if err != nil {
		if sshAuthResult(err).kind == authBad {
			return errors.New("the reconcile account could not sign in")
		}
		return err
	}
	defer c.Close()
	line := t.username + ":" + next + "\n"
	if r.username == "root" {
		return runWithInput(c, "chpasswd", line, next)
	}
	if runWithInput(c, "sudo -n true", "", "") == nil {
		return runWithInput(c, "sudo -n chpasswd", line, next)
	}
	if r.isKey {
		return errors.New("the reconcile account needs sudo without a password (it signs in with a key)")
	}
	// sudo reads its password from the first line, chpasswd the rest.
	return runWithInput(c, "sudo -S -p '' chpasswd", r.secret+"\n"+line, next, r.secret)
}

func runWithInput(c *ssh.Client, cmd, input string, secrets ...string) error {
	s, err := c.NewSession()
	if err != nil {
		return err
	}
	defer s.Close()
	s.Stdin = strings.NewReader(input)
	out := &lockedBuffer{}
	s.Stdout, s.Stderr = out, out
	done := make(chan error, 1)
	go func() { done <- s.Run(cmd) }()
	select {
	case err := <-done:
		if err != nil {
			return fmt.Errorf("%s failed: %s", strings.Fields(cmd)[0], lastLine(redact(out.String(), secrets...)))
		}
		return nil
	case <-time.After(sshStepTimeout):
		return fmt.Errorf("%s did not finish in time", strings.Fields(cmd)[0])
	}
}

func lastLine(s string) string {
	lines := strings.FieldsFunc(strings.TrimSpace(s), func(r rune) bool { return r == '\n' || r == '\r' })
	if len(lines) == 0 {
		return "no output"
	}
	l := strings.TrimSpace(lines[len(lines)-1])
	if len(l) > 200 {
		l = l[:200]
	}
	return l
}

type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}
