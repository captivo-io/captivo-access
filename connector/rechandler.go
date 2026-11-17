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
	if req.Protocol != "" {
		store.NoteProtocol(req.TenantID, req.RecordingKey, req.Format, req.Protocol)
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
// recRangeFrame is the most one frame of a range answer carries; tunnel frames
// are capped at 1 MiB.
const recRangeFrame = 512 << 10

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
		// In frames no bigger than the tunnel allows. One frame per range was
		// refused for anything over 1 MiB, and the player got an empty answer.
		for len(part) > 0 {
			n := len(part)
			if n > recRangeFrame {
				n = recRangeFrame
			}
			if tunnel.WriteFrame(st, part[:n]) != nil {
				return
			}
			part = part[n:]
		}
		return
	}

	// Chunk by chunk, so a long recording is never held in memory whole, and in
	// frames no bigger than the tunnel allows: a repacked stream's chunks are
	// 4 MiB (recmaint.go). An empty chunk is not sent: the reader takes an empty
	// frame as the end.
	writeRecFrame(st, tunnel.RecFetchResponse{TotalBytes: total})
	_ = store.EachChunk(req.TenantID, req.RecordingKey, req.Format, req.FromSeq, func(b []byte) error {
		for len(b) > 0 {
			n := min(len(b), recRangeFrame)
			if err := tunnel.WriteFrame(st, b[:n]); err != nil {
				return err
			}
			b = b[n:]
		}
		return nil
	})
}
