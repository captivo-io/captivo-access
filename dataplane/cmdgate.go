package main

import (
	"strings"
	"unicode/utf8"
)

// cmdGate holds back a typed shell line the resource's command list refuses.
//
// It sees what the user's client sends and nothing of what the shell does with it, so it is a
// GUARDRAIL, not a boundary (cmdfilter.go says what is and is not guaranteed). It rebuilds the
// line from the bytes typed, and when Enter would run a refused line it sends Ctrl-C in its
// place: the shell drops the line and shows a fresh prompt, on bash with readline and on a plain
// sh alike. A line it cannot rebuild with confidence (edited with cursor keys, completed in the
// command word, recalled from history or searched) is "uncertain": an allow list refuses it,
// because it cannot be checked; a deny list lets it through, because refusing every history
// recall would make a shell unusable. Keys typed into a full-screen program (vim, less) are not
// lines for the shell and are passed through, which is also why an allow list that lets such a
// program run lets the user out of the list.
type cmdGate struct {
	policy    *CommandPolicy
	line      []rune
	esc       int // 1 after ESC, 2 inside a CSI/SS3 sequence
	csi       []rune
	paste     bool
	uncertain bool
	alt       altScreen
}

func newCmdGate(p *CommandPolicy) *cmdGate { return &cmdGate{policy: p} }

// shown tells the gate what the terminal showed, to follow full-screen programs.
func (g *cmdGate) shown(b []byte) { g.alt.shown(string(b)) }

func (g *cmdGate) reset() {
	g.line, g.uncertain, g.esc, g.csi, g.paste = g.line[:0], false, 0, g.csi[:0], false
}

// filter returns what to forward to the server and, for each line it held back, why.
func (g *cmdGate) filter(b []byte) (out []byte, refusals []string) {
	if g.alt.on {
		g.reset()
		return b, nil
	}
	out = make([]byte, 0, len(b))
	for i := 0; i < len(b); {
		// Work in runes so a multi-byte character counts once, but forward the original bytes.
		r, size := utf8.DecodeRune(b[i:])
		raw := b[i : i+size]
		i += size
		switch {
		case g.esc == 1:
			g.esc = 0
			if r == '[' || r == 'O' {
				g.esc, g.csi = 2, g.csi[:0]
			} else {
				g.uncertain = true // Alt-key editing
			}
			out = append(out, raw...)
			continue
		case g.esc == 2:
			g.csi = append(g.csi, r)
			out = append(out, raw...)
			if r >= 0x40 && r <= 0x7e {
				g.esc = 0
				switch string(g.csi) {
				case "200~":
					g.paste = true
				case "201~":
					g.paste = false
				default:
					g.uncertain = true // cursor keys, history, Home/End, Delete
				}
			}
			continue
		case r == 0x1b:
			g.esc = 1
			out = append(out, raw...)
			continue
		}
		switch {
		case (r == '\r' || r == '\n') && !g.paste:
			ok, why := g.decide()
			g.line, g.uncertain = g.line[:0], false
			if !ok {
				refusals = append(refusals, why)
				out = append(out, 0x03) // drop the line, fresh prompt
				continue
			}
			out = append(out, raw...)
		case r == 0x7f || r == 0x08:
			if len(g.line) > 0 {
				g.line = g.line[:len(g.line)-1]
			}
			out = append(out, raw...)
		case r == 0x15 || r == 0x03: // Ctrl-U, Ctrl-C: the line is gone
			g.line, g.uncertain = g.line[:0], false
			out = append(out, raw...)
		case r == 0x17: // Ctrl-W: the last word
			g.line = []rune(strings.TrimRight(string(g.line), " "))
			if i := strings.LastIndex(string(g.line), " "); i >= 0 {
				g.line = []rune(string(g.line)[:i+1])
			} else {
				g.line = g.line[:0]
			}
			out = append(out, raw...)
		case r == 0x09: // Tab: completion. Only a completed command word changes what runs.
			if !strings.ContainsRune(string(g.line), ' ') {
				g.uncertain = true
			}
			out = append(out, raw...)
		case r == 0x01 || r == 0x05 || r == 0x12 || r == 0x0b || r == 0x19 || r == 0x14 || r == 0x16 || r == 0x1f:
			// Ctrl-A/E (move), R (search), K/Y (kill, yank), T (swap), V (literal), _ (undo).
			g.uncertain = true
			out = append(out, raw...)
		case r >= 0x20 && r != 0x7f:
			g.line = append(g.line, r)
			out = append(out, raw...)
		default:
			out = append(out, raw...)
		}
	}
	return out, refusals
}

func (g *cmdGate) decide() (bool, string) {
	text := strings.TrimSpace(string(g.line))
	if text == "" {
		return true, ""
	}
	if g.uncertain && g.policy.Mode == "allow" {
		return false, "the line was edited in a way that cannot be checked against the allow list; type the command in full"
	}
	return g.policy.Check(text)
}
