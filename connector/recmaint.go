package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// recMaint looks after recordings once their session has ended. It runs on the
// connector because that is where the recordings and their key are; nothing it
// reads or writes leaves this host except the report of what changed.
//
//   - A graphical session (RDP, VNC) is turned into a VP9 WebM video. Its guac
//     instruction stream can only be replayed from the start, so a player had to
//     download and parse everything before the point it wanted (minutes for a
//     long session), and it took 1-10 MB a minute. The video seeks anywhere and
//     is a fraction of the size (169 MB -> 1.4 MB for a 12-minute session). Once
//     the control plane has recorded that the video is there, and a grace period
//     later, the instruction stream is removed. The keystroke stream stays.
//   - A terminal session (SSH, telnet) stays an instruction stream: it is small
//     (about 2 KB a second) and a video of it would be larger.
//   - Streams kept as they are, and recordings from before compression, are
//     compressed (recstore.go).
//   - An isolated-browser video cut off before its session closed (a restart of
//     the data plane or of this connector) has no duration or seek index, and a
//     player cannot seek in it. It is rewritten without re-encoding, which adds
//     them.
//
// The data plane says when a recording is complete (tunnel.RecDone) and the
// worker starts on it at once, ahead of anything else waiting; without that
// signal (a dropped connection, an older data plane) a recording is left alone
// until it has been quiet for maintSettle. The work goes one recording at a time
// at low CPU priority.
type recMaint struct {
	store *recStore
	tools mediaTools // nil: no encoder in this image, so no conversion or repair
	now   func() time.Time

	settle    time.Duration
	grace     time.Duration
	retryWait time.Duration

	mu      sync.Mutex
	pending map[string]tunnel.RecReportItem // tenant/key -> unacknowledged report
	acks    map[string]tunnel.RecReportItem // tenant/key -> confirmed, not yet saved
	done    map[string]bool                 // tenant/key -> complete, per the data plane
	wake    chan struct{}
	queued  chan struct{} // a report is waiting: send it now, not on the next tick
}

// recMaintenance is the connector's worker; nil in tests that do not start one.
var recMaintenance *recMaint

const (
	maintInterval = time.Minute
	// No chunk written for this long and the session is over: a live guac
	// stream carries guacd's keep-alive every few seconds, and a live video a
	// frame every 100 ms.
	maintSettle = 5 * time.Minute
	// The instruction stream outlives its video by this much, so a replay that
	// started from it just before the switch can finish.
	maintGrace     = 10 * time.Minute
	maintRetryWait = time.Hour
	maintMaxTries  = 3
	// Video chunks are written at the size the data plane flushes at.
	videoChunkBytes = 256 << 10
	// A kept instruction or web-app stream is rewritten in chunks this large:
	// it arrives in small ones (a flush every 2 s), and compressed one by one
	// they kept much of their size (an SSH session: 3.4 MB raw, 2.4 MB in its
	// own chunks, 1.5 MB in 4 MiB ones).
	repackChunkBytes = 4 << 20
	// Larger streams are compressed in place instead: their chunks are already
	// full (256 KiB) and gain little from repacking, and a rewrite would hold a
	// second copy of the stream on disk while it runs.
	repackMaxBytes = 64 << 20
	// Wider sessions are scaled down to this; text stays readable.
	maxVideoWidth   = 2560
	maintStateFile  = ".maint.json"
	maintTempPrefix = "captivo-rec-"
)

