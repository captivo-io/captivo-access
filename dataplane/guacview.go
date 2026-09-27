package main

import (
	"bufio"
	"context"
	"log"
	"net/http"

	"github.com/coder/websocket"
)

// serveGuacView attaches a viewer to an active gateway session by JOINING guacd's
// shared connection (select <connID>). guacd sends the joining user the current
// display keyframe, then live updates — so an idle screen is shown immediately.
// The viewer is read-only unless it holds control, in which case its input is
// forwarded to guacd (which routes it to the target, shared with the vendor).
func serveGuacView(hub *SessionHub, ctrl *ControlClient, reg *Registry, w http.ResponseWriter, r *http.Request) {
	sessionID := r.URL.Query().Get("session")
	if sessionID == "" {
		http.Error(w, "missing session", http.StatusBadRequest)
		return
	}
	ck, err := r.Cookie("ca_session")
	if err != nil || ck.Value == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	viewerUserID, _, err := ctrl.ResolveSession(ck.Value)
	if err != nil || viewerUserID == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	allow, err := ctrl.ViewAuthz(viewerUserID)
	if err != nil || !allow {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	ls := hub.Get(sessionID)
	if ls == nil {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}
	connID, connectorID, guacdAddr := ls.shareInfo()
	if connID == "" {
		http.Error(w, "session not ready", http.StatusConflict)
		return
	}
	sess := reg.Get(connectorID)
	if sess == nil {
		http.Error(w, "connector offline", http.StatusBadGateway)
		return
	}
	guac, err := dialGuacd(sess, guacdAddr)
	if err != nil {
		log.Printf("guac-view session=%s: dialGuacd(%s) failed err=%v", sessionID, guacdAddr, err)
		http.Error(w, "guacd unreachable", http.StatusBadGateway)
		return
	}
	defer guac.Close()

	// Join the existing connection by its ID. guacd replies with args, we echo the
	// handshake, and on `ready` guacd streams the current keyframe + live updates.
	br := bufio.NewReader(guac)
	if _, err := guac.Write(encodeInstruction("select", connID)); err != nil {
		http.Error(w, "handshake", http.StatusBadGateway)
		return
	}
	op, argNames, err := parseInstruction(br)
	if err != nil || op != "args" {
		log.Printf("guac-view session=%s: expected args got op=%q err=%v", sessionID, op, err)
		http.Error(w, "handshake args", http.StatusBadGateway)
		return
	}
	_, _ = guac.Write(encodeInstruction("size", qInt(r, "w", 1280, 640, 5120), qInt(r, "h", 800, 480, 2880), qInt(r, "dpi", 96, 72, 240)))
	_, _ = guac.Write(encodeInstruction("audio"))
	_, _ = guac.Write(encodeInstruction("video"))
	_, _ = guac.Write(encodeInstruction("image"))
	if _, err := guac.Write(buildConnect(argNames, GuacConn{})); err != nil {
		http.Error(w, "connect", http.StatusBadGateway)
		return
	}
	op, readyArgs, err := parseInstruction(br)
	if err != nil || op != "ready" {
		log.Printf("guac-view session=%s: expected ready got op=%q err=%v", sessionID, op, err)
		http.Error(w, "not ready", http.StatusBadGateway)
		return
	}
	log.Printf("guac-view session=%s viewer=%s: joined connID=%s", sessionID, viewerUserID, connID)

	ls.addViewer()
	defer ls.removeViewer()

	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
		Subprotocols:       []string{"guacamole"},
	})
	if err != nil {
		log.Printf("guac-view session=%s: ws accept failed err=%v", sessionID, err)
		return
	}
	c.SetReadLimit(32 << 20) // 32 MiB bound: a live-view spectator sends little input; an unbounded read would let one frame OOM the shared data-plane.
	defer c.CloseNow()
	ctx := context.Background()

	if err := c.Write(ctx, websocket.MessageText, encodeInstruction(append([]string{"ready"}, readyArgs...)...)); err != nil {
		return
	}

	errc := make(chan error, 2)
	// guacd -> viewer browser (keyframe first, then live).
	go func() {
		for {
			inst, rerr := readRawInstruction(br)
			if rerr != nil {
				errc <- rerr
				return
			}
			if werr := c.Write(ctx, websocket.MessageText, inst); werr != nil {
				errc <- werr
				return
			}
		}
	}()
	// viewer browser -> guacd. Input only while this viewer holds control, but
	// protocol liveness always: see viewerMayForward -- guacd disconnects a user it
	// hears nothing from, and a watching viewer's only traffic is its sync echo.
	go func() {
		for {
			_, data, rerr := c.Read(ctx)
			if rerr != nil {
				errc <- rerr
				return
			}
			if !viewerMayForward(instructionOpcode(data), ls.viewerInputAllowed(viewerUserID)) {
				continue
			}
			if _, werr := guac.Write(data); werr != nil {
				errc <- werr
				return
			}
		}
	}()
	// Log why the view ended. Without this a dropped viewer was indistinguishable
	// from a finished session in the log, and the browser shows the same sentence
	// for both.
	if err := <-errc; err != nil {
		log.Printf("guac-view session=%s viewer=%s: view ended err=%v", sessionID, viewerUserID, err)
	}
}
