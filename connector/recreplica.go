package main

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// Copies of a recording made for a connector group. When replication is on for
// the group, the data plane reads a recording from the member that carried the
// session and appends it, as it grows, to this connector's own store (the
// ordinary recwrite), so the recording stays playable when its first holder is
// down. This file is the connector's half: say what is held (recstat) and keep
// maintenance off a copy that is still being made.
//
// A copy is appended by byte position, not by chunk: the recording is the
// concatenation of its chunks everywhere it is read, so the copy only has to
// hold the same bytes in order. Its own chunk sizes are its own.
const (
	// holdFile marks a copy in progress; its modification time is the last
	// append. Maintenance (recmaint.go) leaves such a recording alone: a repack
	// between two appends would renumber the chunks under them.
	holdFile = ".replicating"
	// holdStale: a copy nobody has appended to for this long is abandoned (the
	// source is gone, the member left the group); maintenance may take it.
	holdStale = 6 * time.Hour
	// completeFile records that the data plane said the session ended.
	completeFile = ".complete"
	// completeQuiet is how long a recording may sit untouched before the
	// connector calls it complete without having been told.
	completeQuiet = 10 * time.Minute
)

// NextSeq is the sequence number the next chunk of a stream should take.
func (s *recStore) NextSeq(tenantID, recordingKey, format string) (int, error) {
	idx, err := s.index(tenantID, recordingKey, format)
	if err != nil || len(idx) == 0 {
		return 0, err
	}
	return idx[len(idx)-1].seq + 1, nil
}

// marker (re)writes a small file beside a recording without making it look
// younger: retention sweeps by the directory's time (recStore.Purge).
func (s *recStore) marker(tenantID, recordingKey, name string) error {
	d, err := s.recDir(tenantID, recordingKey)
	if err != nil {
		return err
	}
	return keepModTime(d, func() error {
		if _, err := os.Stat(d); err != nil {
			return err
		}
		return writeFileAtomic(filepath.Join(d, name), []byte(time.Now().UTC().Format(time.RFC3339)))
	})
}

// Hold records that a copy of this recording is being made here, now.
func (s *recStore) Hold(tenantID, recordingKey string) error {
	return s.marker(tenantID, recordingKey, holdFile)
}

// Release ends the hold: the copy is complete (or given up).
func (s *recStore) Release(tenantID, recordingKey string) {
	d, err := s.recDir(tenantID, recordingKey)
	if err != nil {
		return
	}
	_ = keepModTime(d, func() error { return os.Remove(filepath.Join(d, holdFile)) })
}

// Held reports whether a copy is in progress and recent enough to be trusted.
func (s *recStore) Held(tenantID, recordingKey string, now time.Time) bool {
	d, err := s.recDir(tenantID, recordingKey)
	if err != nil {
		return false
	}
	info, err := os.Stat(filepath.Join(d, holdFile))
	return err == nil && now.Sub(info.ModTime()) < holdStale
}

// MarkComplete records that the data plane said the session ended.
func (s *recStore) MarkComplete(tenantID, recordingKey string) {
	_ = s.marker(tenantID, recordingKey, completeFile)
}

// Stat says what this connector holds of a recording.
func (s *recStore) Stat(tenantID, recordingKey string, now time.Time) tunnel.RecStatResponse {
	d, err := s.recDir(tenantID, recordingKey)
	if err != nil {
		return tunnel.RecStatResponse{Error: err.Error()}
	}
	out := tunnel.RecStatResponse{Streams: []tunnel.RecStatStream{}}
	for _, f := range s.Formats(tenantID, recordingKey) {
		total, err := s.TotalPlaintextBytes(tenantID, recordingKey, f)
		if err != nil {
			return tunnel.RecStatResponse{Error: err.Error()}
		}
		next, err := s.NextSeq(tenantID, recordingKey, f)
		if err != nil {
			return tunnel.RecStatResponse{Error: err.Error()}
		}
		out.Streams = append(out.Streams, tunnel.RecStatStream{Format: f, Bytes: total, NextSeq: next})
	}
	out.Protocol = readProtocol(filepath.Join(d, "guac"))
	quiet := time.Duration(0)
	if newest, ok := newestChunk(d); ok {
		quiet = now.Sub(newest)
		if quiet < 0 {
			quiet = 0
		}
	}
	out.QuietSeconds = int64(quiet / time.Second)
	_, statErr := os.Stat(filepath.Join(d, completeFile))
	out.Complete = statErr == nil || (len(out.Streams) > 0 && quiet >= completeQuiet)
	return out
}

// handleRecStat answers one recstat stream.
func handleRecStat(st io.ReadWriter, store *recStore, reqBytes []byte) {
	var req tunnel.RecStatRequest
	if json.Unmarshal(reqBytes, &req) != nil {
		writeRecFrame(st, tunnel.RecStatResponse{Error: "bad request"})
		return
	}
	writeRecFrame(st, store.Stat(req.TenantID, req.RecordingKey, time.Now()))
}