// maintState is what the worker has done to one recording, kept beside it.
type maintState struct {
	// Video: "" not yet looked at, "converted", "terminal" (kept as guac), "kept"
	// (the video would not have been smaller or shorter), "failed".
	Video       string    `json:"video,omitempty"`
	Tries       int       `json:"tries,omitempty"`
	LastTry     time.Time `json:"lastTry,omitempty"`
	ConvertedAt time.Time `json:"convertedAt,omitempty"`
	// The instruction stream as it was when converted: if it changes after,
	// the video is not the whole recording and is made again.
	Source     string `json:"source,omitempty"`
	DurationMs int64  `json:"durationMs,omitempty"`
	// VideoChecked: an isolated-browser video has been probed (and repaired if
	// it had to be).
	VideoChecked bool `json:"videoChecked,omitempty"`
	// Compressed: raw chunks from before compression have been rewritten. Once
	// is enough: new chunks are compressed as they are written, and a chunk
	// that did not shrink stays raw rather than being tried again every pass.
	Compressed bool `json:"compressed,omitempty"`
	// Acked is the last report the control plane confirmed.
	Acked *tunnel.RecReportItem `json:"acked,omitempty"`
}

func newRecMaint(store *recStore, tools mediaTools) *recMaint {
	return &recMaint{
		store: store, tools: tools, now: time.Now,
		settle: maintSettle, grace: maintGrace, retryWait: maintRetryWait,
		pending: map[string]tunnel.RecReportItem{},
		acks:    map[string]tunnel.RecReportItem{},
		done:    map[string]bool{},
		wake:    make(chan struct{}, 1),
		queued:  make(chan struct{}, 1),
	}
}

// run works through the store every maintInterval until ctx ends.
func (m *recMaint) run(ctx context.Context) {
	removeStaleTemp()
	t := time.NewTicker(maintInterval)
	defer t.Stop()
	m.cycle(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-m.wake:
			m.processDone(ctx)
		case <-t.C:
			m.processDone(ctx)
			m.cycle(ctx)
		}
	}
}

// markDone records that a recording is complete and wakes the worker for it.
func (m *recMaint) markDone(tenantID, key string) {
	if !safeSegment.MatchString(tenantID) || !safeSegment.MatchString(key) {
		return
	}
	m.mu.Lock()
	m.done[tenantID+"/"+key] = true
	m.mu.Unlock()
	select {
	case m.wake <- struct{}{}:
	default:
	}
}

// processDone works on the recordings the data plane has said are complete.
func (m *recMaint) processDone(ctx context.Context) {
	for {
		m.mu.Lock()
		var id string
		for k := range m.done {
			id = k
			break
		}
		m.mu.Unlock()
		if id == "" || ctx.Err() != nil {
			return
		}
		tenantID, key, _ := strings.Cut(id, "/")
		m.process(ctx, tenantID, key)
		m.mu.Lock()
		delete(m.done, id)
		m.mu.Unlock()
	}
}

func (m *recMaint) cycle(ctx context.Context) {
	tenants, err := os.ReadDir(m.store.root)
	if err != nil {
		return
	}
	for _, t := range tenants {
		if !t.IsDir() || !safeSegment.MatchString(t.Name()) {
			continue
		}
		recs, err := os.ReadDir(filepath.Join(m.store.root, t.Name()))
		if err != nil {
			continue
		}
		for _, r := range recs {
			if ctx.Err() != nil {
				return
			}
			if r.IsDir() && safeSegment.MatchString(r.Name()) {
				m.process(ctx, t.Name(), r.Name())
			}
		}
	}
}

