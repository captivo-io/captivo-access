package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// guacInst is one Guacamole instruction, each element length-prefixed.
func guacInst(elems ...string) string {
	parts := make([]string, len(elems))
	for i, e := range elems {
		parts[i] = fmt.Sprintf("%d.%s", len([]rune(e)), e)
	}
	return strings.Join(parts, ",") + ";"
}

// guacSession is a small graphical recording: a cursor set before the screen
// has a size (as RDP does), a resize to a larger screen, and syncs spanning
// durMs.
func guacSession(durMs int64) []byte {
	var b strings.Builder
	b.WriteString(guacInst("cursor", "0", "0", "-1", "0", "0", "32", "32"))
	b.WriteString(guacInst("sync", "1000"))
	b.WriteString(guacInst("size", "0", "1280", "720"))
	b.WriteString(guacInst("size", "1", "64", "64")) // not the screen
	b.WriteString(guacInst("name", "Ünïcødé ✓ name"))
	b.WriteString(guacInst("size", "0", "1801", "947"))
	for t := int64(2000); t <= 1000+durMs; t += 1000 {
		b.WriteString(guacInst("rect", "0", "0", "0", "64", "48"))
		b.WriteString(guacInst("sync", fmt.Sprint(t)))
	}
	return []byte(b.String())
}

// fakeTools stands in for guacenc/ffprobe/ffmpeg.
type fakeTools struct {
	encoded    []byte // what EncodeGuac read
	size       [2]int
	videoBytes int
	duration   time.Duration
	noDuration map[string]bool // paths (by base name) that report none
	encodeErr  error
	onEncode   func()
	remuxed    int
}

func (f *fakeTools) EncodeRdp(_ context.Context, in io.Reader, out string) (time.Duration, error) {
	b, err := io.ReadAll(in)
	if err != nil {
		return 0, err
	}
	f.encoded = b
	if f.encodeErr != nil {
		return 0, f.encodeErr
	}
	// The encoder holds the last picture a second; the recording spans the rest.
	if err := os.WriteFile(out, bytes.Repeat([]byte("V"), f.videoBytes), 0o600); err != nil {
		return 0, err
	}
	return f.duration - time.Second, nil
}

func (f *fakeTools) EncodeGuac(_ context.Context, in io.Reader, w, h int, out string) error {
	b, err := io.ReadAll(in)
	if err != nil {
		return err
	}
	f.encoded, f.size = b, [2]int{w, h}
	if f.onEncode != nil {
		f.onEncode()
	}
	if f.encodeErr != nil {
		return f.encodeErr
	}
	return os.WriteFile(out, bytes.Repeat([]byte("V"), f.videoBytes), 0o600)
}

func (f *fakeTools) Duration(_ context.Context, path string) (time.Duration, bool, error) {
	if f.noDuration[filepath.Base(path)] {
		return 0, false, nil
	}
	return f.duration, true, nil
}

func (f *fakeTools) Remux(_ context.Context, in, out string) error {
	f.remuxed++
	b, err := os.ReadFile(in)
	if err != nil {
		return err
	}
	return os.WriteFile(out, append([]byte("REMUXED:"), b...), 0o600)
}

type maintFixture struct {
	t     *testing.T
	store *recStore
	m     *recMaint
	tools *fakeTools
	clock time.Time
}

func newMaintFixture(t *testing.T) *maintFixture {
	f := &maintFixture{t: t, store: newRecStore(t.TempDir(), testKey()), clock: time.Now().Add(time.Hour)}
	f.tools = &fakeTools{videoBytes: 1000, duration: 30 * time.Second, noDuration: map[string]bool{}}
	f.m = newRecMaint(f.store, f.tools)
	f.m.now = func() time.Time { return f.clock }
	return f
}

// write stores data as one stream in chunks of 100 bytes, like the data plane.
func (f *maintFixture) write(key, format, protocol string, data []byte) {
	f.t.Helper()
	for seq := 0; len(data) > 0; seq++ {
		n := min(100, len(data))
		if _, err := f.store.Append("t1", key, format, seq, data[:n]); err != nil {
			f.t.Fatal(err)
		}
		if protocol != "" {
			f.store.NoteProtocol("t1", key, format, protocol)
		}
		data = data[n:]
	}
}

