package main

import (
	"bytes"
	"encoding/binary"
	"log"
	"sync/atomic"
)

// A recorded native RDP session's graphics must all travel on the wire. An
// app with a persistent bitmap cache (Windows mstsc) offers the server the
// tiles it kept on its disk from earlier sessions (RDPGFX Cache Import
// Offer); the server then paints those regions from the app's cache, which
// the recording and the live view never see, so they stay black. The offer is
// rewritten to an empty one: the server sends every tile. The .rdp file
// already asks for no persistent cache; this covers an app that ignores it.

const (
	gfxChannelName      = "Microsoft::Windows::RDS::Graphics"
	gfxCacheImportOffer = 0x0010
	chanFlagFirst       = 0x01
	chanFlagLast        = 0x02
	chanPacketCompress  = 0x00200000
	dvcCreate           = 1
	dvcDataFirst        = 2
	dvcData             = 3
)

type gfxCacheOffer struct {
	gfx    atomic.Int64 // the graphics channel's DVC id; -1 until the server opens it
	drop   int          // bytes of an offer still to come in further fragments
	siteID string
	key    string
}

func newGfxCacheOffer(siteID, key string) *gfxCacheOffer {
	o := &gfxCacheOffer{siteID: siteID, key: key}
	o.gfx.Store(-1)
	return o
}

// mcsChannelData splits a slow-path PDU carrying virtual channel data: the
// prefix up to the MCS length, the channel header's flags, the chunk.
type mcsChunk struct {
	head  []byte // TPKT, X.224 Data, MCS up to (not including) its length
	flags uint32
	chunk []byte
}

func mcsChannelData(pdu []byte, mcsType byte) (mcsChunk, bool) {
	// TPKT (4) + X.224 Data (02 F0 80) + MCS Send Data Request/Indication.
	if len(pdu) < 4+3+6+1 || pdu[0] != 3 || pdu[4] != 2 || pdu[5] != 0xF0 || pdu[7]>>2 != mcsType {
		return mcsChunk{}, false
	}
	i := 7 + 6
	n := int(pdu[i])
	i++
	if n&0x80 != 0 {
		if i >= len(pdu) {
			return mcsChunk{}, false
		}
		n = (n&0x7f)<<8 | int(pdu[i])
		i++
	}
	if i+n != len(pdu) || n < 8 {
		return mcsChunk{}, false
	}
	return mcsChunk{head: pdu[:7+6], flags: binary.LittleEndian.Uint32(pdu[i+4:]), chunk: pdu[i+8:]}, true
}

// dvcHeader reads a dynamic channel PDU's command, channel id and, for
// DataFirst, the whole message's length; rest is what follows them.
func dvcHeader(b []byte) (cmd int, id uint32, idLen int, total int, rest []byte, ok bool) {
	if len(b) < 1 {
		return
	}
	cmd, sp, cb := int(b[0]>>4), int(b[0]>>2&3), int(b[0]&3)
	sizes := [4]int{1, 2, 4, 0}
	idLen = sizes[cb]
	i := 1
	if idLen == 0 || len(b) < i+idLen {
		return
	}
	id = uintLE(b[i : i+idLen])
	i += idLen
	if cmd == dvcDataFirst {
		l := sizes[sp]
		if l == 0 || len(b) < i+l {
			return
		}
		total = int(uintLE(b[i : i+l]))
		i += l
	}
	return cmd, id, idLen, total, b[i:], true
}

func uintLE(b []byte) uint32 {
	var v uint32
	for i := len(b) - 1; i >= 0; i-- {
		v = v<<8 | uint32(b[i])
	}
	return v
}

// server notes the graphics channel's id when the server opens it.
func (o *gfxCacheOffer) server(pdu []byte) {
	c, ok := mcsChannelData(pdu, 26) // Send Data Indication
	if !ok || c.flags&chanFlagFirst == 0 || c.flags&chanPacketCompress != 0 {
		return
	}
	cmd, id, _, _, rest, ok := dvcHeader(c.chunk)
	if !ok || cmd != dvcCreate {
		return
	}
	if name, _, found := bytes.Cut(rest, []byte{0}); found && string(name) == gfxChannelName {
		o.gfx.Store(int64(id))
	}
}

// client returns the PDU to pass on: pdu itself, an empty offer in place of
// the app's, or nil for a later fragment of that offer.
func (o *gfxCacheOffer) client(pdu []byte) []byte {
	gfx := o.gfx.Load()
	if gfx < 0 {
		return pdu
	}
	c, ok := mcsChannelData(pdu, 25) // Send Data Request
	if !ok || c.flags&chanFlagFirst == 0 || c.flags&chanFlagLast == 0 || c.flags&chanPacketCompress != 0 {
		return pdu
	}
	cmd, id, idLen, total, rest, ok := dvcHeader(c.chunk)
	if !ok || int64(id) != gfx {
		return pdu
	}
	if o.drop > 0 {
		if cmd != dvcData {
			o.drop = 0
			return pdu
		}
		o.drop -= len(rest)
		if o.drop < 0 {
			o.drop = 0
		}
		return nil
	}
	if cmd != dvcData && cmd != dvcDataFirst {
		return pdu
	}
	if len(rest) < 10 || binary.LittleEndian.Uint16(rest) != gfxCacheImportOffer {
		return pdu
	}
	count := int(binary.LittleEndian.Uint16(rest[8:]))
	if int(binary.LittleEndian.Uint32(rest[4:])) != 10+12*count {
		return pdu
	}
	if cmd == dvcDataFirst {
		if total != 10+12*count {
			return pdu
		}
		o.drop = total - len(rest)
	}
	if count > 0 {
		log.Printf("rdp recording site=%s key=%s: the app offered %d cached tiles; offered none, so the server sends them", o.siteID, o.key, count)
	}
	return emptyCacheOffer(c, idLen, c.chunk[1:1+idLen])
}

// emptyCacheOffer builds a Cache Import Offer with no entries, on the same
// MCS and dynamic channels as the app's.
func emptyCacheOffer(c mcsChunk, idLen int, id []byte) []byte {
	cb := map[int]byte{1: 0, 2: 1, 4: 2}[idLen]
	dvc := append([]byte{dvcData<<4 | cb}, id...)
	dvc = append(dvc, 0x10, 0x00, 0x00, 0x00, 10, 0, 0, 0, 0, 0)
	user := binary.LittleEndian.AppendUint32(nil, uint32(len(dvc)))
	user = binary.LittleEndian.AppendUint32(user, c.flags)
	user = append(user, dvc...)
	out := append([]byte{}, c.head...)
	if len(user) < 0x80 {
		out = append(out, byte(len(user)))
	} else {
		out = append(out, 0x80|byte(len(user)>>8), byte(len(user)))
	}
	out = append(out, user...)
	binary.BigEndian.PutUint16(out[2:], uint16(len(out)))
	return out
}
