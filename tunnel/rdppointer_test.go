package tunnel

import "testing"

func TestRdpFastPathPointer(t *testing.T) {
	// Two events: a scancode, then a mouse move to (300, 200).
	pdu := []byte{2 << 2, 11, 0x00, 0x1E, 1 << 5, 0x00, 0x08, 0x2C, 0x01, 0xC8, 0x00}
	if x, y, ok := RdpFastPathPointer(pdu); !ok || x != 300 || y != 200 {
		t.Fatalf("%d %d %v", x, y, ok)
	}
	if _, _, ok := RdpFastPathPointer([]byte{1 << 2, 4, 0x00, 0x1E}); ok {
		t.Fatal("a key press is no pointer")
	}
	if _, _, ok := RdpFastPathPointer([]byte{3, 0, 0, 12}); ok {
		t.Fatal("a slow-path PDU is no pointer")
	}
	if r := PointerRecord(300, 200); string(r[:2]) != "PT" || r[2] != 0x2C || r[3] != 1 || r[4] != 0xC8 {
		t.Fatalf("%x", r)
	}
}
