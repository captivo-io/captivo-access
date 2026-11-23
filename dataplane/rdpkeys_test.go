package main

import (
	"encoding/binary"
	"testing"
	"time"
)

// fastPathInput builds a client fast-path input PDU from (code, flags, data) events.
func fastPathInput(events ...[]byte) []byte {
	var body []byte
	for _, e := range events {
		body = append(body, e...)
	}
	n := len(events)
	if n > 15 { // the count goes in a byte of its own
		l := len(body) + 4
		return append([]byte{0, byte(0x80 | l>>8), byte(l), byte(n)}, body...)
	}
	l := len(body) + 3
	return append([]byte{byte(n << 2), byte(0x80 | l>>8), byte(l)}, body...)
}

func sc(code byte, release bool) []byte {
	f := byte(0)
	if release {
		f = kbdRelease
	}
	return []byte{fpEventScancode<<5 | f, code}
}

func tap(code byte) [][]byte { return [][]byte{sc(code, false), sc(code, true)} }

func typedOf(t *testing.T, o *rdpKeyObserver, now time.Time, events ...[]byte) []keyEvent {
	t.Helper()
	return o.input(fastPathInput(events...), now)
}

func coreData(layout uint32) []byte {
	core := make([]byte, 216)
	binary.LittleEndian.PutUint16(core, 0xC001)
	binary.LittleEndian.PutUint16(core[2:], 216)
	binary.LittleEndian.PutUint32(core[16:], layout)
	return append(append([]byte("....Duca"), byte(0x80|len(core)>>8), byte(len(core))), core...)
}

func TestRdpKeysTurkishQ(t *testing.T) {
	now := time.Now()
	o := newRdpKeyObserver(now)
	o.connectInitial(coreData(layoutTurkishQ))
	var ev [][]byte
	// "Iğdır" : Shift+ı (I), ğ, d, ı, r
	ev = append(ev, sc(0x2A, false), sc(0x17, false), sc(0x17, true), sc(0x2A, true))
	for _, k := range []byte{0x1A, 0x20, 0x17, 0x13} {
		ev = append(ev, tap(k)...)
	}
	ev = append(ev, tap(0x39)...) // space
	// "@" with AltGr+q, then "şÇ" (Shift+ç), a typo fixed with Backspace
	ev = append(ev, sc(0x1D, false), []byte{fpEventScancode<<5 | kbdExtended, 0x38}, sc(0x10, false), sc(0x10, true), []byte{fpEventScancode<<5 | kbdExtended | kbdRelease, 0x38}, sc(0x1D, true))
	ev = append(ev, tap(0x27)...)
	ev = append(ev, sc(0x36, false), sc(0x34, false), sc(0x34, true), sc(0x36, true))
	ev = append(ev, tap(0x2D)...) // x, then erased
	ev = append(ev, tap(0x0E)...)
	ev = append(ev, tap(0x1C)...) // Enter ends the line
	got := typedOf(t, o, now, ev...)
	if len(got) != 1 || got[0].Text != "Iğdır @şÇ" || got[0].Kind != "text" {
		t.Fatalf("got %+v", got)
	}
}

func TestRdpKeysShortcutsAndUnicode(t *testing.T) {
	now := time.Now()
	o := newRdpKeyObserver(now)
	o.connectInitial(coreData(layoutUS))
	var ev [][]byte
	ev = append(ev, sc(0x1D, false), sc(0x2E, false), sc(0x2E, true), sc(0x1D, true)) // Ctrl+C: not text
	ev = append(ev, tap(0x23)...)                                                     // h
	ev = append(ev, []byte{fpEventUnicode << 5, 0xe9, 0x00})                          // é from an input method
	ev = append(ev, []byte{fpEventMouse << 5, 0, 0x08, 10, 0, 20, 0})                 // a mouse move between
	ev = append(ev, []byte{fpEventSync<<5 | syncCapsLock})                            // Caps Lock on
	ev = append(ev, tap(0x1E)...)                                                     // A
	ev = append(ev, tap(0x1C)...)
	got := typedOf(t, o, now, ev...)
	if len(got) != 1 || got[0].Text != "héA" {
		t.Fatalf("got %+v", got)
	}
	// An idle gap ends a burst too (Caps Lock is still on).
	typedOf(t, o, now, tap(0x23)...)
	got = typedOf(t, o, now.Add(2*time.Second), tap(0x17)...)
	if len(got) != 1 || got[0].Text != "H" {
		t.Fatalf("got %+v", got)
	}
}

func TestRdpKeysUnknownLayoutIsNotGuessed(t *testing.T) {
	now := time.Now()
	o := newRdpKeyObserver(now)
	o.connectInitial(coreData(0x0407)) // German
	got := typedOf(t, o, now, append(tap(0x15), tap(0x1C)...)...)
	if len(got) != 1 || got[0].Text != "[typed text not logged: keyboard layout 0x0407 is not supported]" {
		t.Fatalf("got %+v", got)
	}
	if got := typedOf(t, o, now, append(tap(0x15), tap(0x1C)...)...); len(got) != 0 {
		t.Fatalf("noted twice or guessed: %+v", got)
	}
}

func TestRdpKeysNoLayoutReadsUS(t *testing.T) {
	now := time.Now()
	o := newRdpKeyObserver(now)
	o.connectInitial(coreData(0)) // the macOS app names none
	got := typedOf(t, o, now, append(append(tap(0x15), tap(0x17)...), tap(0x1C)...)...)
	if len(got) != 2 || got[0].Text != "[the client named no keyboard layout: typed text is read as a US keyboard]" || got[1].Text != "yi" {
		t.Fatalf("got %+v", got)
	}
}
