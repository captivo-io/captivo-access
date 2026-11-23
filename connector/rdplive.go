package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"hash/crc32"
	"io"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// Live watching of a recorded native RDP session. The screen is the result of
// every PDU the server sent since the session began (H.264 frames refer to the
// ones before), so it is decoded as the session runs, watched or not, by
// rdpenc in its live mode (rdpenc/rdpenc.c), fed a copy of what this side
// relays to the client. While someone watches it writes Guacamole protocol,
// which goes to each viewer as the data plane's live view expects it. If the
// decoder falls behind, watching ends for that session; the session itself is
// never held up.

const (
	// Decoders at once (RDP_LIVE_MAX; 0: no live watching). A session's
	// decoder holds about 180 MB; at a full-HD video playing it takes most of
	// a core (an ordinary desktop: 1-2%).
	rdpLiveMaxDefault = 4
	rdpLiveQueue      = 512 // PDUs waiting for the decoder before it counts as behind
	rdpViewQueue      = 256 // instructions waiting for one viewer before it is dropped
	rdpLiveBinary     = "/usr/local/bin/rdpenc"
)

type rdpLive struct {
	start time.Time
	in    chan []byte
	ctrl  *os.File
	cmd   *exec.Cmd

	mu      sync.Mutex
	viewers map[*rdpViewer]struct{}
	broken  bool
	once    sync.Once
}

type rdpViewer struct {
	out     chan []byte
	gone    chan struct{}
	waiting bool // until the next whole screen
}

var rdpLives = struct {
	sync.Mutex
	m map[string]*rdpLive
}{m: map[string]*rdpLive{}}

func rdpLiveMax() int {
	if v := os.Getenv("RDP_LIVE_MAX"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			return n
		}
	}
	return rdpLiveMaxDefault
}

// startRdpLive starts the decoder for a session, or returns nil when this
// image has none or as many run as RDP_LIVE_MAX allows.
func startRdpLive(watchID string) *rdpLive {
	if watchID == "" {
		return nil
	}
	if _, err := os.Stat(rdpLiveBinary); err != nil {
		return nil
	}
	rdpLives.Lock()
	full := len(rdpLives.m) >= rdpLiveMax()
	rdpLives.Unlock()
	if full {
		logInfo("rdp live: %d sessions are already decoded for watching (RDP_LIVE_MAX); this one can't be watched", rdpLiveMax())
		return nil
	}
	cr, cw, err := os.Pipe()
	if err != nil {
		return nil
	}
	cmd := exec.Command(rdpLiveBinary, "--live", "10", "/gfx", "+compression")
	if nice, err := exec.LookPath("nice"); err == nil {
		cmd = exec.Command(nice, append([]string{"-n", "10"}, cmd.Args...)...)
	}
	cmd.ExtraFiles = []*os.File{cr} // fd 3: join / idle
	stdin, err := cmd.StdinPipe()
	if err != nil {
		cr.Close()
		cw.Close()
		return nil
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cr.Close()
		cw.Close()
		return nil
	}
	if err := cmd.Start(); err != nil {
		cr.Close()
		cw.Close()
		logWarn("rdp live: decoder not started: %v", err)
		return nil
	}
	cr.Close()
	l := &rdpLive{start: time.Now(), in: make(chan []byte, rdpLiveQueue), ctrl: cw, cmd: cmd, viewers: map[*rdpViewer]struct{}{}}
	go func() {
		w := bufio.NewWriterSize(stdin, 64<<10)
		for rec := range l.in {
			if _, err := w.Write(rec); err != nil {
				break
			}
			if len(l.in) == 0 && w.Flush() != nil {
				break
			}
		}
		stdin.Close()
	}()
	go l.fanOut(stdout)
	rdpLives.Lock()
	rdpLives.m[watchID] = l
	rdpLives.Unlock()
	return l
}

// server queues a PDU the server sent for the decoder.
func (l *rdpLive) server(pdu []byte) { l.feed(false, pdu) }

// clientChannels gives the decoder the static channels the client asked for
// (its Connect Initial's network data block), ahead of the server's PDUs: the
// server numbers channels in that order, so the decoder asks for the same.
func (l *rdpLive) clientChannels(connectInitial []byte) {
	gccBlocks(connectInitial, "Duca", func(typ uint16, b []byte) {
		if typ == csNet {
			l.feed(true, append([]byte(nil), b...))
		}
	})
}

func (l *rdpLive) feed(fromClient bool, pdu []byte) {
	if l == nil {
		return
	}
	rec := make([]byte, 21, 21+len(pdu))
	binary.LittleEndian.PutUint64(rec, uint64(time.Since(l.start).Milliseconds())+1)
	if fromClient {
		rec[8] = 1
	}
	binary.LittleEndian.PutUint32(rec[9:], crc32.ChecksumIEEE(pdu))
	binary.LittleEndian.PutUint64(rec[13:], uint64(len(pdu)))
	rec = append(rec, pdu...)
	l.mu.Lock()
	broken := l.broken
	l.mu.Unlock()
	if broken {
		return
	}
	select {
	case l.in <- rec:
	default:
		logWarn("rdp live: the decoder fell behind; this session can no longer be watched")
		l.fail()
	}
}

