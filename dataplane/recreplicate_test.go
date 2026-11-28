package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// fakeReplicaStore is one connector's recordings: stream -> chunks.
type fakeReplicaStore struct {
	streams  map[string][][]byte
	protocol string
	complete bool
	released bool
	held     bool
}

func (s *fakeReplicaStore) total(f string) int64 {
	var n int64
	for _, c := range s.streams[f] {
		n += int64(len(c))
	}
	return n
}

type fakeReplicaPeers struct {
	conns   map[string]map[string]*fakeReplicaStore // connector -> recordingKey -> store
	old     map[string]bool
	down    map[string]bool
	statErr map[string]bool // Stat fails though the tunnel is up
	writes  int
	failAt  int // fail the Nth write (1-based), 0: never
	fetches []tunnel.RecFetchRequest
}

func newReplicaPeers() *fakeReplicaPeers {
	return &fakeReplicaPeers{conns: map[string]map[string]*fakeReplicaStore{}, old: map[string]bool{}, down: map[string]bool{}, statErr: map[string]bool{}}
}

func (p *fakeReplicaPeers) store(conn, key string) *fakeReplicaStore {
	if p.conns[conn] == nil {
		p.conns[conn] = map[string]*fakeReplicaStore{}
	}
	if p.conns[conn][key] == nil {
		p.conns[conn][key] = &fakeReplicaStore{streams: map[string][][]byte{}}
	}
	return p.conns[conn][key]
}

func (p *fakeReplicaPeers) Connected() []string {
	var out []string
	for id := range p.conns {
		if !p.down[id] {
			out = append(out, id)
		}
	}
	return out
}
func (p *fakeReplicaPeers) AtLeast(id, _ string) bool { return !p.old[id] && !p.down[id] }
func (p *fakeReplicaPeers) Stat(id string, req tunnel.RecStatRequest) (tunnel.RecStatResponse, error) {
	if p.down[id] || p.statErr[id] {
		return tunnel.RecStatResponse{}, errors.New("offline")
	}
	s := p.store(id, req.RecordingKey)
	out := tunnel.RecStatResponse{Streams: []tunnel.RecStatStream{}, Protocol: s.protocol, Complete: s.complete}
	for f, chunks := range s.streams {
		out.Streams = append(out.Streams, tunnel.RecStatStream{Format: f, Bytes: s.total(f), NextSeq: len(chunks)})
	}
	return out, nil
}
func (p *fakeReplicaPeers) Fetch(id string, req tunnel.RecFetchRequest, w io.Writer) error {
	p.fetches = append(p.fetches, req)
	s := p.store(id, req.RecordingKey)
	var all []byte
	for _, c := range s.streams[req.Format] {
		all = append(all, c...)
	}
	to := req.ToByte
	if to <= 0 || to >= int64(len(all)) {
		to = int64(len(all)) - 1
	}
	_, err := w.Write(all[req.FromByte : to+1])
	return err
}
func (p *fakeReplicaPeers) Write(id string, req tunnel.RecWriteRequest) (int, error) {
	p.writes++
	if p.failAt > 0 && p.writes == p.failAt {
		return 0, errors.New("write failed")
	}
	s := p.store(id, req.RecordingKey)
	if req.Seq != len(s.streams[req.Format]) {
		return 0, errors.New("gap in sequence")
	}
	s.streams[req.Format] = append(s.streams[req.Format], append([]byte(nil), req.Data...))
	if req.Hold {
		s.held = true
	}
	if req.Protocol != "" {
		s.protocol = req.Protocol
	}
	return len(req.Data), nil
}
func (p *fakeReplicaPeers) Done(id, _, key string) {
	s := p.store(id, key)
	s.held = false
	s.released = true
	s.complete = true
}

type fakeReplicaControl struct {
	work    map[string][]replicaWork
	reports map[string][]replicaReport
}

func (c *fakeReplicaControl) ReplicaWork(id string) ([]replicaWork, error) { return c.work[id], nil }
func (c *fakeReplicaControl) ReportReplicas(id string, items []replicaReport) error {
	if c.reports == nil {
		c.reports = map[string][]replicaReport{}
	}
	c.reports[id] = append(c.reports[id], items...)
	return nil
}

func chunked(s string, n int) [][]byte {
	var out [][]byte
	for len(s) > 0 {
		k := min(n, len(s))
		out = append(out, []byte(s[:k]))
		s = s[k:]
	}
	return out
}

func setup() (*fakeReplicaPeers, *fakeReplicaControl, *replicator) {
	p := newReplicaPeers()
	p.store("A", "r1")
	p.store("B", "r1")
	c := &fakeReplicaControl{work: map[string][]replicaWork{"B": {{TenantID: "t1", RecordingKey: "r1", OriginConnectorID: "A"}}}}
	return p, c, newReplicator(c, p)
}

