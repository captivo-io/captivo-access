package tunnel

import (
	"bytes"
	"encoding/binary"
	"testing"
)

func TestTDSPacketsAndMessage(t *testing.T) {
	payload := bytes.Repeat([]byte("x"), 1500)
	wire := TDSPackets(TDSBatch, payload, 512) // 504 + 504 + 492 bytes of payload
	if len(wire) != 1500+3*TDSHeaderLen {
		t.Fatalf("wire %d", len(wire))
	}
	if wire[1] != 0 || wire[512+1] != 0 || wire[2*512+1] != TDSStatusEOM {
		t.Fatal("EOM is not on the last packet only")
	}
	typ, msg, err := ReadTDSMessage(bytes.NewReader(wire), 1<<20)
	if err != nil || typ != TDSBatch || !bytes.Equal(msg, payload) {
		t.Fatalf("%d %v %d", typ, err, len(msg))
	}
}

func TestPreloginRoundTrip(t *testing.T) {
	b := BuildPrelogin([]PreloginOption{{PreloginVersion, []byte{16, 0, 0, 0, 0, 0}}, {PreloginEncryption, []byte{EncryptReq}}, {PreloginThreadID, nil}})
	o, err := ParsePrelogin(b)
	if err != nil || o[PreloginEncryption][0] != EncryptReq || len(o[PreloginVersion]) != 6 || len(o[PreloginThreadID]) != 0 {
		t.Fatalf("%v %v", o, err)
	}
	if _, err := ParsePrelogin([]byte{0, 0, 9, 0, 9}); err == nil {
		t.Fatal("a truncated table parses")
	}
}

func TestLogin7RoundTrip(t *testing.T) {
	in := Login7{TDSVersion: TDSVersion74, PacketSize: 8000, OptionFlags1: 0xE0, OptionFlags2: 0x83, OptionFlags3: 0x11,
		HostName: "laptop", UserName: "cdbt_ticket", AppName: "SSMS", Database: "crm", Language: "us_english"}
	b := in.Build("pässword")
	out, err := ParseLogin7(b)
	if err != nil {
		t.Fatal(err)
	}
	if out.UserName != "cdbt_ticket" || out.AppName != "SSMS" || out.Database != "crm" || out.PacketSize != 8000 || out.HostName != "laptop" {
		t.Fatalf("%+v", out)
	}
	// Windows sign-in, feature extensions and a password change are never asked for.
	if out.OptionFlags2&0x80 != 0 || out.OptionFlags3&0x11 != 0 {
		t.Fatalf("flags %x %x", out.OptionFlags2, out.OptionFlags3)
	}
	// The password is LOGIN7's encoding of UCS-2: decode it back.
	off, n := int(binary.LittleEndian.Uint16(b[44:])), int(binary.LittleEndian.Uint16(b[46:]))
	enc := append([]byte(nil), b[off:off+2*n]...)
	for i, c := range enc {
		c ^= 0xA5
		enc[i] = c<<4 | c>>4
	}
	if FromUCS2(enc) != "pässword" {
		t.Fatalf("password %q", FromUCS2(enc))
	}
}

func TestParseLoginResponse(t *testing.T) {
	env := []byte{TokenEnvChange}
	body := append([]byte{1, 3}, UCS2("crm")...)
	body = append(append(body, 6), UCS2("master")...)
	env = append(binary.LittleEndian.AppendUint16(env, uint16(len(body))), body...)
	ack := []byte{1, 0x74, 0, 0, 4, 4}
	ack = append(append(ack, UCS2("SQLS")...), 16, 0, 0x0F, 0xA0)
	loginAck := append(binary.LittleEndian.AppendUint16([]byte{TokenLoginAck}, uint16(len(ack))), ack...)
	r, err := ParseLoginResponse(append(append(env, loginAck...), TDSDoneToken(0, 0)...))
	if err != nil || !r.OK || r.Database != "crm" || r.ServerVersion != "16.0.4000" {
		t.Fatalf("%+v %v", r, err)
	}
	r, err = ParseLoginResponse(append(TDSErrorToken(18456, 1, 14, "Login failed for user 'app'.", "db1"), TDSDoneToken(DoneError, 0)...))
	if err != nil || r.OK || r.Err == nil || r.Err.Number != 18456 || r.Err.Msg != "Login failed for user 'app'." {
		t.Fatalf("%+v %v", r, err)
	}
}
