package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
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

	pduConfirmActive = 0x3
	pduData          = 0x7
	mcsSendDataInd   = 0x68 // DomainMCSPDU sendDataIndication (26) << 2

	pduType2ShutdownRequest = 0x24
	pduType2SetErrorInfo    = 0x2F
	capsVirtualChannel      = 0x0014
	vcCapsComprSC           = 0x00000001

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

// clearVCCompression takes "server may compress virtual channel data"
// (VCCAPS_COMPR_SC) out of the client's Confirm Active, in place. Windows'
// and Apple's apps offer it; FreeRDP, which turns the recording into video
// and decodes it for live watching, can't decompress channel data, so the
// graphics pipeline (on a channel) and the bulk compression history it shares
// would break there. The server then sends channel data as it is, which the
// app reads just the same.
func clearVCCompression(pdu []byte) bool {
	// TPKT (4), X.224 data (3), MCS: type, initiator (2), channel (2), flags, length.
	if len(pdu) < 4+3+8 || pdu[0] != 3 || pdu[7] != mcsSendDataRq {
		return false
	}
	p := 7 + 6
	if pdu[p]&0x80 != 0 {
		p += 2
	} else {
		p++
	}
	// Share Control Header: total length, type, source; then shareId,
	// originatorId, the source descriptor's and the capabilities' lengths.
	// Under TLS there is no security header before it; a client that sends
	// one anyway (4 bytes) is read past it.
	isConfirm := func(at int) bool {
		return at+16 <= len(pdu) && binary.LittleEndian.Uint16(pdu[at+2:])&0x0F == pduConfirmActive &&
			int(binary.LittleEndian.Uint16(pdu[at:])) == len(pdu)-at
	}
	switch {
	case isConfirm(p):
	case isConfirm(p + 4):
		p += 4
	default:
		return false
	}
	srcLen := int(binary.LittleEndian.Uint16(pdu[p+12:]))
	at := p + 16 + srcLen
	if at+4 > len(pdu) {
		return false
	}
	n := int(binary.LittleEndian.Uint16(pdu[at:]))
	at += 4 // count, padding
	for i := 0; i < n && at+4 <= len(pdu); i++ {
		typ, l := binary.LittleEndian.Uint16(pdu[at:]), int(binary.LittleEndian.Uint16(pdu[at+2:]))
		if l < 4 || at+l > len(pdu) {
			return false
		}
		if typ == capsVirtualChannel && l >= 8 {
			flags := binary.LittleEndian.Uint32(pdu[at+4:])
			binary.LittleEndian.PutUint32(pdu[at+4:], flags&^vcCapsComprSC)
			return flags&vcCapsComprSC != 0
		}
		at += l
	}
	return false
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
	// Why the session ended, for the log: the first side to stop, and what
	// either side said on the way out.
	var endMu sync.Mutex
	var ends []string
	ended := func(s string) {
		endMu.Lock()
		ends = append(ends, s)
		endMu.Unlock()
	}
	// Client -> server.
	go func() {
		defer func() { done <- struct{}{} }()
		r := bufio.NewReaderSize(st, 64<<10)
		first, infoDone := true, false
		for {
			pdu, err := readRdpPDU(r)
			if err != nil {
				ended("the app's side closed (" + endErr(err) + ")")
				return
			}
			if what := rdpGoodbye(pdu, false); what != "" {
				ended("the app " + what)
			}
			if first {
				live.clientChannels(pdu)
				rewriteConnectInitial(pdu, selected, req.BlockChannels)
				first = false
			} else if infoDone {
				clearVCCompression(pdu) // every Confirm Active: a server can reactivate
				live.pointer(pdu)
			} else {
				if _, _, ok := clientInfo(pdu); ok {
					infoDone = true // the first one only; an old client's non-Unicode info passes as it is
					if b := rewriteClientInfo(pdu, user, domain, password); b != nil {
						pdu = b
					}
				}
			}
			if _, err := server.Write(pdu); err != nil {
				ended("writing to the server failed (" + endErr(err) + ")")
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
				ended("the server closed (" + endErr(err) + ")")
				return
			}
			if first {
				rewriteConnectResponse(pdu, start.ClientProtocols)
				first = false
			} else if what := rdpGoodbye(pdu, true); what != "" {
				ended("the server " + what)
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
	endMu.Lock()
	logInfo("rdp rec: session with %s ended: %s", net.JoinHostPort(req.Host, req.Port), strings.Join(ends, "; "))
	endMu.Unlock()
}

func endErr(err error) string {
	if errors.Is(err, io.EOF) {
		return "EOF"
	}
	return err.Error()
}

// rdpGoodbye recognizes what a side says when it ends a session: the
// server's Set Error Info (why it disconnects), an app's Shutdown Request,
// or MCS Disconnect Provider Ultimatum. "" for anything else.
func rdpGoodbye(pdu []byte, fromServer bool) string {
	// TPKT (4), X.224 data (3), then MCS.
	if len(pdu) < 9 || pdu[0] != 3 {
		return ""
	}
	if pdu[7]&0xFC == 0x20 { // DisconnectProviderUltimatum
		return "sent MCS disconnect"
	}
	if pdu[7] != mcsSendDataRq && pdu[7] != mcsSendDataInd {
		return ""
	}
	p := 7 + 6
	if p >= len(pdu) {
		return ""
	}
	if pdu[p]&0x80 != 0 {
		p += 2
	} else {
		p++
	}
	// Share Control Header (6) of a data PDU, Share Data Header (12).
	if p+18 > len(pdu) || binary.LittleEndian.Uint16(pdu[p+2:])&0x0F != pduData {
		return ""
	}
	typ2, compressed := pdu[p+14], pdu[p+15]&0x20 != 0
	switch {
	case typ2 == pduType2ShutdownRequest && !fromServer:
		return "asked to end the session (Shutdown Request)"
	case typ2 == pduType2SetErrorInfo && fromServer && !compressed && p+22 <= len(pdu):
		code := binary.LittleEndian.Uint32(pdu[p+18:])
		if code == 0 {
			return ""
		}
		return fmt.Sprintf("sent error info %#x (%s)", code, rdpErrorInfo(code))
	}
	return ""
}

// rdpErrorInfo names the Set Error Info codes a disconnect most often carries (MS-RDPBCGR 2.2.5.1.1).
func rdpErrorInfo(code uint32) string {
	switch code {
	case 0x1:
		return "disconnected by an administrator or another tool"
	case 0x2:
		return "logged off by an administrator or another tool"
	case 0x3:
		return "the server's idle timeout"
	case 0x4:
		return "the server's session time limit"
	case 0x5:
		return "another connection took over the session"
	case 0x6:
		return "the server is out of memory"
	case 0x7:
		return "the server refused the connection"
	case 0x9:
		return "the user has no right to log on"
	case 0xB:
		return "disconnected by the user (from the session)"
	case 0xC:
		return "logged off by the user"
	case 0xF:
		return "the session's close timed out"
	}
	if code >= 0x100 && code < 0x1000 {
		return "licensing"
	}
	if code >= 0x10C9 {
		return "a protocol error"
	}
	return "see MS-RDPBCGR Set Error Info"
}