// process does whatever one recording still needs, then states it.
func (m *recMaint) process(ctx context.Context, tenantID, key string) {
	recDir, err := m.store.recDir(tenantID, key)
	if err != nil {
		return
	}
	m.mu.Lock()
	complete := m.done[tenantID+"/"+key]
	m.mu.Unlock()
	newest, ok := newestChunk(recDir)
	if !ok || (!complete && m.now().Sub(newest) < m.settle) {
		return
	}
	st := loadMaintState(recDir)
	before := st
	m.mu.Lock()
	if a, ok := m.acks[tenantID+"/"+key]; ok {
		st.Acked = &a
		delete(m.acks, tenantID+"/"+key)
	}
	m.mu.Unlock()
	streams := m.store.Formats(tenantID, key)
	has := func(f string) bool {
		for _, s := range streams {
			if s == f {
				return true
			}
		}
		return false
	}

	if has("guac") && st.Video == "converted" {
		if src := streamStamp(filepath.Join(recDir, "guac")); src != st.Source {
			// Written to after it was converted: the video is short of the end.
			logInfo("recording %s: grew after conversion, converting again", key)
			m.removeStream(recDir, "video")
			st = maintState{Acked: st.Acked}
		} else if st.Acked != nil && st.Acked.Video && m.now().Sub(st.ConvertedAt) >= m.grace {
			m.removeStream(recDir, "guac")
			logInfo("recording %s: instruction stream removed, the video replaces it", key)
		}
	}

	if has("guac") && m.tools != nil && m.dueForConversion(st) {
		m.convert(ctx, tenantID, key, recDir, &st)
	}

	// Compress what is kept. A converted instruction stream is on its way out.
	if !st.Compressed {
		for _, f := range m.store.Formats(tenantID, key) {
			switch {
			case !compressible(f) || (f == "guac" && st.Video == "converted"):
			case repackable(f) && m.streamBytes(tenantID, key, f) <= repackMaxBytes:
				m.repackStream(tenantID, key, recDir, f)
			default:
				m.compressStream(filepath.Join(recDir, f))
			}
		}
		st.Compressed = true
	}

	if has("video") && st.Video != "converted" && !st.VideoChecked && m.tools != nil {
		m.checkVideo(ctx, tenantID, key, recDir, &st)
	}

	if !sameState(st, before) {
		m.saveState(recDir, st)
	}
	m.queueReport(tenantID, key, st)
}

func sameState(a, b maintState) bool {
	ja, _ := json.Marshal(a)
	jb, _ := json.Marshal(b)
	return bytes.Equal(ja, jb)
}

func (m *recMaint) dueForConversion(st maintState) bool {
	switch st.Video {
	case "":
		return true
	case "failed":
		return st.Tries < maintMaxTries && m.now().Sub(st.LastTry) >= m.retryWait
	}
	return false
}

// convert turns the recording's guac stream into its video stream.
func (m *recMaint) convert(ctx context.Context, tenantID, key, recDir string, st *maintState) {
	guacDir := filepath.Join(recDir, "guac")
	source := streamStamp(guacDir)
	scan, err := m.scanGuac(tenantID, key)
	if err != nil {
		m.failed(key, st, err)
		return
	}
	if isTerminal(readProtocol(guacDir), scan) {
		st.Video = "terminal"
		return
	}
	if scan.width <= 0 || scan.height <= 0 || scan.lastSync <= scan.firstSync {
		// Nothing was ever drawn: there is nothing to make a video of.
		st.Video = "kept"
		return
	}
	st.Tries++
	st.LastTry = m.now()

	tmp, err := os.MkdirTemp("", maintTempPrefix)
	if err != nil {
		m.failed(key, st, err)
		return
	}
	defer os.RemoveAll(tmp)
	out := filepath.Join(tmp, "out.webm")

	w, h := videoSize(scan.width, scan.height)
	want := time.Duration(scan.lastSync-scan.firstSync) * time.Millisecond
	// guacenc runs well ahead of real time; this only ends one that hangs.
	ctx, cancel := context.WithTimeout(ctx, 30*time.Minute+2*want)
	defer cancel()
	pr, pw := io.Pipe()
	go func() {
		pw.CloseWithError(m.store.EachChunk(tenantID, key, "guac", 0, func(b []byte) error {
			_, err := pw.Write(b)
			return err
		}))
	}()
	started := m.now()
	err = m.tools.EncodeGuac(ctx, pr, w, h, out)
	pr.Close()
	if err != nil {
		m.failed(key, st, err)
		return
	}
	dur, ok, err := m.tools.Duration(ctx, out)
	if err != nil || !ok {
		m.failed(key, st, fmt.Errorf("the video has no duration (%v)", err))
		return
	}
	slack := 2 * time.Second
	if want/50 > slack {
		slack = want / 50
	}
	if dur < want-slack || dur > want+slack {
		m.failed(key, st, fmt.Errorf("the video is %s long, the recording %s", dur.Round(time.Millisecond), want))
		return
	}
	info, err := os.Stat(out)
	if err != nil {
		m.failed(key, st, err)
		return
	}
	if info.Size() >= scan.bytes {
		// Rare for a graphical session, but never trade a recording for a
		// larger one: the stream stays, compressed.
		st.Video = "kept"
		logInfo("recording %s: video would be %d bytes against %d, kept as it is", key, info.Size(), scan.bytes)
		return
	}
	if err := m.installStream(recDir, "video", out, videoChunkBytes, nil); err != nil {
		m.failed(key, st, err)
		return
	}
	st.Video = "converted"
	st.ConvertedAt = m.now()
	st.Source = source
	st.DurationMs = dur.Milliseconds()
	logInfo("recording %s: converted to video in %s (%d -> %d bytes, %s)",
		key, m.now().Sub(started).Round(time.Second), scan.bytes, info.Size(), dur.Round(time.Second))
}

