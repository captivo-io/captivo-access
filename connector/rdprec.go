package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// Recorded native RDP (Kind "rdp-rec"): a user's own Remote Desktop client on
// a recorded resource. The data plane ends the client's TLS
// (dataplane/rdprec.go) and hands over the RDP sequence in the clear; this
// side signs in to the server with the saved account (rdpnla.go) and carries
// the sequence, changing only what must agree with what each side negotiated:
//
//   - the client's core data names the protocol the server selected (NLA here,
//     TLS with the client), and the server's names the ones the client asked
//     for, as both check;
//   - the client's logon info carries the saved account and asks for
//     automatic logon, so the user never types a password;
//   - static channels the resource keeps off are renamed in the request, so
//     the server opens none of them; UDP transport is not offered.

const (
	csCore           = 0xC001
	csNet            = 0xC003
	csMultitransport = 0xC00A
	scCore           = 0x0C01

	secInfoPkt    = 0x0040
	infoAutologon = 0x00000008
	infoUnicode   = 0x00000010
	mcsSendDataRq = 0x64 // DomainMCSPDU sendDataRequest (25) << 2

	rdpMaxPDU = 1 << 16
)

// readRdpPDU reads one PDU: a TPKT (slow path) or a fast-path one.
func readRdpPDU(r *bufio.Reader) ([]byte, error) {
	h, err := r.Peek(2)
	if err != nil {
		return nil, err
	}
	if h[0] == 3 {
		return readTPKT(r)
	}
	var n, head int
	if h[1]&0x80 != 0 {
		h3, err := r.Peek(3)
		if err != nil {
			return nil, err
		}
		n, head = int(h3[1]&0x7f)<<8|int(h3[2]), 3
	} else {
		n, head = int(h[1]), 2
	}
	if n < head || n > rdpMaxPDU {
		return nil, errors.New("bad RDP PDU length")
	}
	b := make([]byte, n)
	if _, err := io.ReadFull(r, b); err != nil {
		return nil, err
	}
	return b, nil
}

// gccBlocks finds the user data blocks after a GCC key ("Duca" in the client's
// Connect Initial, "McDn" in the server's Connect Response) and calls fn with
// each block's type and bytes (header included), in place.
func gccBlocks(pdu []byte, key string, fn func(typ uint16, block []byte)) bool {
	i := bytes.Index(pdu, []byte(key))
	if i < 0 {
		return false
	}
	p := i + len(key)
	if p >= len(pdu) {
		return false
	}
	n := int(pdu[p])
	p++
	if n&0x80 != 0 {
		if p >= len(pdu) {
			return false
		}
		n = (n&0x7f)<<8 | int(pdu[p])
		p++
	}
	end := min(p+n, len(pdu))
	for p+4 <= end {
		typ, l := binary.LittleEndian.Uint16(pdu[p:]), int(binary.LittleEndian.Uint16(pdu[p+2:]))
		if l < 4 || p+l > end {
			break
		}
		fn(typ, pdu[p:p+l])
		p += l
	}
	return true
}

// rewriteConnectInitial fixes the client's MCS Connect Initial in place.
func rewriteConnectInitial(pdu []byte, selected uint32, block []string) bool {
	return gccBlocks(pdu, "Duca", func(typ uint16, b []byte) {
		switch typ {
		case csCore:
			if len(b) >= 216 {
				binary.LittleEndian.PutUint32(b[212:], selected)
			}
		case csMultitransport:
			if len(b) >= 8 {
				binary.LittleEndian.PutUint32(b[4:], 0)
			}
		case csNet:
			if len(b) < 8 {
				return
			}
			count := int(binary.LittleEndian.Uint32(b[4:]))
			for i := 0; i < count && 8+12*(i+1) <= len(b); i++ {
				name := b[8+12*i : 8+12*i+8]
				n := strings.TrimRight(string(name), "\x00")
				for _, c := range block {
					if strings.EqualFold(n, c) {
						// Same length, a name no server knows: it opens nothing.
						copy(name, "captv"+n[:min(2, len(n))]+"\x00")
					}
				}
			}
		}
	})
}

// rewriteConnectResponse puts the client's own protocols back in the server's
// core data.
func rewriteConnectResponse(pdu []byte, clientProtocols uint32) bool {
	return gccBlocks(pdu, "McDn", func(typ uint16, b []byte) {
		if typ == scCore && len(b) >= 12 {
			binary.LittleEndian.PutUint32(b[8:], clientProtocols)
		}
	})
}

func perLength(n int) []byte {
	if n < 0x80 {
		return []byte{byte(n)}
	}
	return []byte{byte(0x80 | n>>8), byte(n)}
}

// clientInfo finds a Client Info PDU (an MCS send data request whose
// security header says SEC_INFO_PKT) and returns the MCS header up to the
// length and where the info packet starts.
func clientInfo(pdu []byte) (mcsHead []byte, info []byte, ok bool) {
	// TPKT (4), X.224 data (3), MCS: type, initiator (2), channel (2), flags, length.
	if len(pdu) < 4+3+8 || pdu[0] != 3 || pdu[7] != mcsSendDataRq {
		return nil, nil, false
	}
	p := 7 + 6
	if pdu[p]&0x80 != 0 {
		p += 2
	} else {
		p++
	}
	if p+4 > len(pdu) || binary.LittleEndian.Uint16(pdu[p:])&secInfoPkt == 0 {
		return nil, nil, false
	}
	return pdu[7:13], pdu[p:], true
}

