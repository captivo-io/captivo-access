package main

import (
	"testing"
	"time"
)

func TestLineObserverLeavesOutKeysTypedIntoAFullScreenProgram(t *testing.T) {
	now := time.Now()
	o := &lineObserver{start: now}
	var got []string
	typeLine := func(s string) {
		for _, ev := range o.typed([]byte(s), now) {
			got = append(got, ev.Text)
		}
	}
	o.shown([]byte("$ "))
	typeLine("vim notes.txt\r")
	// vim takes the alternate screen; the sequence arrives cut in two.
	o.shown([]byte("\x1b[?10"))
	o.shown([]byte("49h\x1b[HNOTES"))
	typeLine("ihello\x1b:wq\r")
	o.shown([]byte("\x1b[?1049l$ "))
	typeLine("uptime\r")
	if len(got) != 2 || got[0] != "vim notes.txt" || got[1] != "uptime" {
		t.Fatalf("lines = %q, want vim notes.txt and uptime", got)
	}

	// A terminal reset leaves the full-screen state too.
	o.shown([]byte("\x1b[?1049h"))
	typeLine(":q!\r")
	o.shown([]byte("\x1bc$ "))
	typeLine("ls\r")
	if len(got) != 3 || got[2] != "ls" {
		t.Fatalf("lines = %q, want ls after the reset", got)
	}
}
