package main

import (
	"encoding/json"
	"sync"
	"time"
)

// WebLiveHub fans a web app session's rrweb events out to admins watching it
// live -- the web app counterpart of guacd's shared connection (gateway) and
// KasmVNC's shared display (isolated).
//
// A web app session has no server-side screen to join: the "screen" is the
// vendor's own browser, and all there is of it here is the event stream the
// recorder posts. So a viewer is sent the current page's Meta + FullSnapshot
// and every event since (enough for rrweb's Replayer to rebuild the page), then
// each new batch as it arrives. Watching is read-only by nature: nothing can be
// sent back into the vendor's browser. Ending the session and revoking access
// work as for the other kinds.
//
// Keyed by recording key (one browser tab). In memory only, like SessionHub.
type WebLiveHub struct {
	mu      sync.Mutex
	streams map[string]*webLiveStream
	now     func() time.Time
}

type webLiveStream struct {
	userID, siteID, host string
	// events since the last Meta (a new page), raw as the recorder sent them.
	page     []json.RawMessage
	pageSize int
	// overflow: the current page outgrew webLiveMaxPage; viewers wait for the next
	// page (the next Meta) rather than receive a page they cannot rebuild.
	overflow bool
	lastSeen time.Time
	subs     map[chan []json.RawMessage]struct{}
}

const (
	webLiveMaxPage = 16 << 20 // bytes kept per tab for a joining viewer
	webLiveIdle    = 2 * time.Minute
	rrwebMeta      = 4
)

func NewWebLiveHub() *WebLiveHub {
	return &WebLiveHub{streams: map[string]*webLiveStream{}, now: time.Now}
}

// Feed takes one recorder batch ({recordingKey, seq, events}) for (user, site).
func (h *WebLiveHub) Feed(userID, siteID, host string, body []byte) {
	if h == nil {
		return
	}
	var batch struct {
		RecordingKey string            `json:"recordingKey"`
		Events       []json.RawMessage `json:"events"`
	}
	if err := json.Unmarshal(body, &batch); err != nil || batch.RecordingKey == "" || len(batch.Events) == 0 {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.streams[batch.RecordingKey]
	if s == nil {
		s = &webLiveStream{subs: map[chan []json.RawMessage]struct{}{}}
		h.streams[batch.RecordingKey] = s
	}
	// The key is the tab's; the identity is the proxy's, never the page's.
	s.userID, s.siteID, s.host, s.lastSeen = userID, siteID, host, h.now()
	for _, ev := range batch.Events {
		if eventType(ev) == rrwebMeta {
			s.page, s.pageSize, s.overflow = nil, 0, false
		}
		if s.overflow {
			continue
		}
		if s.pageSize+len(ev) > webLiveMaxPage {
			s.page, s.pageSize, s.overflow = nil, 0, true
			continue
		}
		s.page = append(s.page, ev)
		s.pageSize += len(ev)
	}
	for ch := range s.subs {
		select {
		case ch <- batch.Events:
		default: // a viewer that cannot keep up misses a batch rather than stall the vendor
		}
	}
}

func eventType(ev json.RawMessage) int {
	var t struct {
		Type int `json:"type"`
	}
	_ = json.Unmarshal(ev, &t)
	return t.Type
}

// Subscribe returns the current page so far and a channel of what follows.
// ok is false when the tab is unknown or idle.
func (h *WebLiveHub) Subscribe(key string) (siteID string, page []json.RawMessage, ch chan []json.RawMessage, cancel func(), ok bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.streams[key]
	if s == nil || h.now().Sub(s.lastSeen) > webLiveIdle {
		return "", nil, nil, nil, false
	}
	ch = make(chan []json.RawMessage, 64)
	s.subs[ch] = struct{}{}
	page = append([]json.RawMessage(nil), s.page...)
	return s.siteID, page, ch, func() {
		h.mu.Lock()
		delete(s.subs, ch)
		h.mu.Unlock()
	}, true
}

// LiveKeys maps (user, site) to the most recently active tab key, for the live
// list's Watch link. Idle streams are pruned on the way.
func (h *WebLiveHub) LiveKeys() map[string]string {
	out := map[string]string{}
	if h == nil {
		return out
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	best := map[string]time.Time{}
	for key, s := range h.streams {
		if h.now().Sub(s.lastSeen) > webLiveIdle {
			if len(s.subs) == 0 {
				delete(h.streams, key)
			}
			continue
		}
		k := s.userID + webKeySep + s.siteID
		if s.lastSeen.After(best[k]) {
			best[k], out[k] = s.lastSeen, key
		}
	}
	return out
}

// Viewers is the number of admins watching a tab.
func (h *WebLiveHub) Viewers(key string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	if s := h.streams[key]; s != nil {
		return len(s.subs)
	}
	return 0
}