func utf16z(s string) []byte {
	b := utf16le(s)
	return append(b, 0, 0)
}

func decodeUTF16LE(b []byte) string {
	u := make([]uint16, len(b)/2)
	for i := range u {
		u[i] = binary.LittleEndian.Uint16(b[2*i:])
	}
	return string(utf16.Decode(u))
}

// rewriteClientInfo returns the Client Info PDU with the saved account in it
// and automatic logon asked for, or nil when pdu isn't one.
func rewriteClientInfo(pdu []byte, user, domain, password string) []byte {
	mcsHead, sec, ok := clientInfo(pdu)
	if !ok || len(sec) < 4+18 {
		return nil
	}
	info := sec[4:]
	flags := binary.LittleEndian.Uint32(info[4:])
	if flags&infoUnicode == 0 {
		return nil // every current client sends Unicode; leave an old one as it is
	}
	lens := make([]int, 5)
	for i := range lens {
		lens[i] = int(binary.LittleEndian.Uint16(info[8+2*i:]))
	}
	p := 18
	fields := make([][]byte, 5)
	for i, l := range lens {
		if p+l+2 > len(info) {
			return nil
		}
		fields[i] = info[p : p+l]
		p += l + 2
	}
	extra := info[p:]
	fields[0], fields[1], fields[2] = utf16le(domain), utf16le(user), utf16le(password)

	out := append([]byte{}, info[:4]...) // code page
	out = binary.LittleEndian.AppendUint32(out, flags|infoAutologon)
	for _, f := range fields {
		out = binary.LittleEndian.AppendUint16(out, uint16(len(f)))
	}
	for _, f := range fields {
		out = append(append(out, f...), 0, 0)
	}
	out = append(out, extra...)
	body := append(append([]byte{}, sec[:4]...), out...) // the security header, then the info

	mcs := append(append([]byte{}, mcsHead...), perLength(len(body))...)
	x224 := append([]byte{2, 0xf0, 0x80}, mcs...)
	return tpkt(append(x224, body...))
}

func writeRdpRecResp(w io.Writer, resp tunnel.RdpRecResponse) bool {
	b, _ := json.Marshal(resp)
	return tunnel.WriteFrame(w, b) == nil
}

func handleRdpRec(st io.ReadWriteCloser, allow *TargetMatcher, reqBytes []byte) {
	var req tunnel.RdpRecRequest
	if json.Unmarshal(reqBytes, &req) != nil {
		writeRdpRecResp(st, tunnel.RdpRecResponse{Error: "bad request"})
		return
	}
	addr := net.JoinHostPort(req.Host, req.Port)
	if !egressAllowed(allow, addr) {
		denied()
		logDenied("rdp-rec", addr)
		writeRdpRecResp(st, tunnel.RdpRecResponse{Error: "target not allowed"})
		return
	}
	password := req.Secret
	if req.Sealed != "" {
		s, err := openSealed(vaultKey, req.Sealed, vaultTargetAAD(req.Host, req.Port, req.Username))
		if err != nil {
			writeRdpRecResp(st, tunnel.RdpRecResponse{Error: "the saved password does not open on this connector; enter it again"})
			return
		}
		password = s
	}
	in, err := rdpSignIn(addr, req.Username, password)
	if err != nil {
		logUpstreamErr("rdp-rec", addr, err.Error())
		writeRdpRecResp(st, tunnel.RdpRecResponse{Error: err.Error(), CertSHA256: in.fingerprint})
		return
	}
	server, selected := in.conn, in.selected
	defer server.Close()
	live := startRdpLive(req.WatchID)
	defer live.stop(req.WatchID)
	if !writeRdpRecResp(st, tunnel.RdpRecResponse{CertSHA256: in.fingerprint, NegFlags: in.negFlags, Live: live != nil}) {
		return
	}
	// The client negotiates TLS with the data plane meanwhile; the server
	// waits signed in. A client that never comes is not waited for long.
	_ = setStreamDeadline(st, time.Now().Add(rdpSignInLimit))
	sb, err := tunnel.ReadFrame(st)
	var start tunnel.RdpRecStart
	if err != nil || json.Unmarshal(sb, &start) != nil {
		return
	}
	_ = setStreamDeadline(st, time.Time{})
	user, domain := splitAccount(req.Username)
	done := make(chan struct{}, 2)
	// Client -> server.
	go func() {
		defer func() { done <- struct{}{} }()
		r := bufio.NewReaderSize(st, 64<<10)
		first, infoDone := true, false
		for {
			pdu, err := readRdpPDU(r)
			if err != nil {
				return
			}
			if first {
				rewriteConnectInitial(pdu, selected, req.BlockChannels)
				first = false
			} else if !infoDone {
				if _, _, ok := clientInfo(pdu); ok {
					infoDone = true // the first one only; an old client's non-Unicode info passes as it is
					if b := rewriteClientInfo(pdu, user, domain, password); b != nil {
						pdu = b
					}
				}
			}
			if _, err := server.Write(pdu); err != nil {
				return
			}
		}
	}()
	// Server -> client.
	go func() {
		defer func() { done <- struct{}{} }()
		r := bufio.NewReaderSize(server, 64<<10)
		first := true
		for {
			pdu, err := readRdpPDU(r)
			if err != nil {
				return
			}
			if first {
				rewriteConnectResponse(pdu, start.ClientProtocols)
				first = false
			}
			live.server(pdu)
			if _, err := st.Write(pdu); err != nil {
				return
			}
		}
	}()
	<-done
	server.Close()
	st.Close()
	<-done
}
