package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"strconv"
	"sync"
	"time"
	"unicode/utf16"
)

// Taking over a recorded native RDP session. The client's PDUs pass through
// here on their way to the connector (rdprec.go); while an admin holds
// control, the client's input PDUs are dropped and the admin's input from the
// live viewer (Guacamole key and mouse instructions) goes to the server
// instead, as fast-path input PDUs written between the client's own.
//
// Text goes as Unicode events, so it types the same whatever the server's
// keyboard layout; keys that are not text (Enter, arrows, F-keys, modifiers)
// and letters pressed with Ctrl, Alt or the Windows key go as scancodes at
// their US positions, which Q layouts share. Keys and buttons held when
// control changes hands are released, so none stays down for the other side.

const (
	fpPtrMove       = 0x0800
	fpPtrDown       = 0x8000
	fpPtrButton1    = 0x1000 // left
	fpPtrButton2    = 0x2000 // right
	fpPtrButton3    = 0x4000 // middle
	fpPtrWheel      = 0x0200
	fpPtrWheelNeg   = 0x0100
	guacMouseLeft   = 1
	guacMouseMiddle = 2
	guacMouseRight  = 4
	guacMouseUp     = 8
	guacMouseDown   = 16
)

// Keysyms that are not text, as scancodes (extended ones with 0x100).
var keysymScancode = map[int]uint16{
	0xff08: 0x0E, 0xff09: 0x0F, 0xff0d: 0x1C, 0xff1b: 0x01, 0xffff: 0x153,
	0xff50: 0x147, 0xff51: 0x14B, 0xff52: 0x148, 0xff53: 0x14D, 0xff54: 0x150,
	0xff55: 0x149, 0xff56: 0x151, 0xff57: 0x14F, 0xff63: 0x152,
	0xffe1: 0x2A, 0xffe2: 0x36, 0xffe3: 0x1D, 0xffe4: 0x11D, 0xffe9: 0x38, 0xffea: 0x138,
	0xffeb: 0x15B, 0xffec: 0x15C, 0xff67: 0x15D,
	0xffe5: 0x3A, 0xff7f: 0x45, 0xff14: 0x46, 0xff61: 0x137,
	0xffbe: 0x3B, 0xffbf: 0x3C, 0xffc0: 0x3D, 0xffc1: 0x3E, 0xffc2: 0x3F, 0xffc3: 0x40,
	0xffc4: 0x41, 0xffc5: 0x42, 0xffc6: 0x43, 0xffc7: 0x44, 0xffc8: 0x57, 0xffc9: 0x58,
}

// usScancode is where a character sits on a US keyboard (for shortcuts).
var usScancode = func() map[rune]uint16 {
	m := map[rune]uint16{}
	us := rdpLayouts[layoutUS]
	for sc, r := range us.plain {
		m[r] = uint16(sc)
	}
	for sc, r := range us.shift {
		if _, ok := m[r]; !ok {
			m[r] = uint16(sc)
		}
	}
	for r := 'A'; r <= 'Z'; r++ {
		m[r] = m[r+'a'-'A']
	}
	return m
}()

// rdpControl sits on the client's side of one recorded native RDP session.
type rdpControl struct {
	mu   sync.Mutex
	w    *bufio.Writer // to the connector; nil until the relay starts
	held bool          // an admin holds control

	// What the user holds down, to release when an admin takes over.
	userKeys    map[uint16]bool
	userButtons uint16
	userX       uint16
	userY       uint16
	userSync    byte // the user's lock keys (Caps, Num, Scroll), to restore

	// What the admin holds down, to release when control goes back.
	adminKeys map[uint16]bool
	adminMask int
	adminX    uint16
	adminY    uint16
	mods      int // Ctrl, Alt and Windows keys the admin holds

	// The admin's input for the recording: its pointer and typed text.
	onPointer func(x, y uint16)
	onKeys    func([]keyEvent)
	adminObs  *rdpKeyObserver
}

func newRdpControl(start time.Time, onPointer func(x, y uint16), onKeys func([]keyEvent)) *rdpControl {
	return &rdpControl{userKeys: map[uint16]bool{}, adminKeys: map[uint16]bool{}, onPointer: onPointer, onKeys: onKeys, adminObs: newRdpKeyObserver(start)}
}

// relayClient writes one of the client's PDUs to the connector, unless it is
// input while an admin holds control. seen runs for each PDU that goes on.
func (c *rdpControl) relayClient(w *bufio.Writer, pdu []byte, flush bool, seen func([]byte)) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.w = w
	if isFastPathInput(pdu) {
		c.trackUser(pdu)
		if c.held {
			return nil
		}
	}
	if seen != nil {
		seen(pdu)
	}
	if _, err := w.Write(pdu); err != nil {
		return err
	}
	if flush {
		return w.Flush()
	}
	return nil
}

