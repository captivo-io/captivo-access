package main

import (
	"testing"
	"time"
)

func newTestSession(h *SessionHub) *liveSession {
	return h.Register("s1", "site1", "user1", "ssh", "fw-01", time.Now(), "c", "conn", "guacd")
}

func TestActivityCountsInputNotSyncs(t *testing.T) {
	h := NewSessionHub()
	ls := newTestSession(h)
	now := time.Now()
	ls.touch([]byte("4.sync,10.1234567890;"), now)
	ls.touch([]byte("3.key,5.65307,1.1;3.key,5.65307,1.0;5.mouse,2.10,2.20,1.0;"), now)
	got := ls.activitySnapshot(now)
	if len(got) != activityBuckets || got[activityBuckets-1] != 3 {
		t.Fatalf("newest bucket = %v, want 3 inputs", got)
	}
	// Two minutes on, the old input has scrolled out.
	later := ls.activitySnapshot(now.Add(2*time.Minute + time.Second))
	for _, n := range later {
		if n != 0 {
			t.Fatalf("buckets after two minutes = %v, want all zero", later)
		}
	}
}

func TestActivityShiftsByBucket(t *testing.T) {
	h := NewSessionHub()
	ls := newTestSession(h)
	t0 := time.Now().Truncate(activityBucket)
	ls.touch([]byte("3.key,1.1,1.1;"), t0)
	ls.touch([]byte("3.key,1.1,1.1;3.key,1.1,1.0;"), t0.Add(activityBucket))
	got := ls.activitySnapshot(t0.Add(activityBucket))
	if got[activityBuckets-2] != 1 || got[activityBuckets-1] != 2 {
		t.Fatalf("buckets = %v, want ...1,2", got)
	}
}

func TestTypedInputOnlyWhenLogged(t *testing.T) {
	h := NewSessionHub()
	ls := newTestSession(h)
	ls.SetCapture(true, false)
	ls.keyEvents([]keyEvent{{Kind: "command", Text: "rm -rf /tmp/x"}})
	events, _ := h.Feed("s1")
	for _, e := range events {
		if e.Type == "command" {
			t.Fatalf("typed input shown without keystroke logging: %+v", events)
		}
	}

	ls2 := h.Register("s2", "site1", "user2", "ssh", "fw-01", time.Now(), "c", "conn", "guacd")
	ls2.SetCapture(true, true)
	ls2.keyEvents([]keyEvent{{Kind: "command", Text: "uptime"}, {Kind: "text", Text: "hunter2", Masked: true}, {Kind: "text", Text: "  "}})
	events, _ = h.Feed("s2")
	if len(events) != 3 || events[0].Text != "Hidden input (password prompt)" || events[1].Type != "command" || events[2].Type != "start" {
		t.Fatalf("feed = %+v, want newest first: hidden input, command, start", events)
	}
}

func TestFeedRecordsWatchControlAndFiles(t *testing.T) {
	h := NewSessionHub()
	ls := newTestSession(h)
	ls.SetCapture(true, false)
	ls.addViewer()
	_ = ls.setControl("admin1")
	ls.releaseControl("admin1")
	ls.fileEvents([]AuditEvent{{Method: "UPLOAD", Path: "/etc/fw/rules.conf"}, {Method: "DOWNLOAD-PARTIAL", Path: "/var/log/syslog"}})
	events, _ := h.Feed("s1")
	want := []string{"Downloaded (partly) /var/log/syslog", "Uploaded /etc/fw/rules.conf", "Control returned to the user", "An admin took control", "An admin started watching", "Session started"}
	if len(events) != len(want) {
		t.Fatalf("feed = %+v", events)
	}
	for i, w := range want {
		if events[i].Text != w {
			t.Fatalf("event %d = %q, want %q", i, events[i].Text, w)
		}
	}
}

func TestFeedIsCapped(t *testing.T) {
	h := NewSessionHub()
	ls := newTestSession(h)
	for i := 0; i < liveEventCap+20; i++ {
		ls.event("watch", "x")
	}
	events, _ := h.Feed("s1")
	if len(events) != liveEventCap {
		t.Fatalf("feed length = %d, want %d", len(events), liveEventCap)
	}
}

func TestMessageReachesTheUsersPageForAWhile(t *testing.T) {
	h := NewSessionHub()
	newTestSession(h)
	m, ok := h.Message("s1", "Please save your work, maintenance in 5 minutes")
	if !ok || m.ID == "" {
		t.Fatal("message not accepted")
	}
	if got := h.PendingMessage("user1", "site1", m.At.Add(time.Second)); got == nil || got.ID != m.ID {
		t.Fatalf("pending = %+v, want the message", got)
	}
	if got := h.PendingMessage("user1", "site1", m.At.Add(messageTTL+time.Second)); got != nil {
		t.Fatalf("pending after TTL = %+v, want none", got)
	}
	if got := h.PendingMessage("user2", "site1", m.At); got != nil {
		t.Fatal("another user's page got the message")
	}
	if _, ok := h.Message("missing", "x"); ok {
		t.Fatal("message to a missing session accepted")
	}
}
