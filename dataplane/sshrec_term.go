package main

import (
	"bytes"
	"encoding/json"
	"log"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// A recorded native SSH session's terminal, as asciicast v2 lines in "term"
// chunks on the session's connector: a header, then [seconds, "o", text] for
// what the terminal showed, [seconds, "r", "COLSxROWS"] when it was resized and
// [seconds, "m", text] for moments the player marks (a command run without a
// terminal, a file transfer, something refused). What the user typed is not in
// it: the terminal's own echo is, so a password typed at a prompt that does
// not echo is never recorded. Typed lines go to the "keys" stream only when
// the resource logs keystrokes, as in a browser SSH session.

const termFormat = "term"

type termRecorder struct {
	send  func(tunnel.RecWriteRequest) (int, error)
	index *recIndexReporter
	done  func()

	tenantID, key, siteID string
	start                 time.Time
	maxBytes              int

	mu        sync.Mutex
	header    bool
	cols      int
	rows      int
	buf       bytes.Buffer
	seq       int
	total     int
	stopped   bool
	truncated bool
	lastChan  int
	terminals int
	quit      chan struct{}
	wg        sync.WaitGroup
}

func newTermRecorder(send func(tunnel.RecWriteRequest) (int, error), index *recIndexReporter, done func(), tenantID, key, siteID string, start time.Time) *termRecorder {
	r := &termRecorder{send: send, index: index, done: done, tenantID: tenantID, key: key, siteID: siteID, start: start, maxBytes: recordingMaxBytes(), cols: 80, rows: 24, quit: make(chan struct{})}
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

func (r *termRecorder) at(now time.Time) float64 {
	return float64(now.Sub(r.start).Microseconds()) / 1e6
}

// line appends one asciicast event. Callers hold r.mu.
func (r *termRecorder) line(ev []any) {
	if r.stopped {
		return
	}
	if !r.header {
		r.header = true
		h, _ := json.Marshal(map[string]any{"version": 2, "width": r.cols, "height": r.rows, "timestamp": r.start.Unix(), "env": map[string]string{"TERM": "xterm-256color"}})
		r.buf.Write(h)
		r.buf.WriteByte('\n')
	}
	b, err := json.Marshal(ev)
	if err != nil {
		return
	}
	r.buf.Write(b)
	r.buf.WriteByte('\n')
}

// size sets the terminal size a pty asked for, before anything is shown.
func (r *termRecorder) size(cols, rows int) {
	if cols <= 0 || rows <= 0 || cols > 1000 || rows > 1000 {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.header {
		r.cols, r.rows = cols, rows
		return
	}
	r.line([]any{r.at(time.Now()), "r", strconv.Itoa(cols) + "x" + strconv.Itoa(rows)})
}

// opened counts a terminal channel, so output of several is told apart.
func (r *termRecorder) opened() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.terminals++
	return r.terminals
}

func (r *termRecorder) output(ch int, text string) {
	if text == "" {
		return
	}
	r.mu.Lock()
	if r.terminals > 1 && ch != r.lastChan {
		r.line([]any{r.at(time.Now()), "m", "Session " + strconv.Itoa(ch)})
	}
	r.lastChan = ch
	r.line([]any{r.at(time.Now()), "o", text})
	full := r.buf.Len() >= recFlushBytes
	r.mu.Unlock()
	if full {
		r.flush()
	}
}

func (r *termRecorder) marker(text string) {
	r.mu.Lock()
	r.line([]any{r.at(time.Now()), "m", text})
	r.mu.Unlock()
}

func (r *termRecorder) flush() {
	r.mu.Lock()
	if r.buf.Len() == 0 {
		r.mu.Unlock()
		return
	}
	data := append([]byte(nil), r.buf.Bytes()...)
	r.buf.Reset()
	if r.maxBytes > 0 && r.total+len(data) > r.maxBytes {
		r.stopped, r.truncated = true, true
		r.mu.Unlock()
		log.Printf("ssh recording site=%s key=%s: RECORDING_MAX_BYTES reached, stopping capture; the session continues unrecorded", r.siteID, r.key)
		r.index.reportTruncated(r.key)
		return
	}
	seq := r.seq
	r.seq++
	r.total += len(data)
	r.mu.Unlock()
	if _, err := r.send(tunnel.RecWriteRequest{TenantID: r.tenantID, RecordingKey: r.key, Seq: seq, Format: termFormat, Protocol: "ssh", Data: data}); err != nil {
		log.Printf("ssh recording key=%s seq=%d: connector write failed: %v", r.key, seq, err)
		return
	}
	r.index.report(r.key, seq, len(data))
}

func (r *termRecorder) stop() {
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

// utf8Stream turns a byte stream into text without splitting a character
// across two events. A stream that turns out not to be text (a command piping
// a binary file) stops being recorded, and the recording says so.
type utf8Stream struct {
	pending []byte
	binary  bool
	skipped int64
}

// text returns what can be shown now. ok=false the first time the stream turns binary.
func (u *utf8Stream) text(b []byte) (string, bool) {
	if u.binary {
		u.skipped += int64(len(b))
		return "", true
	}
	data := append(u.pending, b...)
	u.pending = nil
	// Keep an incomplete character at the end for the next read.
	cut := len(data)
	for i := 1; i <= 3 && i <= len(data); i++ {
		c := data[len(data)-i]
		if c < 0x80 {
			break
		}
		if utf8.RuneStart(c) {
			if !utf8.FullRune(data[len(data)-i:]) {
				cut = len(data) - i
			}
			break
		}
	}
	u.pending = append([]byte(nil), data[cut:]...)
	data = data[:cut]
	if !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 {
		u.binary = true
		u.skipped += int64(len(data))
		return "", false
	}
	return string(data), true
}

var ansiEscape = regexp.MustCompile(`\x1b(\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|[@-Z\\-_])`)

// passwordPromptTail matches what a terminal shows when it asks for a secret
// it will not echo.
var passwordPromptTail = regexp.MustCompile(`(?i)(password|passphrase|passcode|pin|token|secret)[^\n]{0,60}[:>]\s*$`)

// altScreen follows whether a full-screen program (vim, top, less) holds the
// terminal's alternate screen, from what the terminal shows.
type altScreen struct {
	on    bool
	carry string // a sequence cut across two reads
}

func (a *altScreen) shown(text string) {
	s := a.carry + text
	a.carry = ""
	if i := strings.LastIndexByte(s, 0x1b); i >= 0 && len(s)-i < 8 {
		for _, q := range tailSeqs {
			if rest := s[i:]; len(rest) < len(q.seq) && strings.HasPrefix(q.seq, rest) {
				a.carry, s = rest, s[:i]
				break
			}
		}
	}
	last := -1
	for _, q := range tailSeqs {
		if q.op == tailClear {
			continue
		}
		if i := strings.LastIndex(s, q.seq); i > last {
			last, a.on = i, q.op == tailEnterAlt
		}
	}
}

// lineObserver rebuilds typed lines from what a terminal client sends, for the
// keystroke log. A line typed at a password prompt is masked, as is the line
// after a command that asks for one (sudo, su, passwd). Keys typed into a
// full-screen program are not lines for the shell, so they are left out.
type lineObserver struct {
	start    time.Time
	line     []rune
	esc      int // inside an escape sequence: 1 after ESC, 2 inside CSI
	maskNext bool
	tail     []byte // the end of what the terminal last showed
	alt      altScreen
}

func (o *lineObserver) shown(b []byte) {
	o.alt.shown(string(b))
	o.tail = append(o.tail, b...)
	if len(o.tail) > 512 {
		o.tail = append([]byte(nil), o.tail[len(o.tail)-512:]...)
	}
}

func (o *lineObserver) typed(b []byte, now time.Time) []keyEvent {
	if o.alt.on {
		o.line, o.esc = o.line[:0], 0
		return nil
	}
	var out []keyEvent
	for _, c := range string(b) {
		switch {
		case o.esc == 1:
			if c == '[' || c == 'O' {
				o.esc = 2
			} else {
				o.esc = 0
			}
		case o.esc == 2:
			if c >= 0x40 && c <= 0x7e {
				o.esc = 0
			}
		case c == 0x1b:
			o.esc = 1
		case c == '\r' || c == '\n':
			if ev, ok := o.emit(now); ok {
				out = append(out, ev)
			}
		case c == 0x7f || c == 0x08:
			if len(o.line) > 0 {
				o.line = o.line[:len(o.line)-1]
			}
		case c == 0x15: // Ctrl-U
			o.line = o.line[:0]
		case c == 0x03: // Ctrl-C
			o.line = o.line[:0]
			o.maskNext = false
		case c >= 0x20:
			o.line = append(o.line, c)
		}
	}
	return out
}

func (o *lineObserver) emit(now time.Time) (keyEvent, bool) {
	text := string(o.line)
	o.line = o.line[:0]
	tail := ansiEscape.ReplaceAll(o.tail, nil)
	if i := bytes.LastIndexAny(tail, "\r\n"); i >= 0 {
		tail = tail[i+1:]
	}
	masked := o.maskNext || passwordPromptTail.Match(tail)
	o.tail = o.tail[:0]
	if masked {
		o.maskNext = false
		if text == "" {
			return keyEvent{}, false
		}
		return keyEvent{AtMs: now.Sub(o.start).Milliseconds(), Kind: "command", Text: "••••", Masked: true}, true
	}
	o.maskNext = passwordPrompt(text)
	if strings.TrimSpace(text) == "" {
		return keyEvent{}, false
	}
	return keyEvent{AtMs: now.Sub(o.start).Milliseconds(), Kind: "command", Text: text}, true
}
