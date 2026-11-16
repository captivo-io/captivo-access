package main

import (
	"encoding/json"
	"net"
	"net/http"
	"strings"
	"testing"

	"github.com/hashicorp/yamux"
	"github.com/kurtserdar/captivo-access/tunnel"
)

// answerEgress plays a connector answering one egress call with resp.
func answerEgress(t *testing.T, resp any) (*Session, *tunnel.EgressRequest, func()) {
	t.Helper()
	a, b := net.Pipe()
	srv, _ := yamux.Server(a, tunnel.SessionConfig())
	cli, _ := yamux.Client(b, tunnel.SessionConfig())
	got := &tunnel.EgressRequest{}
	go func() {
		st, err := cli.Accept()
		if err != nil {
			return
		}
		defer st.Close()
		rb, _ := tunnel.ReadFrame(st)
		_ = json.Unmarshal(rb, got)
		out, _ := json.Marshal(resp)
		_ = tunnel.WriteFrame(st, out)
	}()
	return &Session{mux: srv}, got, func() { srv.Close(); cli.Close() }
}

func TestEgressRegisterCarriesTheRule(t *testing.T) {
	sess, got, done := answerEgress(t, tunnel.EgressResponse{Token: "t1", Proxy: "access-connector:3128"})
	defer done()
	out, err := egressCall(sess, tunnel.EgressRequest{Op: "register", Mode: "internet", Hosts: []string{"crm.local"}, ReportOnly: true})
	if err != nil || out.Token != "t1" || out.Proxy != "access-connector:3128" {
		t.Fatalf("%+v %v", out, err)
	}
	if got.Kind != "egress" || got.Op != "register" || got.Mode != "internet" || !got.ReportOnly || got.Hosts[0] != "crm.local" {
		t.Fatalf("sent %+v", got)
	}
}

// A connector that predates the proxy answers an unknown kind like a failed
// dial: no token, so the session runs as before instead of failing.
func TestEgressOnAnOlderConnectorGivesNoToken(t *testing.T) {
	sess, _, done := answerEgress(t, map[string]string{"error": "invalid url"})
	defer done()
	out, err := egressCall(sess, tunnel.EgressRequest{Op: "register"})
	if err == nil || out.Token != "" {
		t.Fatalf("%+v %v", out, err)
	}
}

func TestEgressEventsBecomeAuditEvents(t *testing.T) {
	r, _ := http.NewRequest(http.MethodGet, "http://x/kasm-tunnel/websockify", nil)
	ev := egressAudit([]tunnel.EgressEvent{
		{Dest: "10.0.0.5:445", Reason: "internal network", Count: 3, Blocked: true},
		{Dest: "files.local:80", Reason: "internal network", Count: 1},
	}, "u1", "s1", r)
	if len(ev) != 2 || ev[0].Decision != "DENY" || ev[0].Host != "10.0.0.5:445" || ev[0].Reason != "egress_blocked internal network x3" || ev[0].SiteID != "s1" {
		t.Fatalf("%+v", ev[0])
	}
	if ev[1].Decision != "ALLOW" || !strings.HasPrefix(ev[1].Reason, "egress_would_block ") {
		t.Fatalf("%+v", ev[1])
	}
}

func TestOpenKasmSessionSendsTheProxy(t *testing.T) {
	var buf strings.Builder
	rw := struct {
		*strings.Reader
		*strings.Builder
	}{strings.NewReader("HTTP/1.0 201 Created\r\nContent-Type: application/json\r\n\r\n{\"id\":\"s1\",\"port\":6902}"), &buf}
	if _, _, _, _, err := openKasmSession(rw, "k:7900", "", "https://x", true, true, 1280, 800, "", false, false, "access-connector:3128", "abcd"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(buf.String(), `"proxy":"access-connector:3128","proxyToken":"abcd"`) {
		t.Fatalf("%s", buf.String())
	}
}
