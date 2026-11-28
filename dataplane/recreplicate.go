package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"sync"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// Copying recordings between the connectors of a group.
//
// When a connector group has replication on, a recording made on one member is
// also kept on the others, so that one member going down does not take its
// recordings out of reach. The bytes still live only on connectors, each sealed
// with its own key; this worker moves them through the data plane the same way
// replay does (recfetch) and recording does (recwrite) -- in transit, in memory,
// never stored here.
//
// One mechanism does it all, a byte-position copy: for each stream the target
// asks "how much of this do you hold" (recstat), the source is asked for the
// rest (recfetch, a range), and the target appends it (recwrite). The same
// pass runs while the session is still going (the copy trails it by a few
// seconds), after the connector it was on went away and came back, and after
// the target was offline for a day. A recording is the concatenation of its
// chunks wherever it is read, so the copy's own chunk sizes do not matter.
//
// What is copied: everything, except that a graphical session (RDP, VNC) is
// copied as its video and keystroke timeline once its connector has made the
// video. The raw instruction stream is hundreds of times larger and is deleted
// by its own connector soon after.
const (
	// replicaSince is the first connector release that answers recstat and
	// honours a hold. Older members are left out, whichever side they are on.
	replicaSince = "2.84.0"
	// replicaInterval is how often each connector is asked what it still owes.
	replicaInterval = 15 * time.Second
	// replicaPassBudget bounds one pass over one target, so a long copy cannot
	// starve the others; the next pass carries on from where the target is.
	replicaPassBudget = 40 * time.Second
	// replicaChunk is the size of one append. The tunnel carries frames of at
	// most 1 MiB and the chunk travels base64 inside JSON.
	replicaChunk = 256 << 10
	// replicaRangeMax is the most one stream copies per pass.
	replicaRangeMax = 64 << 20
)

// replicaWork is one recording a connector owes a copy of.
type replicaWork struct {
	TenantID          string `json:"tenantId"`
	RecordingKey      string `json:"recordingKey"`
	OriginConnectorID string `json:"originConnectorId"`
}

// replicaReport is where a copy stands.
type replicaReport struct {
	RecordingKey string `json:"recordingKey"`
	// "COPYING" | "COMPLETE"
	State string `json:"state"`
	// Plaintext bytes the copy holds across the streams it is making.
	Bytes int64 `json:"bytes"`
	// A short code for why the pass could not go on; empty when it could.
	Error string `json:"error,omitempty"`
}

// replicaControl is what the worker needs from the control plane.
type replicaControl interface {
	ReplicaWork(connectorID string) ([]replicaWork, error)
	ReportReplicas(connectorID string, items []replicaReport) error
}

// replicaPeers is the part of the tunnel the worker uses; a seam for tests.
type replicaPeers interface {
	// Connected lists the connectors with a live tunnel.
	Connected() []string
	Stat(connectorID string, req tunnel.RecStatRequest) (tunnel.RecStatResponse, error)
	Fetch(connectorID string, req tunnel.RecFetchRequest, w io.Writer) error
	Write(connectorID string, req tunnel.RecWriteRequest) (int, error)
	Done(connectorID, tenantID, recordingKey string)
	AtLeast(connectorID, version string) bool
}

type replicator struct {
	ctrl  replicaControl
	peers replicaPeers
	now   func() time.Time
	mu    sync.Mutex
	busy  map[string]bool // connector -> a pass is running
}

func newReplicator(ctrl replicaControl, peers replicaPeers) *replicator {
	return &replicator{ctrl: ctrl, peers: peers, now: time.Now, busy: map[string]bool{}}
}

// run asks every connected connector, every few seconds, what it still owes.
func (r *replicator) run(ctx context.Context) {
	t := time.NewTicker(replicaInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			r.pass(ctx)
		}
	}
}

// pass runs one round: each connected, new-enough connector is asked for its
// work; connectors are served in turn, each within its own budget.
func (r *replicator) pass(ctx context.Context) {
	var wg sync.WaitGroup
	for _, id := range r.peers.Connected() {
		if !r.peers.AtLeast(id, replicaSince) {
			continue
		}
		r.mu.Lock()
		if r.busy[id] {
			r.mu.Unlock()
			continue
		}
		r.busy[id] = true
		r.mu.Unlock()
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			defer func() { r.mu.Lock(); delete(r.busy, id); r.mu.Unlock() }()
			r.serve(ctx, id)
		}(id)
	}
	wg.Wait()
}

