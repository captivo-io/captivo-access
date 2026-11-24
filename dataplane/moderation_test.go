package main

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

func moderatedSession(t *testing.T, grace time.Duration) (*SessionHub, *liveSession, *atomic.Int32) {
	t.Helper()
	old := moderatorGrace
	moderatorGrace = grace
	t.Cleanup(func() { moderatorGrace = old })
	hub := NewSessionHub()
	ls := hub.Register("s1", "site1", "vendor", "rdp", "10.0.0.5", time.Now(), "$c", "conn1", "guacd:4822")
	var closed, ended atomic.Int32
	hub.SetCloser("s1", func() { closed.Add(1) })
	hub.Moderate(ls, moderationRef{ID: "m1", ModeratorID: "admin1"}, func() { ended.Add(1) })
	t.Cleanup(func() {
		if ended.Load() != closed.Load() {
			t.Errorf("ended %d, closed %d", ended.Load(), closed.Load())
		}
	})
	return hub, ls, &ended
}

func TestTheUserWaitsForTheModerator(t *testing.T) {
	hub, ls, _ := moderatedSession(t, time.Hour)
	if ls.vendorInputAllowed() {
		t.Fatal("input passed before the moderator watched")
	}
	if st := hub.ModerationOf("vendor", "site1"); st == nil || st.Present || st.Deadline == nil {
		t.Fatalf("state before the moderator: %+v", st)
	}
	// Another admin, a guest, and the user themselves are not the moderator.
	for _, w := range []watcher{{id: "admin2"}, {id: "admin1", guest: true, name: "Ada"}, {id: "vendor"}} {
		_, done := ls.watch(context.Background(), w)
		if ls.vendorInputAllowed() {
			t.Fatalf("%+v counted as the moderator", w)
		}
		done()
	}
	_, done := ls.watch(context.Background(), watcher{id: "admin1"})
	if !ls.vendorInputAllowed() {
		t.Fatal("input paused while the moderator watches")
	}
	if st := hub.ModerationOf("vendor", "site1"); st == nil || !st.Present || st.Deadline != nil {
		t.Fatalf("state with the moderator: %+v", st)
	}
	// Control still pauses the user, moderator or not.
	_ = ls.setControl("admin1")
	if ls.vendorInputAllowed() {
		t.Fatal("input passed while the moderator held control")
	}
	ls.releaseControl("admin1")
	// Two views of the moderator: closing one keeps them there.
	_, done2 := ls.watch(context.Background(), watcher{id: "admin1"})
	done()
	if !ls.vendorInputAllowed() {
		t.Fatal("paused while the moderator still had a view open")
	}
	done2()
	if ls.vendorInputAllowed() {
		t.Fatal("input passed after the moderator left")
	}
	if l := hub.List(); len(l) != 1 || l[0].Moderation == nil || l[0].Moderation.Present || l[0].Moderation.ModeratorID != "admin1" {
		t.Fatalf("list: %+v", l[0].Moderation)
	}
}

func TestNoModeratorEndsTheSession(t *testing.T) {
	hub, ls, ended := moderatedSession(t, 50*time.Millisecond)
	// The moderator came and went; coming back in time keeps the session.
	_, done := ls.watch(context.Background(), watcher{id: "admin1"})
	done()
	_, done = ls.watch(context.Background(), watcher{id: "admin1"})
	time.Sleep(120 * time.Millisecond)
	if ended.Load() != 0 {
		t.Fatal("ended although the moderator came back")
	}
	done()
	deadline := time.Now().Add(2 * time.Second)
	for ended.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if ended.Load() != 1 {
		t.Fatal("the session went on without a moderator")
	}
	if why := hub.EndedReason("vendor", "site1"); why != endModeratorLeft {
		t.Fatalf("ended reason %q", why)
	}
}

func TestAnotherAdminTakesOverAsModerator(t *testing.T) {
	hub, ls, _ := moderatedSession(t, time.Hour)
	_, done := ls.watch(context.Background(), watcher{id: "admin2"})
	defer done()
	if ls.vendorInputAllowed() {
		t.Fatal("admin2 isn't the moderator yet")
	}
	if !hub.SetModerator("s1", "admin2") || !ls.vendorInputAllowed() {
		t.Fatal("admin2 took over but input is still paused")
	}
	if hub.SetModerator("s1", "vendor") {
		t.Fatal("the user became their own moderator")
	}
	if hub.SetModerator("nope", "admin2") {
		t.Fatal("moderated a session that isn't there")
	}
}

func TestAnUnmoderatedSessionIsUntouched(t *testing.T) {
	hub := NewSessionHub()
	ls := hub.Register("s1", "site1", "vendor", "rdp", "h", time.Now(), "$c", "c", "g")
	if !ls.vendorInputAllowed() || hub.ModerationOf("vendor", "site1") != nil || hub.SetModerator("s1", "admin1") {
		t.Fatal("an unmoderated session behaved as moderated")
	}
}

func TestAnEndedSessionsTimerLeavesTheNextOneAlone(t *testing.T) {
	hub, _, ended := moderatedSession(t, 50*time.Millisecond)
	hub.Remove("s1") // the user closed it before any moderator came
	time.Sleep(150 * time.Millisecond)
	if ended.Load() != 0 || hub.EndedReason("vendor", "site1") != "" {
		t.Fatal("a session that had already ended noted a moderator_left end")
	}
}