func (m *recMaint) failed(key string, st *maintState, err error) {
	st.Video = "failed"
	if st.LastTry.IsZero() {
		st.LastTry = m.now()
	}
	if st.Tries == 0 {
		st.Tries = 1
	}
	logWarn("recording %s: conversion failed (try %d of %d): %v", key, st.Tries, maintMaxTries, err)
}

// checkVideo makes sure an isolated-browser video can be seeked, repairing one
// whose session was cut off before ffmpeg wrote its duration and index.
func (m *recMaint) checkVideo(ctx context.Context, tenantID, key, recDir string, st *maintState) {
	tmp, err := os.MkdirTemp("", maintTempPrefix)
	if err != nil {
		return
	}
	defer os.RemoveAll(tmp)
	in := filepath.Join(tmp, "in.webm")
	before := streamStamp(filepath.Join(recDir, "video"))
	if err := m.writeStreamTo(tenantID, key, "video", in); err != nil {
		return
	}
	st.VideoChecked = true
	if dur, ok, err := m.tools.Duration(ctx, in); err == nil && ok {
		st.DurationMs = dur.Milliseconds()
		return
	}
	out := filepath.Join(tmp, "out.webm")
	if err := m.tools.Remux(ctx, in, out); err != nil {
		logWarn("recording %s: video has no duration and could not be repaired: %v", key, err)
		return
	}
	dur, ok, err := m.tools.Duration(ctx, out)
	if err != nil || !ok {
		logWarn("recording %s: video has no duration, even rewritten", key)
		return
	}
	if err := m.installStream(recDir, "video", out, videoChunkBytes, func() bool {
		return streamStamp(filepath.Join(recDir, "video")) == before
	}); err != nil {
		logWarn("recording %s: repaired video not stored: %v", key, err)
		return
	}
	st.DurationMs = dur.Milliseconds()
	logInfo("recording %s: video was cut off; rewritten with its duration (%s)", key, dur.Round(time.Second))
}

// repackable: streams that are only ever read whole, as one concatenation, can
// be rewritten in large chunks. The keystroke stream is searched chunk by chunk
// (each chunk is one JSON batch), so it keeps its chunks.
func repackable(format string) bool { return format == "guac" || format == "rrweb" }

// repackStream rewrites a finished stream in repackChunkBytes chunks, compressed.
// The bytes it holds are unchanged; if the stream is written to meanwhile, the
// rewrite is dropped and the stream left as it is.
func (m *recMaint) repackStream(tenantID, key, recDir, format string) {
	dir := filepath.Join(recDir, format)
	before := streamStamp(dir)
	tmp, err := os.MkdirTemp("", maintTempPrefix)
	if err != nil {
		return
	}
	defer os.RemoveAll(tmp)
	plain := filepath.Join(tmp, "stream")
	if err := m.writeStreamTo(tenantID, key, format, plain); err != nil {
		return
	}
	if err := m.installStream(recDir, format, plain, repackChunkBytes, func() bool { return streamStamp(dir) == before }); err != nil {
		logWarn("recording %s: %s stream not repacked: %v", key, format, err)
	}
}

