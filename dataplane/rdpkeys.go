package main

import (
	"encoding/binary"
	"fmt"
	"time"
	"unicode"
)

// Keystrokes of a recorded native RDP session: the client's fast-path input
// events (MS-RDPBCGR 2.2.8.1.2.2), turned into the text typed, as the keystroke
// timeline of a browser session shows it. A client sends key positions
// (scancodes), so the text depends on its keyboard layout, which it names in
// its MCS Connect Initial; the layouts below are known, and for any other the
// log says so instead of guessing. Unicode events (an input method) are taken
// as they are.

const (
	layoutUS        = 0x0409
	layoutTurkishQ  = 0x041F
	fpEventScancode = 0
	fpEventMouse    = 1
	fpEventMouseX   = 2
	fpEventSync     = 3
	fpEventUnicode  = 4
	fpEventRelMouse = 5
	fpEventQoE      = 6
	kbdRelease      = 0x01
	kbdExtended     = 0x02
	syncCapsLock    = 0x04
	syncNumLock     = 0x02
)

// A layout: what each scancode types plain, with Shift, and with AltGr.
type rdpLayout struct {
	plain, shift, altgr map[byte]rune
	turkish             bool // i/ı casing
}

func keyRow(start byte, plain, shift string) (map[byte]rune, map[byte]rune) {
	p, s := map[byte]rune{}, map[byte]rune{}
	pr, sr := []rune(plain), []rune(shift)
	for i := range pr {
		p[start+byte(i)] = pr[i]
		s[start+byte(i)] = sr[i]
	}
	return p, s
}

func buildLayout(rows [][3]any, altgr map[byte]rune, turkish bool) *rdpLayout {
	l := &rdpLayout{plain: map[byte]rune{}, shift: map[byte]rune{}, altgr: altgr, turkish: turkish}
	for _, r := range rows {
		p, s := keyRow(r[0].(byte), r[1].(string), r[2].(string))
		for k, v := range p {
			l.plain[k] = v
		}
		for k, v := range s {
			l.shift[k] = v
		}
	}
	l.plain[0x39], l.shift[0x39] = ' ', ' '
	return l
}

var rdpLayouts = map[uint32]*rdpLayout{
	layoutUS: buildLayout([][3]any{
		{byte(0x02), "1234567890-=", "!@#$%^&*()_+"},
		{byte(0x10), "qwertyuiop[]", "QWERTYUIOP{}"},
		{byte(0x1E), "asdfghjkl;'`", "ASDFGHJKL:\"~"},
		{byte(0x2B), "\\zxcvbnm,./", "|ZXCVBNM<>?"},
	}, map[byte]rune{}, false),
	layoutTurkishQ: buildLayout([][3]any{
		{byte(0x02), "1234567890*-", "!'^+%&/()=?_"},
		{byte(0x10), "qwertyuıopğü", "QWERTYUIOPĞÜ"},
		{byte(0x1E), "asdfghjklşi\"", "ASDFGHJKLŞİé"},
		{byte(0x2B), ",zxcvbnmöç.", ";ZXCVBNMÖÇ:"},
		{byte(0x56), "<", ">"},
	}, map[byte]rune{0x10: '@', 0x04: '#', 0x05: '$', 0x08: '{', 0x09: '[', 0x0A: ']', 0x0B: '}', 0x0C: '\\', 0x0D: '|', 0x12: '€', 0x1B: '~', 0x2B: '`', 0x56: '|'}, true),
}

// Numpad keys with Num Lock on.
var numpad = map[byte]rune{0x47: '7', 0x48: '8', 0x49: '9', 0x4A: '-', 0x4B: '4', 0x4C: '5', 0x4D: '6', 0x4E: '+', 0x4F: '1', 0x50: '2', 0x51: '3', 0x52: '0', 0x53: ','}

type rdpKeyObserver struct {
	start   time.Time
	layout  *rdpLayout
	unknown uint32 // a layout not in the table: noted once, nothing guessed
	noted   bool

	shiftL, shiftR, ctrl, alt, altgr bool
	caps, num                        bool

	line    []rune
	lastKey time.Time
}

func newRdpKeyObserver(start time.Time) *rdpKeyObserver {
	return &rdpKeyObserver{start: start, layout: rdpLayouts[layoutUS]}
}

// connectInitial reads the keyboard layout from the client's core data.
func (o *rdpKeyObserver) connectInitial(pdu []byte) {
	gccClientBlocks(pdu, func(typ uint16, b []byte) {
		if typ == 0xC001 && len(b) >= 20 {
			id := binary.LittleEndian.Uint32(b[16:]) & 0xFFFF
			if l, ok := rdpLayouts[id]; ok {
				o.layout = l
			} else {
				o.layout, o.unknown = nil, id
			}
		}
	})
}