// fail ends watching for this session, whatever the reason.
func (l *rdpLive) fail() {
	l.mu.Lock()
	l.broken = true
	for v := range l.viewers {
		close(v.gone)
		delete(l.viewers, v)
	}
	l.mu.Unlock()
	l.stopDecoder()
}

func (l *rdpLive) stopDecoder() {
	l.once.Do(func() {
		close(l.in)
		l.ctrl.Close()
		go func() {
			done := make(chan struct{})
			go func() { _ = l.cmd.Wait(); close(done) }()
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				_ = l.cmd.Process.Kill()
			}
		}()
	})
}

func (l *rdpLive) stop(watchID string) {
	if l == nil {
		return
	}
	rdpLives.Lock()
	if rdpLives.m[watchID] == l {
		delete(rdpLives.m, watchID)
	}
	rdpLives.Unlock()
	l.fail()
}

// fanOut reads the decoder's instructions and hands each to the viewers.
func (l *rdpLive) fanOut(stdout io.Reader) {
	r := bufio.NewReaderSize(stdout, 64<<10)
	for {
		inst, op, err := readRawGuac(r)
		if err != nil {
			return
		}
		l.mu.Lock()
		for v := range l.viewers {
			if v.waiting {
				if op != "size" {
					continue
				}
				v.waiting = false
			}
			select {
			case v.out <- inst:
			default: // too slow: let it go
				close(v.gone)
				delete(l.viewers, v)
				l.idleIfAlone()
			}
		}
		l.mu.Unlock()
	}
}

// idleIfAlone tells the decoder to stop drawing when nobody watches. Callers hold l.mu.
func (l *rdpLive) idleIfAlone() {
	if len(l.viewers) == 0 {
		_, _ = l.ctrl.Write([]byte("idle\n"))
	}
}

func (l *rdpLive) join() (*rdpViewer, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.broken {
		return nil, errors.New("this session can no longer be watched")
	}
	v := &rdpViewer{out: make(chan []byte, rdpViewQueue), gone: make(chan struct{}), waiting: true}
	l.viewers[v] = struct{}{}
	_, _ = l.ctrl.Write([]byte("join\n"))
	return v, nil
}

func (l *rdpLive) leave(v *rdpViewer) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, ok := l.viewers[v]; ok {
		delete(l.viewers, v)
		l.idleIfAlone()
	}
}

// readRawGuac reads one Guacamole instruction (LENGTH.VALUE elements,
// ',' between them, ';' at the end; lengths in characters) and its opcode.
func readRawGuac(r *bufio.Reader) ([]byte, string, error) {
	var out []byte
	op := ""
	for first := true; ; first = false {
		lenStr, err := r.ReadString('.')
		if err != nil {
			return nil, "", err
		}
		n, err := strconv.Atoi(lenStr[:len(lenStr)-1])
		if err != nil || n < 0 || n > 1<<24 {
			return nil, "", errors.New("bad instruction")
		}
		out = append(out, lenStr...)
		val := make([]rune, 0, n)
		for range n {
			c, _, err := r.ReadRune()
			if err != nil {
				return nil, "", err
			}
			val = append(val, c)
		}
		s := string(val)
		out = append(out, s...)
		if first {
			op = s
		}
		sep, err := r.ReadByte()
		if err != nil {
			return nil, "", err
		}
		out = append(out, sep)
		if sep == ';' {
			return out, op, nil
		}
		if sep != ',' {
			return nil, "", errors.New("bad instruction")
		}
	}
}

// handleRdpWatch sends a session's live picture to one viewer until either
// side ends.
func handleRdpWatch(st io.ReadWriteCloser, reqBytes []byte) {
	var req tunnel.RdpWatchRequest
	_ = json.Unmarshal(reqBytes, &req)
	rdpLives.Lock()
	l := rdpLives.m[req.WatchID]
	rdpLives.Unlock()
	reply := func(msg string) bool {
		b, _ := json.Marshal(tunnel.RdpWatchResponse{Error: msg})
		return tunnel.WriteFrame(st, b) == nil
	}
	if l == nil {
		reply("this session can't be watched (it ended, or its connector could not decode it)")
		return
	}
	v, err := l.join()
	if err != nil {
		reply(err.Error())
		return
	}
	defer l.leave(v)
	if !reply("") {
		return
	}
	closed := make(chan struct{})
	go func() { _, _ = io.Copy(io.Discard, st); close(closed) }()
	w := bufio.NewWriterSize(st, 64<<10)
	for {
		select {
		case inst := <-v.out:
			if _, err := w.Write(inst); err != nil {
				return
			}
			if len(v.out) == 0 && w.Flush() != nil {
				return
			}
		case <-v.gone:
			_ = w.Flush()
			return
		case <-closed:
			return
		}
	}
}
