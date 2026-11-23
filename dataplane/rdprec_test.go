package main

import (
	"bufio"
	"crypto/tls"
	"encoding/binary"
	"encoding/json"
	"hash/crc32"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// An X.224 Connection Request as mstsc sends it: a cookie, RDP_NEG_REQ, and
// correlation info after it.
func x224Request(protocols uint32, correlation bool) []byte {
	v := []byte("Cookie: mstshash=ana\r\n")
	flags := byte(0)
	if correlation {
		flags = 0x08
	}
	v = append(v, rdpNegReq, flags, 8, 0)
	v = binary.LittleEndian.AppendUint32(v, protocols)
	if correlation {
		v = append(v, 6, 0, 36, 0)
		v = append(v, make([]byte, 32)...)
	}
	x := append([]byte{byte(6 + len(v)), 0xe0, 0, 0, 0, 0, 0}, v...)
	b := []byte{3, 0, 0, 0}
	binary.BigEndian.PutUint16(b[2:], uint16(4+len(x)))
	return append(b, x...)
}

func TestRequestedProtocols(t *testing.T) {
	for _, corr := range []bool{false, true} {
		p, err := requestedProtocols(x224Request(3, corr))
		if err != nil || p != 3 {
			t.Fatalf("correlation %v: %d %v", corr, p, err)
		}
	}
	bare := x224Request(0, false)
	bare = bare[:len(bare)-8]
	bare[4] -= 8
	binary.BigEndian.PutUint16(bare[2:], uint16(len(bare)))
	if p, err := requestedProtocols(bare); err != nil || p != 0 {
		t.Fatalf("no negotiation: %d %v", p, err)
	}
}

type recSink struct {
	mu   sync.Mutex
	data []byte
}

func (s *recSink) send(req tunnel.RecWriteRequest) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data = append(s.data, req.Data...)
	return len(req.Data), nil
}

func TestRdpFrontEndToEnd(t *testing.T) {
	certFile, keyFile, err := selfSignedDbCert(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	cr := &certReloader{certFile: certFile, keyFile: keyFile}
	client, front := net.Pipe()
	up, connector := net.Pipe()
	sink := &recSink{}
	rec := newRdpRecorder(sink.send, nil, nil, "t1", "k1", "s1", time.Now())
	var seen [][]byte
	var seenMu sync.Mutex
	done := make(chan error, 1)
	go func() {
		done <- rdpFront(front, up, 0x03, cr.get, rec, func(p []byte) {
			seenMu.Lock()
			seen = append(seen, p)
			seenMu.Unlock()
		})
	}()
	// The connector: the start frame, then a client PDU in, a server PDU out.
	serverPDU := append([]byte{3, 0, 0, 12}, []byte("SERVER01")...)
	clientPDU := append([]byte{3, 0, 0, 11}, []byte("CLIENT1")...)
	conDone := make(chan error, 1)
	go func() {
		b, err := tunnel.ReadFrame(connector)
		if err != nil {
			conDone <- err
			return
		}
		var start tunnel.RdpRecStart
		_ = json.Unmarshal(b, &start)
		if start.ClientProtocols != 3 {
			t.Errorf("client protocols %d", start.ClientProtocols)
		}
		got, err := readPDU(bufio.NewReader(connector))
		if err != nil || string(got) != string(clientPDU) {
			t.Errorf("connector got %q %v", got, err)
		}
		_, err = connector.Write(serverPDU)
		conDone <- err
	}()

	_ = client.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := client.Write(x224Request(3, true)); err != nil {
		t.Fatal(err)
	}
	cc, err := readX224(client)
	if err != nil {
		t.Fatal(err)
	}
	if cc[11] != rdpNegRsp || cc[12]&0x03 != 0x03 || binary.LittleEndian.Uint32(cc[15:]) != rdpProtoSSL {
		t.Fatalf("confirm %x", cc)
	}
	tc := tls.Client(client, &tls.Config{InsecureSkipVerify: true})
	if err := tc.Handshake(); err != nil {
		t.Fatal(err)
	}
	if _, err := tc.Write(clientPDU); err != nil {
		t.Fatal(err)
	}
	got, err := readPDU(bufio.NewReader(tc))
	if err != nil || string(got) != string(serverPDU) {
		t.Fatalf("client got %q %v", got, err)
	}
	if err := <-conDone; err != nil {
		t.Fatal(err)
	}
	tc.Close()
	<-done
	rec.stop()

	// The recording: the server's PDU in FreeRDP's dump format; nothing of the client's.
	sink.mu.Lock()
	data := sink.data
	sink.mu.Unlock()
	if len(data) != 21+len(serverPDU) || data[8] != 0 || binary.LittleEndian.Uint64(data[13:]) != uint64(len(serverPDU)) ||
		binary.LittleEndian.Uint32(data[9:]) != crc32.ChecksumIEEE(serverPDU) || string(data[21:]) != string(serverPDU) {
		t.Fatalf("recording %x", data)
	}
	seenMu.Lock()
	defer seenMu.Unlock()
	if len(seen) != 1 || string(seen[0]) != string(clientPDU) {
		t.Fatalf("keystroke observer saw %q", seen)
	}
}

func TestRdpFrontRefusesAClientWithoutTLS(t *testing.T) {
	certFile, keyFile, _ := selfSignedDbCert(t.TempDir())
	cr := &certReloader{certFile: certFile, keyFile: keyFile}
	client, front := net.Pipe()
	up, _ := net.Pipe()
	go func() { _ = rdpFront(front, up, 0, cr.get, nil, nil) }()
	_ = client.SetDeadline(time.Now().Add(5 * time.Second))
	_, _ = client.Write(x224Request(0, false))
	cc, err := readX224(client)
	if err != nil || cc[11] != rdpNegFailure || binary.LittleEndian.Uint32(cc[15:]) != rdpSSLRequired {
		t.Fatalf("got %x %v", cc, err)
	}
}
