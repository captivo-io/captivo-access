package main

import (
	"bufio"
	"context"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/coder/websocket"
)

// qInt reads an integer query param, clamped to [lo,hi], defaulting to def.
func qInt(r *http.Request, key string, def, lo, hi int) string {
	n, err := strconv.Atoi(r.URL.Query().Get(key))
	if err != nil || n < lo || n > hi {
		n = def
	}
	return strconv.Itoa(n)
}

// serveGuacTunnel bridges a browser WebSocket (guacamole-common-js) to guacd
// through the connector. It authenticates the Captivo session, resolves the
// connection descriptor from the manager (grant-checked, credential-decrypted),
// opens guacd, drives the full guacd handshake server-side (guacamole-lite model:
// the server does select/args/connect; the browser only renders + sends input),
// and then relays the Guacamole protocol both ways. The credential appears only
// inside the server-side `connect` instruction and never reaches the browser.
func serveGuacTunnel(ctrl *ControlClient, reg *Registry, hub *SessionHub, audit *AuditQueue, w http.ResponseWriter, r *http.Request) {
	siteID := r.URL.Query().Get("site")
	if siteID == "" {
		http.Error(w, "missing site", http.StatusBadRequest)
		return
	}
	ck, err := r.Cookie("ca_session")
	if err != nil || ck.Value == "" {
		log.Printf("guac-tunnel site=%s: no session cookie", siteID)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	userID, _, err := ctrl.ResolveSession(ck.Value)
	if err != nil || userID == "" {
		log.Printf("guac-tunnel site=%s: session resolve failed err=%v", siteID, err)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	conn, guacdAddr, connectorID, record, keystrokeLogging, err := ctrl.GatewayDescriptor(userID, siteID)
	if err != nil {
		log.Printf("guac-tunnel site=%s user=%s: descriptor failed err=%v", siteID, userID, err)
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	log.Printf("guac-tunnel site=%s user=%s: descriptor ok protocol=%s target=%s:%s guacd=%s connector=%s", siteID, userID, conn.Protocol, conn.Hostname, conn.Port, guacdAddr, connectorID)
	ft := newFTObserver(userID, siteID, conn.Hostname, firstHop(r.Header.Get("X-Forwarded-For")), r.UserAgent())
	sess := reg.Get(connectorID)
	if sess == nil {
		log.Printf("guac-tunnel site=%s: connector %s offline", siteID, connectorID)
		http.Error(w, "connector offline", http.StatusBadGateway)
		return
	}

	guac, err := dialGuacd(sess, guacdAddr)
	if err != nil {
		log.Printf("guac-tunnel site=%s: dialGuacd(%s) failed err=%v", siteID, guacdAddr, err)
		http.Error(w, "guacd unreachable", http.StatusBadGateway)
		return
	}
	defer guac.Close()

	// Server-side handshake (spike-proven sequence).
	br := bufio.NewReader(guac)
	if _, err := guac.Write(encodeInstruction("select", conn.Protocol)); err != nil {
		log.Printf("guac-tunnel site=%s: write select failed err=%v", siteID, err)
		http.Error(w, "handshake", http.StatusBadGateway)
		return
	}
	op, argNames, err := parseInstruction(br)
	if err != nil || op != "args" {
		log.Printf("guac-tunnel site=%s: expected args got op=%q err=%v", siteID, op, err)
		http.Error(w, "handshake args", http.StatusBadGateway)
		return
	}
	_, _ = guac.Write(encodeInstruction("size", qInt(r, "w", 1280, 640, 5120), qInt(r, "h", 800, 480, 2880), qInt(r, "dpi", 96, 72, 240)))
	// Advertise the raw PCM types guacamole-common-js can play, so RDP audio (and
	// any other protocol that emits sound) reaches the vendor's browser. guacd only
	// sends audio when the client lists a type; the per-resource "disable-audio"
	// param still switches it off server-side.
	_, _ = guac.Write(encodeInstruction("audio", "audio/L8", "audio/L16"))
	_, _ = guac.Write(encodeInstruction("video"))
	_, _ = guac.Write(encodeInstruction("image"))
	sessionID := newSessionID()
	injectDrivePath(conn.Params, sessionID) // per-session RDP drive isolation (/drive/<sessionID>)
	if _, err := guac.Write(buildConnect(argNames, conn)); err != nil {
		log.Printf("guac-tunnel site=%s: write connect failed err=%v", siteID, err)
		http.Error(w, "connect", http.StatusBadGateway)
		return
	}
	op, readyArgs, err := parseInstruction(br)
	if err != nil || op != "ready" {
		log.Printf("guac-tunnel site=%s: expected ready got op=%q args=%v err=%v", siteID, op, readyArgs, err)
		http.Error(w, "not ready", http.StatusBadGateway)
		return
	}
	log.Printf("guac-tunnel site=%s: READY, bridging", siteID)

	recKey := newRecordingKey(siteID, userID)
	var rec *recWriter
	if record {
		rec = newRecWriter(ctrl.BaseURL, ctrl.Secret, recKey, siteID, userID, conn.Hostname, conn.Protocol, recordingMaxBytes())
		defer rec.Close()
		log.Printf("guac-tunnel site=%s: recording enabled key=%s", siteID, rec.key)
	}
	// Keystroke timeline (opt-in, requires recording): the keyObserver taps the
	// browser->guacd pump (like the ftObserver) and posts reconstructed events under
	// the SAME recording key, so the timeline links to the recording for seeking.
	var keys *keyObserver
	var kw *keyWriter
	if record && keystrokeLogging {
		keys = newKeyObserver(conn.Protocol, time.Now())
		kw = newKeyWriter(ctrl.BaseURL, ctrl.Secret, recKey)
		log.Printf("guac-tunnel site=%s: keystroke logging enabled key=%s", siteID, recKey)
	}

	connID := ""
	if len(readyArgs) > 0 {
		connID = readyArgs[0] // guacd connection ID — the share key for viewers
	}
	ls := hub.Register(sessionID, siteID, userID, conn.Protocol, conn.Hostname, time.Now(), connID, connectorID, guacdAddr)
	// Closing the guacd conn makes the relay error out → goroutines exit → session
	// tears down (defer c.CloseNow + hub.Remove). This is how admin Terminate works.
	hub.SetCloser(sessionID, func() { _ = guac.Close() })
	defer hub.Remove(sessionID)

	sessStart := time.Now()
	audit.Enqueue(auditEvent("ALLOW", "session_open", userID, siteID, conn.Hostname, r, http.StatusSwitchingProtocols, 0))
	defer func() {
		audit.Enqueue(auditEvent("ALLOW", "session_close "+compactDur(time.Since(sessStart)), userID, siteID, conn.Hostname, r, http.StatusSwitchingProtocols, 0))
	}()
	log.Printf("guac-tunnel site=%s: live session id=%s connID=%s", siteID, sessionID, connID)

	// Upgrade the browser WebSocket and bridge. The browser is same-origin behind
	// the front nginx; skip strict origin checks (the session cookie already
	// authenticated the request).
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
		Subprotocols:       []string{"guacamole"}, // guacamole-common-js requires this
	})
	if err != nil {
		log.Printf("guac-tunnel site=%s: ws accept failed err=%v", siteID, err)
		return
	}
	c.SetReadLimit(32 << 20) // 32 MiB: generous for vendor input (clipboard/blob) but bounded, so a giant frame can't OOM the shared data-plane. Image blobs flow guacd->browser (writes), not through this read limit.
	log.Printf("guac-tunnel site=%s: ws accepted subproto=%q", siteID, c.Subprotocol())
	defer c.CloseNow()
	// A background context (not the request's) keeps the long-lived session alive
	// regardless of the HTTP request lifecycle.
	ctx := context.Background()

	// Send `ready` to the browser so guacamole-common-js starts the session.
	if err := c.Write(ctx, websocket.MessageText, encodeInstruction(append([]string{"ready"}, readyArgs...)...)); err != nil {
		return
	}

	errc := make(chan error, 2)
	// guacd -> browser: one WHOLE guac instruction per WS message (never split a
	// large instruction across frames, or the client can't reassemble it).
	go func() {
		for {
			inst, rerr := readRawInstruction(br)
			if rerr != nil {
				errc <- rerr
				return
			}
			if rec != nil {
				rec.Write(inst)
			}
			for _, ev := range ft.observe(dirDownload, inst) {
				audit.Enqueue(ev)
			}
			if werr := c.Write(ctx, websocket.MessageText, inst); werr != nil {
				errc <- werr
				return
			}
		}
	}()
	// browser -> guacd (vendor input; suppressed while an admin holds control)
	go func() {
		for {
			_, data, rerr := c.Read(ctx)
			if rerr != nil {
				errc <- rerr
				return
			}
			if !ls.vendorInputAllowed() {
				continue // an admin has taken control; drop vendor input
			}
			for _, ev := range ft.observe(dirUpload, data) {
				audit.Enqueue(ev)
			}
			if keys != nil {
				if evs := keys.observe(data, time.Now()); len(evs) > 0 {
					kw.post(evs)
				}
			}
			if _, werr := guac.Write(data); werr != nil {
				errc <- werr
				return
			}
		}
	}()
	<-errc
	for _, ev := range ft.flush() {
		audit.Enqueue(ev)
	}
	if keys != nil {
		if evs := keys.flush(time.Now()); len(evs) > 0 {
			kw.post(evs)
		}
	}
}
