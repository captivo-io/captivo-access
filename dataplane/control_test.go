package main

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/hashicorp/yamux"
	"github.com/kurtserdar/captivo-access/tunnel"
)

// controlPair runs runControl over an in-memory yamux session and returns the
// connector's end of the control stream, after the hello and the opening policy.
func controlPair(t *testing.T, ctrl *ControlClient) net.Conn {
	t.Helper()
	a, b := net.Pipe()
	dp, err := yamux.Client(a, nil)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := yamux.Server(b, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { dp.Close(); conn.Close() })
	go runControl(&Session{mux: dp}, "c1", ctrl, "", "", RecordingPolicy{})
	st, err := conn.AcceptStream()
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ { // hello, policy
		if _, err := tunnel.ReadFrame(st); err != nil {
			t.Fatal(err)
		}
	}
	return st
}

func TestControlRelaysARecordingReportAndAcksIt(t *testing.T) {
	var got struct {
		ConnectorID string                 `json:"connectorId"`
		Items       []tunnel.RecReportItem `json:"items"`
	}
	var calls atomic.Int32
	cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/internal/recording/report" || r.Header.Get("x-dataplane-secret") != "s" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		calls.Add(1)
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer cp.Close()
	st := controlPair(t, NewControlClient(cp.URL, "s"))

	item := tunnel.RecReportItem{TenantID: "t1", RecordingKey: "k1", Video: true, DurationMs: 9000, StoredBytes: 1234}
	b, _ := json.Marshal(tunnel.RecReport{Kind: "recreport", Items: []tunnel.RecReportItem{item}})
	if err := tunnel.WriteFrame(st, b); err != nil {
		t.Fatal(err)
	}
	_ = st.SetReadDeadline(time.Now().Add(5 * time.Second))
	f, err := tunnel.ReadFrame(st)
	if err != nil {
		t.Fatalf("no ack: %v", err)
	}
	var ack tunnel.RecReportAck
	if err := json.Unmarshal(f, &ack); err != nil || ack.Kind != "recreportack" || len(ack.Items) != 1 || ack.Items[0] != item {
		t.Fatalf("ack %s", f)
	}
	if calls.Load() != 1 || got.ConnectorID != "c1" || len(got.Items) != 1 || got.Items[0] != item {
		t.Fatalf("relayed %+v", got)
	}
}

func TestControlDoesNotAckAReportTheControlPlaneRefused(t *testing.T) {
	cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer cp.Close()
	st := controlPair(t, NewControlClient(cp.URL, "s"))

	b, _ := json.Marshal(tunnel.RecReport{Kind: "recreport", Items: []tunnel.RecReportItem{{TenantID: "t1", RecordingKey: "k1"}}})
	if err := tunnel.WriteFrame(st, b); err != nil {
		t.Fatal(err)
	}
	_ = st.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	if f, err := tunnel.ReadFrame(st); err == nil {
		t.Fatalf("acked a report that was not recorded: %s", f)
	}
}

func TestVersionAtLeast(t *testing.T) {
	for _, c := range []struct {
		v    string
		want bool
	}{
		{"2.22.0", true}, {"v2.22.1", true}, {"2.23.0-rc1", true}, {"3.0.0", true},
		{"2.21.9", false}, {"2.9.99", false}, {"dev", false}, {"", false},
	} {
		if got := versionAtLeast(c.v, "2.22.0"); got != c.want {
			t.Fatalf("versionAtLeast(%q) = %v", c.v, got)
		}
	}
}

func TestNotifyRecDoneOnlyToConnectorsThatKnowIt(t *testing.T) {
	for _, c := range []struct {
		version string
		want    bool
	}{{"2.22.0", true}, {"2.21.0", false}, {"", false}} {
		a, b := net.Pipe()
		dp, _ := yamux.Client(a, nil)
		conn, _ := yamux.Server(b, nil)
		s := &Session{mux: dp}
		if c.version != "" {
			s.SetTelemetry(&tunnel.Telemetry{Version: c.version})
		}
		got := make(chan []byte, 1)
		go func() {
			st, err := conn.AcceptStream()
			if err != nil {
				return
			}
			f, _ := tunnel.ReadFrame(st)
			got <- f
		}()
		notifyRecDone(s, "t1", "k1")
		select {
		case f := <-got:
			var d tunnel.RecDone
			if !c.want || json.Unmarshal(f, &d) != nil || d.Kind != "recdone" || d.TenantID != "t1" || d.RecordingKey != "k1" {
				t.Fatalf("version %q: sent %s", c.version, f)
			}
		case <-time.After(300 * time.Millisecond):
			if c.want {
				t.Fatalf("version %q: nothing sent", c.version)
			}
		}
		dp.Close()
		conn.Close()
	}
}
