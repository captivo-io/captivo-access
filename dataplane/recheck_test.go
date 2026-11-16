package main

import (
	"errors"
	"testing"
	"time"
)

type fakeAccess struct {
	users  map[string]string // token -> userID
	deny   map[string]string // siteID -> reason
	outage bool
}

func (f *fakeAccess) ResolveSession(token string) (string, string, error) {
	if f.outage {
		return "", "", errors.New("unreachable")
	}
	return f.users[token], "", nil
}

func (f *fakeAccess) CheckAccess(userID, siteID, clientIP string) (bool, string, error) {
	if f.outage {
		return false, "", errors.New("unreachable")
	}
	if r, ok := f.deny[siteID]; ok {
		return false, r, nil
	}
	return true, "allow", nil
}

func liveWith(h *SessionHub, id, site, user, token string) *bool {
	closed := false
	h.Register(id, site, user, "rdp", "h", time.Now(), "c", "conn", "g").SetAuth(token, "203.0.113.5")
	h.SetCloser(id, func() { closed = true })
	return &closed
}

func TestRecheckEndsSessionsWhoseAccessNoLongerHolds(t *testing.T) {
	h := NewSessionHub()
	ok := liveWith(h, "s1", "site-ok", "u1", "t1")
	expired := liveWith(h, "s2", "site-exp", "u1", "t1")
	signedOut := liveWith(h, "s3", "site-ok", "u2", "t2")
	f := &fakeAccess{users: map[string]string{"t1": "u1"}, deny: map[string]string{"site-exp": "expired"}}

	recheckOnce(f, h, nil)

	if *ok {
		t.Fatal("a session whose access holds must stay")
	}
	if !*expired || h.EndedReason("u1", "site-exp") != "expired" {
		t.Fatalf("expired grant: closed=%v reason=%q", *expired, h.EndedReason("u1", "site-exp"))
	}
	if !*signedOut || h.EndedReason("u2", "site-ok") != "signed_out" {
		t.Fatalf("signed out: closed=%v reason=%q", *signedOut, h.EndedReason("u2", "site-ok"))
	}
	// Back in a session there: the old reason is forgotten.
	h.clearEnded("u1", "site-exp")
	if h.EndedReason("u1", "site-exp") != "" {
		t.Fatal("cleared")
	}
}

func TestRecheckEndsNothingWhenTheControlPlaneIsUnreachable(t *testing.T) {
	h := NewSessionHub()
	closed := liveWith(h, "s1", "site-exp", "u1", "t1")
	recheckOnce(&fakeAccess{outage: true, deny: map[string]string{"site-exp": "expired"}}, h, nil)
	if *closed {
		t.Fatal("an outage must not cut sessions")
	}
}

func TestRecheckClosesAWebAppsWebSocket(t *testing.T) {
	closedA, closedB := false, false
	forgetA := watchWebSocket(&watchedWS{userID: "u1", siteID: "site-ok", token: "t1", close: func() { closedA = true }})
	defer forgetA()
	forgetB := watchWebSocket(&watchedWS{userID: "u1", siteID: "site-off", token: "t1", close: func() { closedB = true }})
	defer forgetB()
	recheckWebSockets(&fakeAccess{users: map[string]string{"t1": "u1"}, deny: map[string]string{"site-off": "off_schedule"}}, nil)
	if closedA || !closedB {
		t.Fatalf("ok=%v off=%v", closedA, closedB)
	}
}
