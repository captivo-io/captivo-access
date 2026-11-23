package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/coder/websocket"
)

// Watching a recorded native SSH session live. The jump host already sees
// every byte the server shows the user (it records them), so a viewer gets the
// same text: each terminal's output, its size, and when it opens and closes.
// A viewer who joins late first gets each terminal as it is now, rebuilt from
// the output since its screen was last drawn from scratch. Watching is read
// only; the user is told in their own terminal that an admin is watching.

const (
	// termTailMax bounds what is kept to redraw one terminal for a late viewer.
	termTailMax = 2 << 20
	// termViewerQueue is how many frames a viewer may fall behind before it is
	// dropped (it reconnects and redraws); the user's terminal never waits.
	termViewerQueue = 512
	// A viewer who reconnects within this long does not tell the user again.
	watchNoticeQuiet = time.Minute
)

// Sequences that change what a late viewer must replay.
const (
	tailEnterAlt = iota
	tailExitAlt
	tailClear
	tailReset
)

var tailSeqs = []struct {
	seq string
	op  int
}{
	{"\x1b[?1049h", tailEnterAlt}, {"\x1b[?1047h", tailEnterAlt}, {"\x1b[?47h", tailEnterAlt},
	{"\x1b[?1049l", tailExitAlt}, {"\x1b[?1047l", tailExitAlt}, {"\x1b[?47l", tailExitAlt},
	{"\x1b[2J", tailClear}, {"\x1bc", tailReset},
}

// termTail is what a late viewer replays to see a terminal as it is now: the
// main screen's output since it was last cleared and, while a full-screen
// program (vim, top, less) runs on the alternate screen, that screen's too.
type termTail struct {
	main, alt []byte
	inAlt     bool
	carry     string // a sequence cut across two reads
	midSeq    bool   // the output so far ends inside an escape sequence
}

func (t *termTail) cur() *[]byte {
	if t.inAlt {
		return &t.alt
	}
	return &t.main
}

func (t *termTail) write(text string) {
	if i := strings.LastIndexByte(text, 0x1b); i >= 0 {
		t.midSeq = unterminated(text[i:])
	} else if t.midSeq && strings.IndexFunc(text, func(r rune) bool { return (r >= 0x40 && r <= 0x7e) || r == 0x07 }) >= 0 {
		t.midSeq = false
	}
	s := t.carry + text
	t.carry = ""
	// Hold back a trailing escape that may be the start of one of the sequences.
	if i := strings.LastIndexByte(s, 0x1b); i >= 0 && len(s)-i < 8 {
		for _, q := range tailSeqs {
			if rest := s[i:]; len(rest) < len(q.seq) && strings.HasPrefix(q.seq, rest) {
				t.carry, s = rest, s[:i]
				break
			}
		}
	}
	for strings.IndexByte(s, 0x1b) >= 0 {
		at, op, n := -1, 0, 0
		for _, q := range tailSeqs {
			if i := strings.Index(s, q.seq); i >= 0 && (at < 0 || i < at) {
				at, op, n = i, q.op, len(q.seq)
			}
		}
		if at < 0 {
			break
		}
		b := t.cur()
		*b = append(*b, s[:at]...)
		switch op {
		case tailEnterAlt:
			t.inAlt, t.alt = true, t.alt[:0]
		case tailExitAlt:
			t.inAlt, t.alt = false, nil
		case tailClear:
			*t.cur() = (*t.cur())[:0]
		case tailReset:
			t.main, t.alt, t.inAlt = t.main[:0], nil, false
		}
		s = s[at+n:]
	}
	b := t.cur()
	*b = append(*b, s...)
	if len(*b) > termTailMax {
		cut := len(*b) - termTailMax
		if i := indexByteFrom(*b, '\n', cut); i >= 0 {
			cut = i + 1
		}
		*b = append((*b)[:0], (*b)[cut:]...)
	}
}