func (f *maintFixture) stream(key, format string) []byte {
	f.t.Helper()
	var out []byte
	if err := f.store.EachChunk("t1", key, format, 0, func(b []byte) error {
		out = append(out, b...)
		return nil
	}); err != nil {
		f.t.Fatal(err)
	}
	return out
}

func (f *maintFixture) has(key, format string) bool {
	for _, s := range f.store.Formats("t1", key) {
		if s == format {
			return true
		}
	}
	return false
}

func (f *maintFixture) state(key string) maintState {
	d, _ := f.store.recDir("t1", key)
	return loadMaintState(d)
}

// ack confirms whatever is pending, as the control plane would.
func (f *maintFixture) ack() {
	f.m.acked(f.m.reports(100))
}

func TestMaintConvertsAGraphicalSessionToVideo(t *testing.T) {
	f := newMaintFixture(t)
	rec := guacSession(30_000)
	f.write("r1", "guac", "rdp", rec)
	f.write("r1", "keys", "", []byte(`[{"atMs":5,"text":"dir"}]`))

	f.m.cycle(context.Background())

	if !bytes.Equal(f.tools.encoded, rec) {
		t.Fatal("the encoder was not given the whole instruction stream")
	}
	if f.tools.size != [2]int{1800, 946} {
		t.Fatalf("video size %v, want the largest screen in even numbers (1800x946)", f.tools.size)
	}
	if got := f.stream("r1", "video"); len(got) != 1000 {
		t.Fatalf("video stream is %d bytes, want 1000", len(got))
	}
	st := f.state("r1")
	if st.Video != "converted" || st.DurationMs != 30_000 {
		t.Fatalf("state %+v", st)
	}
	items := f.m.reports(10)
	if len(items) != 1 || !items[0].Video || items[0].DurationMs != 30_000 || items[0].StoredBytes == 0 {
		t.Fatalf("report %+v", items)
	}
	// The instruction stream stays until the control plane knows, and a grace
	// period after.
	if !f.has("r1", "guac") {
		t.Fatal("instruction stream removed before the video was confirmed")
	}
	f.ack()
	f.m.cycle(context.Background())
	if !f.has("r1", "guac") {
		t.Fatal("instruction stream removed inside the grace period")
	}
	f.clock = f.clock.Add(maintGrace)
	f.m.cycle(context.Background())
	if f.has("r1", "guac") {
		t.Fatal("instruction stream still there after the grace period")
	}
	if !f.has("r1", "keys") || !f.has("r1", "video") {
		t.Fatal("keystrokes or video lost with the instruction stream")
	}
	// What the disk now holds is reported, once.
	items = f.m.reports(10)
	if len(items) != 1 || !items[0].Video {
		t.Fatalf("report after removal %+v", items)
	}
	f.ack()
	f.m.cycle(context.Background())
	if items := f.m.reports(10); len(items) != 0 {
		t.Fatalf("reported again with nothing changed: %+v", items)
	}
}

func TestMaintLeavesARecordingThatIsStillBeingWritten(t *testing.T) {
	f := newMaintFixture(t)
	f.write("r1", "guac", "rdp", guacSession(30_000))
	f.clock = time.Now() // the chunks were just written

	f.m.cycle(context.Background())

	if f.tools.encoded != nil || f.has("r1", "video") {
		t.Fatal("converted a recording that may still be growing")
	}
	if len(f.m.reports(10)) != 0 {
		t.Fatal("reported a recording that may still be growing")
	}
}

