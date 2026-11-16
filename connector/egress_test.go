package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/kurtserdar/captivo-access/tunnel"
)

func fakeResolve(m map[string]string) egressResolver {
	return func(_ context.Context, host string) ([]net.IP, error) {
		v, ok := m[host]
		if !ok {
			return nil, fmt.Errorf("no such host")
		}
		var out []net.IP
		for _, s := range strings.Split(v, ",") {
			out = append(out, net.ParseIP(s))
		}
		return out, nil
	}
}

func TestEgressDecisions(t *testing.T) {
	open, _ := ParseAllowedTargets("")
	dns := fakeResolve(map[string]string{
		"crm.corp.local":    "10.0.0.20",
		"files.corp.local":  "10.0.0.30",
		"login.example.com": "203.0.113.10",
		"rebind.evil.com":   "10.0.0.5",
		"meta.evil.com":     "169.254.169.254",
		"mixed.example.com": "10.0.0.9,203.0.113.11",
		"sso.okta.com":      "203.0.113.12",
		"self.evil.com":     "127.0.0.1",
	})
	cases := []struct {
		mode, host, wantTo, wantWhy string
	}{
		// Default: the resource (even internal) and the internet; nothing else internal.
		{"internet", "crm.corp.local", "10.0.0.20:443", ""},
		{"internet", "login.example.com", "203.0.113.10:443", ""},
		{"internet", "files.corp.local", "", "internal network"},
		{"internet", "10.0.0.5", "", "internal network"},
		{"internet", "rebind.evil.com", "", "internal network"},
		{"internet", "mixed.example.com", "203.0.113.11:443", ""}, // only its public address
		{"internet", "meta.evil.com", "", "never allowed"},
		{"internet", "169.254.169.254", "", "never allowed"},
		{"internet", "self.evil.com", "", "never allowed"},
		{"internet", "access-connector", "", "connector service"},
		{"internet", "captivo-guacd", "", "connector service"},
		// Strict: only the listed hosts (wildcards too).
		{"strict", "crm.corp.local", "10.0.0.20:443", ""},
		{"strict", "sso.okta.com", "203.0.113.12:443", ""},
		{"strict", "login.example.com", "", "not on the resource's list"},
		// Open: anything but the never-allowed.
		{"open", "files.corp.local", "10.0.0.30:443", ""},
		{"open", "meta.evil.com", "", "never allowed"},
	}
	for _, c := range cases {
		r := &egressRule{mode: c.mode, hosts: []string{"crm.corp.local", "*.okta.com"}, events: map[string]*tunnel.EgressEvent{}}
		to, why := decide(context.Background(), r, open, dns, c.host, "443")
		if to != c.wantTo || why != c.wantWhy {
			t.Errorf("%s %s: got (%q, %q) want (%q, %q)", c.mode, c.host, to, why, c.wantTo, c.wantWhy)
		}
	}
}

func TestEgressReportOnlyRecordsButAllows(t *testing.T) {
	open, _ := ParseAllowedTargets("")
	dns := fakeResolve(map[string]string{"files.corp.local": "10.0.0.30", "meta.evil.com": "169.254.169.254"})
	r := &egressRule{mode: "internet", reportOnly: true, events: map[string]*tunnel.EgressEvent{}}
	for i := 0; i < 3; i++ {
		if to, why := decide(context.Background(), r, open, dns, "files.corp.local", "80"); to != "10.0.0.30:80" || why != "" {
			t.Fatalf("report-only must allow: %q %q", to, why)
		}
	}
	if _, why := decide(context.Background(), r, open, dns, "meta.evil.com", "80"); why == "" {
		t.Fatal("never-allowed stays blocked in report-only")
	}
	ev := r.events["files.corp.local:80"]
	if ev == nil || ev.Count != 3 || ev.Blocked || ev.Reason != "internal network" {
		t.Fatalf("event: %+v", ev)
	}
	if !r.events["meta.evil.com:80"].Blocked {
		t.Fatal("metadata attempt is recorded as blocked")
	}
}

