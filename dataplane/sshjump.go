package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// The SSH jump host: a user's own SSH client (OpenSSH, VS Code, Termius, PuTTY)
// reaches a resource's SSH server through Captivo with ProxyJump:
//
//	ssh -J <ticket>@<console host>:2222 <their user>@<server>
//
// The portal hands out the command with a ticket as the jump user name (see
// src/app/api/portal/ssh). The ticket says who and which resource and starts
// connections for two minutes; there is no password or key on this hop. The
// only thing this server does is open a direct-tcpip channel to that one
// resource's server through its connector. The SSH session inside is between
// the client and the server, so Captivo sees no terminal: these sessions are
// never recorded or watched, like native RDP (rdpgw.go). The grant is checked
// when the channel opens and every minute after (recheck.go).

const (
	sshTicketMaxAge   = 2 * time.Minute
	sshHandshakeLimit = 30 * time.Second
	sshMaxPending     = 64 // handshakes in progress at once
)

// sshTicket is one command the portal handed out. The manager pushes it here
// (POST /ssh-ticket); it lives in memory only, so a restart costs a user one
// more click.
type sshTicket struct {
	Code, TenantID, SiteID, UserID string
	Exp                            time.Time
}

type sshTickets struct {
	mu sync.Mutex
	m  map[string]sshTicket
}

func newSSHTickets() *sshTickets { return &sshTickets{m: map[string]sshTicket{}} }

func (t *sshTickets) Add(tk sshTicket) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.m[strings.ToLower(tk.Code)] = tk
}

// Get returns a ticket that can still start a connection, pruning expired ones.
func (t *sshTickets) Get(code string, now time.Time) (sshTicket, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	for k, v := range t.m {
		if !now.Before(v.Exp) {
			delete(t.m, k)
		}
	}
	tk, ok := t.m[strings.ToLower(code)]
	return tk, ok
}

// sshAuthorizer is the part of ControlClient the jump host uses.
type sshAuthorizer interface {
	CheckAccess(userID, siteID, clientIP string) (allow bool, reason string, err error)
	NativeSshTarget(userID, siteID string) (rdpTarget, error)
}

type sshJumpDeps struct {
	ctrl    sshAuthorizer
	dial    func(connectorID, target string) (net.Conn, error)
	hub     *SessionHub
	audit   *AuditQueue
	tickets *sshTickets
	now     func() time.Time
}

// loadOrCreateHostKey keeps the jump host's identity across restarts: a new key
// would make every client refuse it as a changed host. When the file can't be
// written the key lives for this process only, and that is said loudly.
func loadOrCreateHostKey(path string) (ssh.Signer, error) {
	if b, err := os.ReadFile(path); err == nil {
		return ssh.ParsePrivateKey(b)
	}
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	block, err := ssh.MarshalPrivateKey(priv, "captivo-access ssh jump host")
	if err != nil {
		return nil, err
	}
	if werr := os.WriteFile(path, pem.EncodeToMemory(block), 0o600); werr != nil {
		log.Printf("WARNING: ssh jump: can't keep the host key at %s (%v); clients will see a new host key after a restart", path, werr)
	} else {
		log.Printf("ssh jump: created a host key at %s", path)
	}
	return ssh.NewSignerFromKey(priv)
}

func sshServerConfig(d sshJumpDeps, hostKey ssh.Signer) *ssh.ServerConfig {
	cfg := &ssh.ServerConfig{
		ServerVersion: "SSH-2.0-CaptivoAccess",
		MaxAuthTries:  2,
		NoClientAuth:  true,
		NoClientAuthCallback: func(cm ssh.ConnMetadata) (*ssh.Permissions, error) {
			tk, ok := d.tickets.Get(cm.User(), d.now())
			if !ok {
				time.Sleep(500 * time.Millisecond) // a guess costs time
				return nil, errors.New("unknown or expired ticket")
			}
			return &ssh.Permissions{Extensions: map[string]string{"tenant": tk.TenantID, "site": tk.SiteID, "user": tk.UserID}}, nil
		},
		BannerCallback: func(cm ssh.ConnMetadata) string {
			if _, ok := d.tickets.Get(cm.User(), d.now()); ok {
				return ""
			}
			return "Captivo Access: this SSH command has expired or was already replaced.\r\n" +
				"Get a new one from My access in your Captivo portal; each one starts connections for two minutes.\r\n"
		},
	}
	cfg.AddHostKey(hostKey)
	return cfg
}

// serveSSHJump accepts connections until the listener closes.
func serveSSHJump(ln net.Listener, d sshJumpDeps, cfg *ssh.ServerConfig) {
	pending := make(chan struct{}, sshMaxPending)
	for {
		c, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			log.Printf("ssh jump: accept: %v", err)
			time.Sleep(100 * time.Millisecond)
			continue
		}
		select {
		case pending <- struct{}{}:
		default:
			c.Close() // too many handshakes at once
			continue
		}
		go func() {
			handleSSHJump(c, d, cfg, func() { <-pending })
		}()
	}
}