// serve brings one connector up to date with what it owes.
func (r *replicator) serve(ctx context.Context, target string) {
	work, err := r.ctrl.ReplicaWork(target)
	if err != nil || len(work) == 0 {
		return
	}
	deadline := r.now().Add(replicaPassBudget)
	var reports []replicaReport
	for _, w := range work {
		if ctx.Err() != nil || r.now().After(deadline) {
			break
		}
		if rep, ok := r.copyOne(target, w, deadline); ok {
			reports = append(reports, rep)
		}
	}
	if len(reports) > 0 {
		if err := r.ctrl.ReportReplicas(target, reports); err != nil {
			log.Printf("replicate: report for %s failed: %v", target, err)
		}
	}
}

func copyStreams(protocol string, origin tunnel.RecStatResponse) (wanted []string, waiting bool) {
	graphical := protocol == "rdp" || protocol == "vnc"
	has := map[string]bool{}
	for _, s := range origin.Streams {
		has[s.Format] = true
	}
	for _, s := range origin.Streams {
		if graphical && (s.Format == "guac" || s.Format == "rdp") {
			continue // the raw screen stream stays where it was made
		}
		wanted = append(wanted, s.Format)
	}
	// A graphical session is copied as its video; until there is one there is nothing to wait for but the video.
	return wanted, graphical && !has["video"]
}

