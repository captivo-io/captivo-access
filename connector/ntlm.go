package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/md5" // #nosec G501 -- NTLM's own construction (MS-NLMP)
	"crypto/rand"
	"crypto/rc4" // #nosec G503 -- NTLM sealing is RC4 (MS-NLMP 3.4.3)
	"encoding/binary"
	"errors"
	"strings"
	"time"
	"unicode/utf16"

	"golang.org/x/crypto/md4" //nolint:staticcheck // NTOWF is MD4 of the password (MS-NLMP 3.3.2)
)

// The client side of NTLMv2 (MS-NLMP) as CredSSP uses it to sign in to an RDP
// server with NLA (rdprec_nla.go): the three messages, then sealing and
// signing with the session key. Only what that needs: extended session
// security, 128-bit keys, key exchange, a MIC.

const (
	ntlmNegotiateUnicode     = 0x00000001
	ntlmRequestTarget        = 0x00000004
	ntlmNegotiateSign        = 0x00000010
	ntlmNegotiateSeal        = 0x00000020
	ntlmNegotiateNTLM        = 0x00000200
	ntlmNegotiateAlwaysSign  = 0x00008000
	ntlmNegotiateExtSecurity = 0x00080000
	ntlmNegotiateTargetInfo  = 0x00800000
	ntlmNegotiateVersion     = 0x02000000
	ntlmNegotiate128         = 0x20000000
	ntlmNegotiateKeyExch     = 0x40000000
	ntlmNegotiate56          = 0x80000000

	ntlmClientFlags = ntlmNegotiate56 | ntlmNegotiateKeyExch | ntlmNegotiate128 | ntlmNegotiateVersion |
		ntlmNegotiateExtSecurity | ntlmNegotiateAlwaysSign | ntlmNegotiateNTLM | ntlmNegotiateSeal |
		ntlmNegotiateSign | ntlmRequestTarget | ntlmNegotiateUnicode

	avEOL       = 0
	avFlags     = 6
	avTimestamp = 7
)

var ntlmSignature = []byte("NTLMSSP\x00")

// The version a client sends: Windows 10, NTLM revision 15.
var ntlmVersion = []byte{10, 0, 0x61, 0x4a, 0, 0, 0, 15}

func utf16le(s string) []byte {
	u := utf16.Encode([]rune(s))
	b := make([]byte, 2*len(u))
	for i, c := range u {
		binary.LittleEndian.PutUint16(b[2*i:], c)
	}
	return b
}

func hmacMD5(key []byte, data ...[]byte) []byte {
	h := hmac.New(md5.New, key)
	for _, d := range data {
		h.Write(d)
	}
	return h.Sum(nil)
}

// ntowfv2 is NTOWFv2: HMAC-MD5 of the user and domain, keyed with MD4 of the password.
func ntowfv2(user, password, domain string) []byte {
	h := md4.New()
	h.Write(utf16le(password))
	return hmacMD5(h.Sum(nil), utf16le(strings.ToUpper(user)+domain))
}

// ntlmClient is one NTLM authentication and, after it, the sealing state.
type ntlmClient struct {
	user, domain, password, workstation string

	negotiate, challenge []byte
	flags                uint32

	// For tests: fixed values instead of random ones and the clock.
	clientChallenge, sessionKey []byte
	now                         func() time.Time

	sealOut, sealIn *rc4.Cipher
	signOut, signIn []byte
	seqOut, seqIn   uint32
}

func (n *ntlmClient) negotiateMessage() []byte {
	b := append([]byte{}, ntlmSignature...)
	b = binary.LittleEndian.AppendUint32(b, 1)
	b = binary.LittleEndian.AppendUint32(b, ntlmClientFlags)
	b = append(b, make([]byte, 16)...) // no domain or workstation supplied
	b = append(b, ntlmVersion...)
	n.negotiate = b
	return b
}

type ntlmChallenge struct {
	flags      uint32
	challenge  []byte
	targetInfo []byte
}

