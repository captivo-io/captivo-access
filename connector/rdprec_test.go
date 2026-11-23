package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"os"
	"strings"
	"testing"
)

// testdata/rdp-connect.bin: FreeRDP 3's Connect Initial, a server's Connect
// Response and FreeRDP's Client Info, from a real session (user "tester").
func rdpFixtures(t *testing.T) (ci, cr, info []byte) {
	t.Helper()
	b, err := os.ReadFile("testdata/rdp-connect.bin")
	if err != nil {
		t.Fatal(err)
	}
	var out [][]byte
	for len(b) >= 4 {
		n := int(binary.LittleEndian.Uint32(b))
		out = append(out, append([]byte(nil), b[4:4+n]...))
		b = b[4+n:]
	}
	return out[0], out[1], out[2]
}

func TestRewriteConnectInitial(t *testing.T) {
	ci, _, _ := rdpFixtures(t)
	var before []string
	gccBlocks(ci, "Duca", func(typ uint16, b []byte) {
		if typ == csNet {
			for i := 0; i < int(binary.LittleEndian.Uint32(b[4:])); i++ {
				before = append(before, strings.TrimRight(string(b[8+12*i:8+12*i+8]), "\x00"))
			}
		}
	})
	if !rewriteConnectInitial(ci, rdpProtoHybrid, []string{"cliprdr", "rdpdr"}) {
		t.Fatal("no GCC data found")
	}
	var proto uint32
	var after []string
	gccBlocks(ci, "Duca", func(typ uint16, b []byte) {
		switch typ {
		case csCore:
			proto = binary.LittleEndian.Uint32(b[212:])
		case csNet:
			for i := 0; i < int(binary.LittleEndian.Uint32(b[4:])); i++ {
				after = append(after, strings.TrimRight(string(b[8+12*i:8+12*i+8]), "\x00"))
			}
		}
	})
	if proto != rdpProtoHybrid {
		t.Fatalf("serverSelectedProtocol %d", proto)
	}
	if len(after) != len(before) || len(after) == 0 {
		t.Fatalf("channels %v -> %v", before, after)
	}
	for i, n := range after {
		blocked := before[i] == "cliprdr" || before[i] == "rdpdr"
		if blocked == (n == before[i]) {
			t.Fatalf("channel %q became %q", before[i], n)
		}
	}
	t.Logf("channels %v -> %v", before, after)
}

func TestRewriteConnectResponse(t *testing.T) {
	_, cr, _ := rdpFixtures(t)
	if !rewriteConnectResponse(cr, rdpProtoSSL) {
		t.Fatal("no GCC data found")
	}
	var got uint32
	gccBlocks(cr, "McDn", func(typ uint16, b []byte) {
		if typ == scCore {
			got = binary.LittleEndian.Uint32(b[8:])
		}
	})
	if got != rdpProtoSSL {
		t.Fatalf("clientRequestedProtocols %d", got)
	}
}

func TestRewriteClientInfo(t *testing.T) {
	_, _, info := rdpFixtures(t)
	out := rewriteClientInfo(info, "svc-rdp", "CORP", "Long-saved-password-1")
	if out == nil {
		t.Fatal("not taken as client info")
	}
	if int(binary.BigEndian.Uint16(out[2:])) != len(out) {
		t.Fatal("TPKT length wrong")
	}
	// The MCS length matches what follows it.
	n, p := int(out[13]), 14
	if n&0x80 != 0 {
		n, p = (n&0x7f)<<8|int(out[14]), 15
	}
	if p+n != len(out) {
		t.Fatalf("MCS length %d, have %d", n, len(out)-p)
	}
	_, sec, _ := clientInfo(out)
	in := sec[4:]
	flags := binary.LittleEndian.Uint32(in[4:])
	if flags&infoAutologon == 0 {
		t.Fatal("autologon not asked for")
	}
	d, u, pw := int(binary.LittleEndian.Uint16(in[8:])), int(binary.LittleEndian.Uint16(in[10:])), int(binary.LittleEndian.Uint16(in[12:]))
	q := 18
	domain := decodeUTF16LE(in[q : q+d])
	q += d + 2
	user := decodeUTF16LE(in[q : q+u])
	q += u + 2
	password := decodeUTF16LE(in[q : q+pw])
	if domain != "CORP" || user != "svc-rdp" || password != "Long-saved-password-1" {
		t.Fatalf("%q %q %q", domain, user, password)
	}
	if bytes.Contains(out, utf16le("S3cret-pw")) || bytes.Contains(out, utf16le("tester")) {
		t.Fatal("the client's own account is still in it")
	}
	// The extra info (time zone, performance flags) is kept.
	if !bytes.HasSuffix(out, info[len(info)-40:]) {
		t.Fatal("extra info lost")
	}
}

