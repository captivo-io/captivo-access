package main

import (
	"bufio"
	"context"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/kurtserdar/captivo-access/tunnel"
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
	// The vendor IP allowlist, as for web apps; the descriptor below checks the grant.
	clientIP := trustedClientIP(r)
	if allow, why, err := ctrl.CheckAccess(userID, siteID, clientIP); err != nil || !allow {
		log.Printf("guac-tunnel site=%s user=%s: access refused (%s) err=%v", siteID, userID, why, err)
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	conn, guacdAddr, cands, tenantID, record, keystrokeLogging, mod, err := ctrl.GatewayDescriptor(userID, siteID)
	if err != nil {
		log.Printf("guac-tunnel site=%s user=%s: descriptor failed err=%v", siteID, userID, err)
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	picked, _ := pickLeastLoaded(reg, hub, cands)
	connectorID := picked.ID
	if picked.SealedSecret != "" {
		conn.SealedSecret = picked.SealedSecret // sealed to this member's own key
	}
	var elev *tunnel.ElevateRequest
	if conn.Elevate != nil {
		if picked.ElevateSealed == "" {
			// A session that should have administrator rights does not open without them.
			log.Printf("guac-tunnel site=%s user=%s: connector %s has no copy of the administrator account", siteID, userID, connectorID)
			http.Error(w, "administrator rights unavailable", http.StatusBadGateway)
			return
		}
		elev = conn.Elevate.request(conn.Hostname, conn.Port, conn.Username, picked.ElevateSealed, conn.SSHHostKey)
	}
	log.Printf("guac-tunnel site=%s user=%s: descriptor ok protocol=%s target=%s:%s guacd=%s connector=%s", siteID, userID, conn.Protocol, conn.Hostname, conn.Port, guacdAddr, connectorID)
	ft := newFTObserver(userID, siteID, conn.Hostname, firstHop(r.Header.Get("X-Forwarded-For")), r.UserAgent())
	sess := reg.Get(connectorID)
	if sess == nil {
		log.Printf("guac-tunnel site=%s: connector %s offline", siteID, connectorID)
		http.Error(w, "connector offline", http.StatusBadGateway)
		return
	}

	var guac net.Conn
	if conn.SealedSecret != "" {
		// The secret is sealed to this connector; only it can open it. The
		// handshake carries a per-session placeholder in its place.
		conn.Secret = vaultPlaceholder()
		guac, err = dialGuacdReq(sess, tunnel.GuacdDialRequest{Kind: "guacd", Target: guacdAddr, Sealed: conn.SealedSecret, Placeholder: conn.Secret, Elevate: elev})
	} else {
		guac, err = dialGuacdReq(sess, tunnel.GuacdDialRequest{Kind: "guacd", Target: guacdAddr, Elevate: elev})
	}
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
		// The chunks go to the connector that is already carrying this session,
		// so they never leave the customer's network.
		send := func(req tunnel.RecWriteRequest) (int, error) { return writeRecChunk(sess, req) }
		idx := &recIndexReporter{send: ctrl.SendRecording, userID: userID, siteID: siteID, host: conn.Hostname, format: "guac", proto: conn.Protocol, connectorID: connectorID}
		rec = newRecWriter(send, idx, tenantID, recKey, siteID, userID, conn.Hostname, conn.Protocol, recordingMaxBytes())
		// Deferred first, so it runs last: after the tail chunk is flushed and
		// the keystrokes posted, the recording is complete.
		defer notifyRecDone(sess, tenantID, recKey)
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
		// Keystrokes go to the same connector store as the video.
		kw = newKeyWriter(func(req tunnel.RecWriteRequest) (int, error) { return writeRecChunk(sess, req) }, tenantID, recKey)
		log.Printf("guac-tunnel site=%s: keystroke logging enabled key=%s", siteID, recKey)
	}

	// The resource's command list on a browser SSH session (guacgate.go).
	var cmdg *guacCmdGate
	if strings.EqualFold(conn.Protocol, "ssh") && conn.Commands.Active() {
		cmdg = newGuacCmdGate(conn.Commands)
		log.Printf("guac-tunnel site=%s: command list %q (%s) active", siteID, conn.Commands.Name, conn.Commands.Mode)
	}

	connID := ""
	if len(readyArgs) > 0 {
		connID = readyArgs[0] // guacd connection ID — the share key for viewers
	}
	ls := hub.Register(sessionID, siteID, userID, conn.Protocol, conn.Hostname, time.Now(), connID, connectorID, guacdAddr)
	ls.SetAuth(ck.Value, clientIP) // checked again every minute (recheck.go)
	ls.SetCapture(record, record && keystrokeLogging)
	hub.clearEnded(userID, siteID)
	if mod.ID != "" {
		hub.Moderate(ls, mod, func() {
			log.Printf("guac-tunnel site=%s: session %s ended, no moderator came back", siteID, sessionID)
			audit.Enqueue(auditEvent("DENY", "session_end_policy "+endModeratorLeft, userID, siteID, conn.Hostname, r, http.StatusForbidden, 0))
		})
	}
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
			if on, ok := altScreenInstruction(inst); ok {
				keys.setAlt(on) // for the keystroke log only: not recorded, not sent on
				if cmdg != nil {
					cmdg.setAlt(on)
				}
				continue
			}
			if rec != nil {
				rec.Write(inst)
			}
			down := ft.observe(dirDownload, inst)
			for _, ev := range down {
				audit.Enqueue(ev)
			}
			ls.fileEvents(down)
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
			if !vendorMayForward(instructionOpcode(data), ls.vendorInputAllowed()) {
				continue // someone else holds control, or no moderator watches: drop the user's input
			}
			ls.touch(data, time.Now())
			up := ft.observe(dirUpload, data)
			for _, ev := range up {
				audit.Enqueue(ev)
			}
			ls.fileEvents(up)
			if keys != nil {
				if evs := keys.observe(data, time.Now()); len(evs) > 0 {
					kw.post(evs)
					ls.keyEvents(evs)
				}
			}
			send := data
			if cmdg != nil {
				var notes []string
				send, notes = cmdg.process(data)
				for _, n := range notes {
					_ = c.Write(ctx, websocket.MessageText, encodeInstruction("captivo-notice", n))
					audit.Enqueue(auditEvent("DENY", "command_denied "+n, userID, siteID, conn.Hostname, r, http.StatusForbidden, 0))
				}
			}
			if len(send) == 0 {
				continue
			}
			if _, werr := guac.Write(send); werr != nil {
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
