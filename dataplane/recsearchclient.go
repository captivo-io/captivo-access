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

// RecFetch streams one recording's chunks from the connector into w for replay, and
// returns the recording's total plaintext length so the caller can answer an HTTP
// Range. Nothing is buffered centrally: the bytes pass through on their way to the
// RecFetch streams one recording's chunks from the connector into w for replay.
//
// onHead is called once, after the connector reports the recording's total plaintext
// length and BEFORE any body byte is written, so the caller can set Content-Range
// and friends on a response it has not started yet. That callback is the reason this
// does not simply return the total: returning it would force the caller to buffer
// the whole body first, which for a 500 MiB recording is the memory blow-up
// connector-local storage exists to avoid.
//
// Nothing is buffered here either: bytes pass straight through to w.
func RecFetch(s *Session, req tunnel.RecFetchRequest, onHead func(totalBytes int64), w io.Writer) error {
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
	if onHead != nil {
		onHead(head.TotalBytes)
	}
	for {
		chunk, err := tunnel.ReadFrame(st)
		if err != nil {
			// EOF is the normal end: the connector closes once every chunk is written.
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