func TestMaintKeepsTerminalSessionsAndCompressesThem(t *testing.T) {
	f := newMaintFixture(t)
	rec := guacSession(30_000)
	f.write("ssh", "guac", "ssh", rec)
	// From before protocols were noted: the terminal's argv gives it away.
	old := append([]byte(guacInst("argv", "0", "text/plain", "font-size")), rec...)
	f.write("old", "guac", "", old)
	// Raw chunks, as stores held them before compression.
	for _, k := range []string{"ssh", "old"} {
		d, _ := f.store.dir("t1", k, "guac")
		set, _ := chunkFiles(d)
		for _, c := range set.byPlay {
			plain, _ := f.store.openChunk(c)
			os.Remove(c.path)
			sealed, _ := f.store.seal(plain)
			os.WriteFile(filepath.Join(d, fmt.Sprintf("%d.bin", c.seq)), sealed, 0o600)
		}
	}

	f.m.cycle(context.Background())

	if f.tools.encoded != nil {
		t.Fatal("encoded a terminal session")
	}
	for k, want := range map[string][]byte{"ssh": rec, "old": old} {
		if f.has(k, "video") || f.state(k).Video != "terminal" {
			t.Fatalf("%s: state %+v", k, f.state(k))
		}
		if !bytes.Equal(f.stream(k, "guac"), want) {
			t.Fatalf("%s: stream changed by compression", k)
		}
		d, _ := f.store.dir("t1", k, "guac")
		set, _ := chunkFiles(d)
		compressed := 0
		for _, c := range set.all {
			if c.compressed {
				compressed++
			}
		}
		// A chunk that does not shrink stays raw; the rest are compressed.
		if compressed < len(set.all)/2 {
			t.Fatalf("%s: %d of %d chunks compressed", k, compressed, len(set.all))
		}
		if !f.state(k).Compressed {
			t.Fatalf("%s: compression pass not recorded", k)
		}
	}
}

func TestMaintKeepsTheStreamWhenTheVideoIsTheWrongLength(t *testing.T) {
	f := newMaintFixture(t)
	f.write("r1", "guac", "rdp", guacSession(30_000))
	f.tools.duration = 12 * time.Second // the encoder stopped early

	f.m.cycle(context.Background())

	st := f.state("r1")
	if st.Video != "failed" || st.Tries != 1 || f.has("r1", "video") || !f.has("r1", "guac") {
		t.Fatalf("state %+v", st)
	}
	// Not retried at once, then retried, then given up on.
	f.tools.encoded = nil
	f.m.cycle(context.Background())
	if f.tools.encoded != nil {
		t.Fatal("retried before the retry wait")
	}
	for i := 0; i < 5; i++ {
		f.clock = f.clock.Add(maintRetryWait)
		f.m.cycle(context.Background())
	}
	if st := f.state("r1"); st.Tries != maintMaxTries {
		t.Fatalf("tries %d, want %d", st.Tries, maintMaxTries)
	}
	if !f.has("r1", "guac") {
		t.Fatal("instruction stream lost after failed conversions")
	}
}

func TestMaintKeepsTheStreamWhenTheEncoderFails(t *testing.T) {
	f := newMaintFixture(t)
	f.write("r1", "guac", "vnc", guacSession(30_000))
	f.tools.encodeErr = errors.New("boom")

	f.m.cycle(context.Background())

	if st := f.state("r1"); st.Video != "failed" || f.has("r1", "video") {
		t.Fatalf("state %+v", st)
	}
	if items := f.m.reports(10); len(items) != 1 || items[0].Video {
		t.Fatalf("report %+v", items)
	}
}

func TestMaintNeverTradesForALargerVideo(t *testing.T) {
	f := newMaintFixture(t)
	rec := guacSession(30_000)
	f.write("r1", "guac", "rdp", rec)
	f.tools.videoBytes = len(rec) + 1

	f.m.cycle(context.Background())

	if st := f.state("r1"); st.Video != "kept" || f.has("r1", "video") {
		t.Fatalf("state %+v", st)
	}
}

func TestMaintConvertsAgainWhenTheStreamGrewAfterward(t *testing.T) {
	f := newMaintFixture(t)
	rec := guacSession(30_000)
	f.write("r1", "guac", "rdp", rec)
	f.m.cycle(context.Background())
	f.ack()

	// A late chunk: the video is short of the end.
	if _, err := f.store.Append("t1", "r1", "guac", 1000, []byte(guacInst("sync", "40000"))); err != nil {
		t.Fatal(err)
	}
	f.clock = f.clock.Add(maintGrace + maintSettle)
	f.tools.encoded = nil
	f.tools.duration = 39 * time.Second
	f.m.cycle(context.Background())

	if !f.has("r1", "guac") {
		t.Fatal("removed an instruction stream its video does not cover")
	}
	if !bytes.HasSuffix(f.tools.encoded, []byte(guacInst("sync", "40000"))) {
		t.Fatal("not converted again with the late chunk")
	}
	if st := f.state("r1"); st.Video != "converted" || st.DurationMs != 39_000 {
		t.Fatalf("state %+v", st)
	}
}

