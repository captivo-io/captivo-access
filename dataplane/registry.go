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
