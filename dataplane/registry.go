package main

import (
	"encoding/json"
	"errors"
	"io"
	"sync"
	"time"

	"github.com/hashicorp/yamux"
	"github.com/kurtserdar/captivo-access/tunnel"
)

var errNoControl = errors.New("connector control stream not ready")

// Session wraps a live yamux session for one connector, plus the latest
// telemetry the connector reported and the write side of its control stream.
type Session struct {
	mux     *yamux.Session
	mu      sync.Mutex
	telem   *tunnel.Telemetry
	telemAt time.Time

	ctrlMu     sync.Mutex
	ctrlStream io.Writer
	// ctrlWriteMu keeps frames whole: a frame is two writes (length, payload),
	// and policy pushes and report acks are sent from different goroutines.
	ctrlWriteMu sync.Mutex

	// kasmToken is the isolated-browser control service's secret, as the
	// connector presented it at the handshake. Memory only, this connection only.
	kasmToken string
}

// kasmAuth is the header line that authorizes a call to this connector's
// isolated-browser control service; empty when the connector sent no token
// (an older connector and broker, which do not check one).
func kasmAuth(s *Session) string {
	if s == nil || s.kasmToken == "" {
		return ""
	}
	return "X-Kasm-Token: " + s.kasmToken + "\r\n"
}

func (s *Session) setControl(w io.Writer) {
	s.ctrlMu.Lock()
	s.ctrlStream = w
	s.ctrlMu.Unlock()
}

// PushPolicy writes a policy frame to the connector's control stream. Returns an
// error if the connector isn't connected / has no control stream yet.
// PushPolicy writes a policy frame to the connector's control stream.
//
// It takes the whole tunnel.Policy rather than a fixed argument list: the frame is
// deliberately extensible, and a positional signature meant every new field (tenant,
// retention window, erasure list) had to be threaded through here and every caller.
func (s *Session) PushPolicy(p tunnel.Policy) error {
	s.ctrlMu.Lock()
	w := s.ctrlStream
	s.ctrlMu.Unlock()
	if w == nil {
		return errors.New("control stream not ready")
	}
	b, err := json.Marshal(p)
	if err != nil {
		return err
	}
	return s.writeControl(w, b)
}

// SendControl writes one frame of any kind on the control stream.
func (s *Session) SendControl(v any) error {
	s.ctrlMu.Lock()
	w := s.ctrlStream
	s.ctrlMu.Unlock()
	if w == nil {
		return errors.New("control stream not ready")
	}
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return s.writeControl(w, b)
}

func (s *Session) writeControl(w io.Writer, b []byte) error {
	s.ctrlWriteMu.Lock()
	defer s.ctrlWriteMu.Unlock()
	return tunnel.WriteFrame(w, b)
}

func (s *Session) SetTelemetry(t *tunnel.Telemetry) {
	s.mu.Lock()
	s.telem = t
	s.telemAt = time.Now()
	s.mu.Unlock()
}

func (s *Session) Telemetry() (*tunnel.Telemetry, time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.telem, s.telemAt
}

// RTT is one round trip over the connector's tunnel (a yamux ping): the
// card's edge latency. ok is false when no answer came within timeout.
func (s *Session) RTT(timeout time.Duration) (time.Duration, bool) {
	if s.mux == nil {
		return 0, false
	}
	type res struct {
		d   time.Duration
		err error
	}
	ch := make(chan res, 1)
	go func() { d, err := s.mux.Ping(); ch <- res{d, err} }()
	select {
	case r := <-ch:
		return r.d, r.err == nil
	case <-time.After(timeout):
		return 0, false
	}
}

// Registry is a thread-safe map of connectorId -> live Session.
type Registry struct {
	mu sync.RWMutex
	m  map[string]*Session
}

func NewRegistry() *Registry { return &Registry{m: map[string]*Session{}} }

func (r *Registry) Set(id string, s *Session) {
	r.mu.Lock()
	if old, ok := r.m[id]; ok && old != nil && old.mux != nil {
		old.mux.Close()
	}
	r.m[id] = s
	r.mu.Unlock()
}

func (r *Registry) Get(id string) *Session {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.m[id]
}

func (r *Registry) Remove(id string) {
	r.mu.Lock()
	delete(r.m, id)
	r.mu.Unlock()
}

// RemoveIfSame deletes the entry only if it still holds s; returns true if it did.
func (r *Registry) RemoveIfSame(id string, s *Session) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.m[id] == s {
		delete(r.m, id)
		return true
	}
	return false
}
