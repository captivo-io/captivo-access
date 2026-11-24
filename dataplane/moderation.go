package main

import (
	"sync"
	"time"
)

// A moderated session (four eyes): it starts only once a moderator has
// admitted it in the console, and the user's input passes only while that
// moderator watches. When they stop watching the user's keyboard and mouse
// are paused; unless a moderator is back within moderatorGrace, the session
// ends. The manager names the moderator (moderationRef); another admin can
// take the role over (SetModerator).

var moderatorGrace = 2 * time.Minute // a var for tests

// The reason a session ends when no moderator came back (src/lib/session/end-reason.ts).
const endModeratorLeft = "moderator_left"

// moderationRef is what the manager says of a moderated session: its request,
// and who admitted it.
type moderationRef struct {
	ID          string `json:"id"`
	ModeratorID string `json:"moderatorId"`
}

type moderation struct {
	ref      moderationRef
	deadline time.Time // zero while the moderator watches
	gen      int       // bumps when deadline changes, so a stale timer does nothing
	timeout  func()
}

// moderated marks ls moderated. Nobody watches yet, so the user's input waits
// for the moderator, who has moderatorGrace to arrive.
func (ls *liveSession) moderated(ref moderationRef, timeout func()) {
	ls.mu.Lock()
	ls.mod = &moderation{ref: ref, timeout: timeout}
	ls.modAbsentLocked(time.Now())
	ls.mu.Unlock()
}

// modAbsentLocked starts the moderator's grace period.
func (ls *liveSession) modAbsentLocked(now time.Time) {
	m := ls.mod
	m.deadline = now.Add(moderatorGrace)
	m.gen++
	gen := m.gen
	time.AfterFunc(moderatorGrace, func() {
		ls.mu.Lock()
		fire := ls.mod != nil && ls.mod.gen == gen && !ls.mod.deadline.IsZero()
		var timeout func()
		if fire {
			timeout = ls.mod.timeout
		}
		ls.mu.Unlock()
		if timeout != nil {
			timeout()
		}
	})
}

// moderatorWatchingLocked: a view of the moderator is open.
func (ls *liveSession) moderatorWatchingLocked() bool {
	for _, v := range ls.views {
		if ls.isModeratorLocked(v.w) {
			return true
		}
	}
	return false
}

func (ls *liveSession) isModeratorLocked(w watcher) bool {
	return ls.mod != nil && !w.guest && w.id != "" && w.id == ls.mod.ref.ModeratorID && w.id != ls.userID
}

// modSeenLocked updates the moderator's presence after views changed and
// says what to tell the user ("" for nothing).
func (ls *liveSession) modSeenLocked(now time.Time) string {
	if ls.mod == nil {
		return ""
	}
	watching := ls.moderatorWatchingLocked()
	switch {
	case watching && !ls.mod.deadline.IsZero():
		ls.mod.deadline = time.Time{}
		ls.mod.gen++
		ls.act.addEvent("moderation", "The moderator joined; the user can type", now)
		return "A moderator joined. You can use the session now."
	case !watching && ls.mod.deadline.IsZero():
		ls.modAbsentLocked(now)
		ls.act.addEvent("moderation", "The moderator left; the user's input is paused", now)
		return "The moderator left. Your keyboard and mouse are paused; the session ends in 2 minutes unless a moderator joins."
	}
	return ""
}

// tellUser writes a line into a recorded native SSH user's terminal; browser
// sessions read the state from watch-status.
func (ls *liveSession) tellUser(text string) {
	if text == "" {
		return
	}
	_, notify := ls.termHooks()
	if notify != nil {
		notify(text, false)
	}
}

// ModerationState is the moderation part of a session's snapshot.
type ModerationState struct {
	ID          string     `json:"id"`
	ModeratorID string     `json:"moderatorId"`
	Present     bool       `json:"present"`
	Deadline    *time.Time `json:"deadline,omitempty"` // the session ends here unless a moderator joins
}

func (ls *liveSession) moderationLocked() *ModerationState {
	if ls.mod == nil {
		return nil
	}
	s := &ModerationState{ID: ls.mod.ref.ID, ModeratorID: ls.mod.ref.ModeratorID, Present: ls.mod.deadline.IsZero()}
	if !s.Present {
		d := ls.mod.deadline
		s.Deadline = &d
	}
	return s
}

// Moderate makes ls a moderated session; when no moderator came in time the
// session ends with endModeratorLeft and ended is called (to audit it).
func (h *SessionHub) Moderate(ls *liveSession, ref moderationRef, ended func()) {
	var once sync.Once
	ls.moderated(ref, func() {
		// A session that already ended leaves no reason behind: it would
		// close the user's next session here as soon as it opens.
		if h.Get(ls.id) != ls {
			return
		}
		once.Do(func() {
			h.noteEnded(ls.userID, ls.siteID, endModeratorLeft)
			if h.Terminate(ls.id) && ended != nil {
				ended()
			}
		})
	})
}

// SetModerator hands the moderator role to another console user (the one
// before left). False when the session isn't moderated or isn't there.
func (h *SessionHub) SetModerator(sessionID, userID string) bool {
	ls := h.Get(sessionID)
	if ls == nil || userID == "" {
		return false
	}
	ls.mu.Lock()
	if ls.mod == nil || userID == ls.userID {
		ls.mu.Unlock()
		return false
	}
	ls.mod.ref.ModeratorID = userID
	text := ls.modSeenLocked(time.Now())
	ls.mu.Unlock()
	ls.tellUser(text)
	return true
}