func handleSSHJump(c net.Conn, d sshJumpDeps, cfg *ssh.ServerConfig, handshook func()) {
	defer c.Close()
	clientIP, _, _ := net.SplitHostPort(c.RemoteAddr().String())
	_ = c.SetDeadline(time.Now().Add(sshHandshakeLimit))
	sc, chans, reqs, err := ssh.NewServerConn(c, cfg)
	handshook()
	if err != nil {
		return
	}
	_ = c.SetDeadline(time.Time{})
	defer sc.Close()
	// No global requests are served: remote forwarding (-R) and the like are refused.
	go ssh.DiscardRequests(reqs)
	tk := sshTicket{TenantID: sc.Permissions.Extensions["tenant"], SiteID: sc.Permissions.Extensions["site"], UserID: sc.Permissions.Extensions["user"]}
	j := &sshJumpConn{d: d, sc: sc, tk: tk, clientIP: clientIP, client: string(sc.ClientVersion())}
	var wg sync.WaitGroup
	for nc := range chans {
		switch nc.ChannelType() {
		case "direct-tcpip":
			wg.Add(1)
			go func(nc ssh.NewChannel) {
				defer wg.Done()
				j.forward(nc)
			}(nc)
		case "session":
			go j.explain(nc)
		default:
			_ = nc.Reject(ssh.Prohibited, "only jumps to your resource are allowed here")
		}
	}
	wg.Wait()
}

type sshJumpConn struct {
	d        sshJumpDeps
	sc       *ssh.ServerConn
	tk       sshTicket
	clientIP string
	client   string
}

// RFC 4254 7.2.
type directTCPIP struct {
	Host       string
	Port       uint32
	OriginHost string
	OriginPort uint32
}

func (j *sshJumpConn) forward(nc ssh.NewChannel) {
	var req directTCPIP
	if err := ssh.Unmarshal(nc.ExtraData(), &req); err != nil {
		_ = nc.Reject(ssh.ConnectionFailed, "bad request")
		return
	}
	allow, why, err := j.d.ctrl.CheckAccess(j.tk.UserID, j.tk.SiteID, j.clientIP)
	if err != nil {
		log.Printf("ssh jump: site=%s user=%s access check failed: %v", j.tk.SiteID, j.tk.UserID, err)
		_ = nc.Reject(ssh.ConnectionFailed, "Captivo could not check your access; try again")
		return
	}
	if !allow {
		log.Printf("ssh jump: site=%s user=%s refused (%s)", j.tk.SiteID, j.tk.UserID, why)
		j.auditDeny("native_ssh_" + strings.ReplaceAll(why, " ", "_"))
		_ = nc.Reject(ssh.Prohibited, "your access to this resource is not active")
		return
	}
	target, err := j.d.ctrl.NativeSshTarget(j.tk.UserID, j.tk.SiteID)
	if err != nil || target.TenantID != j.tk.TenantID {
		log.Printf("ssh jump: site=%s user=%s native target refused: %v", j.tk.SiteID, j.tk.UserID, err)
		j.auditDeny("native_ssh_not_allowed")
		_ = nc.Reject(ssh.Prohibited, "this resource can't be opened with your own SSH app")
		return
	}
	if !strings.EqualFold(req.Host, target.Host) || strconv.Itoa(int(req.Port)) != target.Port {
		// The jump goes where the ticket says, whatever the command was edited to ask for.
		log.Printf("ssh jump: site=%s client asked for %s:%d, using the resource's %s:%s", j.tk.SiteID, req.Host, req.Port, target.Host, target.Port)
	}
	remote, err := j.d.dial(target.ConnectorID, net.JoinHostPort(target.Host, target.Port))
	if err != nil {
		log.Printf("ssh jump: site=%s dial %s:%s via connector %s failed: %v", j.tk.SiteID, target.Host, target.Port, target.ConnectorID, err)
		_ = nc.Reject(ssh.ConnectionFailed, "the server can't be reached from its connector")
		return
	}
	ch, chReqs, err := nc.Accept()
	if err != nil {
		remote.Close()
		return
	}
	go ssh.DiscardRequests(chReqs)
	j.relay(ch, remote, target)
}

// relay carries the bytes both ways and keeps the session in the hub while it
// lasts, where the console lists it, an admin can end it and the grant is
// rechecked every minute.
func (j *sshJumpConn) relay(ch ssh.Channel, remote net.Conn, target rdpTarget) {
	tk, start := j.tk, j.d.now()
	sessionID := newSessionID()
	var once sync.Once
	closeAll := func() { once.Do(func() { ch.Close(); remote.Close() }) }
	if j.d.hub != nil {
		j.d.hub.RegisterNative(sessionID, "ssh", tk.SiteID, tk.UserID, target.Host, start, target.ConnectorID, j.clientIP)
		j.d.hub.clearEnded(tk.UserID, tk.SiteID)
		j.d.hub.SetCloser(sessionID, closeAll)
	}
	j.auditEvent("ALLOW", "session_open native_ssh", target.Host)
	log.Printf("ssh jump: site=%s user=%s live session id=%s target=%s:%s", tk.SiteID, tk.UserID, sessionID, target.Host, target.Port)
	// Count both ways; the close audit carries server→client as bytesOut, the
	// same direction the browser sessions record.
	var down, up int64
	done := make(chan struct{}, 2)
	go func() { down, _ = io.Copy(ch, remote); _ = ch.CloseWrite(); done <- struct{}{} }()
	go func() { up, _ = io.Copy(remote, ch); done <- struct{}{} }()
	<-done
	closeAll()
	<-done
	if j.d.hub != nil {
		j.d.hub.Remove(sessionID)
	}
	j.auditClose(compactDur(j.d.now().Sub(start)), target.Host, down)
	log.Printf("ssh jump: site=%s user=%s session %s closed after %s (down %d B, up %d B)", tk.SiteID, tk.UserID, sessionID, compactDur(j.d.now().Sub(start)), down, up)
}

