package main

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// isWebSocketUpgrade reports whether r is a WebSocket handshake: Upgrade is
// "websocket" (case-insensitive) and Connection contains an "upgrade" token
// (case-insensitive, comma-list aware — e.g. "keep-alive, Upgrade").
func isWebSocketUpgrade(r *http.Request) bool {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		return false
	}
	for _, tok := range strings.Split(r.Header.Get("Connection"), ",") {
		if strings.EqualFold(strings.TrimSpace(tok), "upgrade") {
			return true
		}
	}
	return false
}

// wsRequestHeaders builds the header set forwarded to the connector for a WS
// handshake. It mirrors sanitizeReqHeaders (reserved auth cookies stripped from
// Cookie, any client-supplied gatewayUserHeader dropped, XFF/XFH added)
// EXCEPT it keeps the Upgrade/Connection handshake headers (Sec-WebSocket-*
// are not hop-by-hop and pass through anyway).
func wsRequestHeaders(r *http.Request, host string) map[string][]string {
	out := map[string][]string{}
	for k, vs := range r.Header {
		lk := strings.ToLower(k)
		if lk != "upgrade" && lk != "connection" && hopByHopHeaders[lk] {
			continue
		}
		if strings.EqualFold(k, "Cookie") {
			continue // rebuilt below without reserved auth cookies
		}
		if strings.EqualFold(k, gatewayUserHeader) {
			continue // client must never smuggle the trusted gateway identity header
		}
		cp := make([]string, len(vs))
		copy(cp, vs)
		out[k] = cp
	}
	if ck := filteredCookieHeader(r); ck != "" {
		out["Cookie"] = []string{ck}
	}
	ip := remoteIP(r)
	if ip != "" {
		if existing := r.Header.Get("X-Forwarded-For"); existing != "" {
			ip = existing + ", " + ip
		}
		out["X-Forwarded-For"] = []string{ip}
	}
	out["X-Forwarded-Host"] = []string{host}
	return out
}

// serveWebSocket relays a WebSocket connection through the connector tunnel.
// The access decision has already been made (allow) by the caller. It performs
// the tunnel handshake first (so a failure needs no hijack), then hijacks the
// browser connection and raw-relays bytes both directions until either side
// closes. Two audit events bracket the session.
func (p *BrowserProxy) serveWebSocket(w http.ResponseWriter, r *http.Request, connectorID, siteID, userID, host, upstream string, insecureSkipVerify, gateway bool, email string) {
	sess := p.reg.Get(connectorID)
	if sess == nil || sess.mux == nil {
		http.Error(w, "connector offline", http.StatusBadGateway)
		return
	}
	st, err := sess.mux.Open()
	if err != nil {
		http.Error(w, "connector offline", http.StatusBadGateway)
		return
	}
	defer st.Close()

	hdr := wsRequestHeaders(r, host)
	setGatewayIdentity(hdr, gateway, email)

	wr := tunnel.WsDialRequest{
		Kind:               "ws",
		UpstreamUrl:        upstream,
		Path:               r.URL.RequestURI(),
		Header:             hdr,
		InsecureSkipVerify: insecureSkipVerify,
	}
	reqBytes, err := json.Marshal(wr)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if tunnel.WriteFrame(st, reqBytes) != nil {
		http.Error(w, "tunnel error", http.StatusBadGateway)
		return
	}

	respBytes, err := tunnel.ReadFrame(st)
	if err != nil {
		http.Error(w, "tunnel error", http.StatusBadGateway)
		return
	}
	var wresp tunnel.WsDialResponse
	if json.Unmarshal(respBytes, &wresp) != nil {
		http.Error(w, "tunnel error", http.StatusBadGateway)
		return
	}
	if wresp.Error != "" || wresp.Status != http.StatusSwitchingProtocols {
		http.Error(w, "upstream did not accept the websocket", http.StatusBadGateway)
		return
	}

	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	conn, brw, err := hj.Hijack()
	if err != nil {
		return
	}
	defer conn.Close()

	// Replay the 101 handshake to the browser.
	var b strings.Builder
	b.WriteString("HTTP/1.1 101 Switching Protocols\r\n")
	for k, vs := range wresp.Header {
		for _, v := range vs {
			b.WriteString(k + ": " + v + "\r\n")
		}
	}
	b.WriteString("\r\n")
	if _, err := brw.WriteString(b.String()); err != nil {
		return
	}
	if brw.Flush() != nil {
		return
	}

	wsStart := time.Now()
	p.audit.Enqueue(auditEvent("ALLOW", "session_open", userID, siteID, host, r, http.StatusSwitchingProtocols, 0))
	// Checked again every minute while open (recheck.go).
	forget := watchWebSocket(&watchedWS{userID: userID, siteID: siteID, token: readCookie(r, sessionCookieName), clientIP: trustedClientIP(r),
		close: func() { _ = conn.Close(); _ = st.Close() }})
	defer forget()

	// Raw bidirectional relay. brw (its Reader) holds any bytes the browser
	// already sent past the handshake — read from it, not conn. Count the
	// tunnel→browser bytes for the close audit.
	var total int64
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(st, brw); done <- struct{}{} }()              // browser → tunnel
	go func() { n, _ := io.Copy(conn, st); total = n; done <- struct{}{} }() // tunnel → browser
	<-done
	_ = conn.Close()
	_ = st.Close()
	<-done

	p.audit.Enqueue(auditEvent("ALLOW", "session_close "+compactDur(time.Since(wsStart)), userID, siteID, host, r, http.StatusSwitchingProtocols, total))
}
