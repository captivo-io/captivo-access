package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type fakeGuestAuth struct {
	users map[string]string // session token -> user id
	may   map[string]bool   // user id -> may watch the site
	pass  GuestPass
	err   error
	asked []string // guest tokens asked about
}

func (f *fakeGuestAuth) ResolveSession(token string) (string, string, error) {
	return f.users[token], "", nil
}
func (f *fakeGuestAuth) ViewAuthz(userID, siteID string) (bool, error) { return f.may[userID], nil }
func (f *fakeGuestAuth) GuestAuthz(token, sessionID, siteID string) (GuestPass, error) {
	f.asked = append(f.asked, token+"|"+sessionID+"|"+siteID)
	return f.pass, f.err
}

func viewReq(cookies map[string]string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/guac-view?session=s1", nil)
	for k, v := range cookies {
		r.AddCookie(&http.Cookie{Name: k, Value: v})
	}
	return r
}

func TestViewerOfTellsAdminsGuestsAndStrangersApart(t *testing.T) {
	ls := &liveSession{id: "s1", siteID: "site1"}
	until := time.Now().Add(time.Hour)
	f := &fakeGuestAuth{users: map[string]string{"tok": "admin1", "tok2": "staff1"}, may: map[string]bool{"admin1": true},
		pass: GuestPass{Allow: true, ViewerID: "guest:inv1", Name: "Ayşe Yılmaz", Until: until}}

	if _, st := viewerOf(f, viewReq(nil), ls); st != http.StatusUnauthorized {
		t.Fatalf("no cookie: %d", st)
	}
	v, st := viewerOf(f, viewReq(map[string]string{"ca_session": "tok"}), ls)
	if st != 0 || v.id != "admin1" || v.guest || v.who() != adminWho {
		t.Fatalf("admin: %+v %d", v, st)
	}
	// A console user who may not watch is not let in, and with no guest pass that is all.
	if _, st := viewerOf(f, viewReq(map[string]string{"ca_session": "tok2"}), ls); st != http.StatusForbidden {
		t.Fatalf("staff: %d", st)
	}
	v, st = viewerOf(f, viewReq(map[string]string{guestCookie: "g"}), ls)
	if st != 0 || !v.guest || v.id != "guest:inv1" || v.who() != "Ayşe Yılmaz (guest)" || !v.until.Equal(until) {
		t.Fatalf("guest: %+v %d", v, st)
	}
	if f.asked[len(f.asked)-1] != "g|s1|site1" {
		t.Fatalf("asked %v", f.asked)
	}

	// The manager's word is all that counts, and a pass must look like a guest's and be in date.
	for _, p := range []GuestPass{
		{Allow: false, ViewerID: "guest:inv1", Until: until},
		{Allow: true, ViewerID: "admin1", Until: until},
		{Allow: true, ViewerID: "guest:", Until: until},
		{Allow: true, ViewerID: "guest:inv1", Until: time.Now().Add(-time.Second)},
	} {
		f.pass = p
		if _, st := viewerOf(f, viewReq(map[string]string{guestCookie: "g"}), ls); st != http.StatusForbidden {
			t.Fatalf("pass %+v let in: %d", p, st)
		}
	}
	f.pass, f.err = GuestPass{Allow: true, ViewerID: "guest:inv1", Until: until}, errors.New("down")
	if _, st := viewerOf(f, viewReq(map[string]string{guestCookie: "g"}), ls); st != http.StatusForbidden {
		t.Fatal("a manager that did not answer let a guest in")
	}
}

