package main

import (
	"encoding/json"
	"io"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// writeRecFrame marshals and writes one response frame, ignoring write errors the
// way handleProbe does: the caller has already gone if the stream is dead.
func writeRecFrame(st io.Writer, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	_ = tunnel.WriteFrame(st, b)
}

// handleRecWrite stores one chunk on this connector's disk. Recording bytes stop
// here: they are never forwarded to the control plane.
func handleRecWrite(st io.ReadWriteCloser, store *recStore, reqBytes []byte) {
	var req tunnel.RecWriteRequest
	if json.Unmarshal(reqBytes, &req) != nil {
		writeRecFrame(st, tunnel.RecWriteResponse{Error: "bad request"})
		return
	}
	// The format is part of the chunk's address, not metadata beside it: two
	// writers on one recording key (guac + keystrokes) both count from zero, and
	// storing by seq alone made them overwrite each other.
	if req.Format == "" {
		writeRecFrame(st, tunnel.RecWriteResponse{Error: "missing format"})
		return
	}
	n, err := store.Append(req.TenantID, req.RecordingKey, req.Format, req.Seq, req.Data)
	if err != nil {
		writeRecFrame(st, tunnel.RecWriteResponse{Error: err.Error()})
		return
	}
	writeRecFrame(st, tunnel.RecWriteResponse{Written: n})
}

// handleRecSearch searches this connector's store and returns only matched keys
// plus a short snippet -- never whole chunks.
func handleRecSearch(st io.ReadWriteCloser, store *recStore, reqBytes []byte) {
	var req tunnel.RecSearchRequest
	if json.Unmarshal(reqBytes, &req) != nil {
		writeRecFrame(st, tunnel.RecSearchResponse{Error: "bad request"})
		return
	}
	writeRecFrame(st, searchStore(store, req))
}

// handleRecFetch streams a recording's plaintext chunks for replay: one response
// frame, then one frame per chunk, then the stream closes.
func handleRecFetch(st io.ReadWriteCloser, store *recStore, reqBytes []byte) {
	var req tunnel.RecFetchRequest
	if json.Unmarshal(reqBytes, &req) != nil {
		writeRecFrame(st, tunnel.RecFetchResponse{Error: "bad request"})
		return
	}
	if req.Format == "" {
		writeRecFrame(st, tunnel.RecFetchResponse{Error: "missing format"})
		return
	}
	total, err := store.TotalPlaintextBytes(req.TenantID, req.RecordingKey, req.Format)
	if err != nil {
		writeRecFrame(st, tunnel.RecFetchResponse{Error: err.Error()})
		return
	}

	// A byte range means a player is scrubbing: answer exactly those bytes rather
	// than the whole recording. Range wins over FromSeq when both are present --
	// FromSeq is the coarse resume used by non-seeking players.
	if req.FromByte > 0 || req.ToByte > 0 {
		to := req.ToByte
		if to <= 0 || to >= total {
			to = total - 1
		}
		if total == 0 || req.FromByte > to {
			writeRecFrame(st, tunnel.RecFetchResponse{Error: "range not satisfiable"})
			return
		}
		part, err := store.ReadRange(req.TenantID, req.RecordingKey, req.Format, req.FromByte, to)
		if err != nil {
			writeRecFrame(st, tunnel.RecFetchResponse{Error: err.Error()})
			return
		}
		writeRecFrame(st, tunnel.RecFetchResponse{TotalBytes: total})
		_ = tunnel.WriteFrame(st, part)
		return
	}

	chunks, err := store.Read(req.TenantID, req.RecordingKey, req.Format, req.FromSeq)
	if err != nil {
		writeRecFrame(st, tunnel.RecFetchResponse{Error: err.Error()})
		return
	}
	writeRecFrame(st, tunnel.RecFetchResponse{TotalBytes: total})
	for _, c := range chunks {
		if tunnel.WriteFrame(st, c.Data) != nil {
			return
		}
	}
}