func TestReadRdpPDUFraming(t *testing.T) {
	ci, _, _ := rdpFixtures(t)
	fast := []byte{0x00, 0x05, 1, 2, 3}
	long := append([]byte{0x00, 0x81, 0x04}, make([]byte, 0x104-3)...)
	r := bufio.NewReader(bytes.NewReader(append(append(append([]byte{}, ci...), fast...), long...)))
	for _, want := range [][]byte{ci, fast, long} {
		got, err := readRdpPDU(r)
		if err != nil || !bytes.Equal(got, want) {
			t.Fatalf("got %d bytes, want %d: %v", len(got), len(want), err)
		}
	}
}

func TestSplitAccount(t *testing.T) {
	for in, want := range map[string][2]string{"CORP\\svc": {"svc", "CORP"}, "svc@corp.local": {"svc@corp.local", ""}, "admin": {"admin", ""}} {
		u, d := splitAccount(in)
		if u != want[0] || d != want[1] {
			t.Fatalf("%s -> %s %s", in, u, d)
		}
	}
}

// confirmActive builds a client Confirm Active PDU with the given capability sets.
func confirmActive(secHeader bool, caps ...[]byte) []byte {
	var sets []byte
	for _, c := range caps {
		sets = append(sets, c...)
	}
	body := binary.LittleEndian.AppendUint32(nil, 0x103EA) // shareId
	body = binary.LittleEndian.AppendUint16(body, 0x3EA)
	body = binary.LittleEndian.AppendUint16(body, 4)                  // source descriptor length
	body = binary.LittleEndian.AppendUint16(body, uint16(4+len(sets))) // capabilities length
	body = append(body, "MSTS"...)
	body = binary.LittleEndian.AppendUint16(body, uint16(len(caps)))
	body = append(body, 0, 0)
	body = append(body, sets...)
	share := binary.LittleEndian.AppendUint16(nil, uint16(6+len(body)))
	share = binary.LittleEndian.AppendUint16(share, 0x13)
	share = binary.LittleEndian.AppendUint16(share, 0x3EA)
	share = append(share, body...)
	if secHeader {
		share = append([]byte{0, 0, 0, 0}, share...)
	}
	mcs := append([]byte{mcsSendDataRq, 0, 6, 0x03, 0xEB, 0x70}, perLength(len(share))...)
	x := append([]byte{2, 0xF0, 0x80}, append(mcs, share...)...)
	return append([]byte{3, 0, byte((4 + len(x)) >> 8), byte(4 + len(x))}, x...)
}

func capSet(typ uint16, data []byte) []byte {
	b := binary.LittleEndian.AppendUint16(nil, typ)
	b = binary.LittleEndian.AppendUint16(b, uint16(4+len(data)))
	return append(b, data...)
}

func TestClearVCCompression(t *testing.T) {
	for _, sec := range []bool{false, true} {
		vc := capSet(capsVirtualChannel, []byte{0x03, 0, 0, 0, 0, 0x40, 0, 0}) // COMPR_SC | COMPR_CS_8K, chunk 16 KB
		pdu := confirmActive(sec, capSet(0x0001, make([]byte, 20)), vc)
		if !clearVCCompression(pdu) {
			t.Fatalf("security header %v: not cleared", sec)
		}
		i := bytes.Index(pdu, []byte{0x14, 0, 12, 0})
		if i < 0 || pdu[i+4] != 0x02 {
			t.Fatalf("flags %x", pdu[i:i+8])
		}
		if clearVCCompression(pdu) {
			t.Fatal("cleared twice")
		}
	}
	// Anything else is left alone.
	if clearVCCompression([]byte{3, 0, 0, 12, 2, 0xF0, 0x80, mcsSendDataRq, 0, 6, 0x03, 0xEB, 0x70, 0}) {
		t.Fatal("a short PDU changed")
	}
}
