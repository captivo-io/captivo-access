package main

import (
	"encoding/json"
	"net"
	"testing"
	"time"

	"github.com/hashicorp/yamux"
	"github.com/kurtserdar/captivo-access/tunnel"
)

// hostPair is controlPair with the data-plane's Session handed back.
func hostPair(t *testing.T) (*Session, net.Conn) {
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
	sess := &Session{mux: dp}
	go runControl(sess, "c1", nil, "", "", RecordingPolicy{})
	st, err := conn.AcceptStream()
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ { // hello, policy
		if _, err := tunnel.ReadFrame(st); err != nil {
			t.Fatal(err)
		}
	}
	return sess, st
}

func TestHostActionNeverReachesAnOldConnector(t *testing.T) {
	sess, st := hostPair(t)
	// No telemetry yet, then telemetry without the hostctl fields: both are a
	// connector that would read the frame as a Policy.
	if _, err := sess.HostAction(tunnel.HostAction{ID: "act_0123456789", Action: "update", Version: "2.41.0"}, time.Second); err != errHostActionOld {
		t.Fatalf("no telemetry: %v", err)
	}
	sess.SetTelemetry(&tunnel.Telemetry{Version: "2.40.0"})
	if _, err := sess.HostAction(tunnel.HostAction{ID: "act_0123456789", Action: "update", Version: "2.41.0"}, time.Second); err != errHostActionOld {
		t.Fatalf("old telemetry: %v", err)
	}
	_ = st.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
	if f, err := tunnel.ReadFrame(st); err == nil {
		t.Fatalf("a frame reached the old connector: %s", f)
	}
}

func TestHostActionWaitsForTheAck(t *testing.T) {
	sess, st := hostPair(t)
	sess.SetTelemetry(&tunnel.Telemetry{Version: "2.41.0", Updater: &tunnel.UpdaterInfo{Version: "2.41.0", DockerOK: true}})

	go func() {
		f, err := tunnel.ReadFrame(st)
		if err != nil {
			return
		}
		var a tunnel.HostAction
		_ = json.Unmarshal(f, &a)
		// Another id first: must not be taken for ours.
		other, _ := json.Marshal(tunnel.HostActionAck{Kind: "hostactionack", ID: "act_somebody_else"})
		_ = tunnel.WriteFrame(st, other)
		code := ""
		if a.Kind != "hostaction" || a.Action != "uninstall" || !a.KeepData {
			code = "invalid"
		}
		ack, _ := json.Marshal(tunnel.HostActionAck{Kind: "hostactionack", ID: a.ID, Error: code})
		_ = tunnel.WriteFrame(st, ack)
	}()
	ack, err := sess.HostAction(tunnel.HostAction{ID: "act_0123456789", Action: "uninstall", KeepData: true}, 5*time.Second)
	if err != nil || ack.ID != "act_0123456789" || ack.Error != "" {
		t.Fatalf("ack %+v err %v", ack, err)
	}
}

func TestHostActionTimesOut(t *testing.T) {
	sess, st := hostPair(t)
	sess.SetTelemetry(&tunnel.Telemetry{Version: "2.41.0", Updater: &tunnel.UpdaterInfo{Version: "2.41.0"}})
	go func() { _, _ = tunnel.ReadFrame(st) }() // reads, never answers
	if _, err := sess.HostAction(tunnel.HostAction{ID: "act_0123456789", Action: "update", Version: "2.41.0"}, 300*time.Millisecond); err != errHostActionTimeout {
		t.Fatalf("err %v", err)
	}
}
