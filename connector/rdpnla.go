package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/asn1"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"time"
)

// Signing in to an RDP server for a recorded native session (rdprec.go): the
// X.224 security negotiation, TLS, and Network Level Authentication (CredSSP,
// MS-CSSP) with NTLM and the saved account. After this the connection carries
// the RDP sequence from the MCS Connect Initial on.

const (
	rdpProtoRDP    = 0
	rdpProtoSSL    = 1
	rdpProtoHybrid = 2

	rdpNegReq     = 1
	rdpNegRsp     = 2
	rdpNegFailure = 3

	credsspVersion = 6
	rdpSignInLimit = 20 * time.Second
)

// tpkt frames one X.224 / MCS PDU.
func tpkt(payload []byte) []byte {
	b := []byte{3, 0, 0, 0}
	binary.BigEndian.PutUint16(b[2:], uint16(4+len(payload)))
	return append(b, payload...)
}

// readTPKT reads one TPKT-framed PDU (header included).
func readTPKT(r io.Reader) ([]byte, error) {
	var h [4]byte
	if _, err := io.ReadFull(r, h[:]); err != nil {
		return nil, err
	}
	if h[0] != 3 {
		return nil, errors.New("not an RDP server")
	}
	n := int(binary.BigEndian.Uint16(h[2:]))
	if n < 4 {
		return nil, errors.New("not an RDP server")
	}
	b := make([]byte, n)
	copy(b, h[:])
	if _, err := io.ReadFull(r, b[4:]); err != nil {
		return nil, err
	}
	return b, nil
}

// x224ConnectionRequest asks for the given security protocols. The cookie
// line ("Cookie: mstshash=<user>") lets a load balancer route the session.
func x224ConnectionRequest(user string, protocols uint32) []byte {
	var p []byte
	if user != "" {
		p = append(p, "Cookie: mstshash="+user+"\r\n"...)
	}
	p = append(p, rdpNegReq, 0, 8, 0)
	p = binary.LittleEndian.AppendUint32(p, protocols)
	x := []byte{byte(6 + len(p)), 0xe0, 0, 0, 0, 0, 0}
	return tpkt(append(x, p...))
}

// parseX224Confirm returns the protocol the server selected and its
// negotiation flags.
func parseX224Confirm(b []byte) (uint32, uint8, error) {
	if len(b) < 11 || b[5] != 0xd0 {
		return 0, 0, errors.New("not an RDP server")
	}
	if len(b) < 19 {
		return rdpProtoRDP, 0, nil // no negotiation: standard RDP security
	}
	neg := b[11:]
	switch neg[0] {
	case rdpNegRsp:
		return binary.LittleEndian.Uint32(neg[4:]), neg[1], nil
	case rdpNegFailure:
		return 0, 0, fmt.Errorf("the RDP server refused the security negotiation (code %d)", binary.LittleEndian.Uint32(neg[4:]))
	}
	return 0, 0, errors.New("not an RDP server")
}

// CredSSP messages (MS-CSSP 2.2.1).
type tsRequest struct {
	Version     int         `asn1:"explicit,tag:0"`
	NegoTokens  []negoToken `asn1:"explicit,optional,tag:1"`
	AuthInfo    []byte      `asn1:"explicit,optional,tag:2"`
	PubKeyAuth  []byte      `asn1:"explicit,optional,tag:3"`
	ErrorCode   int64       `asn1:"explicit,optional,tag:4"`
	ClientNonce []byte      `asn1:"explicit,optional,tag:5"`
}

type negoToken struct {
	Token []byte `asn1:"explicit,tag:0"`
}

type tsCredentials struct {
	CredType    int    `asn1:"explicit,tag:0"`
	Credentials []byte `asn1:"explicit,tag:1"`
}

type tsPasswordCreds struct {
	Domain   []byte `asn1:"explicit,tag:0"`
	User     []byte `asn1:"explicit,tag:1"`
	Password []byte `asn1:"explicit,tag:2"`
}

