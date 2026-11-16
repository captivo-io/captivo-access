package main

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/coder/websocket"
)

// viewAuthorizer is what serveWebView needs from the control plane.
type viewAuthorizer interface {
	ResolveSession(token string) (userID, email string, err error)
	ViewAuthz(userID, siteID string) (bool, error)
}

// serveWebView streams a web app tab's live rrweb events to an admin's
// browser: the current page first (one frame), then each batch the vendor's
// recorder posts. Same viewer authentication and site authorization as the
// gateway and isolated live views; read-only, since nothing can be sent back
// into the vendor's own browser.
func serveWebView(live *WebLiveHub, ctrl viewAuthorizer, w http.ResponseWriter, r *http.Request) {
	key := r.URL.Query().Get("key")
	if key == "" {
		http.Error(w, "missing key", http.StatusBadRequest)
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
	siteID, page, ch, cancel, ok := live.Subscribe(key)
	if !ok {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}
	defer cancel()
	allow, err := ctrl.ViewAuthz(viewerUserID, siteID)
	if err != nil || !allow {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer c.CloseNow()
	// Read-only: anything the viewer sends is discarded, but reading is what
	// notices the viewer leaving.
	ctx := c.CloseRead(r.Context())

	send := func(events []json.RawMessage) error {
		b, err := json.Marshal(events)
		if err != nil {
			return err
		}
		wctx, done := context.WithTimeout(ctx, 10*time.Second)
		defer done()
		return c.Write(wctx, websocket.MessageText, b)
	}
	if len(page) > 0 {
		if send(page) != nil {
			return
		}
	}
	idle := time.NewTicker(30 * time.Second)
	defer idle.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case events := <-ch:
			if send(events) != nil {
				return
			}
		case <-idle.C:
			if c.Ping(ctx) != nil {
				return
			}
		}
	}
}
