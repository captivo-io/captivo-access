package main

import (
	"sort"
	"sync"
	"time"
)

// WebSessionInfo is the JSON snapshot of one active web-app (transparent) access
// span for the internal list API. Unlike a gateway session it is not a live
// connection — it is derived from recent proxied requests.
type WebSessionInfo struct {
	UserID    string    `json:"userId"`
	SiteID    string    `json:"siteId"`
	Host      string    `json:"host"`
	StartedAt time.Time `json:"startedAt"`
	LastSeen  time.Time `json:"lastSeen"`
	// LiveKey names the tab an admin can watch (see WebLiveHub); empty when the
	// site does not record, since live view rides on the recorder's events.
	LiveKey string `json:"liveKey,omitempty"`
	Viewers int    `json:"viewers"`
}

// WebActivityTracker is a thread-safe, in-memory record of recent web-app access,
// keyed by (userId, siteId). It is the transparent-proxy analogue of SessionHub.
// In-memory only: lost on restart, like SessionHub.
type WebActivityTracker struct {
	mu  sync.Mutex
	m   map[string]*WebSessionInfo
	now func() time.Time
}

func NewWebActivityTracker() *WebActivityTracker {
	return &WebActivityTracker{m: map[string]*WebSessionInfo{}, now: time.Now}
}

const webKeySep = "\x1f"

// Touch records activity for (userID, siteID). Cheap and non-blocking. Returns true
// when it STARTS A NEW SPAN — a first touch, or one after the previous activity has
// been idle longer than `idle` (so the caller can emit a session_open audit event
// once per web session). A touch within the window advances LastSeen and refreshes
// the host, keeping StartedAt, and returns false.
func (t *WebActivityTracker) Touch(userID, siteID, host string, idle time.Duration) bool {
	if t == nil || userID == "" || siteID == "" {
		return false
	}
	now := t.now()
	key := userID + webKeySep + siteID
	t.mu.Lock()
	defer t.mu.Unlock()
	if e, ok := t.m[key]; ok && now.Sub(e.LastSeen) <= idle {
		e.LastSeen = now
		e.Host = host
		return false
	}
	t.m[key] = &WebSessionInfo{UserID: userID, SiteID: siteID, Host: host, StartedAt: now, LastSeen: now}
	return true
}

// List returns the active spans (LastSeen within idle), pruning older ones. The
// result is sorted by StartedAt descending (newest first) for stable display.
func (t *WebActivityTracker) List(idle time.Duration) []WebSessionInfo {
	cutoff := t.now().Add(-idle)
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make([]WebSessionInfo, 0, len(t.m))
	for key, e := range t.m {
		if e.LastSeen.Before(cutoff) {
			delete(t.m, key)
			continue
		}
		out = append(out, *e)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StartedAt.After(out[j].StartedAt) })
	return out
}
