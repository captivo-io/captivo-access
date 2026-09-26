package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"os"

	"github.com/kurtserdar/captivo-access/tunnel"
	"strconv"
	"time"
)

const (
	recFlushBytes      = 256 * 1024
	recFlushInterval   = 2 * time.Second
	recDefaultMaxBytes = 524288000 // 500 MiB
)

// recordingMaxBytes is the per-recording cumulative (pre-gzip) byte cap. Past it,
// capture stops but the live session continues.
func recordingMaxBytes() int {
	if v := os.Getenv("RECORDING_MAX_BYTES"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return recDefaultMaxBytes
}

// newRecordingKey builds a globally-unique key for one session recording.
func newRecordingKey(siteID, userID string) string {
	var b [4]byte
	_, _ = rand.Read(b[:])
	return fmt.Sprintf("%s-%s-%d-%s", siteID, userID, time.Now().UnixNano(), hex.EncodeToString(b[:]))
}

// recWriter tees a guacd->browser Guacamole instruction stream INTO THE
// CONNECTOR'S OWN STORE in 256 KiB / 2 s chunks. The bytes never reach the
// control plane: that is the point of connector-local recordings. It is
// single-goroutine (called only from the guacd->browser relay loop) so it needs
// no locking. Every method is best-effort: a failed write or a reached size cap
// never blocks the session.
type recWriter struct {
	// send ships one chunk. Injected so this file needs no registry or session,
	// and so the recorder is testable without a tunnel.
	send     func(tunnel.RecWriteRequest) (int, error)
	tenantID string
	key      string
	siteID   string
	userID   string
	host     string
	protocol string
	capBytes int

	buf       bytes.Buffer
	seq       int
	total     int
	lastFlush time.Time
	stopped   bool
	// unsupportedLogged counts the "connector too old" notices emitted. At 256 KiB
	// / 2 s, logging per chunk would bury everything else in the log.
	unsupportedLogged int
}

func newRecWriter(send func(tunnel.RecWriteRequest) (int, error), tenantID, key, siteID, userID, host, protocol string, capBytes int) *recWriter {
	return &recWriter{
		send:      send,
		tenantID:  tenantID,
		key:       key,
		siteID:    siteID,
		userID:    userID,
		host:      host,
		protocol:  protocol,
		capBytes:  capBytes,
		lastFlush: time.Now(),
	}
}

// Write appends one whole guac instruction and flushes when the buffer reaches
// recFlushBytes or recFlushInterval has elapsed. Once the cumulative byte total
// exceeds capBytes, capture stops (logged once) and further writes are dropped.
func (w *recWriter) Write(inst []byte) {
	if w.stopped {
		return
	}
	if w.total >= w.capBytes {
		log.Printf("recording site=%s key=%s: size cap reached, stopping capture", w.siteID, w.key)
		w.stopped = true
		return
	}
	w.buf.Write(inst)
	w.total += len(inst)
	if w.buf.Len() >= recFlushBytes || time.Since(w.lastFlush) >= recFlushInterval {
		w.flush()
	}
}

// flush writes the buffered bytes as one chunk to the connector. On any error it
// logs and drops the chunk (advancing seq) -- a missing chunk is a small replay
// gap, never a broken session. On success the buffer is reset.
func (w *recWriter) flush() {
	if w.buf.Len() == 0 {
		return
	}
	chunk := make([]byte, w.buf.Len())
	copy(chunk, w.buf.Bytes())
	seq := w.seq
	w.seq++
	w.buf.Reset()
	w.lastFlush = time.Now()

	_, err := w.send(tunnel.RecWriteRequest{
		TenantID:     w.tenantID,
		RecordingKey: w.key,
		Seq:          seq,
		Format:       "guac",
		Protocol:     w.protocol,
		Data:         chunk,
	})
	if err == nil {
		return
	}
	if errors.Is(err, errRecUnsupported) {
		if w.unsupportedLogged == 0 {
			log.Printf("recording site=%s key=%s: connector does not support local recordings; capture disabled for this session", w.siteID, w.key)
		}
		w.unsupportedLogged++
		w.stopped = true
		return
	}
	log.Printf("recording key=%s seq=%d: connector write failed err=%v", w.key, seq, err)
}

// Close flushes the tail chunk.
func (w *recWriter) Close() {
	w.flush()
}