func (m *recMaint) streamBytes(tenantID, key, format string) int64 {
	n, err := m.store.TotalPlaintextBytes(tenantID, key, format)
	if err != nil {
		return 1 << 62
	}
	return n
}

// writeStreamTo writes a stream's plaintext to a new file at path.
func (m *recMaint) writeStreamTo(tenantID, key, format, path string) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	err = m.store.EachChunk(tenantID, key, format, 0, func(b []byte) error {
		_, err := f.Write(b)
		return err
	})
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

// compressStream rewrites a stream's raw chunks compressed.
func (m *recMaint) compressStream(dir string) {
	set, err := chunkFiles(dir)
	if err != nil {
		return
	}
	for _, c := range set.byPlay {
		if c.compressed || c.plain == 0 {
			continue
		}
		plain, err := m.store.openChunk(c)
		if err != nil {
			continue
		}
		m.store.mu.Lock()
		if info, err := os.Stat(c.path); err == nil {
			// The chunk keeps its write time: that time is how the worker tells
			// a recording still being written from a finished one.
			if m.store.writeChunk(dir, c.seq, plain, true) == nil {
				if set, err := chunkFiles(dir); err == nil {
					for _, n := range set.all {
						if n.seq == c.seq {
							_ = os.Chtimes(n.path, info.ModTime(), info.ModTime())
						}
					}
				}
			}
		}
		m.store.mu.Unlock()
	}
}

// installStream stores the file at src as the recording's stream named format,
// in chunks of chunkBytes, replacing any stream of that name if unchanged (when
// given) still holds at the moment of the swap. Nothing is written if the
// recording has been erased meanwhile, and the recording's age (its directory's
// time, which retention reads) is left as it was.
func (m *recMaint) installStream(recDir, format, src string, chunkBytes int, unchanged func() bool) (err error) {
	if info, serr := os.Stat(recDir); serr == nil {
		defer func() { _ = os.Chtimes(recDir, info.ModTime(), info.ModTime()) }()
	}
	staging := filepath.Join(recDir, "."+format+".new")
	_ = os.RemoveAll(staging)
	if err := os.Mkdir(staging, 0o700); err != nil {
		return err // the recording is gone, or its directory is unusable
	}
	defer os.RemoveAll(staging)
	f, err := os.Open(src)
	if err != nil {
		return err
	}
	defer f.Close()
	buf := make([]byte, chunkBytes)
	for seq := 0; ; seq++ {
		n, err := io.ReadFull(f, buf)
		if n > 0 {
			if werr := m.store.writeChunk(staging, seq, buf[:n], compressible(format)); werr != nil {
				return werr
			}
		}
		if err == io.EOF || err == io.ErrUnexpectedEOF {
			break
		}
		if err != nil {
			return err
		}
	}
	m.store.mu.Lock()
	defer m.store.mu.Unlock()
	return keepModTime(recDir, func() error {
		if _, err := os.Stat(recDir); err != nil {
			return err
		}
		if unchanged != nil && !unchanged() {
			return errors.New("written to meanwhile")
		}
		final := filepath.Join(recDir, format)
		old := filepath.Join(recDir, "."+format+".old")
		_ = os.RemoveAll(old)
		if _, err := os.Stat(final); err == nil {
			if err := os.Rename(final, old); err != nil {
				return err
			}
		}
		if err := os.Rename(staging, final); err != nil {
			_ = os.Rename(old, final)
			return err
		}
		return os.RemoveAll(old)
	})
}

func (m *recMaint) removeStream(recDir, format string) {
	m.store.mu.Lock()
	defer m.store.mu.Unlock()
	_ = keepModTime(recDir, func() error {
		return os.RemoveAll(filepath.Join(recDir, format))
	})
}

