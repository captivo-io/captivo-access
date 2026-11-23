package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"io"
	"log"
	"sync"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// The recording of a recorded native RDP session: what the server sent the
// client, PDU by PDU from the MCS Connect Response on, in FreeRDP's transport
// dump format, so the connector's encoder (connector/rdpenc) can replay it
// into a FreeRDP client, without a server, and make a video of it. Each PDU is
// a record: the time in milliseconds, a direction byte (0: from the server),
// the CRC-32 of the data, its length, the data. What the client sent (its
// logon info carries the saved password) is never written.

const rdpFormat = "rdp"

// rdpRecorder writes the stream in chunks, as the terminal recorder does.
type rdpRecorder struct {
	send  func(tunnel.RecWriteRequest) (int, error)
	index *recIndexReporter
	done  func()

	tenantID, key, siteID string
	start                 time.Time
	maxBytes              int

	mu      sync.Mutex
	buf     bytes.Buffer
	seq     int
	total   int
	stopped bool
	quit    chan struct{}
	wg      sync.WaitGroup
}

func newRdpRecorder(send func(tunnel.RecWriteRequest) (int, error), index *recIndexReporter, done func(), tenantID, key, siteID string, start time.Time) *rdpRecorder {
	r := &rdpRecorder{send: send, index: index, done: done, tenantID: tenantID, key: key, siteID: siteID, start: start, maxBytes: recordingMaxBytes(), quit: make(chan struct{})}
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		t := time.NewTicker(recFlushInterval)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				r.flush()
			case <-r.quit:
				return
			}
		}
	}()
	return r
}

// dumpRecord is one PDU in FreeRDP's transport dump format.
func dumpRecord(ms uint64, pdu []byte) []byte {
	b := make([]byte, 21, 21+len(pdu))
	binary.LittleEndian.PutUint64(b, ms)
	b[8] = 0 // sent by the server
	binary.LittleEndian.PutUint32(b[9:], crc32.ChecksumIEEE(pdu))
	binary.LittleEndian.PutUint64(b[13:], uint64(len(pdu)))
	return append(b, pdu...)
}

// server records one PDU the server sent.
func (r *rdpRecorder) server(pdu []byte) {
	r.mu.Lock()
	if r.stopped {
		r.mu.Unlock()
		return
	}
	// Never zero: the encoder takes the first record's time as the start.
	ms := uint64(time.Since(r.start).Milliseconds()) + 1
	r.buf.Write(dumpRecord(ms, pdu))
	full := r.buf.Len() >= recFlushBytes
	r.mu.Unlock()
	if full {
		r.flush()
	}
}

func (r *rdpRecorder) flush() {
	r.mu.Lock()
	if r.buf.Len() == 0 {
		r.mu.Unlock()
		return
	}
	data := append([]byte(nil), r.buf.Bytes()...)
	r.buf.Reset()
	if r.maxBytes > 0 && r.total+len(data) > r.maxBytes {
		r.stopped = true
		r.mu.Unlock()
		log.Printf("rdp recording site=%s key=%s: RECORDING_MAX_BYTES reached, stopping capture; the session continues unrecorded", r.siteID, r.key)
		r.index.reportTruncated(r.key)
		return
	}
	seq := r.seq
	r.seq++
	r.total += len(data)
	r.mu.Unlock()
	if _, err := r.send(tunnel.RecWriteRequest{TenantID: r.tenantID, RecordingKey: r.key, Seq: seq, Format: rdpFormat, Protocol: "rdp", Data: data}); err != nil {
		log.Printf("rdp recording key=%s seq=%d: connector write failed: %v", r.key, seq, err)
		return
	}
	r.index.report(r.key, seq, len(data))
}

func (r *rdpRecorder) stop() {
	close(r.quit)
	r.wg.Wait()
	r.flush()
	r.mu.Lock()
	r.stopped = true
	r.mu.Unlock()
	if r.done != nil {
		r.done()
	}
}

// readPDU reads one RDP PDU, slow path (TPKT) or fast path.
func readPDU(r *bufio.Reader) ([]byte, error) {
	h, err := r.Peek(2)
	if err != nil {
		return nil, err
	}
	var n, head int
	switch {
	case h[0] == 3:
		h4, err := r.Peek(4)
		if err != nil {
			return nil, err
		}
		n, head = int(binary.BigEndian.Uint16(h4[2:])), 4
	case h[1]&0x80 != 0:
		h3, err := r.Peek(3)
		if err != nil {
			return nil, err
		}
		n, head = int(h3[1]&0x7f)<<8|int(h3[2]), 3
	default:
		n, head = int(h[1]), 2
	}
	if n < head {
		return nil, errors.New("bad RDP PDU length")
	}
	b := make([]byte, n)
	_, err = io.ReadFull(r, b)
	return b, err
}