func indexByteFrom(b []byte, c byte, from int) int {
	for i := from; i < len(b); i++ {
		if b[i] == c {
			return i
		}
	}
	return -1
}

// unterminated says whether s, which starts with ESC, is an escape sequence
// still waiting for its end.
func unterminated(s string) bool {
	if len(s) < 2 {
		return true
	}
	switch s[1] {
	case '[':
		for i := 2; i < len(s); i++ {
			if s[i] >= 0x40 && s[i] <= 0x7e {
				return false
			}
		}
		return true
	case ']', 'P', '_', '^':
		return !strings.ContainsRune(s, 0x07)
	case '(', ')', '*', '+', '#', '%':
		return len(s) < 3
	}
	return false
}

// snapshot is what a fresh terminal must be written to look like this one.
func (t *termTail) snapshot() string {
	if !t.inAlt {
		return string(t.main)
	}
	return string(t.main) + "\x1b[?1049h" + string(t.alt)
}

// currentLine is the main screen's line the cursor is on (a shell prompt and
// what the user has typed after it), so it can be drawn again under a notice.
func (t *termTail) currentLine() string {
	i := strings.LastIndexByte(string(t.main), '\n')
	if len(t.main)-i > 1024 {
		return ""
	}
	return string(t.main[i+1:])
}

// settled: nothing is mid-sequence and no full-screen program is running, so a
// line written into the user's terminal now lands on its own.
func (t *termTail) settled() bool { return !t.inAlt && !t.midSeq && t.carry == "" }

// termFrame is one message to a viewer.
type termFrame struct {
	T     string `json:"t"` // open | o | r | close | end
	Ch    int    `json:"ch,omitempty"`
	Label string `json:"label,omitempty"`
	Cols  int    `json:"cols,omitempty"`
	Rows  int    `json:"rows,omitempty"`
	D     string `json:"d,omitempty"`
}

type liveTerm struct {
	label      string
	cols, rows int
	tail       termTail
}

type termViewer struct {
	out  chan []byte
	gone chan struct{}
	once sync.Once
}

func (v *termViewer) drop() { v.once.Do(func() { close(v.gone) }) }

// termLive fans one recorded session's terminals out to its viewers.
type termLive struct {
	mu      sync.Mutex
	terms   map[int]*liveTerm
	order   []int
	viewers map[*termViewer]struct{}
	ended   bool
}

func newTermLive() *termLive {
	return &termLive{terms: map[int]*liveTerm{}, viewers: map[*termViewer]struct{}{}}
}

// send passes a frame to every viewer. Callers hold l.mu.
func (l *termLive) send(f termFrame) {
	if len(l.viewers) == 0 {
		return
	}
	b, err := json.Marshal(f)
	if err != nil {
		return
	}
	for v := range l.viewers {
		select {
		case v.out <- b:
		default:
			delete(l.viewers, v)
			v.drop()
		}
	}
}

