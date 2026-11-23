package main

import (
	"bufio"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/kurtserdar/captivo-access/tunnel"
)

// rdpViewKeepalive is how often a viewer gets a nop when nothing else is sent.
const rdpViewKeepalive = 5 * time.Second

// serveRdpView shows a viewer a recorded native RDP session as it runs. Its
// connector decodes the picture (connector/rdplive.go) and sends Guacamole
// protocol, the same the browser's live view gets from guacd for a session
// in the browser, so the viewer page is the same. What the viewer sends (keys,
// the mouse) reaches the session only while it holds control (rdpcontrol.go).
// The user is not told in their app (an RDP app has no place Captivo could
// write to); the portal and the .rdp file say sessions may be watched or
// taken over.
func serveRdpView(ls *liveSession, s *Session, watchID, viewerUserID string, w http.ResponseWriter, r *http.Request) {
	if s == nil || s.mux == nil {
		http.Error(w, "the session's connector is offline", http.StatusBadGateway)
		return
	}
	st, err := s.mux.Open()
	if err != nil {
		http.Error(w, "the session's connector is offline", http.StatusBadGateway)
		return
	}
	defer st.Close()
	b, _ := json.Marshal(tunnel.RdpWatchRequest{Kind: "rdp-watch", WatchID: watchID})
	if err := tunnel.WriteFrame(st, b); err != nil {
		http.Error(w, "the session's connector is offline", http.StatusBadGateway)
		return
	}
	_ = st.SetReadDeadline(time.Now().Add(15 * time.Second))
	rb, err := tunnel.ReadFrame(st)
	var resp tunnel.RdpWatchResponse
	if err != nil || json.Unmarshal(rb, &resp) != nil {
		http.Error(w, "the connector did not answer; it may need an update", http.StatusBadGateway)
		return
	}
	if resp.Error != "" {
		http.Error(w, resp.Error, http.StatusConflict)
		return
	}
	_ = st.SetReadDeadline(time.Time{})
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true, Subprotocols: []string{"guacamole"}})
	if err != nil {
		return
	}
	defer c.CloseNow()
	c.SetReadLimit(1 << 20)
	ls.addViewer()
	defer ls.removeViewer()
	log.Printf("rdp-view session=%s viewer=%s: watching", ls.id, viewerUserID)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := c.Write(ctx, websocket.MessageText, encodeInstruction("ready", "$"+watchID)); err != nil {
		return
	}
	errc := make(chan error, 2)
	go func() {
		br := bufio.NewReaderSize(st, 64<<10)
		for {
			inst, err := readRawInstruction(br)
			if err != nil {
				errc <- err
				return
			}
			if err := c.Write(ctx, websocket.MessageText, inst); err != nil {
				errc <- err
				return
			}
		}
	}()
	// A still screen sends nothing, and guacamole-common-js gives up on a
	// tunnel it hears nothing from for 15 seconds ("The session ended or is no
	// longer available"); guacd sends syncs all along, the decoder only what
	// changed. A nop now and then keeps the view open.
	go func() {
		tick := time.NewTicker(rdpViewKeepalive)
		defer tick.Stop()
		for {
			select {
			case <-tick.C:
				if err := c.Write(ctx, websocket.MessageText, encodeInstruction("nop")); err != nil {
					return
				}
			case <-ctx.Done():
				return
			}
		}
	}()
	// Control the viewer holds goes back to the user when it leaves.
	defer ls.releaseControl(viewerUserID)
	go func() {
		// Key and mouse instructions count only while this viewer holds control.
		for {
			_, msg, err := c.Read(ctx)
			if err != nil {
				errc <- err
				return
			}
			ls.fromController(viewerUserID, msg)
		}
	}()
	// Why the view ended: the viewer left, or the connector's side stopped.
	if err := <-errc; err != nil {
		log.Printf("rdp-view session=%s viewer=%s: view ended: %v", ls.id, viewerUserID, err)
	}
}
