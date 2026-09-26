package main

import (
	"encoding/json"
	"errors"
	"io"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// RecSearch asks one connector to search its own recording store. The control
// plane cannot do this itself: the manager is TypeScript and holds no tunnel
// sessions, so every connector round trip goes through here.
func RecSearch(s *Session, req tunnel.RecSearchRequest) (tunnel.RecSearchResponse, error) {
	if s == nil || s.mux == nil {
		return tunnel.RecSearchResponse{}, errors.New("connector offline")
	}
	req.Kind = "recsearch"
	st, err := s.mux.Open()
	if err != nil {
		return tunnel.RecSearchResponse{}, err
	}
	defer st.Close()
	reqBytes, err := json.Marshal(req)
	if err != nil {
		return tunnel.RecSearchResponse{}, err
	}
	if err := tunnel.WriteFrame(st, reqBytes); err != nil {
		return tunnel.RecSearchResponse{}, err
	}
	respBytes, err := tunnel.ReadFrame(st)
	if err != nil {
		return tunnel.RecSearchResponse{}, err
	}
	var resp tunnel.RecSearchResponse
	if err := json.Unmarshal(respBytes, &resp); err != nil {
		return tunnel.RecSearchResponse{}, err
	}
	if resp.Error != "" {
		return resp, errors.New(resp.Error)
	}
	return resp, nil
}

// RecFetch streams one recording's chunks from the connector into w for replay.
// Nothing is buffered centrally: the bytes pass through on their way to the
// admin's browser and are never written to control-plane storage.
func RecFetch(s *Session, req tunnel.RecFetchRequest, w io.Writer) error {
	if s == nil || s.mux == nil {
		return errors.New("connector offline")
	}
	req.Kind = "recfetch"
	st, err := s.mux.Open()
	if err != nil {
		return err
	}
	defer st.Close()
	reqBytes, err := json.Marshal(req)
	if err != nil {
		return err
	}
	if err := tunnel.WriteFrame(st, reqBytes); err != nil {
		return err
	}
	headBytes, err := tunnel.ReadFrame(st)
	if err != nil {
		return err
	}
	var head tunnel.RecFetchResponse
	if err := json.Unmarshal(headBytes, &head); err != nil {
		return err
	}
	if head.Error != "" {
		return errors.New(head.Error)
	}
	for {
		chunk, err := tunnel.ReadFrame(st)
		if err != nil {
			// EOF is the normal end of the stream: the connector closes once it has
			// written every chunk.
			return nil
		}
		if len(chunk) == 0 {
			return nil
		}
		if _, err := w.Write(chunk); err != nil {
			return err
		}
	}
}
