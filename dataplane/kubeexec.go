package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
	"github.com/moby/spdystream/spdy"
)

// kubectl exec and attach through the Kubernetes proxy (kubeproxy.go). The
// connection is relayed as it is; a tap reads both directions on the side to
// pull out the container's terminal (stdout, stderr), what the user typed
// (stdin) and the terminal size, whichever streaming protocol kubectl chose:
//
//   - WebSocket with the channel.k8s.io subprotocols (kubectl 1.30+): each
//     message starts with its channel, 0 stdin, 1 stdout, 2 stderr, 3 the
//     exit status, 4 a resize;
//   - SPDY/3.1 (older kubectl, most client libraries): each stream is opened
//     with a "streamtype" header naming what it carries.
//
// Each exec is its own session in the console: a terminal recording (like
// recorded SSH's), watchable live and ended by Terminate. On a recorded
// resource an exec whose protocol can't be read is refused, never relayed
// unrecorded.

// execSink takes what a tap read off the connection.
type execSink interface {
	stdin(b []byte)
	output(b []byte, stderr bool)
	resize(cols, rows int)
	status(b []byte)
}

type streamTap interface {
	start(sink execSink)
	up(b []byte)   // user -> cluster
	down(b []byte) // cluster -> user
	close()
}

// newStreamTap returns the tap for the protocol the API server switched to,
// or nil when it is one Captivo can't read.
func newStreamTap(h http.Header) streamTap {
	switch strings.ToLower(h.Get("Upgrade")) {
	case "spdy/3.1":
		return &spdyTap{types: map[spdy.StreamId]string{}}
	case "websocket":
		switch h.Get("Sec-WebSocket-Protocol") {
		case "v5.channel.k8s.io", "v4.channel.k8s.io", "v3.channel.k8s.io", "v2.channel.k8s.io", "channel.k8s.io":
			return &wsTap{}
		case "v5.base64.channel.k8s.io", "v4.base64.channel.k8s.io", "v3.base64.channel.k8s.io", "v2.base64.channel.k8s.io", "base64.channel.k8s.io":
			return &wsTap{base64: true}
		}
	}
	return nil
}

// Channels of the channel.k8s.io protocols, and the stream types SPDY names.
const (
	chStdin  = 0
	chStdout = 1
	chStderr = 2
	chError  = 3
	chResize = 4
)

func deliver(sink execSink, ch int, b []byte) {
	switch ch {
	case chStdin:
		sink.stdin(b)
	case chStdout:
		sink.output(b, false)
	case chStderr:
		sink.output(b, true)
	case chError:
		sink.status(b)
	case chResize:
		var sz struct{ Width, Height int }
		for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
			if json.Unmarshal([]byte(line), &sz) == nil {
				sink.resize(sz.Width, sz.Height)
			}
		}
	}
}

// wsTap reads WebSocket frames in both directions.
type wsTap struct {
	base64   bool
	upP, dnP wsParser
}

func (t *wsTap) start(sink execSink) {
	t.upP = wsParser{base64: t.base64, emit: func(ch int, b []byte) { deliver(sink, ch, b) }}
	t.dnP = wsParser{base64: t.base64, emit: func(ch int, b []byte) { deliver(sink, ch, b) }}
}
func (t *wsTap) up(b []byte)   { t.upP.feed(b) }
func (t *wsTap) down(b []byte) { t.dnP.feed(b) }
func (t *wsTap) close()        {}

// The channels whose messages are read whole (small JSON); the others stream.
func wholeMessage(ch int) bool { return ch == chError || ch == chResize }

const wsMessageKeep = 1 << 20

// wsParser follows one direction's frames as bytes arrive, unmasking the
// payload; a message's first byte is its channel.
type wsParser struct {
	base64 bool
	emit   func(ch int, b []byte)

	hdr      []byte
	need     uint64 // payload bytes left in the frame
	inFrame  bool
	data     bool // the frame is part of a data message
	fin      bool
	masked   bool
	mask     [4]byte
	maskPos  int
	ch       int // the message's channel; -1 before its first byte
	msg      []byte
	tooLarge bool
}

func wsHeaderLen(h []byte) int {
	if len(h) < 2 {
		return 2
	}
	n := 2
	switch h[1] & 0x7f {
	case 126:
		n += 2
	case 127:
		n += 8
	}
	if h[1]&0x80 != 0 {
		n += 4
	}
	return n
}

