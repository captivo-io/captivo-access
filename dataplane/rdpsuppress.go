package main

import "encoding/binary"

// A minimised RDP app asks the server to stop drawing (Suppress Output PDU,
// allowDisplayUpdates 0). On a recorded session that would leave a gap in the
// recording and a black live view while programs on the server go on, so the
// request never reaches the server; the one that turns drawing back on passes.

const pduType2SuppressOutput = 35

// isSuppressOutputOff reports a client Suppress Output PDU that stops drawing.
func isSuppressOutputOff(pdu []byte) bool {
	c, ok := mcsUserData(pdu, 25)
	// Share Control Header (6) + Share Data Header (12) + allowDisplayUpdates.
	if !ok || len(c) < 6+12+1 {
		return false
	}
	if binary.LittleEndian.Uint16(c[2:])&0x0F != 0x7 { // PDUTYPE_DATAPDU
		return false
	}
	// Not bulk-compressed (PACKET_COMPRESSED), as a compressed one can't be read.
	return c[6+8] == pduType2SuppressOutput && c[6+9]&0x20 == 0 && c[6+12] == 0
}