func join(chunks [][]byte) string { return string(bytes.Join(chunks, nil)) }

func TestCopiesAWholeRecordingAndLetsTheTargetGoOnWithIt(t *testing.T) {
	p, c, r := setup()
	a := p.store("A", "r1")
	a.protocol = "ssh"
	a.complete = true
	a.streams["guac"] = chunked(strings.Repeat("0123456789", 5000), 9000) // 50 000 bytes, uneven chunks
	a.streams["keys"] = chunked(`[{"atMs":1}]`, 100)
	r.serve(context.Background(), "B")
	b := p.store("B", "r1")
	if join(b.streams["guac"]) != join(a.streams["guac"]) || join(b.streams["keys"]) != join(a.streams["keys"]) {
		t.Fatal("the copy differs from the original")
	}
	if b.protocol != "ssh" {
		t.Fatalf("protocol %q was not carried over: the copy's own upkeep needs it", b.protocol)
	}
	got := c.reports["B"]
	if len(got) != 1 || got[0].State != "COMPLETE" || got[0].Bytes != 50000+int64(len(`[{"atMs":1}]`)) || got[0].Error != "" {
		t.Fatalf("report %+v", got)
	}
	if !b.released || b.held {
		t.Fatal("a complete copy must be released to its connector's upkeep")
	}
}

func TestAGrowingRecordingIsCopiedInStepsAndStaysHeldUntilTheSessionEnds(t *testing.T) {
	p, c, r := setup()
	a := p.store("A", "r1")
	a.streams["guac"] = chunked("aaaaaaaaaa", 4)
	r.serve(context.Background(), "B")
	b := p.store("B", "r1")
	if join(b.streams["guac"]) != "aaaaaaaaaa" || !b.held {
		t.Fatalf("first pass: %q held=%v", join(b.streams["guac"]), b.held)
	}
	if rep := c.reports["B"][0]; rep.State != "COPYING" || rep.Bytes != 10 {
		t.Fatalf("report %+v", rep)
	}
	// The session goes on; the copy picks up exactly where it is.
	a.streams["guac"] = append(a.streams["guac"], []byte("bbbbbb"), []byte("cc"))
	r.serve(context.Background(), "B")
	if join(b.streams["guac"]) != "aaaaaaaaaabbbbbbcc" {
		t.Fatalf("second pass: %q", join(b.streams["guac"]))
	}
	if last := p.fetches[len(p.fetches)-1]; last.FromByte != 10 {
		t.Fatalf("second pass asked from byte %d, want 10 (what the copy already had)", last.FromByte)
	}
	if b.released {
		t.Fatal("released while the session was still going")
	}
	a.complete = true
	r.serve(context.Background(), "B")
	if !b.released || c.reports["B"][len(c.reports["B"])-1].State != "COMPLETE" {
		t.Fatal("not completed after the session ended")
	}
}

func TestACopyThatFailedPartWayResumesFromWhatIsThere(t *testing.T) {
	p, c, r := setup()
	a := p.store("A", "r1")
	a.complete = true
	a.streams["guac"] = chunked(strings.Repeat("x", replicaChunk*3+100), 50000)
	p.failAt = 2 // the second append fails
	r.serve(context.Background(), "B")
	b := p.store("B", "r1")
	if b.total("guac") != int64(replicaChunk) {
		t.Fatalf("after the failure the copy holds %d bytes, want one chunk", b.total("guac"))
	}
	if rep := c.reports["B"][0]; rep.State != "COPYING" || rep.Error != "copy_failed" {
		t.Fatalf("report %+v", rep)
	}
	p.failAt = 0
	r.serve(context.Background(), "B")
	if join(b.streams["guac"]) != join(a.streams["guac"]) {
		t.Fatal("did not resume into a whole copy")
	}
	if rep := c.reports["B"][len(c.reports["B"])-1]; rep.State != "COMPLETE" || rep.Error != "" {
		t.Fatalf("report %+v", rep)
	}
}