func (p *wsParser) feed(b []byte) {
	for len(b) > 0 {
		if !p.inFrame {
			p.hdr = append(p.hdr, b[0])
			b = b[1:]
			if len(p.hdr) < wsHeaderLen(p.hdr) {
				continue
			}
			p.startFrame()
			if p.need == 0 {
				p.endFrame()
			}
			continue
		}
		take := uint64(len(b))
		if take > p.need {
			take = p.need
		}
		chunk := append([]byte(nil), b[:take]...)
		if p.masked {
			for i := range chunk {
				chunk[i] ^= p.mask[p.maskPos&3]
				p.maskPos++
			}
		}
		b = b[take:]
		p.need -= take
		if p.data {
			p.payload(chunk)
		}
		if p.need == 0 {
			p.endFrame()
		}
	}
}

func (p *wsParser) startFrame() {
	h := p.hdr
	p.hdr = p.hdr[:0]
	p.fin = h[0]&0x80 != 0
	op := h[0] & 0x0f
	p.masked = h[1]&0x80 != 0
	n := uint64(h[1] & 0x7f)
	i := 2
	switch n {
	case 126:
		n = uint64(binary.BigEndian.Uint16(h[2:4]))
		i = 4
	case 127:
		n = binary.BigEndian.Uint64(h[2:10])
		i = 10
	}
	if p.masked {
		copy(p.mask[:], h[i:i+4])
	}
	p.maskPos = 0
	p.need = n
	p.inFrame = true
	switch op {
	case 1, 2: // a new data message
		p.data, p.ch, p.msg, p.tooLarge = true, -1, nil, false
	case 0: // its continuation
		p.data = true
	default: // control frames (close, ping, pong) carry no channel data
		p.data = false
	}
}

func (p *wsParser) payload(b []byte) {
	if p.ch < 0 {
		if len(b) == 0 {
			return
		}
		c := b[0]
		if p.base64 {
			c -= '0'
		}
		p.ch = int(c)
		b = b[1:]
	}
	if p.base64 || wholeMessage(p.ch) {
		if len(p.msg)+len(b) > wsMessageKeep {
			p.tooLarge = true
			return
		}
		p.msg = append(p.msg, b...)
		return
	}
	if len(b) > 0 {
		p.emit(p.ch, b)
	}
}

func (p *wsParser) endFrame() {
	p.inFrame = false
	if !p.data || !p.fin {
		return
	}
	p.data = false
	if p.ch < 0 || p.tooLarge || (!p.base64 && !wholeMessage(p.ch)) {
		return
	}
	msg := p.msg
	p.msg = nil
	if p.base64 {
		dec, err := base64.StdEncoding.DecodeString(string(msg))
		if err != nil {
			return
		}
		msg = dec
	}
	if len(msg) > 0 {
		p.emit(p.ch, msg)
	}
}

// spdyTap reads SPDY/3.1 frames in both directions; streams are opened by the
// client with a header naming their type.
type spdyTap struct {
	sink   execSink
	mu     sync.Mutex
	types  map[spdy.StreamId]string
	upW    *io.PipeWriter
	dnW    *io.PipeWriter
	wg     sync.WaitGroup
	broken bool
}

func (t *spdyTap) start(sink execSink) {
	t.sink = sink
	t.upW = t.reader(true)
	t.dnW = t.reader(false)
}

// reader runs one direction's framer over a pipe. A frame it can't read
// leaves the rest of that direction unread (and the recording marked).
func (t *spdyTap) reader(up bool) *io.PipeWriter {
	pr, pw := io.Pipe()
	t.wg.Add(1)
	go func() {
		defer t.wg.Done()
		defer func() { _, _ = io.Copy(io.Discard, pr) }()
		f, err := spdy.NewFramer(io.Discard, pr)
		if err != nil {
			return
		}
		for {
			fr, err := f.ReadFrame()
			if err != nil {
				if err != io.EOF && err != io.ErrClosedPipe {
					t.mu.Lock()
					t.broken = true
					t.mu.Unlock()
				}
				return
			}
			t.frame(fr)
		}
	}()
	return pw
}

func (t *spdyTap) frame(fr spdy.Frame) {
	switch f := fr.(type) {
	case *spdy.SynStreamFrame:
		t.mu.Lock()
		t.types[f.StreamId] = f.Headers.Get("streamtype")
		t.mu.Unlock()
	case *spdy.DataFrame:
		t.mu.Lock()
		typ := t.types[f.StreamId]
		t.mu.Unlock()
		ch := map[string]int{"stdin": chStdin, "stdout": chStdout, "stderr": chStderr, "error": chError, "resize": chResize}
		if c, ok := ch[typ]; ok && len(f.Data) > 0 {
			deliver(t.sink, c, f.Data)
		}
	}
}