// readDER reads one DER element (a TSRequest) from the TLS stream.
func readDER(r io.Reader) ([]byte, error) {
	h := make([]byte, 2)
	if _, err := io.ReadFull(r, h); err != nil {
		return nil, err
	}
	if h[0] != 0x30 {
		return nil, errors.New("the server's NLA answer is not valid")
	}
	n := int(h[1])
	if n&0x80 != 0 {
		k := n & 0x7f
		if k == 0 || k > 3 {
			return nil, errors.New("the server's NLA answer is not valid")
		}
		lb := make([]byte, k)
		if _, err := io.ReadFull(r, lb); err != nil {
			return nil, err
		}
		h = append(h, lb...)
		n = 0
		for _, c := range lb {
			n = n<<8 | int(c)
		}
	}
	if n > 1<<20 {
		return nil, errors.New("the server's NLA answer is too long")
	}
	body := make([]byte, n)
	if _, err := io.ReadFull(r, body); err != nil {
		return nil, err
	}
	return append(h, body...), nil
}

func readTSRequest(r io.Reader) (tsRequest, error) {
	var req tsRequest
	b, err := readDER(r)
	if err != nil {
		return req, err
	}
	if _, err := asn1.Unmarshal(b, &req); err != nil {
		return req, errors.New("the server's NLA answer is not valid")
	}
	if req.ErrorCode != 0 {
		return req, nlaError(uint32(req.ErrorCode))
	}
	return req, nil
}

// nlaError names the NTSTATUS a server answers a failed sign-in with.
func nlaError(code uint32) error {
	switch code {
	case 0xC000006D, 0xC000006A, 0xC0000064:
		return errors.New("the server refused the saved account (wrong user name or password)")
	case 0xC0000071, 0xC0000224:
		return errors.New("the saved account's password has expired or must be changed")
	case 0xC0000234:
		return errors.New("the saved account is locked out")
	case 0xC0000072:
		return errors.New("the saved account is disabled")
	case 0xC000006E, 0xC000006F, 0xC0000070:
		return errors.New("the saved account may not sign in now or from here (account restrictions)")
	case 0xC0000413:
		return errors.New("the saved account may not sign in to this server (authentication firewall)")
	}
	return fmt.Errorf("the server refused the sign-in (NTSTATUS %#x)", code)
}

// subjectPublicKey is the server certificate's public key as CredSSP binds to
// it: the BIT STRING inside SubjectPublicKeyInfo.
func subjectPublicKey(cert *x509.Certificate) ([]byte, error) {
	var spki struct {
		Algorithm asn1.RawValue
		Key       asn1.BitString
	}
	if _, err := asn1.Unmarshal(cert.RawSubjectPublicKeyInfo, &spki); err != nil {
		return nil, err
	}
	return spki.Key.Bytes, nil
}

// splitAccount takes "DOMAIN\user", "user@domain" or "user".
func splitAccount(account string) (user, domain string) {
	if i := strings.IndexByte(account, '\\'); i >= 0 {
		return account[i+1:], account[:i]
	}
	if i := strings.LastIndexByte(account, '@'); i >= 0 {
		return account, "" // a UPN goes whole as the user name
	}
	return account, ""
}

// rdpSignedIn is a connection past TLS (and NLA): what the server selected
// and its negotiation flags, and its certificate's SHA-256.
type rdpSignedIn struct {
	conn        *tls.Conn
	selected    uint32
	negFlags    uint8
	fingerprint string
}

