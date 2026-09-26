package main

import (
	"encoding/json"
	"errors"
	"log"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// keyWriter ships reconstructed keystroke events INTO THE CONNECTOR'S OWN STORE as
// "keys" chunks. They used to be POSTed to the manager, which encrypted them into
// SessionKeyEvent rows -- but a keystroke log is the most sensitive thing this
// product records: it is literally what the vendor typed, passwords included on
// lines masking does not catch. It belongs on the customer's host with the video.
//
// The connector searches these chunks locally (connector/recsearch.go), so command
// search keeps working without the text ever reaching the control plane.
//
// Best-effort: a failed write never blocks the session.
type keyWriter struct {
	send     func(tunnel.RecWriteRequest) (int, error)
	tenantID string
	key      string

	seq               int
	unsupportedLogged int
	stopped           bool
}

func newKeyWriter(send func(tunnel.RecWriteRequest) (int, error), tenantID, key string) *keyWriter {
	return &keyWriter{send: send, tenantID: tenantID, key: key}
}

func (w *keyWriter) post(events []keyEvent) {
	if len(events) == 0 || w.stopped || w.send == nil {
		return
	}
	payload, err := json.Marshal(events)
	if err != nil {
		return
	}
	seq := w.seq
	w.seq++
	if _, err := w.send(tunnel.RecWriteRequest{
		TenantID:     w.tenantID,
		RecordingKey: w.key,
		Seq:          seq,
		// "keys" is what makes these chunks searchable on the connector; any other
		// format is skipped by search on purpose.
		Format: "keys",
		// Newline-terminated for the same reason as rrweb: replay concatenates
		// chunks, and NDJSON survives that where bare JSON arrays do not.
		Data: append(payload, '\n'),
	}); err != nil {
		if errors.Is(err, errRecUnsupported) {
			if w.unsupportedLogged == 0 {
				log.Printf("keyevents key=%s: connector does not support local recordings; keystroke capture disabled for this session", w.key)
			}
			w.unsupportedLogged++
			w.stopped = true
			return
		}
		log.Printf("keyevents key=%s seq=%d: connector write failed err=%v", w.key, seq, err)
	}
}
