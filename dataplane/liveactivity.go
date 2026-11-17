package main

import (
	"bytes"
	"strings"
	"time"
)

// What the console's Sessions page shows beside a live session (design
// hand-off 7.11): how busy it has been over the last two minutes, its recent
// events, and the last message an admin sent the user. All of it is in memory
// and goes with the session; nothing here is stored.
//
// Typed input appears only when the resource logs keystrokes (the same opt-in
// the recording's timeline has), and a masked line stays hidden: an admin
// watching live sees no more than the recording will hold.

const (
	activityBuckets = 24
	activityBucket  = 5 * time.Second
	liveEventCap    = 50
	// A message stays offered to the user's page this long after it was sent.
	messageTTL = 90 * time.Second
)

// LiveEvent is one moment in a live session's feed.
type LiveEvent struct {
	At   time.Time `json:"at"`
	Type string    `json:"type"` // start | command | text | file | watch | control | message
	Text string    `json:"text"`
}

// LiveMessage is an admin's message to the user of a live session.
type LiveMessage struct {
	ID   string    `json:"id"`
	Text string    `json:"text"`
	At   time.Time `json:"at"`
}

type liveActivity struct {
	recording, keystrokes bool
	buckets               [activityBuckets]int
	bucketAt              time.Time // start of the newest bucket
	events                []LiveEvent
	message               *LiveMessage
}

// shift moves the buckets on to now. Callers hold ls.mu.
func (a *liveActivity) shift(now time.Time) {
	if a.bucketAt.IsZero() {
		a.bucketAt = now.Truncate(activityBucket)
		return
	}
	n := int(now.Sub(a.bucketAt) / activityBucket)
	if n <= 0 {
		return
	}
	if n >= activityBuckets {
		a.buckets = [activityBuckets]int{}
	} else {
		copy(a.buckets[:], a.buckets[n:])
		for i := activityBuckets - n; i < activityBuckets; i++ {
			a.buckets[i] = 0
		}
	}
	a.bucketAt = a.bucketAt.Add(time.Duration(n) * activityBucket)
}

// addEvent appends to the feed, keeping the newest liveEventCap. Callers hold ls.mu.
func (a *liveActivity) addEvent(typ, text string, now time.Time) {
	a.events = append(a.events, LiveEvent{At: now, Type: typ, Text: text})
	if len(a.events) > liveEventCap {
		a.events = append([]LiveEvent(nil), a.events[len(a.events)-liveEventCap:]...)
	}
}

// SetCapture records what this session captures, and starts its feed.
func (ls *liveSession) SetCapture(recording, keystrokes bool) {
	ls.mu.Lock()
	ls.act.recording, ls.act.keystrokes = recording, keystrokes
	ls.act.addEvent("start", "Session started", ls.startedAt)
	ls.mu.Unlock()
}

// touch counts the user's input in one browser->guacd message: key and mouse
// instructions, not the sync acknowledgements the client sends for every frame.
func (ls *liveSession) touch(data []byte, now time.Time) {
	n := inputCount(data)
	if n == 0 {
		return
	}
	ls.mu.Lock()
	ls.act.shift(now)
	ls.act.buckets[activityBuckets-1] += n
	ls.mu.Unlock()
}

func inputCount(data []byte) int {
	return bytes.Count(data, []byte("3.key,")) + bytes.Count(data, []byte("5.mouse,"))
}

// event adds a moment to the feed.
func (ls *liveSession) event(typ, text string) {
	ls.mu.Lock()
	ls.act.addEvent(typ, text, time.Now())
	ls.mu.Unlock()
}

// keyEvents adds typed input, only where keystrokes are logged; masked lines stay hidden.
func (ls *liveSession) keyEvents(evs []keyEvent) {
	ls.mu.Lock()
	defer ls.mu.Unlock()
	if !ls.act.keystrokes {
		return
	}
	now := time.Now()
	for _, e := range evs {
		text := strings.TrimSpace(e.Text)
		if e.Masked {
			ls.act.addEvent("text", "Hidden input (password prompt)", now)
			continue
		}
		if text == "" {
			continue
		}
		typ := "text"
		if e.Kind == "command" {
			typ = "command"
		}
		ls.act.addEvent(typ, text, now)
	}
}

// fileEvents adds the session's file transfers, as the audit log records them.
func (ls *liveSession) fileEvents(evs []AuditEvent) {
	for _, e := range evs {
		verb := "Uploaded"
		if strings.HasPrefix(e.Method, "DOWNLOAD") {
			verb = "Downloaded"
		}
		if strings.HasSuffix(e.Method, "-PARTIAL") {
			verb += " (partly)"
		}
		ls.event("file", verb+" "+e.Path)
	}
}

// setMessage keeps an admin's message for the user's page to show.
func (ls *liveSession) setMessage(text string) LiveMessage {
	m := LiveMessage{ID: newSessionID(), Text: text, At: time.Now()}
	ls.mu.Lock()
	ls.act.message = &m
	ls.act.addEvent("message", "Admin message: "+text, m.At)
	ls.mu.Unlock()
	return m
}

// activitySnapshot is the last two minutes of input, oldest bucket first.
func (ls *liveSession) activitySnapshot(now time.Time) []int {
	ls.mu.Lock()
	defer ls.mu.Unlock()
	ls.act.shift(now)
	out := make([]int, activityBuckets)
	copy(out, ls.act.buckets[:])
	return out
}

// Feed is a session's recent events, newest first.
func (h *SessionHub) Feed(id string) ([]LiveEvent, bool) {
	ls := h.Get(id)
	if ls == nil {
		return nil, false
	}
	ls.mu.Lock()
	defer ls.mu.Unlock()
	out := make([]LiveEvent, len(ls.act.events))
	for i, e := range ls.act.events {
		out[len(out)-1-i] = e
	}
	return out, true
}

// Message sends an admin's message to a live session's user.
func (h *SessionHub) Message(id, text string) (LiveMessage, bool) {
	ls := h.Get(id)
	if ls == nil {
		return LiveMessage{}, false
	}
	return ls.setMessage(text), true
}

// PendingMessage is the message the user's page should show, if any is recent.
func (h *SessionHub) PendingMessage(userID, siteID string, now time.Time) *LiveMessage {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, ls := range h.m {
		if ls.userID != userID || ls.siteID != siteID {
			continue
		}
		ls.mu.Lock()
		m := ls.act.message
		ls.mu.Unlock()
		if m != nil && now.Sub(m.At) < messageTTL {
			cp := *m
			return &cp
		}
	}
	return nil
}