// rdpSignIn connects to the server, negotiates TLS (and NLA when the server
// takes it), and signs in as account.
func rdpSignIn(addr, account, password string) (rdpSignedIn, error) {
	var s rdpSignedIn
	raw, err := net.DialTimeout("tcp", addr, 10*time.Second)
	if err != nil {
		return s, errors.New("the RDP server can't be reached from the connector")
	}
	_ = raw.SetDeadline(time.Now().Add(rdpSignInLimit))
	user, domain := splitAccount(account)
	cookie := user
	if len(cookie) > 9 {
		cookie = cookie[:9] // what mstsc sends
	}
	if _, err := raw.Write(x224ConnectionRequest(cookie, rdpProtoSSL|rdpProtoHybrid)); err != nil {
		raw.Close()
		return s, errors.New("the RDP server closed the connection")
	}
	cc, err := readTPKT(raw)
	if err != nil {
		raw.Close()
		return s, errors.New("the RDP server closed the connection")
	}
	selected, negFlags, err := parseX224Confirm(cc)
	if err != nil {
		raw.Close()
		return s, err
	}
	if selected != rdpProtoSSL && selected != rdpProtoHybrid {
		raw.Close()
		return s, errors.New("the RDP server offers only standard RDP security; turn on TLS (SSL) or NLA on it")
	}
	// RDP servers present self-signed certificates; the fingerprint is reported.
	tc := tls.Client(raw, &tls.Config{InsecureSkipVerify: true, MinVersion: tls.VersionTLS12}) // #nosec G402
	if err := tc.Handshake(); err != nil {
		raw.Close()
		return s, fmt.Errorf("TLS to the RDP server failed: %v", err)
	}
	certs := tc.ConnectionState().PeerCertificates
	if len(certs) == 0 {
		tc.Close()
		return s, errors.New("the RDP server sent no certificate")
	}
	fp := sha256.Sum256(certs[0].Raw)
	fingerprint := fmt.Sprintf("%x", fp)
	s.fingerprint = fingerprint
	if selected == rdpProtoHybrid {
		if err := credssp(tc, certs[0], user, domain, password); err != nil {
			tc.Close()
			return s, err
		}
	}
	_ = raw.SetDeadline(time.Time{})
	return rdpSignedIn{conn: tc, selected: selected, negFlags: negFlags, fingerprint: fingerprint}, nil
}

// credssp runs CredSSP over the TLS connection: NTLM, the binding to the
// server's public key both ways, then the password.
func credssp(rw io.ReadWriter, cert *x509.Certificate, user, domain, password string) error {
	pub, err := subjectPublicKey(cert)
	if err != nil {
		return errors.New("the RDP server's certificate key can't be read")
	}
	n := &ntlmClient{user: user, domain: domain, password: password, workstation: "CAPTIVO"}
	send := func(r tsRequest) error {
		b, err := asn1.Marshal(r)
		if err != nil {
			return err
		}
		_, err = rw.Write(b)
		return err
	}
	if err := send(tsRequest{Version: credsspVersion, NegoTokens: []negoToken{{n.negotiateMessage()}}}); err != nil {
		return errors.New("the RDP server closed the connection during NLA")
	}
	ch, err := readTSRequest(rw)
	if err != nil {
		return err
	}
	if len(ch.NegoTokens) == 0 {
		return errors.New("the RDP server sent no NTLM challenge (is NTLM turned off in the domain?)")
	}
	auth, err := n.authenticateMessage(ch.NegoTokens[0].Token)
	if err != nil {
		return err
	}
	version := min(ch.Version, credsspVersion)
	nonce := make([]byte, 32)
	_, _ = rand.Read(nonce)
	var bind []byte
	if version >= 5 {
		h := sha256.New()
		h.Write([]byte("CredSSP Client-To-Server Binding Hash\x00"))
		h.Write(nonce)
		h.Write(pub)
		bind = h.Sum(nil)
	} else {
		bind = pub
	}
	req := tsRequest{Version: credsspVersion, NegoTokens: []negoToken{{auth}}, PubKeyAuth: n.seal(bind)}
	if version >= 5 {
		req.ClientNonce = nonce
	}
	if err := send(req); err != nil {
		return errors.New("the RDP server closed the connection during NLA")
	}
	ans, err := readTSRequest(rw)
	if err != nil {
		return err
	}
	got, err := n.unseal(ans.PubKeyAuth)
	if err != nil {
		return errors.New("the RDP server did not prove it holds its certificate's key")
	}
	var want []byte
	if version >= 5 {
		h := sha256.New()
		h.Write([]byte("CredSSP Server-To-Client Binding Hash\x00"))
		h.Write(nonce)
		h.Write(pub)
		want = h.Sum(nil)
	} else {
		want = append([]byte(nil), pub...)
		want[0]++
	}
	if subtle.ConstantTimeCompare(got, want) != 1 {
		return errors.New("the RDP server did not prove it holds its certificate's key")
	}
	creds, _ := asn1.Marshal(tsPasswordCreds{Domain: utf16le(domain), User: utf16le(user), Password: utf16le(password)})
	ts, _ := asn1.Marshal(tsCredentials{CredType: 1, Credentials: creds})
	if err := send(tsRequest{Version: credsspVersion, AuthInfo: n.seal(ts)}); err != nil {
		return errors.New("the RDP server closed the connection during NLA")
	}
	return nil
}
