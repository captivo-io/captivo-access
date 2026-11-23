package tunnel

import "encoding/binary"

// The pointer in a recorded native RDP session. A client moves its pointer
// itself and tells the server where it went in its fast-path input
// (MS-RDPBCGR 2.2.8.1.2.2); the server only sends the pointer's shape. So the
// side that sees the client's PDUs (the data plane for the recording, the
// connector for live watching) hands the decoder the position, as a client
// record of the dump: PointerRecord. Nothing else of the input goes with it.

// RdpFastPathPointer returns the last absolute pointer position in a client
// fast-path input PDU.
func RdpFastPathPointer(pdu []byte) (x, y uint16, ok bool) {
	if len(pdu) < 2 || pdu[0]&0x03 != 0 || pdu[0]&0x80 != 0 {
		return 0, 0, false // not fast-path input, or RDP-encrypted
	}
	count := int(pdu[0]>>2) & 0x0F
	p := 2
	if pdu[1]&0x80 != 0 {
		p = 3
	}
	if count == 0 {
		if p >= len(pdu) {
			return 0, 0, false
		}
		count = int(pdu[p])
		p++
	}
	for i := 0; i < count && p < len(pdu); i++ {
		code := pdu[p] >> 5
		p++
		switch code {
		case 0: // scancode
			p++
		case 1, 2: // mouse, extended mouse: flags, x, y
			if p+6 > len(pdu) {
				return x, y, ok
			}
			x, y, ok = binary.LittleEndian.Uint16(pdu[p+2:]), binary.LittleEndian.Uint16(pdu[p+4:]), true
			p += 6
		case 3: // sync
		case 4: // unicode
			p += 2
		case 5: // relative mouse
			p += 6
		case 6: // quality of experience
			p += 4
		default:
			return x, y, ok
		}
	}
	return x, y, ok
}

// PointerRecord is the data of the client record that moves the pointer.
func PointerRecord(x, y uint16) []byte {
	b := []byte{'P', 'T', 0, 0, 0, 0}
	binary.LittleEndian.PutUint16(b[2:], x)
	binary.LittleEndian.PutUint16(b[4:], y)
	return b
}