func TestEgressRespectsTheConnectorsAllowedTargets(t *testing.T) {
	only, _ := ParseAllowedTargets("crm.corp.local")
	dns := fakeResolve(map[string]string{"files.corp.local": "10.0.0.30", "login.example.com": "203.0.113.10"})
	r := &egressRule{mode: "open", events: map[string]*tunnel.EgressEvent{}}
	if _, why := decide(context.Background(), r, only, dns, "files.corp.local", "443"); why == "" {
		t.Fatal("internal destinations stay inside ALLOWED_TARGETS")
	}
	if _, why := decide(context.Background(), r, only, dns, "login.example.com", "443"); why != "" {
		t.Fatalf("internet destinations are not ALLOWED_TARGETS' business: %s", why)
	}
}

// Through the real proxy: a session without a token gets 407; with one, an
// allowed site loads (plain HTTP and CONNECT) and a refused one gets 403; the
// release hands back what was refused.
func TestEgressProxyEndToEnd(t *testing.T) {
	egressNeverAllowed = func(net.IP) bool { return false }
	defer func() { egressNeverAllowed = neverAllowed }()
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Proxy-Authorization") != "" {
			t.Error("the token must not reach the site")
		}
		_, _ = io.WriteString(w, "hello from the resource")
	}))
	defer site.Close()
	_, port, _ := net.SplitHostPort(strings.TrimPrefix(site.URL, "http://"))
	open, _ := ParseAllowedTargets("")
	p := httptest.NewServer(&egressProxy{allow: open, resolve: fakeResolve(map[string]string{"res.test": "127.0.0.1", "other.test": "10.0.0.1"})})
	defer p.Close()

	tok, _ := registerEgress(tunnel.EgressRequest{Mode: "strict", Hosts: []string{"res.test"}})
	pu, _ := url.Parse(p.URL)
	client := func(user *url.Userinfo) *http.Client {
		u := *pu
		u.User = user
		return &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(&u)}}
	}

	resp, err := client(nil).Get("http://res.test:" + port + "/")
	if err != nil || resp.StatusCode != http.StatusProxyAuthRequired {
		t.Fatalf("no token: %v %v", err, resp)
	}
	resp, err = client(url.UserPassword("s", tok)).Get("http://res.test:" + port + "/")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "hello from the resource" {
		t.Fatalf("allowed: %d %q", resp.StatusCode, body)
	}
	resp, err = client(url.UserPassword("s", tok)).Get("http://other.test:" + port + "/")
	if err != nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("refused: %v %v", err, resp)
	}

	// CONNECT (what HTTPS uses).
	c, err := net.Dial("tcp", pu.Host)
	if err != nil {
		t.Fatal(err)
	}
	auth := base64.StdEncoding.EncodeToString([]byte("s:" + tok))
	fmt.Fprintf(c, "CONNECT res.test:%s HTTP/1.1\r\nHost: res.test:%s\r\nProxy-Authorization: Basic %s\r\n\r\n", port, port, auth)
	br := bufio.NewReader(c)
	line, _ := br.ReadString('\n')
	if !strings.Contains(line, "200") {
		t.Fatalf("connect: %q", line)
	}
	_, _ = br.ReadString('\n')
	fmt.Fprintf(c, "GET / HTTP/1.1\r\nHost: res.test\r\nConnection: close\r\n\r\n")
	rest, _ := io.ReadAll(br)
	c.Close()
	if !strings.Contains(string(rest), "hello from the resource") {
		t.Fatalf("tunnelled: %q", rest)
	}

	ev := releaseEgress(tok)
	if len(ev) != 1 || ev[0].Dest != "other.test:"+port || !ev[0].Blocked {
		t.Fatalf("events: %+v", ev)
	}
	if egressRuleFor(tok) != nil {
		t.Fatal("released")
	}
}
