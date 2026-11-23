package main

import (
	"strconv"
	"testing"
	"time"
)

func keydown(keysym int) []byte { return encodeInstruction("key", strconv.Itoa(keysym), "1") }

func TestKeyObserverSSHLine(t *testing.T) {
	base := time.Unix(1000, 0)
	o := newKeyObserver("ssh", base)
	for _, c := range "ls -la" {
		o.observe(keydown(int(c)), base)
	}
	evs := o.observe(keydown(0xFF0D), base.Add(2*time.Second)) // Enter
	if len(evs) != 1 || evs[0].Kind != "command" || evs[0].Text != "ls -la" || evs[0].AtMs != 2000 {
		t.Fatalf("unexpected: %+v", evs)
	}
}

func TestKeyObserverBackspace(t *testing.T) {
	base := time.Unix(1000, 0)
	o := newKeyObserver("ssh", base)
	for _, c := range "lss" {
		o.observe(keydown(int(c)), base)
	}
	o.observe(keydown(0xFF08), base) // backspace
	evs := o.observe(keydown(0xFF0D), base)
	if len(evs) != 1 || evs[0].Text != "ls" {
		t.Fatalf("backspace: %+v", evs)
	}
}

func TestKeyObserverPasswordMask(t *testing.T) {
	base := time.Unix(1000, 0)
	o := newKeyObserver("ssh", base)
	for _, c := range "sudo su" {
		o.observe(keydown(int(c)), base)
	}
	o.observe(keydown(0xFF0D), base) // "sudo su" -> arms masking
	for _, c := range "hunter2" {
		o.observe(keydown(int(c)), base)
	}
	evs := o.observe(keydown(0xFF0D), base)
	if len(evs) != 1 || !evs[0].Masked || evs[0].Text != "••••" {
		t.Fatalf("mask: %+v", evs)
	}
}

func TestKeyObserverRDPBurstOnIdle(t *testing.T) {
	base := time.Unix(1000, 0)
	o := newKeyObserver("rdp", base)
	o.observe(keydown(int('a')), base)
	o.observe(keydown(int('b')), base.Add(100*time.Millisecond))
	evs := o.observe(keydown(int('c')), base.Add(2*time.Second)) // >1.5s gap flushes "ab"
	if len(evs) != 1 || evs[0].Kind != "text" || evs[0].Text != "ab" {
		t.Fatalf("burst: %+v", evs)
	}
}

// Keys typed into vim (guacd's terminal on its alternate buffer) are not a
// shell line; the line typed after it is.
func TestKeyObserverSSHSkipsFullScreenPrograms(t *testing.T) {
	o := newKeyObserver("ssh", time.Now())
	typeLine := func(s string) []keyEvent {
		var raw []byte
		for _, c := range s {
			raw = append(raw, keydown(int(c))...)
		}
		return o.observe(append(raw, keydown(ksEnter)...), time.Now())
	}
	if ev := typeLine("vim notes"); len(ev) != 1 || ev[0].Text != "vim notes" {
		t.Fatalf("%+v", ev)
	}
	on, ok := altScreenInstruction(encodeInstruction("captivo-altscreen", "1"))
	if !ok || !on {
		t.Fatal("the notice is not read")
	}
	o.setAlt(on)
	if ev := typeLine(":wq"); len(ev) != 0 {
		t.Fatalf("logged inside vim: %+v", ev)
	}
	off, _ := altScreenInstruction(encodeInstruction("captivo-altscreen", "0"))
	o.setAlt(off)
	if ev := typeLine("ls"); len(ev) != 1 || ev[0].Text != "ls" {
		t.Fatalf("%+v", ev)
	}
	if _, ok := altScreenInstruction(encodeInstruction("size", "0", "1", "1")); ok {
		t.Fatal("another instruction taken for the notice")
	}
}