func parseNTLMChallenge(b []byte) (ntlmChallenge, error) {
	var c ntlmChallenge
	if len(b) < 48 || !bytes.Equal(b[:8], ntlmSignature) || binary.LittleEndian.Uint32(b[8:]) != 2 {
		return c, errors.New("not an NTLM challenge")
	}
	c.flags = binary.LittleEndian.Uint32(b[20:])
	c.challenge = append([]byte(nil), b[24:32]...)
	l, off := int(binary.LittleEndian.Uint16(b[40:])), int(binary.LittleEndian.Uint32(b[44:]))
	if off+l > len(b) || off < 0 {
		return c, errors.New("bad NTLM challenge")
	}
	c.targetInfo = append([]byte(nil), b[off:off+l]...)
	return c, nil
}

// avPairs splits target info into its pairs (without the terminator).
func avPairs(ti []byte) [][2][]byte {
	var out [][2][]byte
	for len(ti) >= 4 {
		id, l := binary.LittleEndian.Uint16(ti), int(binary.LittleEndian.Uint16(ti[2:]))
		if id == avEOL || len(ti) < 4+l {
			break
		}
		out = append(out, [2][]byte{ti[:2], ti[4 : 4+l]})
		ti = ti[4+l:]
	}
	return out
}

func avBytes(pairs [][2][]byte) []byte {
	var b []byte
	for _, p := range pairs {
		b = append(b, p[0]...)
		b = binary.LittleEndian.AppendUint16(b, uint16(len(p[1])))
		b = append(b, p[1]...)
	}
	return append(b, 0, 0, 0, 0)
}

// authenticateMessage answers the server's challenge. It sets up the sealing
// keys; the MIC covers all three messages.
func (n *ntlmClient) authenticateMessage(challenge []byte) ([]byte, error) {
	c, err := parseNTLMChallenge(challenge)
	if err != nil {
		return nil, err
	}
	if c.flags&ntlmNegotiateExtSecurity == 0 || c.flags&ntlmNegotiate128 == 0 || c.flags&ntlmNegotiateKeyExch == 0 {
		return nil, errors.New("the server's NTLM does not offer 128-bit session security")
	}
	n.challenge = challenge
	n.flags = ntlmClientFlags & c.flags
	if n.flags&ntlmNegotiateVersion == 0 {
		n.flags |= ntlmNegotiateVersion
	}

	// The server's time if it sent one (then the LM response is empty), else ours.
	pairs := avPairs(c.targetInfo)
	var ts []byte
	for _, p := range pairs {
		if binary.LittleEndian.Uint16(p[0]) == avTimestamp {
			ts = p[1]
		}
	}
	lmEmpty := ts != nil
	if ts == nil {
		now := time.Now
		if n.now != nil {
			now = n.now
		}
		ft := uint64(now().UnixNano()/100) + 116444736000000000
		ts = binary.LittleEndian.AppendUint64(nil, ft)
	}
	cc := n.clientChallenge
	if cc == nil {
		cc = make([]byte, 8)
		_, _ = rand.Read(cc)
	}
	// Say a MIC follows.
	withFlags := append([][2][]byte{}, pairs...)
	found := false
	for i, p := range withFlags {
		if binary.LittleEndian.Uint16(p[0]) == avFlags {
			v := binary.LittleEndian.Uint32(p[1]) | 2
			withFlags[i] = [2][]byte{p[0], binary.LittleEndian.AppendUint32(nil, v)}
			found = true
		}
	}
	if !found {
		withFlags = append(withFlags, [2][]byte{binary.LittleEndian.AppendUint16(nil, avFlags), binary.LittleEndian.AppendUint32(nil, 2)})
	}

	key := ntowfv2(n.user, n.password, n.domain)
	temp := []byte{1, 1, 0, 0, 0, 0, 0, 0}
	temp = append(temp, ts...)
	temp = append(temp, cc...)
	temp = append(temp, 0, 0, 0, 0)
	temp = append(temp, avBytes(withFlags)...)
	temp = append(temp, 0, 0, 0, 0)
	proof := hmacMD5(key, c.challenge, temp)
	ntResp := append(append([]byte{}, proof...), temp...)
	lmResp := make([]byte, 24)
	if !lmEmpty {
		lmResp = append(hmacMD5(key, c.challenge, cc), cc...)
	}
	baseKey := hmacMD5(key, proof)
	exported := n.sessionKey
	if exported == nil {
		exported = make([]byte, 16)
		_, _ = rand.Read(exported)
	}
	enc, _ := rc4.NewCipher(baseKey)
	encKey := make([]byte, 16)
	enc.XORKeyStream(encKey, exported)

	domain, user, ws := utf16le(n.domain), utf16le(n.user), utf16le(n.workstation)
	const head = 88 // fixed part, version and MIC included
	payload := [][]byte{lmResp, ntResp, domain, user, ws, encKey}
	b := append([]byte{}, ntlmSignature...)
	b = binary.LittleEndian.AppendUint32(b, 3)
	off := head
	fields := make([]byte, 0, 48)
	for _, p := range payload {
		fields = binary.LittleEndian.AppendUint16(fields, uint16(len(p)))
		fields = binary.LittleEndian.AppendUint16(fields, uint16(len(p)))
		fields = binary.LittleEndian.AppendUint32(fields, uint32(off))
		off += len(p)
	}
	// Field order on the wire: LM, NT, domain, user, workstation, session key.
	b = append(b, fields...)
	b = binary.LittleEndian.AppendUint32(b, n.flags)
	b = append(b, ntlmVersion...)
	micAt := len(b)
	b = append(b, make([]byte, 16)...)
	for _, p := range payload {
		b = append(b, p...)
	}
	mic := hmacMD5(exported, n.negotiate, n.challenge, b)
	copy(b[micAt:], mic)

	n.setKeys(exported)
	return b, nil
}