// copyOne copies as much of one recording as the budget allows and says where
// the copy stands. ok is false when there is nothing to say yet (the source is
// not connected: the target keeps owing it).
func (r *replicator) copyOne(target string, w replicaWork, deadline time.Time) (replicaReport, bool) {
	rep := replicaReport{RecordingKey: w.RecordingKey, State: "COPYING"}
	if w.OriginConnectorID == "" || w.OriginConnectorID == target {
		return rep, false
	}
	if !r.peers.AtLeast(w.OriginConnectorID, replicaSince) {
		return rep, false
	}
	origin, err := r.peers.Stat(w.OriginConnectorID, tunnel.RecStatRequest{Kind: "recstat", TenantID: w.TenantID, RecordingKey: w.RecordingKey})
	if err != nil || origin.Error != "" {
		rep.Error = "origin_unreachable"
		return rep, true
	}
	if len(origin.Streams) == 0 {
		rep.Error = "origin_empty"
		return rep, true
	}
	wanted, waitingForVideo := copyStreams(origin.Protocol, origin)
	have, err := r.peers.Stat(target, tunnel.RecStatRequest{Kind: "recstat", TenantID: w.TenantID, RecordingKey: w.RecordingKey})
	if err != nil || have.Error != "" {
		rep.Error = "target_unreachable"
		return rep, true
	}
	haveBy := map[string]tunnel.RecStatStream{}
	for _, s := range have.Streams {
		haveBy[s.Format] = s
	}

	for _, s := range origin.Streams {
		if !contains(wanted, s.Format) {
			continue
		}
		if r.now().After(deadline) {
			break
		}
		h := haveBy[s.Format]
		if h.Bytes > s.Bytes {
			// The source's stream got shorter than the copy (a video made again):
			// the copy cannot be repaired by appending.
			rep.Error = "diverged"
			return rep, true
		}
		if h.Bytes == s.Bytes {
			continue
		}
		copied, err := r.copyRange(origin.Protocol, target, w, s, h)
		if err != nil {
			rep.Error = "copy_failed"
			log.Printf("replicate: %s -> %s key=%s stream=%s: %v", w.OriginConnectorID, target, w.RecordingKey, s.Format, err)
		}
		h.Bytes += copied
		haveBy[s.Format] = h
	}

	var total int64
	allThere := true
	for _, s := range origin.Streams {
		if !contains(wanted, s.Format) {
			continue
		}
		got := haveBy[s.Format].Bytes
		total += got
		if got != s.Bytes {
			allThere = false
		}
	}
	rep.Bytes = total
	switch {
	case waitingForVideo:
		if rep.Error == "" {
			rep.Error = "waiting_for_video"
		}
	case allThere && origin.Complete && rep.Error == "":
		rep.State = "COMPLETE"
		// The copy is whole and the source is finished with: let the target go
		// on with its own upkeep of it (compress, repack).
		r.peers.Done(target, w.TenantID, w.RecordingKey)
	}
	return rep, true
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

var errShortCopy = errors.New("source ended before the range")

// copyRange appends the part of a stream the target lacks, in chunks, and says
// how many bytes it appended (also on a failure part-way: they are there).
func (r *replicator) copyRange(protocol, target string, w replicaWork, src tunnel.RecStatStream, dst tunnel.RecStatStream) (int64, error) {
	from := dst.Bytes
	to := src.Bytes - 1
	if to-from+1 > replicaRangeMax {
		to = from + replicaRangeMax - 1
	}
	sink := &chunkSink{max: replicaChunk, seq: dst.NextSeq, flush: func(seq int, data []byte) error {
		req := tunnel.RecWriteRequest{TenantID: w.TenantID, RecordingKey: w.RecordingKey, Seq: seq, Format: src.Format, Data: data, Hold: true}
		if src.Format == "guac" {
			req.Protocol = protocol
		}
		_, err := r.peers.Write(target, req)
		return err
	}}
	req := tunnel.RecFetchRequest{TenantID: w.TenantID, RecordingKey: w.RecordingKey, Format: src.Format, FromByte: from, ToByte: to}
	err := r.peers.Fetch(w.OriginConnectorID, req, sink)
	if err == nil {
		err = sink.close()
	}
	if err == nil && sink.written != to-from+1 {
		err = errShortCopy
	}
	return sink.written, err
}

// chunkSink collects what a range answer streams and appends it in chunks of
// at most max bytes; written counts what the target has acknowledged.
type chunkSink struct {
	max     int
	seq     int
	buf     []byte
	written int64
	flush   func(seq int, data []byte) error
}

func (c *chunkSink) Write(p []byte) (int, error) {
	n := len(p)
	for len(p) > 0 {
		room := c.max - len(c.buf)
		take := min(room, len(p))
		c.buf = append(c.buf, p[:take]...)
		p = p[take:]
		if len(c.buf) >= c.max {
			if err := c.drain(); err != nil {
				return 0, err
			}
		}
	}
	return n, nil
}

func (c *chunkSink) drain() error {
	if len(c.buf) == 0 {
		return nil
	}
	if err := c.flush(c.seq, c.buf); err != nil {
		return err
	}
	c.written += int64(len(c.buf))
	c.seq++
	c.buf = c.buf[:0]
	return nil
}

func (c *chunkSink) close() error { return c.drain() }

// ---- the real tunnel and control plane ------------------------------------

type registryPeers struct{ reg *Registry }

func (p registryPeers) Connected() []string {
	p.reg.mu.RLock()
	defer p.reg.mu.RUnlock()
	var out []string
	for id, s := range p.reg.m {
		if s != nil && s.mux != nil && !s.mux.IsClosed() {
			out = append(out, id)
		}
	}
	return out
}

func (p registryPeers) session(id string) *Session { return p.reg.Get(id) }

func (p registryPeers) Stat(id string, req tunnel.RecStatRequest) (tunnel.RecStatResponse, error) {
	s := p.session(id)
	if s == nil || s.mux == nil {
		return tunnel.RecStatResponse{}, errors.New("connector offline")
	}
	st, err := s.mux.Open()
	if err != nil {
		return tunnel.RecStatResponse{}, err
	}
	defer st.Close()
	b, err := json.Marshal(req)
	if err != nil {
		return tunnel.RecStatResponse{}, err
	}
	if err := tunnel.WriteFrame(st, b); err != nil {
		return tunnel.RecStatResponse{}, err
	}
	rb, err := tunnel.ReadFrame(st)
	if err != nil {
		return tunnel.RecStatResponse{}, err
	}
	var resp tunnel.RecStatResponse
	if err := json.Unmarshal(rb, &resp); err != nil {
		return tunnel.RecStatResponse{}, err
	}
	return resp, nil
}

func (p registryPeers) Fetch(id string, req tunnel.RecFetchRequest, w io.Writer) error {
	return RecFetch(p.session(id), req, nil, w)
}

func (p registryPeers) Write(id string, req tunnel.RecWriteRequest) (int, error) {
	return writeRecChunk(p.session(id), req)
}

func (p registryPeers) Done(id, tenantID, key string) { notifyRecDone(p.session(id), tenantID, key) }

func (p registryPeers) AtLeast(id, version string) bool {
	s := p.session(id)
	return s != nil && connectorAtLeast(s, version)
}

// ReplicaWork asks what a connector still owes a copy of.
func (c *ControlClient) ReplicaWork(connectorID string) ([]replicaWork, error) {
	var out struct {
		Items []replicaWork `json:"items"`
	}
	if err := c.post("/api/internal/recording/replicas/work", map[string]string{"connectorId": connectorID}, &out); err != nil {
		return nil, err
	}
	return out.Items, nil
}

// ReportReplicas says where a connector's copies stand.
func (c *ControlClient) ReportReplicas(connectorID string, items []replicaReport) error {
	return c.post("/api/internal/recording/replicas/report", map[string]any{"connectorId": connectorID, "items": items}, nil)
}
