package main

import (
	"bytes"
	"errors"
	"log"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// kasmRecWriter tees a KasmVNC session's live WebM byte stream INTO THE
// CONNECTOR'S OWN STORE in recFlushBytes / recFlushInterval chunks. It is the video
// analog of guacrecord.go's recWriter and is deliberately self-contained (transport
// B must not depend on the former transport A). Best-effort: a failed write or a
// reached cap never blocks the session. Single-goroutine (the recording relay loop).
type kasmRecWriter struct {
	send     func(tunnel.RecWriteRequest) (int, error)
	index    *recIndexReporter
	tenantID string
	key      string
	siteID   string
	userID   string
	host     string
	capBytes int

	buf               bytes.Buffer
	seq               int
	total             int
	lastFlush         time.Time
	stopped           bool
	unsupportedLogged int
}

func newKasmRecWriter(send func(tunnel.RecWriteRequest) (int, error), index *recIndexReporter, tenantID, key, siteID, userID, host string, capBytes int) *kasmRecWriter {
	return &kasmRecWriter{
		send: send, index: index, tenantID: tenantID, key: key,
		siteID: siteID, userID: userID, host: host, capBytes: capBytes,
		lastFlush: time.Now(),
	}
}

// Write appends WebM bytes and flushes when the buffer reaches recFlushBytes or
// recFlushInterval has elapsed. Once the cumulative total exceeds capBytes, capture
// stops (logged once) and further writes are dropped.
func (w *kasmRecWriter) Write(b []byte) {
	if w.stopped {
		return
	}
	if w.total >= w.capBytes {
		log.Printf("kasm-recording site=%s key=%s: size cap reached, stopping capture", w.siteID, w.key)
		w.stopped = true
		return
	}
	w.buf.Write(b)
	w.total += len(b)
	if w.buf.Len() >= recFlushBytes || time.Since(w.lastFlush) >= recFlushInterval {
		w.flush()
	}
}

func (w *kasmRecWriter) flush() {
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
		Format:       "video",
		Data:         chunk,
	})
	w.index.report(w.key, seq, len(chunk))
	if err == nil {
		return
	}
	if errors.Is(err, errRecUnsupported) {
		if w.unsupportedLogged == 0 {
			log.Printf("kasm-recording site=%s key=%s: connector does not support local recordings; capture disabled for this session", w.siteID, w.key)
		}
		w.unsupportedLogged++
		w.stopped = true
		return
	}
	log.Printf("kasm-recording key=%s seq=%d: connector write failed err=%v", w.key, seq, err)
}

// Close flushes the tail chunk.
func (w *kasmRecWriter) Close() { w.flush() }

// sendFinalizedVideo writes one chunk of the finalized (seekable) recording to the
// connector, replacing the interim chunks it holds for the same recording. The
// seq space continues from the interim chunks, so the connector overwrites in
// place. Best-effort, like every recording write.
func sendFinalizedVideo(send func(tunnel.RecWriteRequest) (int, error), tenantID, key string, seq int, data []byte) {
	if send == nil {
		return
	}
	if _, err := send(tunnel.RecWriteRequest{
		TenantID:     tenantID,
		RecordingKey: key,
		Seq:          seq,
		Format:       "video",
		Data:         data,
	}); err != nil {
		log.Printf("kasm-recording key=%s seq=%d: finalize write failed err=%v", key, seq, err)
	}
}
