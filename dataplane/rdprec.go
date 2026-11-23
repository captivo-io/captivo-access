package main

import (
	"bufio"
	"bytes"
	"crypto/tls"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"sync"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// Recorded native RDP: on a recorded resource the RD Gateway (rdpgw.go) does
// not carry the client's RDP to the server end to end. Inside the gateway
// tunnel this side answers the client's security negotiation with TLS (the
// console's certificate; the .rdp file names the console as the computer) and
// no NLA, so the client asks for no password. The resource's connector has
// already signed in to the server with the saved account
// (connector/rdprec.go); from the client's MCS Connect Initial on, the RDP
// sequence goes to it in the clear, inside the tunnel.

const (
	rdpProtoSSL          = 1
	rdpNegReq            = 1
	rdpNegRsp            = 2
	rdpNegFailure        = 3
	rdpSSLRequired       = 1 // SSL_REQUIRED_BY_SERVER
	rdpFrontHandshake    = 30 * time.Second
	rdpNegExtendedClient = 0x01
)

// dialRdpRec asks the connector to sign in to the resource's RDP server.
func dialRdpRec(s *Session, req tunnel.RdpRecRequest) (net.Conn, tunnel.RdpRecResponse, error) {
	var resp tunnel.RdpRecResponse
	if s == nil || s.mux == nil {
		return nil, resp, errors.New("the resource's connector is offline")
	}
	st, err := s.mux.Open()
	if err != nil {
		return nil, resp, errors.New("the resource's connector is offline")
	}
	req.Kind = "rdp-rec"
	b, _ := json.Marshal(req)
	if err := tunnel.WriteFrame(st, b); err != nil {
		st.Close()
		return nil, resp, errors.New("the resource's connector is offline")
	}
	_ = st.SetReadDeadline(time.Now().Add(30 * time.Second))
	rb, err := tunnel.ReadFrame(st)
	if err != nil {
		st.Close()
		return nil, resp, errors.New("the connector did not answer; it may need an update")
	}
	_ = st.SetReadDeadline(time.Time{})
	if err := json.Unmarshal(rb, &resp); err != nil {
		st.Close()
		return nil, resp, err
	}
	return st, resp, nil
}

// readX224 reads one TPKT-framed PDU.
func readX224(r io.Reader) ([]byte, error) {
	var h [4]byte
	if _, err := io.ReadFull(r, h[:]); err != nil {
		return nil, err
	}
	n := int(binary.BigEndian.Uint16(h[2:]))
	if h[0] != 3 || n < 11 || n > 4096 {
		return nil, errors.New("not an RDP client")
	}
	b := make([]byte, n)
	copy(b, h[:])
	_, err := io.ReadFull(r, b[4:])
	return b, err
}

// requestedProtocols reads an X.224 Connection Request's RDP_NEG_REQ; a
// request without one asks for standard RDP security only.
func requestedProtocols(cr []byte) (uint32, error) {
	if len(cr) < 11 || cr[5] != 0xe0 {
		return 0, errors.New("not an X.224 connection request")
	}
	end := 5 + int(cr[4])
	if end > len(cr) {
		return 0, errors.New("bad X.224 connection request")
	}
	// After the fixed header: an optional cookie or routing token ending in
	// CRLF, then RDP_NEG_REQ, then (mstsc) optional correlation info.
	p := 11
	if i := bytes.Index(cr[p:end], []byte("\r\n")); i >= 0 {
		p += i + 2
	}
	if p+8 <= end && cr[p] == rdpNegReq && binary.LittleEndian.Uint16(cr[p+2:]) == 8 {
		return binary.LittleEndian.Uint32(cr[p+4:]), nil
	}
	return 0, nil
}

func x224Confirm(neg []byte) []byte {
	x := append([]byte{byte(6 + len(neg)), 0xd0, 0, 0, 0x12, 0x34, 0}, neg...)
	b := []byte{3, 0, 0, 0}
	binary.BigEndian.PutUint16(b[2:], uint16(4+len(x)))
	return append(b, x...)
}

func rdpNeg(typ, flags uint8, value uint32) []byte {
	return binary.LittleEndian.AppendUint32([]byte{typ, flags, 8, 0}, value)
}

// rdpFront serves the client's side on c (the inside of the gateway tunnel):
// it takes TLS with the console's certificate, tells the connector on up what
// the client asked for, and relays until either side ends.
func rdpFront(c net.Conn, up net.Conn, negFlags uint8, cert func(*tls.ClientHelloInfo) (*tls.Certificate, error), rec *rdpRecorder, client func(pdu []byte)) error {
	defer up.Close()
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(rdpFrontHandshake))
	cr, err := readX224(c)
	if err != nil {
		return err
	}
	asked, err := requestedProtocols(cr)
	if err != nil {
		return err
	}
	if asked&rdpProtoSSL == 0 {
		_, _ = c.Write(x224Confirm(rdpNeg(rdpNegFailure, 0, rdpSSLRequired)))
		return errors.New("the client offers no TLS")
	}
	if _, err := c.Write(x224Confirm(rdpNeg(rdpNegRsp, negFlags|rdpNegExtendedClient, rdpProtoSSL))); err != nil {
		return err
	}
	tc := tls.Server(c, &tls.Config{GetCertificate: cert, MinVersion: tls.VersionTLS12})
	if err := tc.Handshake(); err != nil {
		return err
	}
	_ = c.SetDeadline(time.Time{})
	b, _ := json.Marshal(tunnel.RdpRecStart{ClientProtocols: asked})
	if err := tunnel.WriteFrame(up, b); err != nil {
		return err
	}
	var once sync.Once
	closeBoth := func() { once.Do(func() { tc.Close(); up.Close() }) }
	done := make(chan struct{}, 2)
	go func() {
		// The client's PDUs go on as they are; client (the keystroke log)
		// sees each first.
		r := bufio.NewReaderSize(tc, 64<<10)
		w := bufio.NewWriterSize(up, 64<<10)
		for {
			pdu, err := readPDU(r)
			if err != nil {
				break
			}
			if client != nil {
				client(pdu)
			}
			if _, err := w.Write(pdu); err != nil {
				break
			}
			if r.Buffered() == 0 && w.Flush() != nil {
				break
			}
		}
		_ = w.Flush()
		closeBoth()
		done <- struct{}{}
	}()
	go func() {
		// PDU by PDU, so each is recorded whole.
		r := bufio.NewReaderSize(up, 64<<10)
		w := bufio.NewWriterSize(tc, 64<<10)
		for {
			pdu, err := readPDU(r)
			if err != nil {
				break
			}
			if rec != nil {
				rec.server(pdu)
			}
			if _, err := w.Write(pdu); err != nil {
				break
			}
			if r.Buffered() == 0 && w.Flush() != nil {
				break
			}
		}
		_ = w.Flush()
		closeBoth()
		done <- struct{}{}
	}()
	<-done
	<-done
	return nil
}

