package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// A batch of syslog messages for a connector to deliver to the SIEM on its
// network (connector/logforward.go). The control plane keeps the queue: it
// asks again with the same batch until a call answers ok.

// The connector gives a batch 20 s; the control plane waits 25 s for this answer.
const logForwardTimeout = 22 * time.Second

var errLogForwardOld = errors.New("connector cannot forward logs")

// ForwardLogs sends one batch on its own stream and waits for the connector's
// answer. An older connector takes the stream for a dial request and answers
// "bad upstream url"; that is reported as errLogForwardOld.
func ForwardLogs(s *Session, req tunnel.LogForwardRequest) (tunnel.LogForwardResponse, error) {
	if s == nil || s.mux == nil {
		return tunnel.LogForwardResponse{}, errors.New("connector offline")
	}
	st, err := s.mux.OpenStream()
	if err != nil {
		return tunnel.LogForwardResponse{}, err
	}
	defer st.Close()
	_ = st.SetDeadline(time.Now().Add(logForwardTimeout))
	req.Kind = "logforward"
	b, err := json.Marshal(req)
	if err != nil {
		return tunnel.LogForwardResponse{}, err
	}
	if err := tunnel.WriteFrame(st, b); err != nil {
		return tunnel.LogForwardResponse{}, err
	}
	rb, err := tunnel.ReadFrame(st)
	if err != nil {
		return tunnel.LogForwardResponse{}, err
	}
	var resp tunnel.LogForwardResponse
	if err := json.Unmarshal(rb, &resp); err != nil {
		return tunnel.LogForwardResponse{}, err
	}
	if resp.Error == "bad upstream url" {
		return tunnel.LogForwardResponse{}, errLogForwardOld
	}
	return resp, nil
}

// serveLogForward is POST /connector-logforward on the internal listener.
func serveLogForward(reg *Registry, secret string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !dpAuthorized(r, secret) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		var body struct {
			ConnectorID string `json:"connectorId"`
			tunnel.LogForwardRequest
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20)).Decode(&body); err != nil || body.ConnectorID == "" || body.Target == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "reason": "invalid_body"})
			return
		}
		sess := reg.Get(body.ConnectorID)
		if sess == nil {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "reason": "offline"})
			return
		}
		resp, err := ForwardLogs(sess, body.LogForwardRequest)
		switch {
		case errors.Is(err, errLogForwardOld):
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "reason": "connector_too_old"})
		case err != nil:
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "reason": "no_answer"})
		case resp.Error != "":
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "reason": "send_failed", "detail": resp.Error, "sent": resp.Sent})
		default:
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "sent": resp.Sent, "latencyMs": resp.LatencyMs})
		}
	}
}
