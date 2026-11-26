package main

import (
	"bufio"
	"bytes"
	"strconv"
	"sync"
	"unicode/utf8"
)

// guacCmdGate applies the resource's command list to a BROWSER SSH session. The browser sends
// key events (keysyms), not bytes, so each key-down is turned back into the bytes a terminal
// would send and fed to the same cmdGate a native SSH session uses (cmdgate.go: a guardrail on
// the typed line, not a boundary). When Enter would run a refused line the Enter is swallowed and
// Ctrl-C is sent in its place.
//
// Pasting is turned off while a list is active: a paste arrives as a clipboard stream the
// gate cannot read as keys, and a pasted newline would run a line unseen.
type guacCmdGate struct {
	mu        sync.Mutex
	g         *cmdGate
	ctrl      int          // control keys currently held
	swallowUp map[int]bool // key-ups owed for a swallowed key-down
	dropped   map[string]bool
}

func newGuacCmdGate(p *CommandPolicy) *guacCmdGate {
	return &guacCmdGate{g: newCmdGate(p), swallowUp: map[int]bool{}, dropped: map[string]bool{}}
}

// setAlt follows a full-screen program (guacd's captivo-altscreen), whose keys are not shell lines.
func (k *guacCmdGate) setAlt(on bool) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if on {
		k.g.shown([]byte("\x1b[?1049h"))
	} else {
		k.g.shown([]byte("\x1b[?1049l"))
	}
}

const (
	ksControlL = 0xffe3
	ksControlR = 0xffe4
	ksReturn   = 0xff0d
	ksKPEnter  = 0xff8d
	ksEscape   = 0xff1b
	ksDelete   = 0xffff
	ksHome     = 0xff50
	ksLeft     = 0xff51
	ksUp       = 0xff52
	ksRight    = 0xff53
	ksDown     = 0xff54
	ksPageUp   = 0xff55
	ksPageDown = 0xff56
	ksEnd      = 0xff57
)

// keyBytes is what a terminal sends for a key-down, or nil for a key that sends nothing (a modifier).
func keyBytes(keysym int, ctrl bool) []byte {
	switch keysym {
	case ksReturn, ksKPEnter:
		return []byte{'\r'}
	case ksBackspace:
		return []byte{0x7f}
	case ksTab:
		return []byte{'\t'}
	case ksEscape:
		return []byte{0x1b}
	case ksDelete:
		return []byte("\x1b[3~")
	case ksUp:
		return []byte("\x1b[A")
	case ksDown:
		return []byte("\x1b[B")
	case ksRight:
		return []byte("\x1b[C")
	case ksLeft:
		return []byte("\x1b[D")
	case ksHome:
		return []byte("\x1b[H")
	case ksEnd:
		return []byte("\x1b[F")
	case ksPageUp:
		return []byte("\x1b[5~")
	case ksPageDown:
		return []byte("\x1b[6~")
	}
	if ctrl && ((keysym >= 'a' && keysym <= 'z') || (keysym >= 'A' && keysym <= 'Z')) {
		return []byte{byte(keysym) & 0x1f}
	}
	if keysym >= 0x20 && keysym <= 0x7e {
		return []byte{byte(keysym)}
	}
	if keysym >= 0x1000000 && keysym <= 0x110ffff { // a Unicode keysym
		return utf8.AppendRune(nil, rune(keysym-0x1000000))
	}
	if keysym >= 0xa0 && keysym <= 0xff { // Latin-1
		return utf8.AppendRune(nil, rune(keysym))
	}
	return nil
}

func ctrlC() []byte {
	return bytes.Join([][]byte{
		encodeInstruction("key", strconv.Itoa(ksControlL), "1"),
		encodeInstruction("key", "99", "1"),
		encodeInstruction("key", "99", "0"),
		encodeInstruction("key", strconv.Itoa(ksControlL), "0"),
	}, nil)
}

// process takes one browser message and returns what to forward to guacd, and the notices to show.
func (k *guacCmdGate) process(raw []byte) ([]byte, []string) {
	switch op := instructionOpcode(raw); op {
	case "key", "clipboard", "blob", "end":
	default:
		return raw, nil
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	var out bytes.Buffer
	var notices []string
	br := bufio.NewReader(bytes.NewReader(raw))
	for {
		op, args, err := parseInstruction(br)
		if err != nil {
			break
		}
		switch {
		case op == "clipboard" && len(args) >= 1:
			k.dropped[args[0]] = true
			notices = append(notices, "pasting is off while this resource has a command list")
			continue
		case (op == "blob" || op == "end") && len(args) >= 1 && k.dropped[args[0]]:
			if op == "end" {
				delete(k.dropped, args[0])
			}
			continue
		case op != "key" || len(args) < 2:
			out.Write(encodeInstruction(append([]string{op}, args...)...))
			continue
		}
		keysym, _ := strconv.Atoi(args[0])
		down := args[1] == "1"
		if keysym == ksControlL || keysym == ksControlR {
			if down {
				k.ctrl++
			} else if k.ctrl > 0 {
				k.ctrl--
			}
			out.Write(encodeInstruction("key", args[0], args[1]))
			continue
		}
		if !down {
			if k.swallowUp[keysym] {
				delete(k.swallowUp, keysym)
				continue
			}
			out.Write(encodeInstruction("key", args[0], args[1]))
			continue
		}
		b := keyBytes(keysym, k.ctrl > 0)
		if b == nil {
			out.Write(encodeInstruction("key", args[0], args[1]))
			continue
		}
		fwd, refused := k.g.filter(b)
		if len(refused) == 0 || !bytes.Equal(fwd, []byte{0x03}) {
			out.Write(encodeInstruction("key", args[0], args[1]))
			continue
		}
		// The Enter is replaced by Ctrl-C: the shell drops the line and shows a fresh prompt.
		k.swallowUp[keysym] = true
		out.Write(ctrlC())
		for _, why := range refused {
			notices = append(notices, "Command refused ("+why+")")
		}
	}
	return out.Bytes(), notices
}