func (m *recMaint) saveState(recDir string, st maintState) {
	b, err := json.Marshal(st)
	if err != nil {
		return
	}
	m.store.mu.Lock()
	defer m.store.mu.Unlock()
	_ = keepModTime(recDir, func() error {
		if _, err := os.Stat(recDir); err != nil {
			return err
		}
		return writeFileAtomic(filepath.Join(recDir, maintStateFile), b)
	})
}

func loadMaintState(recDir string) maintState {
	var st maintState
	if b, err := os.ReadFile(filepath.Join(recDir, maintStateFile)); err == nil {
		_ = json.Unmarshal(b, &st)
	}
	return st
}

// keepModTime runs fn and puts dir's modification time back: retention sweeps
// by it (recStore.Purge), and work on a recording must not make it younger.
func keepModTime(dir string, fn func() error) error {
	info, statErr := os.Stat(dir)
	err := fn()
	if statErr == nil {
		_ = os.Chtimes(dir, info.ModTime(), info.ModTime())
	}
	return err
}

// queueReport states the recording's current shape to the control plane unless
// it already confirmed exactly that.
func (m *recMaint) queueReport(tenantID, key string, st maintState) {
	recDir, err := m.store.recDir(tenantID, key)
	if err != nil {
		return
	}
	if _, err := os.Stat(recDir); err != nil {
		return
	}
	stored, _ := m.store.Bytes(tenantID, key)
	_, videoErr := os.Stat(filepath.Join(recDir, "video"))
	item := tunnel.RecReportItem{
		TenantID: tenantID, RecordingKey: key,
		Video: videoErr == nil, DurationMs: st.DurationMs, StoredBytes: stored,
	}
	if st.Acked != nil && *st.Acked == item {
		return
	}
	m.mu.Lock()
	m.pending[tenantID+"/"+key] = item
	m.mu.Unlock()
	select {
	case m.queued <- struct{}{}:
	default:
	}
}

// reportQueued fires when a report is waiting, so the control stream sends it
// at once: the console is waiting to switch a recording to its video. Nil (never
// fires) without a worker.
func (m *recMaint) reportQueued() <-chan struct{} {
	if m == nil {
		return nil
	}
	return m.queued
}

// reports returns what is waiting to be confirmed, at most max items.
func (m *recMaint) reports(max int) []tunnel.RecReportItem {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []tunnel.RecReportItem
	for _, it := range m.pending {
		if len(out) == max {
			break
		}
		out = append(out, it)
	}
	return out
}

// acked records the control plane's confirmation of items it was sent. The
// worker saves it with the recording's state on its next pass, so the two never
// write that state at once.
func (m *recMaint) acked(items []tunnel.RecReportItem) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, it := range items {
		id := it.TenantID + "/" + it.RecordingKey
		if cur, ok := m.pending[id]; ok && cur == it {
			delete(m.pending, id)
		}
		m.acks[id] = it
	}
}

// newestChunk is the time of the most recent chunk write in any stream.
func newestChunk(recDir string) (time.Time, bool) {
	var newest time.Time
	found := false
	streams, err := os.ReadDir(recDir)
	if err != nil {
		return newest, false
	}
	for _, s := range streams {
		if !s.IsDir() || strings.HasPrefix(s.Name(), ".") {
			continue
		}
		set, err := chunkFiles(filepath.Join(recDir, s.Name()))
		if err != nil {
			continue
		}
		for _, c := range set.all {
			if info, err := os.Stat(c.path); err == nil {
				found = true
				if info.ModTime().After(newest) {
					newest = info.ModTime()
				}
			}
		}
	}
	return newest, found
}

// streamStamp identifies a stream's content cheaply: its chunk count, last seq
// and the newest write. Compression rewrites chunks, so it reads the seqs and
// the plaintext sizes, not the files' own times.
func streamStamp(dir string) string {
	set, err := chunkFiles(dir)
	if err != nil || len(set.byPlay) == 0 {
		return ""
	}
	var total int64
	for _, c := range set.byPlay {
		total += c.plain
	}
	last := set.byPlay[len(set.byPlay)-1]
	return fmt.Sprintf("%d/%d/%d", len(set.byPlay), last.seq, total)
}

