package main

import (
	"encoding/json"
	"errors"
	"net"
	"testing"

	"github.com/hashicorp/yamux"
	"github.com/kurtserdar/captivo-access/tunnel"
)

// fakeConnector stands up a yamux pair and answers one recording frame the way a
// Slice-A connector does, recording what it received.
func fakeConnector(t *testing.T, ack tunnel.RecWriteResponse) (*Session, *tunnel.RecWriteRequest, func()) {
	t.Helper()
	a, b := net.Pipe()
	srv, err := yamux.Server(a, tunnel.SessionConfig())
	if err != nil {
		t.Fatal(err)
	}
	cli, err := yamux.Client(b, tunnel.SessionConfig())
	if err != nil {
		t.Fatal(err)
	}
	got := &tunnel.RecWriteRequest{}
	go func() {
		st, err := cli.Accept()
		if err != nil {
			return
		}
		defer st.Close()
		reqBytes, err := tunnel.ReadFrame(st)
		if err != nil {
			return
		}
		_ = json.Unmarshal(reqBytes, got)
		respBytes, _ := json.Marshal(ack)
		_ = tunnel.WriteFrame(st, respBytes)
	}()
	return &Session{mux: srv}, got, func() { srv.Close(); cli.Close() }
}

func TestWriteRecChunkSendsRecwriteAndReturnsAck(t *testing.T) {
	sess, got, cleanup := fakeConnector(t, tunnel.RecWriteResponse{Written: 7})
	defer cleanup()

	n, err := writeRecChunk(sess, tunnel.RecWriteRequest{
		TenantID: "acme", RecordingKey: "rec-1", Seq: 2,
		Format: "guac", Protocol: "ssh", Data: []byte("payload"),
	})
	if err != nil {
		t.Fatalf("write: %v", err)
	}
	if n != 7 {
		t.Fatalf("want the ack's count (7), got %d", n)
	}
	if got.Kind != "recwrite" {
		// The connector dispatches on Kind; an empty one falls through to
		// handleDial and the recording is silently lost.
		t.Fatalf("want kind recwrite, got %q", got.Kind)
	}
	if got.RecordingKey != "rec-1" || got.Seq != 2 || string(got.Data) != "payload" {
		t.Fatalf("request lost fields: %+v", got)
	}
}

func TestWriteRecChunkSurfacesConnectorError(t *testing.T) {
	sess, _, cleanup := fakeConnector(t, tunnel.RecWriteResponse{Error: "invalid tenant id"})
	defer cleanup()

	if _, err := writeRecChunk(sess, tunnel.RecWriteRequest{TenantID: "x", RecordingKey: "y"}); err == nil {
		t.Fatal("want the connector's error surfaced")
	}
}

func TestWriteRecChunkOfflineSessionDoesNotPanic(t *testing.T) {
	if _, err := writeRecChunk(nil, tunnel.RecWriteRequest{}); err == nil {
		t.Fatal("want an error for a nil session")
	}
	if _, err := writeRecChunk(&Session{}, tunnel.RecWriteRequest{}); err == nil {
		t.Fatal("want an error for a session with no mux")
	}
}

func TestRecUnsupportedIsASentinel(t *testing.T) {
	// Task 7 logs this once per session rather than once per chunk, so it must be
	// comparable with errors.Is rather than by string matching.
	if !errors.Is(errRecUnsupported, errRecUnsupported) {
		t.Fatal("errRecUnsupported must be a comparable sentinel")
	}
}
