package main

import (
	"encoding/json"
	"errors"

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
