package main

import (
	"bufio"
	"bytes"
	"strconv"
	"strings"
	"time"
)

type keyEvent struct {
	AtMs   int64  `json:"atMs"`
	Kind   string `json:"kind"` // "command" (ssh) | "text" (rdp)
	Text   string `json:"text"`
	Masked bool   `json:"masked"`
	By     string `json:"by,omitempty"` // "admin": typed by an admin who took control
}

const (
	ksEnter     = 0xff0d
	ksBackspace = 0xff08
	ksTab       = 0xff09
)

// keyObserver reconstructs typed input from the guac `key` instructions on the
// browser->guacd pump. SSH emits one event per line (Enter); RDP emits a "text"
// burst on Enter or after an idle gap. atMs is relative to the recording start.
type keyObserver struct {
	ssh      bool
	start    time.Time
	line     strings.Builder
	lastKey  time.Time
	maskNext bool
}

func newKeyObserver(protocol string, start time.Time) *keyObserver {
	return &keyObserver{ssh: strings.EqualFold(protocol, "ssh"), start: start}
}

func (o *keyObserver) observe(raw []byte, now time.Time) []keyEvent {
	var out []keyEvent
	br := bufio.NewReader(bytes.NewReader(raw))
	for {
		op, args, err := parseInstruction(br)
		if err != nil {
			break
		}
		if op != "key" || len(args) < 2 || args[1] != "1" { // key-down only
			continue
		}
		keysym, _ := strconv.Atoi(args[0])
		if !o.ssh && !o.lastKey.IsZero() && now.Sub(o.lastKey) > 1500*time.Millisecond && o.line.Len() > 0 {
			out = append(out, o.emit(now))
		}
		o.lastKey = now
		switch keysym {
		case ksEnter:
			if o.line.Len() > 0 {
				out = append(out, o.emit(now))
			}
		case ksBackspace:
			s := o.line.String()
			o.line.Reset()
			if len(s) > 0 {
				o.line.WriteString(s[:len(s)-1])
			}
		default:
			if keysym >= 0x20 && keysym <= 0x7e {
				o.line.WriteByte(byte(keysym))
			}
		}
	}
	return out
}

func (o *keyObserver) flush(now time.Time) []keyEvent {
	if o.line.Len() == 0 {
		return nil
	}
	return []keyEvent{o.emit(now)}
}

func (o *keyObserver) emit(now time.Time) keyEvent {
	text := o.line.String()
	o.line.Reset()
	masked := o.maskNext
	if masked {
		text = "••••"
	}
	o.maskNext = passwordPrompt(text)
	kind := "text"
	if o.ssh {
		kind = "command"
	}
	return keyEvent{AtMs: now.Sub(o.start).Milliseconds(), Kind: kind, Text: text, Masked: masked}
}

func passwordPrompt(s string) bool {
	l := strings.ToLower(strings.TrimSpace(s))
	return strings.HasPrefix(l, "sudo") || strings.HasPrefix(l, "su ") || l == "su" || strings.Contains(l, "passwd")
}