// inject writes PDUs of the proxy's own. Callers hold c.mu.
func (c *rdpControl) inject(events [][]byte) {
	if c.w == nil || len(events) == 0 {
		return
	}
	for len(events) > 0 {
		n := min(len(events), 15)
		pdu := fastPathPDU(events[:n])
		events = events[n:]
		_, _ = c.w.Write(pdu)
		if c.onKeys != nil {
			if evs := c.adminObs.input(pdu, time.Now()); len(evs) > 0 {
				for i := range evs {
					evs[i].By = "admin"
				}
				c.onKeys(evs)
			}
		}
	}
	_ = c.w.Flush()
}

// setHeld is the session's onControl hook.
func (c *rdpControl) setHeld(taken bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if taken == c.held {
		return
	}
	c.held = taken
	var evs [][]byte
	if taken {
		for k := range c.userKeys {
			evs = append(evs, fpScancode(k, false))
		}
		evs = append(evs, c.buttonsUp(c.userButtons, c.userX, c.userY)...)
		c.userKeys, c.userButtons = map[uint16]bool{}, 0
		c.adminKeys, c.adminMask, c.mods = map[uint16]bool{}, 0, 0
	} else {
		for k := range c.adminKeys {
			evs = append(evs, fpScancode(k, false))
		}
		evs = append(evs, c.buttonsUp(maskButtons(c.adminMask), c.adminX, c.adminY)...)
		evs = append(evs, []byte{fpEventSync<<5 | c.userSync&0x1F})
		c.adminKeys, c.adminMask, c.mods = map[uint16]bool{}, 0, 0
	}
	c.inject(evs)
}

func (c *rdpControl) buttonsUp(buttons uint16, x, y uint16) [][]byte {
	var evs [][]byte
	for _, b := range []uint16{fpPtrButton1, fpPtrButton2, fpPtrButton3} {
		if buttons&b != 0 {
			evs = append(evs, fpMouse(b, x, y))
		}
	}
	return evs
}

// fromAdmin takes the live viewer's Guacamole instructions (key, mouse) and
// sends them to the server, while the admin holds control.
func (c *rdpControl) fromAdmin(msg []byte) {
	br := bufio.NewReader(bytes.NewReader(msg))
	for {
		op, args, err := parseInstruction(br)
		if err != nil {
			return
		}
		switch op {
		case "key":
			if len(args) >= 2 {
				ks, err := strconv.Atoi(args[0])
				if err == nil {
					c.adminKey(ks, args[1] == "1")
				}
			}
		case "mouse":
			if len(args) >= 3 {
				x, e1 := strconv.Atoi(args[0])
				y, e2 := strconv.Atoi(args[1])
				mask, e3 := strconv.Atoi(args[2])
				if e1 == nil && e2 == nil && e3 == nil && x >= 0 && y >= 0 && x < 65536 && y < 65536 {
					c.adminMouse(uint16(x), uint16(y), mask)
				}
			}
		}
	}
}

func (c *rdpControl) adminKey(keysym int, down bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.held {
		return
	}
	if keysym == 0xfe03 { // AltGr: the browser already turned it into the character
		return
	}
	switch keysym {
	case 0xffe3, 0xffe4, 0xffe9, 0xffea, 0xffeb, 0xffec:
		bit := map[int]int{0xffe3: 1, 0xffe4: 2, 0xffe9: 4, 0xffea: 8, 0xffeb: 16, 0xffec: 32}[keysym]
		if down {
			c.mods |= bit
		} else {
			c.mods &^= bit
		}
	}
	if sc, ok := keysymScancode[keysym]; ok {
		c.adminKeyDown(sc, down)
		c.inject([][]byte{fpScancode(sc, down)})
		return
	}
	r, ok := keysymRune(keysym)
	if !ok {
		return
	}
	if c.mods != 0 { // a shortcut: the key, not the character
		if sc, ok := usScancode[r]; ok {
			c.adminKeyDown(sc, down)
			c.inject([][]byte{fpScancode(sc, down)})
		}
		return
	}
	var evs [][]byte
	for _, u := range utf16.Encode([]rune{r}) {
		evs = append(evs, fpUnicode(u, down))
	}
	c.inject(evs)
}

func (c *rdpControl) adminKeyDown(sc uint16, down bool) {
	if down {
		c.adminKeys[sc] = true
	} else {
		delete(c.adminKeys, sc)
	}
}

