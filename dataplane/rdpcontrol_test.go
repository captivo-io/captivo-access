package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"testing"
	"time"
)

// events reads the input events of the fast-path PDUs in b.
func events(t *testing.T, b []byte) [][]byte {
	t.Helper()
	var out [][]byte
	for len(b) > 0 {
		pdu, err := readPDU(bufio.NewReader(bytes.NewReader(b)))
		if err != nil {
			t.Fatalf("bad PDU %x: %v", b, err)
		}
		b = b[len(pdu):]
		p := 2
		if pdu[1]&0x80 != 0 {
			p = 3
		}
		for i := 0; i < int(pdu[0]>>2)&0x0F; i++ {
			size := map[byte]int{fpEventScancode: 2, fpEventUnicode: 3, fpEventMouse: 7, fpEventSync: 1}[pdu[p]>>5]
			out = append(out, pdu[p:p+size])
			p += size
		}
	}
	return out
}

func TestRdpControlHandsInputOver(t *testing.T) {
	var sent bytes.Buffer
	w := bufio.NewWriter(&sent)
	var pointer [][2]uint16
	var typed []keyEvent
	c := newRdpControl(time.Now(), func(x, y uint16) { pointer = append(pointer, [2]uint16{x, y}) }, func(evs []keyEvent) { typed = append(typed, evs...) })
	relay := func(pdu []byte) { t.Helper(); _ = c.relayClient(w, pdu, true, nil) }
	take := func() []byte { sent.Reset(); return sent.Bytes() }

	// The user holds Shift and the left button, with Caps Lock on.
	relay(fastPathPDU([][]byte{{fpEventSync<<5 | syncCapsLock}, fpScancode(0x2A, true), fpMouse(fpPtrButton1|fpPtrDown, 10, 20)}))
	if sent.Len() == 0 {
		t.Fatal("the user's input did not go on")
	}
	take()

	// Taking control releases them.
	c.setHeld(true)
	ev := events(t, sent.Bytes())
	if len(ev) != 2 || !bytes.Equal(ev[0], fpScancode(0x2A, false)) || !bytes.Equal(ev[1], fpMouse(fpPtrButton1, 10, 20)) {
		t.Fatalf("released %x", ev)
	}
	take()

	// The user's input is dropped; a slow-path PDU still goes on.
	relay(fastPathPDU([][]byte{fpScancode(0x1E, true)}))
	if sent.Len() != 0 {
		t.Fatal("the user typed while an admin held control")
	}
	slow := []byte{3, 0, 0, 8, 2, 0xf0, 0x80, 0}
	relay(slow)
	if !bytes.Equal(sent.Bytes(), slow) {
		t.Fatal("a slow-path PDU was held back")
	}
	take()

	// Text as Unicode (ğ, whatever the server's layout); Ctrl+C as scancodes; Enter.
	c.fromAdmin(append(append(encodeInstruction("key", "287", "1"), encodeInstruction("key", "16777503", "1")...), encodeInstruction("key", "16777503", "0")...))
	ev = events(t, sent.Bytes())
	if len(ev) != 2 || !bytes.Equal(ev[0], fpUnicode(0x011F, true)) || !bytes.Equal(ev[1], fpUnicode(0x011F, false)) {
		t.Fatalf("ğ as %x", ev)
	}
	take()
	c.fromAdmin(append(encodeInstruction("key", "65507", "1"), encodeInstruction("key", "99", "1")...))
	ev = events(t, sent.Bytes())
	if len(ev) != 2 || !bytes.Equal(ev[0], fpScancode(0x1D, true)) || !bytes.Equal(ev[1], fpScancode(0x2E, true)) {
		t.Fatalf("Ctrl+C as %x", ev)
	}
	take()

	// The mouse: a move with the left button down, then the wheel.
	c.fromAdmin(encodeInstruction("mouse", "300", "200", "1"))
	c.fromAdmin(encodeInstruction("mouse", "300", "200", "9"))
	ev = events(t, sent.Bytes())
	if len(ev) != 4 || !bytes.Equal(ev[1], fpMouse(fpPtrButton1|fpPtrDown, 300, 200)) || binary.LittleEndian.Uint16(ev[3][1:])&fpPtrWheel == 0 {
		t.Fatalf("mouse %x", ev)
	}
	if len(pointer) != 2 || pointer[1] != [2]uint16{300, 200} {
		t.Fatalf("pointer %v", pointer)
	}
	take()

	// Giving it back releases what the admin holds (Ctrl, C, the left
	// button) and puts the user's lock keys back.
	c.setHeld(false)
	ev = events(t, sent.Bytes())
	if len(ev) != 4 || !bytes.Equal(ev[2], fpMouse(fpPtrButton1, 300, 200)) || !bytes.Equal(ev[3], []byte{fpEventSync<<5 | syncCapsLock}) {
		t.Fatalf("given back %x", ev)
	}
	take()
	c.fromAdmin(encodeInstruction("key", "97", "1"))
	if sent.Len() != 0 {
		t.Fatal("an admin without control typed")
	}

	// The admin's typing is logged as theirs (the ğ typed earlier is on the same line).
	c.setHeld(true)
	c.fromAdmin(append(append(encodeInstruction("key", "108", "1"), encodeInstruction("key", "115", "1")...), encodeInstruction("key", "65293", "1")...))
	if len(typed) == 0 || typed[len(typed)-1].Text != "ğls" || typed[len(typed)-1].By != "admin" {
		t.Fatalf("typed %+v", typed)
	}
}
