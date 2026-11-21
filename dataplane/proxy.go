package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// maxProxyBody caps how much of the upstream response body we buffer in
// memory for the control plane's /proxy response (64 KiB).
const maxProxyBody = 64 << 10

// ProxyResult is the outcome of round-tripping a DialRequest through a
// connector's yamux session.
type ProxyResult struct {
	Status    int
	Header    map[string][]string
	Body      []byte // up to maxProxyBody bytes
	Truncated bool
}

// Proxy opens a new yamux stream on the connector's session, sends the
// DialRequest control frame, reads back the DialResponse control frame and
// up to maxProxyBody bytes of body.
func Proxy(s *Session, dr tunnel.DialRequest) (*ProxyResult, error) {
	if s == nil || s.mux == nil {
		return nil, errors.New("connector offline")
	}
	st, err := s.mux.Open()
	if err != nil {
		return nil, err
	}
	defer st.Close()

	reqBytes, err := json.Marshal(dr)
	if err != nil {
		return nil, err
	}
	if err := tunnel.WriteFrame(st, reqBytes); err != nil {
		return nil, err
	}
	// Admin test-connection never sends a request body; the terminator alone
	// tells the connector's body reader there's nothing to stream.
	if err := tunnel.WriteBody(st, bytes.NewReader(nil)); err != nil {
		return nil, err
	}

	respBytes, err := tunnel.ReadFrame(st)
	if err != nil {
		return nil, err
	}
	var resp tunnel.DialResponse
	if err := json.Unmarshal(respBytes, &resp); err != nil {
		return nil, err
	}
	if resp.Error != "" {
		// The connector's error path never writes a body stream, so don't
		// attempt to read one here.
		return nil, errors.New(resp.Error)
	}

	body, err := io.ReadAll(io.LimitReader(tunnel.NewBodyReader(st), maxProxyBody+1))
	if err != nil {
		return nil, err
	}
	truncated := len(body) > maxProxyBody
	if truncated {
		body = body[:maxProxyBody]
	}

	return &ProxyResult{Status: resp.Status, Header: resp.Header, Body: body, Truncated: truncated}, nil
}

// Probe opens a stream, sends a ProbeRequest, and reads back the single
// ProbeResponse frame. No body is written (a probe carries none).
func Probe(s *Session, pr tunnel.ProbeRequest) (*tunnel.ProbeResponse, error) {
	if s == nil || s.mux == nil {
		return nil, errors.New("connector offline")
	}
	st, err := s.mux.Open()
	if err != nil {
		return nil, err
	}
	defer st.Close()
	pr.Kind = "probe"
	reqBytes, err := json.Marshal(pr)
	if err != nil {
		return nil, err
	}
	if err := tunnel.WriteFrame(st, reqBytes); err != nil {
		return nil, err
	}
	respBytes, err := tunnel.ReadFrame(st)
	if err != nil {
		return nil, err
	}
	var resp tunnel.ProbeResponse
	if err := json.Unmarshal(respBytes, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// Reseal asks a connector to copy saved secrets to other connectors' keys
// (tunnel.ResealRequest). A whole batch is bounded by one deadline: the work
// is local crypto on the connector, so a slow answer means a stuck tunnel.
// Rotate asks the connector to work on one resource's saved password
// (connector/rotate.go). A change on the target can take a while (sign in,
// passwd, sign in again), so the stream gets a longer deadline than Reseal --
// still inside the console's 29 s wait (src/lib/vault/rotation.ts).
func Rotate(s *Session, req tunnel.RotateRequest) (*tunnel.RotateResponse, error) {
	if s == nil || s.mux == nil {
		return nil, errors.New("connector offline")
	}
	st, err := s.mux.Open()
	if err != nil {
		return nil, err
	}
	defer st.Close()
	_ = st.SetDeadline(time.Now().Add(27 * time.Second))
	req.Kind = "rotate"
	reqBytes, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	if err := tunnel.WriteFrame(st, reqBytes); err != nil {
		return nil, err
	}
	respBytes, err := tunnel.ReadFrame(st)
	if err != nil {
		return nil, err
	}
	var resp tunnel.RotateResponse
	if err := json.Unmarshal(respBytes, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

func Reseal(s *Session, req tunnel.ResealRequest) (*tunnel.ResealResponse, error) {
	if s == nil || s.mux == nil {
		return nil, errors.New("connector offline")
	}
	st, err := s.mux.Open()
	if err != nil {
		return nil, err
	}
	defer st.Close()
	_ = st.SetDeadline(time.Now().Add(20 * time.Second))
	req.Kind = "reseal"
	reqBytes, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	if err := tunnel.WriteFrame(st, reqBytes); err != nil {
		return nil, err
	}
	respBytes, err := tunnel.ReadFrame(st)
	if err != nil {
		return nil, err
	}
	var resp tunnel.ResealResponse
	if err := json.Unmarshal(respBytes, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}