func readProtocol(guacDir string) string {
	b, err := os.ReadFile(filepath.Join(guacDir, ".protocol"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// isTerminal: SSH, telnet and kubernetes sessions are drawn by guacd's terminal,
// whose recordings are small text-like streams. A recording from before the
// protocol was noted is recognised by the terminal's own "argv" instructions.
func isTerminal(protocol string, scan guacScan) bool {
	switch protocol {
	case "ssh", "telnet", "kubernetes":
		return true
	case "":
		return scan.terminal
	}
	return false
}

// videoSize is the video's frame: the session's largest screen, no wider than
// maxVideoWidth, in even numbers (VP9's 4:2:0 needs them).
func videoSize(w, h int) (int, int) {
	if w > maxVideoWidth {
		h = h * maxVideoWidth / w
		w = maxVideoWidth
	}
	return w &^ 1, h &^ 1
}

func removeStaleTemp() {
	entries, err := os.ReadDir(os.TempDir())
	if err != nil {
		return
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), maintTempPrefix) {
			_ = os.RemoveAll(filepath.Join(os.TempDir(), e.Name()))
		}
	}
}

// guacScan is what one pass over an instruction stream tells the converter.
type guacScan struct {
	width, height       int   // the largest size the screen (layer 0) had
	firstSync, lastSync int64 // the recording's timestamps, in ms
	terminal            bool  // guacd's terminal announced its arguments
	bytes               int64
}

func (m *recMaint) scanGuac(tenantID, key string) (guacScan, error) {
	var p guacParser
	err := m.store.EachChunk(tenantID, key, "guac", 0, func(b []byte) error {
		p.scan.bytes += int64(len(b))
		return p.feed(b)
	})
	return p.scan, err
}

// guacParser reads the Guacamole protocol (LENGTH.VALUE elements separated by
// commas, an instruction ended by a semicolon; a length counts Unicode code
// points) across chunk boundaries, keeping only what guacScan needs.
type guacParser struct {
	scan      guacScan
	inValue   bool
	length    int
	remaining int
	elem      int // index of the element being read in this instruction
	opcode    []byte
	arg       []byte
	args      [3]string
}

const guacCapture = 32 // longest value kept (sizes and timestamps are short)

func (p *guacParser) feed(b []byte) error {
	for _, c := range b {
		if !p.inValue {
			switch {
			case c >= '0' && c <= '9':
				p.length = p.length*10 + int(c-'0')
				if p.length > 1<<30 {
					return errors.New("guac stream: element too long")
				}
			case c == '.':
				p.inValue = true
				p.remaining = p.length
				p.length = 0
				p.arg = p.arg[:0]
			default:
				return fmt.Errorf("guac stream: unexpected %q", c)
			}
			continue
		}
		// A byte that starts a code point either belongs to the value or, once
		// the value is complete, is the separator after it.
		if c&0xC0 != 0x80 {
			if p.remaining == 0 {
				p.endElement()
				switch c {
				case ',':
					p.elem++
				case ';':
					p.endInstruction()
				default:
					return fmt.Errorf("guac stream: unexpected %q after a value", c)
				}
				p.inValue = false
				continue
			}
			p.remaining--
		}
		if p.elem == 0 {
			if len(p.opcode) < guacCapture {
				p.opcode = append(p.opcode, c)
			}
		} else if len(p.arg) < guacCapture {
			p.arg = append(p.arg, c)
		}
	}
	return nil
}

func (p *guacParser) endElement() {
	if p.elem >= 1 && p.elem <= len(p.args) {
		p.args[p.elem-1] = string(p.arg)
	}
}

func (p *guacParser) endInstruction() {
	switch string(p.opcode) {
	case "size":
		if p.args[0] == "0" {
			w, _ := strconv.Atoi(p.args[1])
			h, _ := strconv.Atoi(p.args[2])
			if w > p.scan.width {
				p.scan.width = w
			}
			if h > p.scan.height {
				p.scan.height = h
			}
		}
	case "sync":
		if ts, err := strconv.ParseInt(p.args[0], 10, 64); err == nil {
			if p.scan.firstSync == 0 {
				p.scan.firstSync = ts
			}
			p.scan.lastSync = ts
		}
	case "argv":
		p.scan.terminal = true
	}
	p.elem = 0
	p.opcode = p.opcode[:0]
	p.args = [3]string{}
}

// mediaTools are the encoders the worker drives; execTools in the image, a fake
// in tests.
type mediaTools interface {
	// EncodeGuac turns the instruction stream read from in into a VP9 WebM at out.
	EncodeGuac(ctx context.Context, in io.Reader, width, height int, out string) error
	// Duration is a media file's length; ok is false when it states none.
	Duration(ctx context.Context, path string) (d time.Duration, ok bool, err error)
	// Remux rewrites a WebM without re-encoding it, which writes its duration
	// and seek index.
	Remux(ctx context.Context, in, out string) error
}

// vp9Options: constant quality, which spends nothing on a still screen; the
// realtime speed preset (a 12-minute session encodes in under two minutes on one
// core); tuned for screen content; two threads at most.
const vp9Options = "crf=36:qmin=0:qmax=63:deadline=realtime:cpu-used=8:row-mt=1:tune-content=screen:threads=2"

type execTools struct{ guacenc, ffmpeg, ffprobe, nice string }

// findMediaTools returns the image's encoders, or nil when they are missing (a
// development build): the store then keeps every recording as written.
func findMediaTools() mediaTools {
	t := execTools{guacenc: "/opt/guacamole/bin/guacenc"}
	if _, err := os.Stat(t.guacenc); err != nil {
		return nil
	}
	var err error
	if t.ffmpeg, err = exec.LookPath("ffmpeg"); err != nil {
		return nil
	}
	if t.ffprobe, err = exec.LookPath("ffprobe"); err != nil {
		return nil
	}
	t.nice, _ = exec.LookPath("nice")
	return t
}

// command runs name at low CPU priority: sessions come first.
func (t execTools) command(ctx context.Context, name string, args ...string) *exec.Cmd {
	if t.nice != "" {
		return exec.CommandContext(ctx, t.nice, append([]string{"-n", "15", name}, args...)...)
	}
	return exec.CommandContext(ctx, name, args...)
}

func runTool(cmd *exec.Cmd) error {
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if len(msg) > 300 {
			msg = msg[len(msg)-300:]
		}
		return fmt.Errorf("%s: %v: %s", filepath.Base(cmd.Args[len(cmd.Args)-1]), err, msg)
	}
	return nil
}

func (t execTools) EncodeGuac(ctx context.Context, in io.Reader, w, h int, out string) error {
	cmd := t.command(ctx, t.guacenc, "-f", "-s", fmt.Sprintf("%dx%d", w, h), "-r", "0",
		"-c", "libvpx-vp9", "-F", "10", "-g", "300", "-x", vp9Options, "-o", out, "/dev/stdin")
	cmd.Stdin = in
	return runTool(cmd)
}

func (t execTools) Duration(ctx context.Context, path string) (time.Duration, bool, error) {
	cmd := exec.CommandContext(ctx, t.ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path)
	out, err := cmd.Output()
	if err != nil {
		return 0, false, err
	}
	s := strings.TrimSpace(string(out))
	sec, err := strconv.ParseFloat(s, 64)
	if err != nil || sec <= 0 {
		return 0, false, nil // "N/A": a WebM cut off before its end was written
	}
	return time.Duration(sec * float64(time.Second)), true, nil
}

func (t execTools) Remux(ctx context.Context, in, out string) error {
	return runTool(t.command(ctx, t.ffmpeg, "-v", "error", "-y", "-i", in, "-c", "copy", "-f", "webm", out))
}