func TestMaintDoesNotWriteBackAnErasedRecording(t *testing.T) {
	f := newMaintFixture(t)
	f.write("r1", "guac", "rdp", guacSession(30_000))
	f.tools.onEncode = func() {
		if err := f.store.Delete("t1", "r1"); err != nil {
			t.Fatal(err)
		}
	}

	f.m.cycle(context.Background())

	d, _ := f.store.recDir("t1", "r1")
	if _, err := os.Stat(d); !os.IsNotExist(err) {
		t.Fatalf("erased recording written back (stat err %v)", err)
	}
	if items := f.m.reports(10); len(items) != 0 {
		t.Fatalf("reported an erased recording: %+v", items)
	}
}

func TestMaintLeavesTheRecordingsAgeAlone(t *testing.T) {
	f := newMaintFixture(t)
	f.write("r1", "guac", "rdp", guacSession(30_000))
	d, _ := f.store.recDir("t1", "r1")
	old := time.Now().Add(-40 * 24 * time.Hour)
	if err := os.Chtimes(d, old, old); err != nil {
		t.Fatal(err)
	}

	f.m.cycle(context.Background())
	f.ack()
	f.clock = f.clock.Add(maintGrace)
	f.m.cycle(context.Background())

	if f.has("r1", "guac") {
		t.Fatal("setup: expected the instruction stream gone")
	}
	info, err := os.Stat(d)
	if err != nil || !info.ModTime().Equal(old) {
		t.Fatalf("recording directory time %v, want %v", info.ModTime(), old)
	}
	// Retention still sees a 40-day-old recording.
	if n, _ := f.store.Purge("t1", time.Now().Add(-30*24*time.Hour)); n != 1 {
		t.Fatalf("retention removed %d recordings, want 1", n)
	}
}

func TestMaintRepairsACutOffIsolatedVideo(t *testing.T) {
	f := newMaintFixture(t)
	f.write("cut", "video", "", []byte("webm-without-cues"))
	f.write("ok", "video", "", []byte("webm-finished"))
	f.tools.noDuration["in.webm"] = true // every input reads as cut off ...
	f.tools.duration = 95 * time.Second

	f.m.cycle(context.Background())

	// ... so both were rewritten; the remuxed one now has a duration.
	if got := f.stream("cut", "video"); string(got) != "REMUXED:webm-without-cues" {
		t.Fatalf("video %q", got)
	}
	if st := f.state("cut"); !st.VideoChecked || st.DurationMs != 95_000 {
		t.Fatalf("state %+v", st)
	}
	// Checked once, not on every pass.
	n := f.tools.remuxed
	f.m.cycle(context.Background())
	if f.tools.remuxed != n {
		t.Fatal("checked the same video again")
	}
	// Video chunks are not compressed: Range reads need their sizes.
	d, _ := f.store.dir("t1", "cut", "video")
	set, _ := chunkFiles(d)
	for _, c := range set.all {
		if c.compressed {
			t.Fatal("video chunk compressed")
		}
	}
}

func TestMaintChecksAFinishedIsolatedVideoWithoutRewritingIt(t *testing.T) {
	f := newMaintFixture(t)
	f.write("ok", "video", "", []byte("webm-finished"))
	f.tools.duration = 7 * time.Second

	f.m.cycle(context.Background())

	if f.tools.remuxed != 0 || string(f.stream("ok", "video")) != "webm-finished" {
		t.Fatal("rewrote a video that had its duration")
	}
	items := f.m.reports(10)
	if len(items) != 1 || !items[0].Video || items[0].DurationMs != 7000 {
		t.Fatalf("report %+v", items)
	}
}