func (c *rdpControl) adminMouse(x, y uint16, mask int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.held {
		return
	}
	evs := [][]byte{fpMouse(fpPtrMove, x, y)}
	for _, b := range []struct {
		guac int
		rdp  uint16
	}{{guacMouseLeft, fpPtrButton1}, {guacMouseRight, fpPtrButton2}, {guacMouseMiddle, fpPtrButton3}} {
		was, is := c.adminMask&b.guac != 0, mask&b.guac != 0
		if was != is {
			flags := b.rdp
			if is {
				flags |= fpPtrDown
			}
			evs = append(evs, fpMouse(flags, x, y))
		}
	}
	if mask&guacMouseUp != 0 && c.adminMask&guacMouseUp == 0 {
		evs = append(evs, fpMouse(fpPtrWheel|0x0078, x, y))
	}
	if mask&guacMouseDown != 0 && c.adminMask&guacMouseDown == 0 {
		evs = append(evs, fpMouse(fpPtrWheel|fpPtrWheelNeg|0x0088, x, y))
	}
	c.adminMask, c.adminX, c.adminY = mask, x, y
	c.inject(evs)
	if c.onPointer != nil {
		c.onPointer(x, y)
	}
}

func maskButtons(mask int) uint16 {
	var b uint16
	if mask&guacMouseLeft != 0 {
		b |= fpPtrButton1
	}
	if mask&guacMouseRight != 0 {
		b |= fpPtrButton2
	}
	if mask&guacMouseMiddle != 0 {
		b |= fpPtrButton3
	}
	return b
}

// trackUser follows the keys and buttons the user holds. Callers hold c.mu.
func (c *rdpControl) trackUser(pdu []byte) {
	count := int(pdu[0]>>2) & 0x0F
	p := 2
	if pdu[1]&0x80 != 0 {
		p = 3
	}
	if count == 0 {
		if p >= len(pdu) {
			return
		}
		count = int(pdu[p])
		p++
	}
	for i := 0; i < count && p < len(pdu); i++ {
		h := pdu[p]
		code, flags := h>>5, h&0x1F
		p++
		switch code {
		case fpEventScancode:
			if p >= len(pdu) {
				return
			}
			k := uint16(pdu[p])
			if flags&kbdExtended != 0 {
				k |= 0x100
			}
			if flags&kbdRelease != 0 {
				delete(c.userKeys, k)
			} else {
				c.userKeys[k] = true
			}
			p++
		case fpEventMouse, fpEventMouseX:
			if p+6 > len(pdu) {
				return
			}
			pf := binary.LittleEndian.Uint16(pdu[p:])
			c.userX, c.userY = binary.LittleEndian.Uint16(pdu[p+2:]), binary.LittleEndian.Uint16(pdu[p+4:])
			if code == fpEventMouse && pf&fpPtrWheel == 0 {
				if b := pf & (fpPtrButton1 | fpPtrButton2 | fpPtrButton3); b != 0 {
					if pf&fpPtrDown != 0 {
						c.userButtons |= b
					} else {
						c.userButtons &^= b
					}
				}
			}
			p += 6
		case fpEventRelMouse:
			p += 6
		case fpEventSync:
			c.userSync = flags
		case fpEventUnicode:
			p += 2
		case fpEventQoE:
			p += 4
		default:
			return
		}
	}
}

// isFastPathInput: a client fast-path PDU, all of which are input.
func isFastPathInput(pdu []byte) bool { return len(pdu) >= 2 && pdu[0]&0x03 == 0 }

// fastPathPDU wraps up to 15 input events.
func fastPathPDU(events [][]byte) []byte {
	var body []byte
	for _, e := range events {
		body = append(body, e...)
	}
	n := len(body) + 2 // header and a one-byte length
	if n > 0x7F {
		n++ // a two-byte length
		return append([]byte{byte(len(events) << 2), byte(0x80 | n>>8), byte(n)}, body...)
	}
	return append([]byte{byte(len(events) << 2), byte(n)}, body...)
}

func fpScancode(k uint16, down bool) []byte {
	flags := byte(0)
	if !down {
		flags |= kbdRelease
	}
	if k&0x100 != 0 {
		flags |= kbdExtended
	}
	return []byte{fpEventScancode<<5 | flags, byte(k)}
}

func fpUnicode(u uint16, down bool) []byte {
	flags := byte(0)
	if !down {
		flags = kbdRelease
	}
	return binary.LittleEndian.AppendUint16([]byte{fpEventUnicode<<5 | flags}, u)
}

func fpMouse(flags, x, y uint16) []byte {
	b := binary.LittleEndian.AppendUint16([]byte{fpEventMouse << 5}, flags)
	b = binary.LittleEndian.AppendUint16(b, x)
	return binary.LittleEndian.AppendUint16(b, y)
}

// keysymRune is the character a keysym types, if it is one.
func keysymRune(ks int) (rune, bool) {
	switch {
	case ks >= 0x20 && ks <= 0x7E, ks >= 0xA0 && ks <= 0xFF:
		return rune(ks), true
	case ks >= 0x01000100 && ks <= 0x0110FFFF:
		return rune(ks - 0x01000000), true
	}
	return 0, false
}
