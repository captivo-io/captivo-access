package main

import (
	"encoding/json"
	"net"
	"testing"

	"github.com/hashicorp/yamux"
	"github.com/kurtserdar/captivo-access/tunnel"
)

// logPair is a data-plane Session whose connector side answers each stream with reply.
func logPair(t *testing.T, reply func(req []byte) any) *Session {
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
	go func() {
		for {
			st, err := conn.AcceptStream()
			if err != nil {
				return
			}
			req, err := tunnel.ReadFrame(st)
			if err != nil {
				return
			}
			out, _ := json.Marshal(reply(req))
			_ = tunnel.WriteFrame(st, out)
			st.Close()
		}
	}()
	return &Session{mux: dp}
}

func TestForwardLogsCarriesTheBatch(t *testing.T) {
	var seen tunnel.LogForwardRequest
	sess := logPair(t, func(req []byte) any {
		_ = json.Unmarshal(req, &seen)
		return tunnel.LogForwardResponse{Sent: len(seen.Messages), LatencyMs: 3}
	})
	resp, err := ForwardLogs(sess, tunnel.LogForwardRequest{Transport: "tls", Target: "siem.corp:6514", Messages: []string{"a", "b"}})
	if err != nil || resp.Sent != 2 {
		t.Fatalf("resp %+v err %v", resp, err)
	}
	if seen.Kind != "logforward" || seen.Transport != "tls" || seen.Target != "siem.corp:6514" {
		t.Fatalf("connector saw %+v", seen)
	}
}

func TestForwardLogsKnowsAnOldConnector(t *testing.T) {
	// What connector/handler.go's handleDial answers a frame it can't place.
	sess := logPair(t, func([]byte) any { return tunnel.DialResponse{Error: "bad upstream url"} })
	if _, err := ForwardLogs(sess, tunnel.LogForwardRequest{Transport: "udp", Target: "10.0.0.5:514"}); err != errLogForwardOld {
		t.Fatalf("err = %v", err)
	}
}

func TestForwardLogsReportsTheSendError(t *testing.T) {
	sess := logPair(t, func([]byte) any { return tunnel.LogForwardResponse{Error: "target not allowed"} })
	resp, err := ForwardLogs(sess, tunnel.LogForwardRequest{Transport: "tcp", Target: "10.0.0.5:514"})
	if err != nil || resp.Error != "target not allowed" {
		t.Fatalf("resp %+v err %v", resp, err)
	}
}
