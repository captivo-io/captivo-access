package main

import (
	"bytes"
	"encoding/binary"
	"testing"
)

// chanPDU wraps a dynamic channel PDU as one static channel chunk on MCS
// channel 1007: mcsType 25 from the client, 26 from the server.
func chanPDU(mcsType byte, flags uint32, dvc []byte, total int) []byte {
	user := binary.LittleEndian.AppendUint32(nil, uint32(total))
	user = binary.LittleEndian.AppendUint32(user, flags)
	user = append(user, dvc...)
	out := []byte{3, 0, 0, 0, 2, 0xF0, 0x80, mcsType << 2, 0, 6, 0x03, 0xEF, 0x70}
	if len(user) < 0x80 {
		out = append(out, byte(len(user)))
	} else {
		out = append(out, 0x80|byte(len(user)>>8), byte(len(user)))
	}
	out = append(out, user...)
	binary.BigEndian.PutUint16(out[2:], uint16(len(out)))
	return out
}

func createGfx(id byte) []byte {
	return chanPDU(26, chanFlagFirst|chanFlagLast, append([]byte{dvcCreate << 4, id}, append([]byte(gfxChannelName), 0)...), 0)
}

func offerBody(count int) []byte {
	b := binary.LittleEndian.AppendUint16(nil, gfxCacheImportOffer)
	b = binary.LittleEndian.AppendUint16(b, 0)
	b = binary.LittleEndian.AppendUint32(b, uint32(10+12*count))
	b = binary.LittleEndian.AppendUint16(b, uint16(count))
	for i := 0; i < count; i++ {
		b = binary.LittleEndian.AppendUint64(b, uint64(i+1))
		b = binary.LittleEndian.AppendUint32(b, 0x00400040)
	}
	return b
}

// wantEmptyOffer checks out is a well-formed empty offer on DVC id.
func wantEmptyOffer(t *testing.T, out []byte, id byte) {
	t.Helper()
	if int(binary.BigEndian.Uint16(out[2:])) != len(out) {
		t.Fatalf("TPKT length %d, PDU %d", binary.BigEndian.Uint16(out[2:]), len(out))
	}
	c, ok := mcsChannelData(out, 25)
	if !ok {
		t.Fatalf("not an MCS channel PDU: % x", out)
	}
	if !bytes.Equal(c.head[8:13], []byte{0, 6, 0x03, 0xEF, 0x70}) {
		t.Fatalf("MCS initiator/channel changed: % x", c.head)
	}
	if got := binary.LittleEndian.Uint32(out[len(out)-len(c.chunk)-8:]); int(got) != len(c.chunk) {
		t.Fatalf("channel length %d, chunk %d", got, len(c.chunk))
	}
	cmd, gotID, _, _, rest, ok := dvcHeader(c.chunk)
	if !ok || cmd != dvcData || gotID != uint32(id) || !bytes.Equal(rest, offerBody(0)) {
		t.Fatalf("not an empty offer: cmd %d id %d % x", cmd, gotID, rest)
	}
}

func TestTheAppsCacheOfferBecomesAnEmptyOne(t *testing.T) {
	o := newGfxCacheOffer("s", "k")
	offer := chanPDU(25, chanFlagFirst|chanFlagLast|0x10, append([]byte{dvcData << 4, 7}, offerBody(3)...), 2+10+36)
	if got := o.client(offer); !bytes.Equal(got, offer) {
		t.Fatal("rewrote before the server opened the graphics channel")
	}
	o.server(createGfx(7))
	wantEmptyOffer(t, o.client(offer), 7)
	// Other dynamic channels and other graphics PDUs pass as they are.
	other := chanPDU(25, chanFlagFirst|chanFlagLast, append([]byte{dvcData << 4, 8}, offerBody(3)...), 2+10+36)
	if got := o.client(other); !bytes.Equal(got, other) {
		t.Fatal("touched another channel")
	}
	ack := chanPDU(25, chanFlagFirst|chanFlagLast, append([]byte{dvcData << 4, 7}, 0x0D, 0, 0, 0, 20, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0), 22)
	if got := o.client(ack); !bytes.Equal(got, ack) {
		t.Fatal("touched a frame acknowledge")
	}
	compressed := chanPDU(25, chanFlagFirst|chanFlagLast|chanPacketCompress, append([]byte{dvcData << 4, 7}, offerBody(3)...), 2+10+36)
	if got := o.client(compressed); !bytes.Equal(got, compressed) {
		t.Fatal("touched compressed data")
	}
}

func TestAFragmentedCacheOfferIsDroppedAfterTheEmptyOne(t *testing.T) {
	o := newGfxCacheOffer("s", "k")
	o.server(createGfx(0x31))
	body := offerBody(300) // 3610 bytes: DataFirst and two Data fragments
	first := chanPDU(25, chanFlagFirst|chanFlagLast, append([]byte{dvcDataFirst<<4 | 1<<2, 0x31, byte(len(body)), byte(len(body) >> 8)}, body[:1500]...), 4+1500)
	wantEmptyOffer(t, o.client(first), 0x31)
	for _, part := range [][]byte{body[1500:3000], body[3000:]} {
		if got := o.client(chanPDU(25, chanFlagFirst|chanFlagLast, append([]byte{dvcData << 4, 0x31}, part...), 2+len(part))); got != nil {
			t.Fatal("passed a fragment of the app's offer")
		}
	}
	after := chanPDU(25, chanFlagFirst|chanFlagLast, append([]byte{dvcData << 4, 0x31}, 0x0D, 0, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0), 14)
	if got := o.client(after); !bytes.Equal(got, after) {
		t.Fatal("dropped the PDU after the offer")
	}
}