func TestAGraphicalSessionIsCopiedAsVideoOnlyAndWaitsForIt(t *testing.T) {
	p, c, r := setup()
	a := p.store("A", "r1")
	a.protocol = "rdp"
	a.complete = true
	a.streams["guac"] = chunked(strings.Repeat("raw", 100000), 65536)
	a.streams["keys"] = chunked(`[]`, 10)
	r.serve(context.Background(), "B")
	b := p.store("B", "r1")
	if len(b.streams["guac"]) != 0 {
		t.Fatal("the raw screen stream must not be copied")
	}
	if rep := c.reports["B"][0]; rep.State != "COPYING" || rep.Error != "waiting_for_video" {
		t.Fatalf("report %+v", rep)
	}
	a.streams["video"] = chunked("WEBMWEBMWEBM", 5)
	r.serve(context.Background(), "B")
	if join(b.streams["video"]) != "WEBMWEBMWEBM" || join(b.streams["keys"]) != "[]" || len(b.streams["guac"]) != 0 {
		t.Fatal("video and keystrokes were not copied")
	}
	if rep := c.reports["B"][len(c.reports["B"])-1]; rep.State != "COMPLETE" {
		t.Fatalf("report %+v", rep)
	}
}

func TestVideoThatShrankAtTheSourceIsReportedNotPatched(t *testing.T) {
	p, c, r := setup()
	a := p.store("A", "r1")
	a.protocol = "rdp"
	a.complete = true
	a.streams["video"] = chunked("0123456789", 100)
	r.serve(context.Background(), "B")
	a.streams["video"] = chunked("abc", 100) // made again, shorter
	r.serve(context.Background(), "B")
	if rep := c.reports["B"][len(c.reports["B"])-1]; rep.Error != "diverged" || rep.State == "COMPLETE" {
		t.Fatalf("report %+v", rep)
	}
}

func TestOfflineAndOldConnectorsAreLeftAlone(t *testing.T) {
	p, c, r := setup()
	a := p.store("A", "r1")
	a.streams["guac"] = chunked("data", 10)
	p.down["A"] = true
	r.serve(context.Background(), "B")
	if len(c.reports["B"]) != 0 {
		t.Fatalf("a source that is not connected is not a failure to report: %+v", c.reports["B"])
	}
	p.down["A"] = false
	p.old["A"] = true
	r.serve(context.Background(), "B")
	if len(c.reports["B"]) != 0 || p.writes != 0 {
		t.Fatal("an origin too old to answer recstat was used")
	}
	p.old["A"] = false
	r.pass(context.Background())
	if join(p.store("B", "r1").streams["guac"]) != "data" {
		t.Fatal("pass did not serve the target")
	}
	p.old["B"] = true
	n := p.writes
	r.pass(context.Background())
	if p.writes != n {
		t.Fatal("a target too old to honour a hold was written to")
	}
}

func TestAnUnreadableSourceOrTargetIsReportedWithAShortCode(t *testing.T) {
	p, c, r := setup()
	p.store("A", "r1").streams["guac"] = chunked("data", 10)
	p.statErr["A"] = true
	r.serve(context.Background(), "B")
	if rep := c.reports["B"][0]; rep.Error != "origin_unreachable" || rep.State == "COMPLETE" {
		t.Fatalf("report %+v", rep)
	}
	p.statErr = map[string]bool{"B": true}
	r.serve(context.Background(), "B")
	if rep := c.reports["B"][1]; rep.Error != "target_unreachable" {
		t.Fatalf("report %+v", rep)
	}
	p.statErr = map[string]bool{}
	p.store("A", "r1").streams = map[string][][]byte{}
	r.serve(context.Background(), "B")
	if rep := c.reports["B"][2]; rep.Error != "origin_empty" {
		t.Fatalf("report %+v", rep)
	}
}

func TestChunkSinkSplitsAtTheChunkSizeAndKeepsOrder(t *testing.T) {
	var got [][]byte
	s := &chunkSink{max: 4, flush: func(seq int, d []byte) error {
		if seq != len(got) {
			t.Fatalf("seq %d, want %d", seq, len(got))
		}
		got = append(got, append([]byte(nil), d...))
		return nil
	}}
	_, _ = s.Write([]byte("abc"))
	_, _ = s.Write([]byte("defghij"))
	_ = s.close()
	if join(got) != "abcdefghij" || len(got) != 3 || s.written != 10 {
		t.Fatalf("%q written=%d", got, s.written)
	}
	if err := s.close(); err != nil {
		t.Fatal(err)
	}
}

func TestPassBudgetStopsAfterTheDeadline(t *testing.T) {
	p, c, r := setup()
	c.work["B"] = []replicaWork{{TenantID: "t1", RecordingKey: "r1", OriginConnectorID: "A"}, {TenantID: "t1", RecordingKey: "r2", OriginConnectorID: "A"}}
	p.store("A", "r1").streams["guac"] = chunked("one", 10)
	p.store("A", "r2").streams["guac"] = chunked("two", 10)
	clock := time.Now()
	r.now = func() time.Time { clock = clock.Add(replicaPassBudget); return clock }
	r.serve(context.Background(), "B")
	if len(c.reports["B"]) > 1 {
		t.Fatalf("worked past the budget: %+v", c.reports["B"])
	}
}