func (t *spdyTap) up(b []byte)   { _, _ = t.upW.Write(b) }
func (t *spdyTap) down(b []byte) { _, _ = t.dnW.Write(b) }
func (t *spdyTap) close() {
	t.upW.Close()
	t.dnW.Close()
	t.wg.Wait()
}

// kubeExec is one kubectl exec or attach: a session of its own.
type kubeExec struct {
	s     *kubeSession
	t     kubeTarget
	id    string
	start time.Time
	tty   bool
	what  string // "kubectl exec -n web api-1 -- sh"

	cc, up net.Conn
	once   sync.Once

	ls   *liveSession
	term *termRecorder
	keys *keyWriter
	live *termLive

	mu     sync.Mutex
	out    utf8Stream
	errOut utf8Stream
	lines  *lineObserver
	cols   int
	rows   int
	exit   string
}

func execLabel(k kubeReq, q url.Values) string {
	var b strings.Builder
	b.WriteString("kubectl " + k.Sub)
	if k.Namespace != "" {
		b.WriteString(" -n " + k.Namespace)
	}
	b.WriteString(" " + k.Name)
	if c := q.Get("container"); c != "" {
		b.WriteString(" -c " + c)
	}
	if cmd := q["command"]; len(cmd) > 0 {
		b.WriteString(" -- " + strings.Join(cmd, " "))
	}
	return b.String()
}

func (s *kubeSession) runExec(k kubeReq, q url.Values, tap streamTap, cc net.Conn, cr *bufio.Reader, up net.Conn, ur *bufio.Reader) {
	t := s.target()
	e := &kubeExec{s: s, t: t, id: newSessionID(), start: s.p.d.now(), cc: cc, up: up, cols: 80, rows: 24, what: execLabel(k, q)}
	e.tty = q.Get("tty") == "true" || q.Get("tty") == "1"
	s.mu.Lock()
	s.execs[e] = struct{}{}
	s.mu.Unlock()
	e.begin(k)
	if tap != nil {
		tap.start(e)
	} else {
		e.marker("The terminal of this " + k.Sub + " can't be read (" + k.Sub + " over an unknown stream); it was not recorded")
	}
	stop := context.AfterFunc(s.ctx, e.close)
	done := make(chan struct{}, 2)
	go func() { e.pump(ur, cc, tap, false); done <- struct{}{} }()
	go func() { e.pump(cr, up, tap, true); done <- struct{}{} }()
	<-done
	e.close()
	<-done
	stop()
	if tap != nil {
		tap.close()
		if st, ok := tap.(*spdyTap); ok && st.broken {
			e.marker("Part of the stream couldn't be read and is missing from this recording")
		}
	}
	s.mu.Lock()
	delete(s.execs, e)
	s.mu.Unlock()
	e.end()
}

func (e *kubeExec) pump(src *bufio.Reader, dst net.Conn, tap streamTap, up bool) {
	buf := make([]byte, 32*1024)
	for {
		n, err := src.Read(buf)
		if n > 0 {
			if _, werr := dst.Write(buf[:n]); werr != nil {
				return
			}
			if tap != nil {
				if up {
					tap.up(buf[:n])
				} else {
					tap.down(buf[:n])
				}
			}
		}
		if err != nil {
			return
		}
	}
}

func (e *kubeExec) close() {
	e.once.Do(func() {
		e.cc.Close()
		e.up.Close()
	})
}

