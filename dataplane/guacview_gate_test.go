package main

import "testing"

func TestInstructionOpcode(t *testing.T) {
	for _, tc := range []struct{ raw, want string }{
		{"4.sync,13.1234567890123;", "sync"},
		{"3.key,5.65507,1.1;", "key"},
		{"5.mouse,3.100,3.200,1.1;", "mouse"},
		{"3.nop;", "nop"},
		{"4.size,1.0,4.1024,3.768;", "size"},
		{"", ""},
		{"notalength.x;", ""},
		{"9.sync,1.1;", ""}, // prefix longer than the value: unreadable, not "sync,1.1"
	} {
		if got := instructionOpcode([]byte(tc.raw)); got != tc.want {
			t.Errorf("instructionOpcode(%q) = %q, want %q", tc.raw, got, tc.want)
		}
	}
}

// A watching admin holds no control, and guacd disconnects a user it hears nothing
// from within 15 s. So the sync echo has to pass while input does not: gating the
// whole upstream direction killed the view seconds after it opened, and opening the
// direction entirely would let a spectator drive the vendor's session.
func TestViewerMayForward(t *testing.T) {
	const watching, controlling = false, true

	for _, op := range []string{"sync", "nop"} {
		if !viewerMayForward(op, watching) {
			t.Errorf("%q must pass for a watching viewer: guacd drops a silent user", op)
		}
	}
	for _, op := range []string{"key", "mouse", "size", "clipboard", "put", "ack", ""} {
		if viewerMayForward(op, watching) {
			t.Errorf("%q must NOT pass for a watching viewer: it would drive or mutate the shared session", op)
		}
		if !viewerMayForward(op, controlling) {
			t.Errorf("%q must pass once the viewer holds control", op)
		}
	}
}