// explain answers someone who signed in to the jump host itself instead of
// jumping through it: there is no shell here, only the way to use it.
func (j *sshJumpConn) explain(nc ssh.NewChannel) {
	ch, reqs, err := nc.Accept()
	if err != nil {
		return
	}
	defer ch.Close()
	for r := range reqs {
		switch r.Type {
		case "shell", "exec":
			_ = r.Reply(true, nil)
			msg := "This is Captivo Access's SSH jump host. It has no shell: use it with -J to reach your server,\r\n" +
				"as in the command from My access in your Captivo portal:\r\n\r\n" +
				"  ssh -J " + j.sc.User() + "@<this host> <your user>@<server>\r\n\r\n"
			_, _ = io.WriteString(ch, msg)
			_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{1}))
			return
		default:
			_ = r.Reply(r.Type == "pty-req" || r.Type == "env", nil)
		}
	}
}

func (j *sshJumpConn) auditDeny(reason string) {
	j.auditEvent("DENY", reason, "")
}

func (j *sshJumpConn) auditEvent(decision, reason, host string) {
	j.enqueue(decision, reason, host, 0)
}

func (j *sshJumpConn) auditClose(dur, host string, bytesOut int64) {
	j.enqueue("ALLOW", "session_close "+dur, host, bytesOut)
}

func (j *sshJumpConn) enqueue(decision, reason, host string, bytesOut int64) {
	if j.d.audit == nil {
		return
	}
	status := 0
	if decision == "DENY" {
		status = 403
	}
	j.d.audit.Enqueue(AuditEvent{
		Timestamp: time.Now(), UserID: j.tk.UserID, SiteID: j.tk.SiteID, Host: host,
		Method: "SSH", Path: "/", Status: status, BytesOut: bytesOut, Decision: decision, Reason: reason,
		ClientIP: j.clientIP, UserAgent: j.client,
	})
}

// sshJumpInfo is what the portal shows beside the command: the port and the
// host key's fingerprint, to compare with what the client prints on first use.
type sshJumpInfo struct {
	Enabled     bool   `json:"enabled"`
	Fingerprint string `json:"fingerprint,omitempty"`
}

func startSSHJump(addr, keyFile string, d sshJumpDeps) (sshJumpInfo, error) {
	if addr == "" || addr == "off" {
		return sshJumpInfo{}, nil
	}
	key, err := loadOrCreateHostKey(keyFile)
	if err != nil {
		return sshJumpInfo{}, fmt.Errorf("host key: %w", err)
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return sshJumpInfo{}, err
	}
	go serveSSHJump(ln, d, sshServerConfig(d, key))
	log.Printf("ssh jump: listening on %s (host key %s)", addr, ssh.FingerprintSHA256(key.PublicKey()))
	return sshJumpInfo{Enabled: true, Fingerprint: ssh.FingerprintSHA256(key.PublicKey())}, nil
}

// serveSSHTicket is POST /ssh-ticket on the internal listener: the manager
// registers a command it is about to show. The answer carries the host key's
// fingerprint for the portal to show beside it.
func serveSSHTicket(info sshJumpInfo, tickets *sshTickets, secret string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !dpAuthorized(r, secret) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if !info.Enabled {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "reason": "ssh_off"})
			return
		}
		var body struct {
			Code      string    `json:"code"`
			TenantID  string    `json:"tenantId"`
			SiteID    string    `json:"siteId"`
			UserID    string    `json:"userId"`
			ExpiresAt time.Time `json:"expiresAt"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil || len(body.Code) < 10 || body.SiteID == "" || body.UserID == "" || body.TenantID == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "reason": "invalid_body"})
			return
		}
		exp := body.ExpiresAt
		if max := time.Now().Add(sshTicketMaxAge); exp.After(max) {
			exp = max
		}
		tickets.Add(sshTicket{Code: body.Code, TenantID: body.TenantID, SiteID: body.SiteID, UserID: body.UserID, Exp: exp})
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "fingerprint": info.Fingerprint})
	}
}

// serveSSHInfo is POST /ssh-info: whether the jump host runs, and its key.
func serveSSHInfo(info sshJumpInfo, secret string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !dpAuthorized(r, secret) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		writeJSON(w, http.StatusOK, info)
	}
}