func (l *termLive) open(ch int, label string, cols, rows int) {
	if cols <= 0 || rows <= 0 {
		cols, rows = 80, 24
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.terms[ch] != nil {
		return
	}
	l.terms[ch] = &liveTerm{label: label, cols: cols, rows: rows}
	l.order = append(l.order, ch)
	l.send(termFrame{T: "open", Ch: ch, Label: label, Cols: cols, Rows: rows})
}

func (l *termLive) resize(ch, cols, rows int) {
	if cols <= 0 || rows <= 0 || cols > 1000 || rows > 1000 {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	t := l.terms[ch]
	if t == nil {
		return
	}
	t.cols, t.rows = cols, rows
	l.send(termFrame{T: "r", Ch: ch, Cols: cols, Rows: rows})
}

func (l *termLive) output(ch int, text string) {
	if text == "" {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	t := l.terms[ch]
	if t == nil {
		return
	}
	t.tail.write(text)
	l.send(termFrame{T: "o", Ch: ch, D: text})
}

// settled says whether a notice may be written into this terminal now, and
// the line to draw again under it.
func (l *termLive) settled(ch int) (bool, string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	t := l.terms[ch]
	if t == nil {
		return true, ""
	}
	return t.tail.settled(), t.tail.currentLine()
}

func (l *termLive) closeTerm(ch int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.terms[ch] == nil {
		return
	}
	delete(l.terms, ch)
	for i, n := range l.order {
		if n == ch {
			l.order = append(l.order[:i], l.order[i+1:]...)
			break
		}
	}
	l.send(termFrame{T: "close", Ch: ch})
}

func (l *termLive) end() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.ended = true
	l.send(termFrame{T: "end"})
	for v := range l.viewers {
		delete(l.viewers, v)
		v.drop()
	}
}

// join adds a viewer and returns each open terminal as it is now. Nothing is
// sent to the viewer between the two, so it misses no output.
func (l *termLive) join() (*termViewer, []termFrame) {
	l.mu.Lock()
	defer l.mu.Unlock()
	v := &termViewer{out: make(chan []byte, termViewerQueue), gone: make(chan struct{})}
	if l.ended {
		v.drop()
		return v, nil
	}
	frames := make([]termFrame, 0, len(l.order))
	for _, ch := range l.order {
		t := l.terms[ch]
		frames = append(frames, termFrame{T: "open", Ch: ch, Label: t.label, Cols: t.cols, Rows: t.rows, D: t.tail.snapshot()})
	}
	l.viewers[v] = struct{}{}
	return v, frames
}

func (l *termLive) leave(v *termViewer) {
	l.mu.Lock()
	delete(l.viewers, v)
	l.mu.Unlock()
	v.drop()
}

// noticeLine is a line from Captivo in the user's terminal. Text from an
// admin is stripped of control characters, so it can't drive the terminal.
func noticeLine(text string) string {
	clean := strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, text)
	return "\r\n\x1b[1;7m Captivo Access \x1b[0m " + clean + "\r\n"
}

// Delivery of a notice to the user's terminal.
const (
	noticeShown  = "shown"
	noticeQueued = "queued" // a full-screen program is running; shown when it ends
	noticeNone   = "none"   // no terminal is open (only file transfer or commands)
)

// serveTermView streams a recorded native SSH session to a viewer.
func serveTermView(ls *liveSession, live *termLive, notify func(string, bool) string, viewerUserID string, w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		log.Printf("term-view session=%s: ws accept failed err=%v", ls.id, err)
		return
	}
	c.SetReadLimit(4 << 10) // a viewer sends nothing but its close
	defer c.CloseNow()
	v, frames := live.join()
	defer live.leave(v)
	log.Printf("term-view session=%s viewer=%s: joined (%d terminals)", ls.id, viewerUserID, len(frames))
	ls.addViewer()
	defer ls.removeViewer()
	if notify != nil {
		notify("An admin is now watching this session.", true)
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go func() {
		// Reads only notice the viewer leaving.
		for {
			if _, _, err := c.Read(ctx); err != nil {
				cancel()
				return
			}
		}
	}()
	write := func(b []byte) bool {
		wctx, done := context.WithTimeout(ctx, 10*time.Second)
		defer done()
		return c.Write(wctx, websocket.MessageText, b) == nil
	}
	hello, _ := json.Marshal(termFrame{T: "hello"})
	if !write(hello) {
		return
	}
	for _, f := range frames {
		b, _ := json.Marshal(f)
		if !write(b) {
			return
		}
	}
	for {
		select {
		case b := <-v.out:
			if !write(b) {
				return
			}
		case <-v.gone:
			// Ended, or fell too far behind: what is queued still goes out.
			for {
				select {
				case b := <-v.out:
					if !write(b) {
						return
					}
				default:
					_ = c.Close(websocket.StatusNormalClosure, "")
					return
				}
			}
		case <-ctx.Done():
			return
		}
	}
}
