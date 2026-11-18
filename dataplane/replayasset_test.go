package main

import (
	"bytes"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/hashicorp/yamux"
	"github.com/kurtserdar/captivo-access/tunnel"
)

func TestReplayAsset(t *testing.T) {
	const host = "captivo.acme.cloud.captivo.io"
	cases := []struct {
		name, method, dest, referer, host string
		want                              bool
	}{
		{"tenant console image", "GET", "image", "https://acme.cloud.captivo.io/", host, true},
		{"tenant console stylesheet, full path", "GET", "style", "https://acme.cloud.captivo.io/admin/recordings/r1", host, true},
		{"manager host", "GET", "font", "https://platform.cloud.captivo.io/", host, true},
		{"the app's own page", "GET", "image", "https://captivo.acme.cloud.captivo.io/dashboard", host, false},
		{"another app", "GET", "image", "https://wiki.acme.cloud.captivo.io/", host, false},
		{"another tenant's console", "GET", "image", "https://globex.cloud.captivo.io/", host, false},
		{"navigation from the console", "GET", "document", "https://acme.cloud.captivo.io/", host, false},
		{"api call", "GET", "empty", "https://acme.cloud.captivo.io/", host, false},
		{"not a GET", "POST", "image", "https://acme.cloud.captivo.io/", host, false},
		{"no fetch metadata", "GET", "", "https://acme.cloud.captivo.io/", host, false},
		{"no referer", "GET", "image", "", host, false},
	}
	for _, c := range cases {
		r := httptest.NewRequest(c.method, "http://"+c.host+"/logo.svg", nil)
		if c.dest != "" {
			r.Header.Set("Sec-Fetch-Dest", c.dest)
		}
		if c.referer != "" {
			r.Header.Set("Referer", c.referer)
		}
		if got := replayAsset(r, c.host, "https://platform.cloud.captivo.io"); got != c.want {
			t.Errorf("%s: replayAsset = %v, want %v", c.name, got, c.want)
		}
	}
}

// A recording replay in the console loads the page's images through the proxy:
// they are served, but no web session starts and the request is logged as a replay.
func TestBrowserProxyReplayAssetIsNotASession(t *testing.T) {
	a, b := net.Pipe()
	srv, err := yamux.Server(a, tunnel.SessionConfig())
	if err != nil {
		t.Fatal(err)
	}
	cli, err := yamux.Client(b, tunnel.SessionConfig())
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	defer cli.Close()
	go func() {
		for {
			st, err := cli.Accept()
			if err != nil {
				return
			}
			go func() {
				defer st.Close()
				if _, err := tunnel.ReadFrame(st); err != nil {
					return
				}
				respBytes, _ := json.Marshal(tunnel.DialResponse{Status: http.StatusOK, Header: map[string][]string{"Content-Type": {"image/svg+xml"}}})
				_ = tunnel.WriteFrame(st, respBytes)
				_ = tunnel.WriteBody(st, bytes.NewReader([]byte("<svg/>")))
			}()
		}
	}()

	reg := NewRegistry()
	reg.Set("c1", &Session{mux: srv})
	ctrl := &fakeControl{userID: "u1", siteID: "s1", connID: "c1", upstream: "http://app.internal", allow: true, reason: "allow"}
	web := NewWebActivityTracker()
	p := &BrowserProxy{reg: reg, ctrl: ctrl, managerURL: "https://platform.example", audit: NewAuditQueue(100), web: web, webIdle: 5 * time.Minute}

	get := func(dest, referer string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "http://app.acme.example/logo.svg", nil)
		req.AddCookie(&http.Cookie{Name: "ca_session", Value: "tok"})
		req.Header.Set("Sec-Fetch-Dest", dest)
		req.Header.Set("Referer", referer)
		w := httptest.NewRecorder()
		p.ServeHTTP(w, req)
		return w
	}

	if w := get("image", "https://acme.example/"); w.Code != http.StatusOK || w.Body.String() != "<svg/>" {
		t.Fatalf("replay asset: %d %q, want it served", w.Code, w.Body.String())
	}
	if n := len(web.List(5 * time.Minute)); n != 0 {
		t.Fatalf("web sessions after a replay asset = %d, want 0", n)
	}
	evs := p.audit.drain(10)
	if len(evs) != 1 || evs[0].Reason != "replay" || evs[0].Decision != "ALLOW" {
		t.Fatalf("audit = %+v, want one ALLOW/replay", evs)
	}

	// The same image from the app's own page is use of the app.
	get("image", "http://app.acme.example/home")
	if n := len(web.List(5 * time.Minute)); n != 1 {
		t.Fatalf("web sessions after real use = %d, want 1", n)
	}
	evs = p.audit.drain(10)
	if len(evs) != 2 || evs[0].Reason != "session_open" || evs[1].Reason != "" {
		t.Fatalf("audit = %+v, want session_open then the request", evs)
	}
}