func TestKickViewerEndsAGuestsViewsAndControl(t *testing.T) {
	hub := NewSessionHub()
	ls := hub.Register("s1", "site1", "u1", "rdp", "h", time.Now(), "c1", "conn", "guacd")
	g := watcher{id: "guest:inv1", name: "Ayşe", guest: true, until: time.Now().Add(time.Hour)}
	gctx, gdone := ls.watch(context.Background(), g)
	defer gdone()
	actx, adone := ls.watch(context.Background(), watcher{id: "admin1"})
	defer adone()

	if w, guests, by := hub.WatchStatus("u1", "site1"); !w || len(guests) != 1 || guests[0] != "Ayşe" || by != "" {
		t.Fatalf("status %v %v %q", w, guests, by)
	}
	if err := hub.SetControlAs("s1", g.id, g.who(), false); err != nil {
		t.Fatal(err)
	}
	if _, _, by := hub.WatchStatus("u1", "site1"); by != "Ayşe (guest)" {
		t.Fatalf("control by %q", by)
	}
	if !hub.KickViewer("s1", g.id) {
		t.Fatal("not found")
	}
	select {
	case <-gctx.Done():
	case <-time.After(time.Second):
		t.Fatal("the guest's view stayed open")
	}
	if actx.Err() != nil {
		t.Fatal("the admin's view was closed too")
	}
	if !ls.vendorInputAllowed() {
		t.Fatal("the removed guest kept control")
	}
	gdone()
	if _, guests, _ := hub.WatchStatus("u1", "site1"); len(guests) != 0 {
		t.Fatalf("guests %v", guests)
	}
}

func TestAGuestsViewEndsWithTheInvite(t *testing.T) {
	ls := &liveSession{id: "s1"}
	ctx, done := ls.watch(context.Background(), watcher{id: "guest:inv1", guest: true, until: time.Now().Add(30 * time.Millisecond)})
	defer done()
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("the view outlived the invite")
	}
}

func TestAnAdminTakesControlBackFromAGuestOnly(t *testing.T) {
	var said []string
	ls := &liveSession{id: "s1", native: true}
	ls.setTakeover(func([]byte) {}, func(taken bool, who string) {
		if taken {
			said = append(said, who)
		} else {
			said = append(said, "back")
		}
	})
	if err := ls.setControlAs("guest:inv1", "Ayşe (guest)", false); err != nil {
		t.Fatal(err)
	}
	// Another guest can't take it, forced or not; an admin can.
	if err := ls.setControlAs("guest:inv2", "Ali (guest)", true); !errors.Is(err, errControlHeld) {
		t.Fatalf("second guest: %v", err)
	}
	if err := ls.setControlAs("admin1", adminWho, false); !errors.Is(err, errControlHeld) {
		t.Fatalf("admin without force: %v", err)
	}
	if err := ls.setControlAs("admin1", adminWho, true); err != nil {
		t.Fatal(err)
	}
	if !ls.viewerInputAllowed("admin1") || ls.viewerInputAllowed("guest:inv1") {
		t.Fatal("control did not move to the admin")
	}
	// Admin to admin is never forced.
	if err := ls.setControlAs("admin2", adminWho, true); !errors.Is(err, errControlHeld) {
		t.Fatalf("admin over admin: %v", err)
	}
	ls.releaseControl("admin1")
	if len(said) != 3 || said[0] != "Ayşe (guest)" || said[1] != adminWho || said[2] != "back" {
		t.Fatalf("hook heard %v", said)
	}
}

func TestRdpControlHandOverReleasesTheGuestsKeys(t *testing.T) {
	var sent bytes.Buffer
	w := bufio.NewWriter(&sent)
	var typed []keyEvent
	c := newRdpControl(time.Now(), nil, func(evs []keyEvent) { typed = append(typed, evs...) })
	_ = c.relayClient(w, fastPathPDU([][]byte{{fpEventSync << 5}}), true, nil)
	c.setHeldBy(true, "Ayşe (guest)")
	sent.Reset()
	// The guest holds Ctrl and types.
	c.fromAdmin(encodeInstruction("key", "65507", "1"))
	c.fromAdmin(append(encodeInstruction("key", "97", "1"), encodeInstruction("key", "97", "0")...))
	sent.Reset()
	c.setHeldBy(true, adminWho)
	ev := events(t, sent.Bytes())
	if len(ev) != 1 || !bytes.Equal(ev[0], fpScancode(0x1D, false)) {
		t.Fatalf("hand-over released %x", ev)
	}
	if !c.held || c.who != adminWho {
		t.Fatal("control did not stay held by the admin")
	}
	for _, e := range typed {
		if e.By != "guest" {
			t.Fatalf("the guest's typing marked %q", e.By)
		}
	}
}
