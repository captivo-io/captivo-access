package main

import (
	"encoding/json"
	"errors"
	"log"
	"strconv"
	"strings"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// errRecUnsupported means this connector is too old to store recordings locally.
// A sentinel rather than a string so the caller can log it ONCE per session
// instead of once per chunk -- at 256 KiB / 2 s that difference is the whole log.
var errRecUnsupported = errors.New("connector does not support local recordings")

// writeRecChunk ships one chunk to the connector that owns the session, where it
// stops: recording bytes are never sent to the control plane. Mirrors dialGuacd's
// open/write/read shape.
//
// The returned count comes from the connector's ack, not from len(Data), so the
// central byte counter reflects what actually reached the disk.
func writeRecChunk(s *Session, req tunnel.RecWriteRequest) (int, error) {
	if s == nil || s.mux == nil {
		return 0, errors.New("connector offline")
	}
	req.Kind = "recwrite"
	st, err := s.mux.Open()
	if err != nil {
		return 0, err
	}
	defer st.Close()
	reqBytes, err := json.Marshal(req)
	if err != nil {
		return 0, err
	}
	if err := tunnel.WriteFrame(st, reqBytes); err != nil {
		return 0, err
	}
	respBytes, err := tunnel.ReadFrame(st)
	if err != nil {
		return 0, err
	}
	var resp tunnel.RecWriteResponse
	if err := json.Unmarshal(respBytes, &resp); err != nil {
		return 0, err
	}
	if resp.Error != "" {
		return 0, errors.New(resp.Error)
	}
	return resp.Written, nil
}

// recIndexReporter reports a chunk's INDEX to the control plane so the recording
// appears in the list. Without it a recording's bytes sit on the connector
// invisible -- which is how Slice B first shipped, because only the rrweb path had
// ever reported an index and the other two lost theirs with their POSTs.
//
// Best-effort and deliberately separate from the chunk write: an index that fails
// must not stop capture, and a chunk that fails must still be counted as attempted.
type recIndexReporter struct {
	// send posts one index body. A seam rather than a *ControlClient so a test can
	// observe what is reported; "the field is not nil" asserts nothing.
	send                func(userID, siteID, host string, body []byte) error
	userID, siteID      string
	host, format, proto string
}

func (r *recIndexReporter) report(recordingKey string, seq, bytes int) {
	if r == nil || r.send == nil {
		return
	}
	body, err := json.Marshal(map[string]any{
		"recordingKey": recordingKey,
		"seq":          seq,
		"bytes":        bytes,
		"format":       r.format,
		"protocol":     r.proto,
	})
	if err != nil {
		return
	}
	if err := r.send(r.userID, r.siteID, r.host, body); err != nil {
		log.Printf("recording index key=%s seq=%d: report failed err=%v", recordingKey, seq, err)
	}
}

// reportTruncated marks the recording's index row as cut short: capture stopped at
// RECORDING_MAX_BYTES while the session went on. Without this the console shows a
// recording shorter than its session and nothing says why -- in an investigation
// that reads as "nothing else happened". Carries no chunk, so the control plane
// moves no counters for it.
func (r *recIndexReporter) reportTruncated(recordingKey string) {
	if r == nil || r.send == nil {
		return
	}
	body, err := json.Marshal(map[string]any{
		"recordingKey": recordingKey,
		"truncated":    true,
		"format":       r.format,
		"protocol":     r.proto,
	})
	if err != nil {
		return
	}
	if err := r.send(r.userID, r.siteID, r.host, body); err != nil {
		log.Printf("recording index key=%s: truncated report failed err=%v", recordingKey, err)
	}
}

// recDoneSince is the first connector release that understands tunnel.RecDone.
const recDoneSince = "2.22.0"

// notifyRecDone tells the connector holding a recording that it is complete, so
// its worker starts on it at once (connector/recmaint.go) instead of waiting
// for the recording to go quiet. Best-effort: the connector falls back to that
// wait, which is also what an older connector does.
func notifyRecDone(s *Session, tenantID, key string) {
	if s == nil || s.mux == nil || !connectorAtLeast(s, recDoneSince) {
		return
	}
	st, err := s.mux.Open()
	if err != nil {
		return
	}
	defer st.Close()
	b, err := json.Marshal(tunnel.RecDone{Kind: "recdone", TenantID: tenantID, RecordingKey: key})
	if err == nil {
		_ = tunnel.WriteFrame(st, b)
	}
}

// connectorAtLeast compares the version a connector reports in its telemetry
// with min (plain X.Y.Z). An unknown version (no telemetry yet, a dev build)
// is not assumed to be new enough.
func connectorAtLeast(s *Session, min string) bool {
	t, _ := s.Telemetry()
	if t == nil {
		return false
	}
	return versionAtLeast(t.Version, min)
}

func versionAtLeast(v, min string) bool {
	parse := func(s string) ([3]int, bool) {
		var out [3]int
		s = strings.TrimPrefix(strings.TrimSpace(s), "v")
		if i := strings.IndexAny(s, "-+"); i >= 0 {
			s = s[:i]
		}
		parts := strings.Split(s, ".")
		if len(parts) != 3 {
			return out, false
		}
		for i, p := range parts {
			n, err := strconv.Atoi(p)
			if err != nil || n < 0 {
				return out, false
			}
			out[i] = n
		}
		return out, true
	}
	a, ok1 := parse(v)
	b, ok2 := parse(min)
	if !ok1 || !ok2 {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return a[i] > b[i]
		}
	}
	return true
}
