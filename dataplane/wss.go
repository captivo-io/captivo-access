package main

import (
	"context"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/hashicorp/yamux"
	"github.com/kurtserdar/captivo-access/tunnel"
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

	sess := &Session{mux: mux}
	s.reg.Set(connectorID, sess)
	policy, logLevel, rec := s.ctrl.ReportStatus(connectorID, "ONLINE", r.RemoteAddr, r.Header.Get("X-Connector-Version"))
	go runControl(sess, connectorID, s.ctrl, policy, logLevel, rec)
	defer func() {
		if s.reg.RemoveIfSame(connectorID, sess) {
			_, _, _ = s.ctrl.ReportStatus(connectorID, "OFFLINE", r.RemoteAddr, "")
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