func (e *kubeExec) begin(k kubeReq) {
	s, t := e.s, e.t
	e.live = newTermLive()
	if s.p.d.hub != nil {
		e.ls = s.p.d.hub.RegisterNative(e.id, "kubectl", t.SiteID, t.UserID, t.Host, e.start, s.connectorID, s.clientIP)
		e.ls.SetCapture(t.Record, t.Keystrokes)
		e.ls.setTerm(e.live, nil)
		s.p.d.hub.SetCloser(e.id, e.close)
	}
	if t.Record {
		key := newRecordingKey(t.SiteID, t.UserID)
		send := func(req tunnel.RecWriteRequest) (int, error) { return writeRecChunk(s.p.d.session(s.connectorID), req) }
		e.term = newTermRecorder(send,
			&recIndexReporter{send: s.p.d.recIndex, userID: t.UserID, siteID: t.SiteID, host: t.Host, format: termFormat, proto: "kubernetes", connectorID: s.connectorID},
			func() { notifyRecDone(s.p.d.session(s.connectorID), t.TenantID, key) },
			t.TenantID, key, t.SiteID, e.start)
		e.term.opened()
		if t.Keystrokes {
			e.keys = newKeyWriter(send, t.TenantID, key)
		}
	}
	if e.tty && (e.keys != nil || e.ls != nil) {
		e.lines = &lineObserver{start: e.start}
	}
	label := e.what
	if len(label) > 60 {
		label = label[:57] + "..."
	}
	e.live.open(1, label, e.cols, e.rows)
	cmd := []keyEvent{{AtMs: 0, Kind: "command", Text: e.what}}
	if e.keys != nil {
		e.keys.post(cmd)
	}
	if e.ls != nil {
		e.ls.keyEvents(cmd)
	}
	s.event(e.what)
	s.audit("ALLOW", "session_open kubernetes_"+k.Sub+" "+k.Namespace+"/"+k.Name, 0, k.Namespace)
	log.Printf("kube proxy: site=%s user=%s %s session %s", t.SiteID, t.UserID, k.Sub, e.id)
}

func (e *kubeExec) marker(text string) {
	if e.term != nil {
		e.term.marker(text)
	}
}

func (e *kubeExec) end() {
	s := e.s
	if s.p.d.hub != nil {
		s.p.d.hub.Remove(e.id)
	}
	e.live.closeTerm(1)
	e.live.end()
	dur := s.p.d.now().Sub(e.start)
	e.mu.Lock()
	exit := e.exit
	skipped := e.out.skipped + e.errOut.skipped
	e.mu.Unlock()
	if skipped > 0 {
		e.marker(fmt.Sprintf("%d bytes of binary output were not recorded", skipped))
	}
	if exit != "" {
		e.marker(exit)
	}
	if e.term != nil {
		e.term.marker("Session ended")
		e.term.stop()
	}
	s.audit("ALLOW", "session_close "+compactDur(dur), 0, "")
}

func (e *kubeExec) stdin(b []byte) {
	if e.ls != nil {
		e.ls.mu.Lock()
		now := time.Now()
		e.ls.act.shift(now)
		e.ls.act.buckets[activityBuckets-1]++
		e.ls.mu.Unlock()
	}
	e.mu.Lock()
	var evs []keyEvent
	if e.lines != nil {
		evs = e.lines.typed(b, e.s.p.d.now())
	}
	e.mu.Unlock()
	if len(evs) == 0 {
		return
	}
	if e.keys != nil {
		e.keys.post(evs)
	}
	if e.ls != nil {
		e.ls.keyEvents(evs)
	}
}

func (e *kubeExec) output(b []byte, stderr bool) {
	e.mu.Lock()
	stream := &e.out
	if stderr {
		stream = &e.errOut
	}
	text, ok := stream.text(b)
	if e.lines != nil {
		e.lines.shown(b)
	}
	e.mu.Unlock()
	if !ok {
		e.marker("Binary output not recorded")
	}
	if e.term != nil {
		e.term.output(1, text)
	}
	e.live.output(1, text)
}

func (e *kubeExec) resize(cols, rows int) {
	if cols <= 0 || rows <= 0 || cols > 1000 || rows > 1000 {
		return
	}
	e.mu.Lock()
	e.cols, e.rows = cols, rows
	e.mu.Unlock()
	if e.term != nil {
		e.term.size(cols, rows)
	}
	e.live.resize(1, cols, rows)
}

// status reads the exit status the API server sends at the end (a v1.Status).
func (e *kubeExec) status(b []byte) {
	var st struct {
		Status  string `json:"status"`
		Message string `json:"message"`
		Details struct {
			Causes []struct{ Reason, Message string } `json:"causes"`
		} `json:"details"`
	}
	if json.Unmarshal(b, &st) != nil {
		return
	}
	text := ""
	for _, c := range st.Details.Causes {
		if c.Reason == "ExitCode" {
			text = "Exited with code " + c.Message
		}
	}
	if text == "" && st.Status == "Success" {
		text = "Exited with code 0"
	}
	if text == "" && st.Message != "" {
		text = st.Message
	}
	e.mu.Lock()
	e.exit = text
	e.mu.Unlock()
}
