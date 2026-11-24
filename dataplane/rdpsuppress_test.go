package main

import (
	"bufio"
	"bytes"
	"crypto/tls"
	"encoding/binary"
	"net"
	"testing"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// suppressOutput builds a client Suppress Output PDU on the I/O channel.
func suppressOutput(allow byte, compressed byte) []byte {
	body := []byte{allow, 0, 0, 0}
	if allow == 1 {
		body = append(body, 0, 0, 0, 0, 0x00, 0x0A, 0xA0, 0x05)
	}
	share := binary.LittleEndian.AppendUint16(nil, uint16(18+len(body)))
	share = binary.LittleEndian.AppendUint16(share, 0x17)
	share = binary.LittleEndian.AppendUint16(share, 1007)
	share = binary.LittleEndian.AppendUint32(share, 0x103EA)
	share = append(share, 0, 1)
	share = binary.LittleEndian.AppendUint16(share, uint16(4+len(body)))
	share = append(share, pduType2SuppressOutput, compressed, 0, 0)
	share = append(share, body...)
	out := []byte{3, 0, 0, 0, 2, 0xF0, 0x80, 25 << 2, 0, 6, 0x03, 0xEB, 0x70, byte(len(share))}
	out = append(out, share...)
	binary.BigEndian.PutUint16(out[2:], uint16(len(out)))
	return out
}

func TestOnlyTheRequestToStopDrawingIsCaught(t *testing.T) {
	if !isSuppressOutputOff(suppressOutput(0, 0)) {
		t.Fatal("missed the request to stop drawing")
	}
	if isSuppressOutputOff(suppressOutput(1, 0)) {
		t.Fatal("caught the request to draw again")
	}
	if isSuppressOutputOff(suppressOutput(0, 0x20)) {
		t.Fatal("read a compressed PDU")
	}
	if isSuppressOutputOff(chanPDU(25, chanFlagFirst|chanFlagLast, append([]byte{dvcData << 4, 7}, offerBody(3)...), 2+10+36)) {
		t.Fatal("caught channel data")
	}
}

// The front never passes a minimised app's request on, and passes the one after.
func TestAMinimisedAppDoesNotStopTheServerDrawing(t *testing.T) {
	certFile, keyFile, err := selfSignedDbCert(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	cr := &certReloader{certFile: certFile, keyFile: keyFile}
	client, front := net.Pipe()
	up, connector := net.Pipe()
	rec := newRdpRecorder((&recSink{}).send, nil, nil, "t1", "k1", "s1", time.Now())
	defer rec.stop()
	go func() { _ = rdpFront(front, up, 0, cr.get, rec, nil, nil) }()
	got := make(chan []byte, 1)
	go func() {
		if _, err := tunnel.ReadFrame(connector); err != nil {
			return
		}
		p, _ := readPDU(bufio.NewReader(connector))
		got <- p
	}()
	_ = client.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := client.Write(x224Request(1, false)); err != nil {
		t.Fatal(err)
	}
	if _, err := readX224(client); err != nil {
		t.Fatal(err)
	}
	tc := tls.Client(client, &tls.Config{InsecureSkipVerify: true})
	if err := tc.Handshake(); err != nil {
		t.Fatal(err)
	}
	defer tc.Close()
	on := suppressOutput(1, 0)
	if _, err := tc.Write(append(suppressOutput(0, 0), on...)); err != nil {
		t.Fatal(err)
	}
	select {
	case p := <-got:
		if !bytes.Equal(p, on) {
			t.Fatalf("server got % x, want the request to draw again", p)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("nothing reached the server")
	}
}
