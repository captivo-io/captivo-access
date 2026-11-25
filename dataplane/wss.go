package main

import (
	"context"
	"encoding/base64"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/hashicorp/yamux"
	"github.com/kurtserdar/captivo-access/tunnel"
	"golang.org/x/crypto/ssh"
)

// tunnelRateLimit and tunnelRateWindow bound how many /tunnel connection
// attempts a single source IP may make before its connector-token auth is
// even attempted, since AuthConnector's argon2 verify is expensive and
// otherwise cheap to amplify by spamming random bearer tokens.
const (
	tunnelRateLimit  = 10
	tunnelRateWindow = 60 * time.Second
)

// Server handles connector WSS connections and hosts the connector
// registry shared with the internal /proxy API.
type Server struct {
	reg  *Registry
	ctrl *ControlClient
	rl   *rateLimiter
}

// HandleTunnel upgrades a connector's WSS connection to a yamux server
// session after validating its bearer token against the control plane. It
// blocks for the lifetime of the session and cleans up (deregister +
// report OFFLINE) on exit.
func (s *Server) HandleTunnel(w http.ResponseWriter, r *http.Request) {
	if s.rl != nil && !s.rl.allow(clientIP(r), tunnelRateLimit, tunnelRateWindow) {
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}

	token := bearer(r.Header.Get("Authorization"))
	connectorID, err := s.ctrl.AuthConnector(token)
	if err != nil || connectorID == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	c, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}

	// NetConn gives us an io.ReadWriteCloser/net.Conn we can hand to yamux.
	netConn := websocket.NetConn(context.Background(), c, websocket.MessageBinary)
	mux, err := yamux.Server(netConn, tunnel.SessionConfig())
	if err != nil {
		c.Close(websocket.StatusInternalError, "yamux setup failed")
		return
	}

	sess := &Session{mux: mux, kasmToken: kasmTokenFromHeader(r.Header.Get("X-Kasm-Control-Token"))}
	s.reg.Set(connectorID, sess)
	policy, logLevel, rec := s.ctrl.ReportStatus(connectorID, "ONLINE", r.RemoteAddr, r.Header.Get("X-Connector-Version"), vaultPublicKeyFromHeader(r.Header.Get("X-Vault-Public-Key")), connectorPlatform(r.Header.Get("X-Connector-Platform")), sshCAKeyFromHeader(r.Header.Get("X-SSH-CA-Public-Key")))
	go runControl(sess, connectorID, s.ctrl, policy, logLevel, rec)
	defer func() {
		if s.reg.RemoveIfSame(connectorID, sess) {
			_, _, _ = s.ctrl.ReportStatus(connectorID, "OFFLINE", r.RemoteAddr, "", "", "", "")
		}
		mux.Close()
	}()

	// Block until the session dies (yamux keepalive detects a dead peer).
	<-mux.CloseChan()
}

func bearer(h string) string {
	const p = "Bearer "
	if len(h) > len(p) && h[:len(p)] == p {
		return h[len(p):]
	}
	return ""
}

// clientIP returns the un-spoofable rate-limit key: the right-most
// X-Forwarded-For hop (the one our own trusted front proxy appends), else the
// socket peer. The left-most hop is client-controlled — using it would let an
// attacker rotate buckets to bypass the limiter or forge a victim's IP to
// lock them out.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.LastIndexByte(xff, ','); i >= 0 {
			return strings.TrimSpace(xff[i+1:])
		}
		return strings.TrimSpace(xff)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// connectorPlatform accepts only the platforms a program install reports; the
// Docker image sends none, and anything else is treated as that.
func connectorPlatform(v string) string {
	switch v {
	case "windows", "linux":
		return v
	}
	return ""
}

// vaultPublicKeyFromHeader accepts only a base64 X25519 public key (32 bytes):
// the control plane seals resource secrets to it, for that connector alone.
func vaultPublicKeyFromHeader(v string) string {
	b, err := base64.StdEncoding.DecodeString(v)
	if err != nil || len(b) != 32 {
		return ""
	}
	return v
}

// sshCAKeyFromHeader accepts only one ssh-ed25519 public key line: servers are
// told to trust it, so nothing else (a comment with line breaks, another key
// type) may pass through the control plane to an admin's screen.
func sshCAKeyFromHeader(v string) string {
	v = strings.TrimSpace(v)
	pk, comment, _, rest, err := ssh.ParseAuthorizedKey([]byte(v))
	if err != nil || len(rest) != 0 || comment != "" || pk.Type() != ssh.KeyAlgoED25519 {
		return ""
	}
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(pk)))
}

// kasmTokenFromHeader accepts only a plain token: it is written into raw HTTP
// requests to the broker, so CR, LF or anything but hex must not get through.
func kasmTokenFromHeader(v string) string {
	if len(v) == 0 || len(v) > 256 {
		return ""
	}
	for _, c := range v {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return ""
		}
	}
	return v
}
