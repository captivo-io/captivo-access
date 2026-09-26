package main

import (
	"strings"
	"testing"
)

// TestRrwebEventsNeverReachTheControlPlane is the slice-level contract for the one
// recording source that does not pass through the connector on its own: the
// visitor's browser posts straight to this proxy. The bytes must be split off to
// the connector and only the index may travel.
func TestRrwebEventsNeverReachTheControlPlane(t *testing.T) {
	ctrl := &fakeControl{}
	p := &BrowserProxy{ctrl: ctrl, reg: NewRegistry()}

	p.sendRrwebToConnector("c-offline", "acme", "u1", "s1", "host",
		[]byte(`{"recordingKey":"k9","seq":7,"events":[{"type":3,"data":{"text":"password123"}}]}`))

	body := string(ctrl.sentBody)
	if strings.Contains(body, "password123") || strings.Contains(body, "events") {
		t.Fatalf("event content reached the control plane: %s", body)
	}
	// Even with the connector offline the index must land, or an admin cannot tell
	// a session happened at all.
	if !strings.Contains(body, `"recordingKey":"k9"`) || !strings.Contains(body, `"seq":7`) {
		t.Fatalf("index did not reach the control plane: %s", body)
	}
}

func TestRrwebIgnoresAnUnparseableBatch(t *testing.T) {
	ctrl := &fakeControl{}
	p := &BrowserProxy{ctrl: ctrl, reg: NewRegistry()}
	p.sendRrwebToConnector("c1", "acme", "u1", "s1", "host", []byte("not json"))
	if len(ctrl.sentBody) != 0 {
		t.Fatalf("a malformed batch produced an index row: %s", ctrl.sentBody)
	}
}
