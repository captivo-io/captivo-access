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
			Data:         batch.Events,
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

func mustIndexJSON(key string, seq, bytes int) []byte {
	b, err := json.Marshal(map[string]any{"recordingKey": key, "seq": seq, "bytes": bytes})
	if err != nil {
		return []byte("{}")
	}
	return b
}