func TestMaintWithoutEncoderOnlyCompresses(t *testing.T) {
	f := newMaintFixture(t)
	f.m.tools = nil
	rec := guacSession(30_000)
	f.write("r1", "guac", "rdp", rec)

	f.m.cycle(context.Background())

	if f.has("r1", "video") || !bytes.Equal(f.stream("r1", "guac"), rec) {
		t.Fatal("without an encoder the recording must stay as written")
	}
}

func TestMaintAckOnlyConfirmsWhatWasSent(t *testing.T) {
	f := newMaintFixture(t)
	f.write("r1", "keys", "", bytes.Repeat([]byte(`{"atMs":1,"text":"x"}`), 50))
	f.m.cycle(context.Background())
	sent := f.m.reports(10)
	if len(sent) != 1 {
		t.Fatalf("reports %+v", sent)
	}
	// The recording changes before the ack for the old state arrives.
	stale := sent[0]
	stale.StoredBytes--
	f.m.acked([]tunnel.RecReportItem{stale})
	f.m.cycle(context.Background())
	if len(f.m.reports(10)) != 1 {
		t.Fatal("a stale ack silenced the current report")
	}
}

func TestGuacParserAcrossChunkBoundaries(t *testing.T) {
	rec := guacSession(12_000)
	for _, step := range []int{1, 2, 3, 7, 64, len(rec)} {
		var p guacParser
		for i := 0; i < len(rec); i += step {
			if err := p.feed(rec[i:min(i+step, len(rec))]); err != nil {
				t.Fatalf("step %d: %v", step, err)
			}
		}
		s := p.scan
		if s.width != 1801 || s.height != 947 || s.firstSync != 1000 || s.lastSync != 13000 || s.terminal {
			t.Fatalf("step %d: scan %+v", step, s)
		}
	}
	var p guacParser
	if err := p.feed([]byte("4.size,x")); err == nil {
		t.Fatal("garbage accepted")
	}
}

func TestVideoSizeCapsWidthAndKeepsEvenNumbers(t *testing.T) {
	for _, c := range []struct{ w, h, ww, wh int }{
		{1801, 947, 1800, 946},
		{3840, 2160, 2560, 1440},
		{5120, 1440, 2560, 720},
	} {
		if w, h := videoSize(c.w, c.h); w != c.ww || h != c.wh {
			t.Fatalf("videoSize(%d,%d) = %d,%d, want %d,%d", c.w, c.h, w, h, c.ww, c.wh)
		}
	}
}

func TestMaintRepacksAKeptStreamInLargeChunks(t *testing.T) {
	f := newMaintFixture(t)
	rec := bytes.Repeat(guacSession(30_000), 40) // ~60 KB in 100-byte chunks
	f.write("ssh", "guac", "ssh", rec)
	web := bytes.Repeat([]byte(`[{"type":3,"data":{"source":0}}]`+"\n"), 2000)
	f.write("web", "rrweb", "", web)
	keys := []byte(`[{"atMs":1,"text":"ls"}]`)
	f.write("web", "keys", "", keys)
	f.write("web", "keys", "", keys) // seq 0 again: one chunk
	if _, err := f.store.Append("t1", "web", "keys", 1, []byte(`[{"atMs":2,"text":"pwd"}]`)); err != nil {
		t.Fatal(err)
	}

	f.m.cycle(context.Background())

	for k, fm := range map[string]string{"ssh": "guac", "web": "rrweb"} {
		d, _ := f.store.dir("t1", k, fm)
		set, _ := chunkFiles(d)
		if len(set.all) != 1 || !set.all[0].compressed {
			t.Fatalf("%s/%s: %d chunk files after repacking", k, fm, len(set.all))
		}
	}
	if !bytes.Equal(f.stream("ssh", "guac"), rec) || !bytes.Equal(f.stream("web", "rrweb"), web) {
		t.Fatal("repacking changed the bytes")
	}
	// Keystrokes are searched chunk by chunk: they keep their chunks.
	d, _ := f.store.dir("t1", "web", "keys")
	if set, _ := chunkFiles(d); len(set.byPlay) != 2 {
		t.Fatalf("keystroke stream has %d chunks, want its own 2", len(set.byPlay))
	}
	res := searchStore(f.store, tunnel.RecSearchRequest{TenantID: "t1", Query: "pwd", RecordingKeys: []string{"web"}})
	if len(res.Matches) != 1 {
		t.Fatalf("search after maintenance: %+v", res)
	}
}