// gccClientBlocks walks the user data blocks of a client MCS Connect Initial.
func gccClientBlocks(pdu []byte, fn func(typ uint16, b []byte)) {
	for i := 0; i+4 <= len(pdu); i++ {
		if pdu[i] != 'D' || string(pdu[i:i+4]) != "Duca" {
			continue
		}
		p := i + 4
		if p >= len(pdu) {
			return
		}
		n := int(pdu[p])
		p++
		if n&0x80 != 0 && p < len(pdu) {
			n = (n&0x7f)<<8 | int(pdu[p])
			p++
		}
		end := min(p+n, len(pdu))
		for p+4 <= end {
			typ, l := binary.LittleEndian.Uint16(pdu[p:]), int(binary.LittleEndian.Uint16(pdu[p+2:]))
			if l < 4 || p+l > end {
				return
			}
			fn(typ, pdu[p:p+l])
			p += l
		}
		return
	}
}

func (o *rdpKeyObserver) emit(now time.Time) keyEvent {
	e := keyEvent{AtMs: now.Sub(o.start).Milliseconds(), Kind: "text", Text: string(o.line)}
	o.line = o.line[:0]
	return e
}

// input reads one client PDU and returns the text it finished, if any.
func (o *rdpKeyObserver) input(pdu []byte, now time.Time) []keyEvent {
	if len(pdu) < 2 || pdu[0]&0x03 != 0 {
		return nil // not a fast-path input PDU
	}
	count := int(pdu[0]>>2) & 0x0F
	p := 2
	if pdu[1]&0x80 != 0 {
		p = 3
	}
	if count == 0 {
		if p >= len(pdu) {
			return nil
		}
		count = int(pdu[p])
		p++
	}
	var out []keyEvent
	if o.layout == nil && !o.noted {
		o.noted = true
		out = append(out, keyEvent{AtMs: now.Sub(o.start).Milliseconds(), Kind: "text", Text: fmt.Sprintf("[typed text not logged: keyboard layout %#04x is not supported]", o.unknown)})
	}
	for i := 0; i < count && p < len(pdu); i++ {
		h := pdu[p]
		code, flags := h>>5, h&0x1F
		p++
		switch code {
		case fpEventScancode:
			if p >= len(pdu) {
				return out
			}
			out = append(out, o.scancode(pdu[p], flags, now)...)
			p++
		case fpEventUnicode:
			if p+2 > len(pdu) {
				return out
			}
			if flags&kbdRelease == 0 {
				out = append(out, o.typed(rune(binary.LittleEndian.Uint16(pdu[p:])), now)...)
			}
			p += 2
		case fpEventMouse, fpEventMouseX, fpEventRelMouse:
			p += 6
		case fpEventSync:
			o.caps, o.num = flags&syncCapsLock != 0, flags&syncNumLock != 0
		case fpEventQoE:
			p += 4
		default:
			return out // unknown: the rest can't be read
		}
	}
	return out
}

func (o *rdpKeyObserver) typed(r rune, now time.Time) []keyEvent {
	var out []keyEvent
	if !o.lastKey.IsZero() && now.Sub(o.lastKey) > 1500*time.Millisecond && len(o.line) > 0 {
		out = append(out, o.emit(now))
	}
	o.lastKey = now
	o.line = append(o.line, r)
	return out
}

func (o *rdpKeyObserver) scancode(sc, flags byte, now time.Time) []keyEvent {
	down := flags&kbdRelease == 0
	ext := flags&kbdExtended != 0
	switch {
	case sc == 0x2A:
		o.shiftL = down
		return nil
	case sc == 0x36:
		o.shiftR = down
		return nil
	case sc == 0x1D:
		o.ctrl = down
		return nil
	case sc == 0x38 && ext:
		o.altgr = down
		return nil
	case sc == 0x38:
		o.alt = down
		return nil
	case sc == 0x3A:
		if down {
			o.caps = !o.caps
		}
		return nil
	case sc == 0x45 && !ext:
		if down {
			o.num = !o.num
		}
		return nil
	}
	if !down || o.layout == nil {
		return nil
	}
	switch sc {
	case 0x1C: // Enter (the numpad's too)
		var out []keyEvent
		if len(o.line) > 0 {
			out = append(out, o.emit(now))
		}
		o.lastKey = now
		return out
	case 0x0E: // Backspace
		if len(o.line) > 0 {
			o.line = o.line[:len(o.line)-1]
		}
		o.lastKey = now
		return nil
	case 0x0F:
		return o.typed('\t', now)
	}
	if o.ctrl && !o.altgr || o.alt {
		return nil // a shortcut, not text
	}
	if r, ok := numpad[sc]; ok && !ext {
		if o.num {
			return o.typed(r, now)
		}
		return nil
	}
	if ext {
		return nil // arrows, Insert/Delete, the numpad's Enter and /
	}
	var r rune
	var ok bool
	switch {
	case o.altgr || (o.ctrl && o.alt):
		r, ok = o.layout.altgr[sc]
	case o.shiftL || o.shiftR:
		r, ok = o.layout.shift[sc]
	default:
		r, ok = o.layout.plain[sc]
	}
	if !ok {
		return nil
	}
	if o.caps && !o.altgr && unicode.IsLetter(r) {
		shifted := o.shiftL || o.shiftR
		if p, okp := o.layout.plain[sc]; okp && unicode.IsLetter(p) {
			if shifted {
				r = p
			} else {
				r = o.layout.shift[sc]
			}
		}
	}
	return o.typed(r, now)
}