func (n *ntlmClient) setKeys(exported []byte) {
	key := func(magic string) []byte {
		h := md5.New() // #nosec G401
		h.Write(exported)
		h.Write([]byte(magic))
		return h.Sum(nil)
	}
	n.signOut = key("session key to client-to-server signing key magic constant\x00")
	n.signIn = key("session key to server-to-client signing key magic constant\x00")
	n.sealOut, _ = rc4.NewCipher(key("session key to client-to-server sealing key magic constant\x00"))
	n.sealIn, _ = rc4.NewCipher(key("session key to server-to-client sealing key magic constant\x00"))
}

// seal encrypts a message to the server and puts its 16-byte signature first,
// as CredSSP carries it.
func (n *ntlmClient) seal(msg []byte) []byte {
	sealed := make([]byte, len(msg))
	n.sealOut.XORKeyStream(sealed, msg)
	sig := n.signature(n.signOut, n.sealOut, n.seqOut, msg)
	n.seqOut++
	return append(sig, sealed...)
}

func (n *ntlmClient) signature(signKey []byte, seal *rc4.Cipher, seq uint32, msg []byte) []byte {
	seqb := binary.LittleEndian.AppendUint32(nil, seq)
	sum := hmacMD5(signKey, seqb, msg)[:8]
	seal.XORKeyStream(sum, sum)
	sig := []byte{1, 0, 0, 0}
	sig = append(sig, sum...)
	return append(sig, seqb...)
}

// unseal decrypts a message from the server (signature first) and checks it.
func (n *ntlmClient) unseal(b []byte) ([]byte, error) {
	if len(b) < 16 {
		return nil, errors.New("short sealed message")
	}
	msg := make([]byte, len(b)-16)
	n.sealIn.XORKeyStream(msg, b[16:])
	want := n.signature(n.signIn, n.sealIn, n.seqIn, msg)
	n.seqIn++
	if !hmac.Equal(want, b[:16]) {
		return nil, errors.New("the server's NTLM signature does not match")
	}
	return msg, nil
}