func TestMaintDropsARepackWhenTheStreamChanges(t *testing.T) {
	f := newMaintFixture(t)
	rec := bytes.Repeat([]byte("4.sync,4.1000;"), 300)
	f.write("ssh", "guac", "ssh", rec)
	recDir, _ := f.store.recDir("t1", "ssh")
	dir := filepath.Join(recDir, "guac")
	before := streamStamp(dir)
	src := filepath.Join(t.TempDir(), "x")
	os.WriteFile(src, []byte("replacement"), 0o600)
	// A chunk lands between reading the stream and swapping it in.
	if _, err := f.store.Append("t1", "ssh", "guac", 999, []byte("late;")); err != nil {
		t.Fatal(err)
	}
	err := f.m.installStream(recDir, "guac", src, repackChunkBytes, func() bool { return streamStamp(dir) == before })
	if err == nil {
		t.Fatal("swapped in a stream that missed a late chunk")
	}
	if got := f.stream("ssh", "guac"); !bytes.HasSuffix(got, []byte("late;")) || !bytes.HasPrefix(got, rec) {
		t.Fatal("the stream was touched")
	}
}

func TestMaintStartsAtOnceOnARecordingTheDataPlaneSaysIsComplete(t *testing.T) {
	f := newMaintFixture(t)
	f.write("r1", "guac", "rdp", guacSession(30_000))
	f.write("r2", "guac", "rdp", guacSession(30_000))
	f.clock = time.Now() // both just written: the quiet period has not passed

	f.m.markDone("t1", "r1")
	select {
	case <-f.m.wake:
	default:
		t.Fatal("markDone did not wake the worker")
	}
	f.m.processDone(context.Background())

	if st := f.state("r1"); st.Video != "converted" {
		t.Fatalf("complete recording not converted at once: %+v", st)
	}
	if f.has("r2", "video") {
		t.Fatal("converted a recording that may still be growing")
	}
	select {
	case <-f.m.reportQueued():
	default:
		t.Fatal("the report was not signalled for sending at once")
	}
	f.m.mu.Lock()
	left := len(f.m.done)
	f.m.mu.Unlock()
	if left != 0 {
		t.Fatalf("%d recordings still marked complete after processing", left)
	}
	f.m.markDone("../x", "r1") // untrusted ids are refused
	if len(f.m.done) != 0 {
		t.Fatal("accepted a traversing tenant id")
	}
}

func TestMaintConvertsARecordedNativeRdpSession(t *testing.T) {
	f := newMaintFixture(t)
	dump := bytes.Repeat([]byte("PDU"), 400)
	f.write("r1", "rdp", "rdp", dump)
	f.write("r1", "keys", "", []byte(`[{"atMs":5,"kind":"text","text":"dir"}]`))

	f.m.cycle(context.Background())

	if !bytes.Equal(f.tools.encoded, dump) {
		t.Fatal("the encoder was not given the whole stream")
	}
	st := f.state("r1")
	if st.Video != "converted" || len(f.stream("r1", "video")) != 1000 {
		t.Fatalf("state %+v", st)
	}
	if items := f.m.reports(10); len(items) != 1 || !items[0].Video {
		t.Fatalf("report %+v", items)
	}
	f.ack()
	f.clock = f.clock.Add(maintGrace)
	f.m.cycle(context.Background())
	if f.has("r1", "rdp") || !f.has("r1", "video") || !f.has("r1", "keys") {
		t.Fatal("after the grace period only the video and the keystrokes should be left")
	}
}

func TestMaintRdpSessionThatShowedNothing(t *testing.T) {
	f := newMaintFixture(t)
	f.tools.encodeErr = errNothingDrawn
	f.write("r1", "rdp", "rdp", []byte("PDU"))
	f.m.cycle(context.Background())
	if st := f.state("r1"); st.Video != "kept" || f.has("r1", "video") {
		t.Fatalf("state %+v", st)
	}
	if items := f.m.reports(10); len(items) != 1 || items[0].Video {
		t.Fatalf("report %+v", items)
	}
}