// openRecorded signs in through the connector and returns the gateway's end
// of the tunnel: what the client sends goes in, what it receives comes out.
func (t *rdpgwTunnel) openRecorded() (net.Conn, error) {
	sealed := ""
	for _, c := range t.target.Candidates {
		if c.ID == t.target.ConnectorID {
			sealed = c.SealedSecret
		}
	}
	up, resp, err := t.d.dialRec(t.target.ConnectorID, tunnel.RdpRecRequest{
		Host: t.target.Host, Port: t.target.Port, Username: t.target.Username,
		Sealed: sealed, Secret: t.target.Secret, BlockChannels: t.target.BlockChannels,
	})
	if err != nil {
		return nil, err
	}
	if resp.Error != "" {
		up.Close()
		return nil, errors.New(resp.Error)
	}
	tk, cid := t.ticket, t.target.ConnectorID
	key := newRecordingKey(tk.SiteID, tk.UserID)
	send := func(req tunnel.RecWriteRequest) (int, error) { return writeRecChunk(t.d.rec.session(cid), req) }
	rec := newRdpRecorder(send,
		&recIndexReporter{send: t.d.rec.recIndex, userID: tk.UserID, siteID: tk.SiteID, host: t.target.Host, format: rdpFormat, proto: "rdp", connectorID: cid},
		func() { notifyRecDone(t.d.rec.session(cid), tk.TenantID, key) },
		tk.TenantID, key, tk.SiteID, t.d.now())
	var client func([]byte)
	if t.target.Keystrokes {
		keys := newKeyWriter(send, tk.TenantID, key)
		obs := newRdpKeyObserver(t.d.now())
		first := true
		client = func(pdu []byte) {
			if first {
				first = false
				obs.connectInitial(pdu)
				return
			}
			if evs := obs.input(pdu, t.d.now()); len(evs) > 0 {
				keys.post(evs)
				if ls := t.live(); ls != nil {
					ls.keyEvents(evs)
				}
			}
		}
	}
	gw, front := net.Pipe()
	go func() {
		if err := rdpFront(front, up, resp.NegFlags, t.d.cert, rec, client); err != nil {
			log.Printf("rdpgw: site=%s recorded session: %v", tk.SiteID, err)
		}
		rec.stop()
		gw.Close()
	}()
	return gw, nil
}
