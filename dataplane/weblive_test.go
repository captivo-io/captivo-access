package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func batch(key string, events ...string) []byte {
	return []byte(`{"recordingKey":"` + key + `","seq":0,"events":[` + strings.Join(events, ",") + `]}`)
}

func TestWebLiveHub_JoiningViewerGetsTheCurrentPage(t *testing.T) {
	h := NewWebLiveHub()
	h.Feed("u1", "s1", "app.acme.test", batch("tab1", `{"type":4,"n":1}`, `{"type":2,"n":2}`, `{"type":3,"n":3}`))
	// A new page (Meta) replaces the old one: the viewer must not get page 1's DOM.
	h.Feed("u1", "s1", "app.acme.test", batch("tab1", `{"type":4,"n":4}`, `{"type":2,"n":5}`))

	siteID, page, ch, cancel, ok := h.Subscribe("tab1")
	if !ok || siteID != "s1" {
		t.Fatalf("subscribe: ok=%v site=%q", ok, siteID)
	}
	defer cancel()
	if got := string(mustJSON(page)); got != `[{"type":4,"n":4},{"type":2,"n":5}]` {
		t.Fatalf("page = %s", got)
	}
	h.Feed("u1", "s1", "app.acme.test", batch("tab1", `{"type":3,"n":6}`))
	select {
	case ev := <-ch:
		if string(mustJSON(ev)) != `[{"type":3,"n":6}]` {
			t.Fatalf("live batch = %s", mustJSON(ev))
		}
	case <-time.After(time.Second):
		t.Fatal("live batch not delivered")
	}
	if h.Viewers("tab1") != 1 {
		t.Fatalf("viewers = %d", h.Viewers("tab1"))
	}
}

func TestWebLiveHub_ListAndIdle(t *testing.T) {
	h := NewWebLiveHub()
	now := time.Unix(1_700_000_000, 0)
	h.now = func() time.Time { return now }
	h.Feed("u1", "s1", "h", batch("old", `{"type":4}`))
	now = now.Add(10 * time.Second)
	h.Feed("u1", "s1", "h", batch("new", `{"type":4}`))
	if k := h.LiveKeys()["u1"+webKeySep+"s1"]; k != "new" {
		t.Fatalf("live key = %q, want the most recent tab", k)
	}
	now = now.Add(webLiveIdle + time.Second)
	if _, _, _, _, ok := h.Subscribe("new"); ok {
		t.Fatal("an idle tab must not be watchable")
	}
	if len(h.LiveKeys()) != 0 {
		t.Fatal("idle tabs must leave the list")
	}
}

func TestWebLiveHub_OversizedPageWaitsForTheNext(t *testing.T) {
	h := NewWebLiveHub()
	big := `{"type":2,"x":"` + strings.Repeat("a", webLiveMaxPage) + `"}`
	h.Feed("u1", "s1", "h", batch("t", `{"type":4}`, big))
	_, page, _, cancel, _ := h.Subscribe("t")
	cancel()
	if len(page) != 0 {
		t.Fatal("a page that cannot be rebuilt must not be sent")
	}
	h.Feed("u1", "s1", "h", batch("t", `{"type":4}`, `{"type":2}`))
	_, page, _, cancel, _ = h.Subscribe("t")
	cancel()
	if len(page) != 2 {
		t.Fatalf("next page not kept: %d events", len(page))
	}
}

type fakeViewAuth struct {
	user  string
	allow bool
}

func (f fakeViewAuth) ResolveSession(string) (string, string, error) { return f.user, "", nil }
func (f fakeViewAuth) ViewAuthz(string, string) (bool, error)         { return f.allow, nil }

func TestServeWebView_Refusals(t *testing.T) {
	h := NewWebLiveHub()
	h.Feed("u1", "s1", "h", batch("tab", `{"type":4}`))
	req := func(key string, cookie bool) *http.Request {
		r := httptest.NewRequest(http.MethodGet, "/web-view?key="+key, nil)
		if cookie {
			r.AddCookie(&http.Cookie{Name: "ca_session", Value: "tok"})
		}
		return r
	}
	for _, c := range []struct {
		name string
		auth fakeViewAuth
		r    *http.Request
		want int
	}{
		{"no cookie", fakeViewAuth{"admin", true}, req("tab", false), http.StatusUnauthorized},
		{"unknown tab", fakeViewAuth{"admin", true}, req("nope", true), http.StatusNotFound},
		{"not allowed to watch", fakeViewAuth{"admin", false}, req("tab", true), http.StatusForbidden},
		{"no key", fakeViewAuth{"admin", true}, req("", true), http.StatusBadRequest},
	} {
		rec := httptest.NewRecorder()
		serveWebView(h, c.auth, rec, c.r)
		if rec.Code != c.want {
			t.Errorf("%s: status %d, want %d", c.name, rec.Code, c.want)
		}
	}
	if h.Viewers("tab") != 0 {
		t.Fatal("a refused viewer must not stay subscribed")
	}
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

// The recorder asks this to show the vendor "being monitored" while an admin
// watches -- the notice gateway and isolated sessions already show.
func TestServeRecording_WatchedAnswersForTheTab(t *testing.T) {
	h := NewWebLiveHub()
	h.Feed("u1", "s1", "h", batch("tab", `{"type":4}`))
	p := &BrowserProxy{ctrl: &fakeControl{}, live: h}
	ask := func() string {
		rec := httptest.NewRecorder()
		p.serveRecording(rec, httptest.NewRequest(http.MethodGet, "/__captivo/watched?key=tab", nil), "u1", "s1", "h", "c1", "acme", true, false)
		return rec.Body.String()
	}
	if got := ask(); got != `{"watching":0}` {
		t.Fatalf("nobody watching: %s", got)
	}
	_, _, _, cancel, _ := h.Subscribe("tab")
	if got := ask(); got != `{"watching":1}` {
		t.Fatalf("one admin watching: %s", got)
	}
	cancel()
	if got := ask(); got != `{"watching":0}` {
		t.Fatalf("admin left: %s", got)
	}
}
