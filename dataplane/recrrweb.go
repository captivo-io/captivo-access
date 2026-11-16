package main

import (
	"encoding/json"
	"log"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// sendRrwebToConnector splits one browser-posted rrweb batch into the two halves
// this design separates: the EVENT BYTES go to the connector's own store, and the
// INDEX (that a recording exists, how large, for whom) goes to the control plane.
//
// This is the only recording source that does not already pass through the
// connector -- the visitor's browser POSTs straight to this proxy -- so the split
// happens here rather than in a recorder.
//
// Best-effort throughout: recording must never affect the proxied response.
func (p *BrowserProxy) sendRrwebToConnector(connectorID, tenantID, userID, siteID, host string, body []byte) {
	var batch struct {
		RecordingKey string          `json:"recordingKey"`
		Seq          int             `json:"seq"`
		Events       json.RawMessage `json:"events"`
	}
	if err := json.Unmarshal(body, &batch); err != nil || batch.RecordingKey == "" {
		return
	}

	// Recording is best-effort and must never surface to the page, so a missing
	// registry skips the CHUNK and nothing else -- it must not skip the index
	// below. A test with a bare BrowserProxy found both halves of this: first a
	// nil-registry panic, then an early return that silently dropped the index.
	if p.reg != nil {
		sess := p.reg.Get(connectorID)
		if _, err := writeRecChunk(sess, tunnel.RecWriteRequest{
			TenantID:     tenantID,
			RecordingKey: batch.RecordingKey,
			Seq:          batch.Seq,
			Format:       "rrweb",
			// Newline-terminated: chunks come back concatenated on replay, and
			// "[...][...]" is not JSON while "[...]\n[...]" is NDJSON.
			Data: append([]byte(batch.Events), '\n'),
		}); err != nil {
			// Fall through: the index is still worth recording, so an admin can see
			// that a session happened even when its bytes did not land.
			log.Printf("rrweb-recording key=%s seq=%d: connector write failed err=%v", batch.RecordingKey, batch.Seq, err)
		}
	}

	// Index only -- no event payload. len(Events) is what the connector was asked
	// to store, which is the honest number for the byte counter.
	_ = p.ctrl.SendRecording(userID, siteID, host, mustIndexJSON(batch.RecordingKey, batch.Seq, len(batch.Events)))
}

// maxKeyBatchBytes caps one POST /__captivo/keys body. A batch is a few
// seconds of typing; 256 KiB is far beyond any honest one.
const maxKeyBatchBytes = 256 << 10

// sendKeysToConnector stores one batch of typed-input events from a web app
// page as a "keys" chunk under the page's recording key -- the same stream the
// gateway's keyWriter fills, so the player's timeline and the connector's
// search read web, isolated and gateway sessions alike. Only well-formed
// events are kept; the page is not trusted to send the shape.
func (p *BrowserProxy) sendKeysToConnector(connectorID, tenantID string, body []byte) {
	req, ok := webKeyChunk(tenantID, body)
	if !ok || p.reg == nil {
		return
	}
	if _, err := writeRecChunk(p.reg.Get(connectorID), req); err != nil {
		log.Printf("web-keys key=%s seq=%d: connector write failed err=%v", req.RecordingKey, req.Seq, err)
	}
}

// webKeyChunk turns a page-posted batch into the chunk to store. The page is
// not trusted with the shape: events are re-encoded as keyEvent, oversized or
// negative-time ones are dropped, and a masked one never keeps its text.
func webKeyChunk(tenantID string, body []byte) (tunnel.RecWriteRequest, bool) {
	var batch struct {
		RecordingKey string     `json:"recordingKey"`
		Seq          int        `json:"seq"`
		Events       []keyEvent `json:"events"`
	}
	if err := json.Unmarshal(body, &batch); err != nil || batch.RecordingKey == "" || batch.Seq < 0 {
		return tunnel.RecWriteRequest{}, false
	}
	events := make([]keyEvent, 0, len(batch.Events))
	for _, e := range batch.Events {
		if e.AtMs < 0 || len(e.Text) > 4096 {
			continue
		}
		e.Kind = "text"
		if e.Masked {
			e.Text = "••••"
		}
		events = append(events, e)
	}
	if len(events) == 0 {
		return tunnel.RecWriteRequest{}, false
	}
	payload, err := json.Marshal(events)
	if err != nil {
		return tunnel.RecWriteRequest{}, false
	}
	return tunnel.RecWriteRequest{
		TenantID:     tenantID,
		RecordingKey: batch.RecordingKey,
		Seq:          batch.Seq,
		Format:       "keys",
		Data:         append(payload, '\n'),
	}, true
}

func mustIndexJSON(key string, seq, bytes int) []byte {
	b, err := json.Marshal(map[string]any{"recordingKey": key, "seq": seq, "bytes": bytes})
	if err != nil {
		return []byte("{}")
	}
	return b
}
