package tunnel

import (
	"bufio"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"strconv"
	"time"
	"unicode/utf16"
)

// SQL Server's TDS protocol (MS-TDS), the pieces both sides of the database
// proxy need: the data plane serves the user's client (SSMS, sqlcmd, Azure
// Data Studio, DBeaver), the connector signs in to the server with the saved
// account (connector/mssql.go, dataplane/mssqlproxy.go).
//
// A TDS message is one or more packets: an 8-byte header (type, status, length
// with the header, SPID, packet number, window) and up to the negotiated
// packet size; the last packet has the EOM status bit. Encryption is
// negotiated in PRELOGIN; the TLS handshake then travels inside PRELOGIN
// packets, and after it the TLS records go on the wire as they are.

const (
	TDSBatch      = 0x01 // SQL batch
	TDSRPC        = 0x03 // remote procedure call
	TDSReply      = 0x04 // the server's tabular response
	TDSAttention  = 0x06 // cancel
	TDSBulk       = 0x07 // bulk load data
	TDSTransMgr   = 0x0E // transaction manager request
	TDSLogin7     = 0x10
	TDSSSPI       = 0x11
	TDSPrelogin   = 0x12
	TDSStatusEOM  = 0x01
	TDSHeaderLen  = 8
	TDSMaxPacket  = 32767
	TDSMinPacket  = 512
	TDSVersion74  = 0x74000004
	TDSDefaultPkt = 4096

	// PRELOGIN options and the encryption values.
	PreloginVersion    = 0x00
	PreloginEncryption = 0x01
	PreloginInstOpt    = 0x02
	PreloginThreadID   = 0x03
	PreloginMARS       = 0x04
	PreloginTraceID    = 0x05
	PreloginFedAuth    = 0x06
	PreloginNonce      = 0x07
	PreloginTerminator = 0xFF
	EncryptOff         = 0x00 // the login packet only
	EncryptOn          = 0x01
	EncryptNotSup      = 0x02
	EncryptReq         = 0x03

	// Tokens of the server's responses.
	TokenError       = 0xAA
	TokenInfo        = 0xAB
	TokenLoginAck    = 0xAD
	TokenFeatureAck  = 0xAE
	TokenEnvChange   = 0xE3
	TokenDone        = 0xFD
	TokenDoneProc    = 0xFE
	TokenDoneInProc  = 0xFF
	DoneError        = 0x0002
	DoneCount        = 0x0010
	DoneAttn         = 0x0020
	DoneServerError  = 0x0100
	tdsDoneTokenSize = 13 // token, status (2), current command (2), row count (8)
)

var errNotTDS = errors.New("not a SQL Server (TDS) connection")

// ReadTDSPacket reads one packet; max bounds its length.
func ReadTDSPacket(r io.Reader, max int) (typ, status byte, payload []byte, err error) {
	var h [TDSHeaderLen]byte
	if _, err = io.ReadFull(r, h[:]); err != nil {
		return 0, 0, nil, err
	}
	n := int(binary.BigEndian.Uint16(h[2:]))
	if n < TDSHeaderLen || n > max {
		return 0, 0, nil, errNotTDS
	}
	payload = make([]byte, n-TDSHeaderLen)
	if _, err = io.ReadFull(r, payload); err != nil {
		return 0, 0, nil, err
	}
	return h[0], h[1], payload, nil
}

// ReadTDSMessage reads packets up to the one with EOM; max bounds the message.
func ReadTDSMessage(r io.Reader, max int) (byte, []byte, error) {
	var msg []byte
	for {
		typ, status, p, err := ReadTDSPacket(r, TDSMaxPacket+TDSHeaderLen)
		if err != nil {
			return 0, nil, err
		}
		if len(msg)+len(p) > max {
			return 0, nil, errors.New("TDS message too long")
		}
		msg = append(msg, p...)
		if status&TDSStatusEOM != 0 {
			return typ, msg, nil
		}
	}
}

// TDSPackets splits a message into packets of at most packetSize bytes.
func TDSPackets(typ byte, payload []byte, packetSize int) []byte {
	if packetSize < TDSMinPacket {
		packetSize = TDSDefaultPkt
	}
	room := packetSize - TDSHeaderLen
	var out []byte
	id := byte(1)
	for first := true; first || len(payload) > 0; first = false {
		n := min(len(payload), room)
		status := byte(0)
		if n == len(payload) {
			status = TDSStatusEOM
		}
		h := [TDSHeaderLen]byte{typ, status, 0, 0, 0, 0, id, 0}
		binary.BigEndian.PutUint16(h[2:], uint16(n+TDSHeaderLen))
		out = append(append(out, h[:]...), payload[:n]...)
		payload = payload[n:]
		id++
	}
	return out
}

// PreloginOption is one PRELOGIN option.
type PreloginOption struct {
	Token byte
	Data  []byte
}

// BuildPrelogin lays out PRELOGIN options: a table of (token, offset, length)
// and then the data.
func BuildPrelogin(opts []PreloginOption) []byte {
	table := len(opts)*5 + 1
	var head, data []byte
	for _, o := range opts {
		head = append(head, o.Token)
		head = binary.BigEndian.AppendUint16(head, uint16(table+len(data)))
		head = binary.BigEndian.AppendUint16(head, uint16(len(o.Data)))
		data = append(data, o.Data...)
	}
	return append(append(head, PreloginTerminator), data...)
}

// ParsePrelogin reads PRELOGIN options by token.
func ParsePrelogin(b []byte) (map[byte][]byte, error) {
	out := map[byte][]byte{}
	for i := 0; ; i += 5 {
		if i >= len(b) {
			return nil, errNotTDS
		}
		if b[i] == PreloginTerminator {
			return out, nil
		}
		if i+5 > len(b) {
			return nil, errNotTDS
		}
		off, n := int(binary.BigEndian.Uint16(b[i+1:])), int(binary.BigEndian.Uint16(b[i+3:]))
		if off+n > len(b) {
			return nil, errNotTDS
		}
		out[b[i]] = b[off : off+n]
	}
}

// TDSHandshakeConn carries a TLS handshake inside PRELOGIN packets; after
// Passthrough, reads and writes go to the connection as they are.
type TDSHandshakeConn struct {
	net.Conn
	R           *bufio.Reader
	Passthrough bool
	buf         []byte
}

func (c *TDSHandshakeConn) Read(p []byte) (int, error) {
	if c.Passthrough && len(c.buf) == 0 {
		return c.R.Read(p)
	}
	for len(c.buf) == 0 {
		_, _, payload, err := ReadTDSPacket(c.R, TDSMaxPacket+TDSHeaderLen)
		if err != nil {
			return 0, err
		}
		c.buf = payload
	}
	n := copy(p, c.buf)
	c.buf = c.buf[n:]
	return n, nil
}

func (c *TDSHandshakeConn) Write(p []byte) (int, error) {
	if c.Passthrough {
		return c.Conn.Write(p)
	}
	if _, err := c.Conn.Write(TDSPackets(TDSPrelogin, p, TDSDefaultPkt)); err != nil {
		return 0, err
	}
	return len(p), nil
}

func (c *TDSHandshakeConn) SetDeadline(t time.Time) error { return c.Conn.SetDeadline(t) }

// UCS2 encodes a string as TDS does (UTF-16LE).
func UCS2(s string) []byte {
	u := utf16.Encode([]rune(s))
	b := make([]byte, 2*len(u))
	for i, v := range u {
		binary.LittleEndian.PutUint16(b[2*i:], v)
	}
	return b
}

// FromUCS2 decodes UTF-16LE.
func FromUCS2(b []byte) string {
	u := make([]uint16, len(b)/2)
	for i := range u {
		u[i] = binary.LittleEndian.Uint16(b[2*i:])
	}
	return string(utf16.Decode(u))
}

// Login7 is what a LOGIN7 message says that the proxy uses or passes on.
type Login7 struct {
	TDSVersion    uint32
	PacketSize    uint32
	ClientProgVer uint32
	ClientPID     uint32
	OptionFlags1  byte
	OptionFlags2  byte
	TypeFlags     byte
	OptionFlags3  byte
	TimeZone      int32
	LCID          uint32
	HostName      string
	UserName      string
	AppName       string
	ServerName    string
	ClientIntName string
	Language      string
	Database      string
	ClientID      [6]byte
}

const (
	login7Fixed      = 94
	loginFlag2IntSec = 0x80 // fIntSecurity: Windows (SSPI) sign-in
	loginFlag3Ext    = 0x10 // fExtension: feature extensions follow
	loginFlag3ChgPw  = 0x01 // fChangePassword
	loginFlag3UnkCol = 0x08 // fUnknownCollationHandling
)

// ParseLogin7 reads a client's LOGIN7. The password and any Windows (SSPI)
// token are not kept.
func ParseLogin7(b []byte) (Login7, error) {
	var l Login7
	if len(b) < login7Fixed {
		return l, errNotTDS
	}
	l.TDSVersion = binary.LittleEndian.Uint32(b[4:])
	l.PacketSize = binary.LittleEndian.Uint32(b[8:])
	l.ClientProgVer = binary.LittleEndian.Uint32(b[12:])
	l.ClientPID = binary.LittleEndian.Uint32(b[16:])
	l.OptionFlags1, l.OptionFlags2, l.TypeFlags, l.OptionFlags3 = b[24], b[25], b[26], b[27]
	l.TimeZone = int32(binary.LittleEndian.Uint32(b[28:]))
	l.LCID = binary.LittleEndian.Uint32(b[32:])
	str := func(at int) string {
		off, n := int(binary.LittleEndian.Uint16(b[at:])), int(binary.LittleEndian.Uint16(b[at+2:]))
		if n == 0 || off+2*n > len(b) {
			return ""
		}
		return FromUCS2(b[off : off+2*n])
	}
	l.HostName, l.UserName = str(36), str(40)
	l.AppName, l.ServerName = str(48), str(52)
	l.ClientIntName, l.Language, l.Database = str(60), str(64), str(68)
	copy(l.ClientID[:], b[72:78])
	return l, nil
}

// Build lays out a LOGIN7 signing in as UserName with password: SQL Server
// authentication, no feature extensions, no Windows sign-in.
func (l Login7) Build(password string) []byte {
	strs := []struct {
		at  int
		val []byte
	}{
		{36, UCS2(l.HostName)}, {40, UCS2(l.UserName)}, {44, obfuscatePassword(password)},
		{48, UCS2(l.AppName)}, {52, UCS2(l.ServerName)}, {60, UCS2(l.ClientIntName)},
		{64, UCS2(l.Language)}, {68, UCS2(l.Database)},
	}
	b := make([]byte, login7Fixed)
	data := []byte{}
	for _, s := range strs {
		binary.LittleEndian.PutUint16(b[s.at:], uint16(login7Fixed+len(data)))
		binary.LittleEndian.PutUint16(b[s.at+2:], uint16(len(s.val)/2))
		data = append(data, s.val...)
	}
	for _, at := range []int{56, 78, 82, 86} { // extension, SSPI, attach file, change password: empty
		binary.LittleEndian.PutUint16(b[at:], uint16(login7Fixed+len(data)))
	}
	b = append(b, data...)
	binary.LittleEndian.PutUint32(b[0:], uint32(len(b)))
	binary.LittleEndian.PutUint32(b[4:], l.TDSVersion)
	binary.LittleEndian.PutUint32(b[8:], l.PacketSize)
	binary.LittleEndian.PutUint32(b[12:], l.ClientProgVer)
	binary.LittleEndian.PutUint32(b[16:], l.ClientPID)
	b[24], b[25], b[26] = l.OptionFlags1, l.OptionFlags2&^loginFlag2IntSec, l.TypeFlags
	b[27] = l.OptionFlags3 &^ (loginFlag3Ext | loginFlag3ChgPw)
	binary.LittleEndian.PutUint32(b[28:], uint32(l.TimeZone))
	binary.LittleEndian.PutUint32(b[32:], l.LCID)
	copy(b[72:78], l.ClientID[:])
	return b
}

// obfuscatePassword is LOGIN7's password encoding: each byte of the UCS-2
// string with its nibbles swapped, XOR 0xA5. (Not encryption: the packet
// travels inside TLS.)
func obfuscatePassword(p string) []byte {
	b := UCS2(p)
	for i, c := range b {
		b[i] = (c<<4 | c>>4) ^ 0xA5
	}
	return b
}

// TDSErrorToken is an ERROR token as SQL Server sends it.
func TDSErrorToken(number uint32, state, class byte, msg, server string) []byte {
	var body []byte
	body = binary.LittleEndian.AppendUint32(body, number)
	body = append(body, state, class)
	m := UCS2(msg)
	body = binary.LittleEndian.AppendUint16(body, uint16(len(m)/2))
	body = append(body, m...)
	s := UCS2(server)
	body = append(append(body, byte(len(s)/2)), s...)
	body = append(body, 0)                           // procedure name
	body = binary.LittleEndian.AppendUint32(body, 1) // line
	out := binary.LittleEndian.AppendUint16([]byte{TokenError}, uint16(len(body)))
	return append(out, body...)
}

// TDSDoneToken is a DONE token.
func TDSDoneToken(status uint16, rows uint64) []byte {
	b := binary.LittleEndian.AppendUint16([]byte{TokenDone}, status)
	b = binary.LittleEndian.AppendUint16(b, 0)
	return binary.LittleEndian.AppendUint64(b, rows)
}

// TDSServerError is what the server says in an ERROR token.
type TDSServerError struct {
	Number uint32
	State  byte
	Class  byte
	Msg    string
}

func (e *TDSServerError) Error() string { return e.Msg }

// ParseErrorToken reads an ERROR or INFO token's body (after the length).
func ParseErrorToken(body []byte) (TDSServerError, bool) {
	var e TDSServerError
	if len(body) < 8 {
		return e, false
	}
	e.Number = binary.LittleEndian.Uint32(body)
	e.State, e.Class = body[4], body[5]
	n := int(binary.LittleEndian.Uint16(body[6:]))
	if 8+2*n > len(body) {
		return e, false
	}
	e.Msg = FromUCS2(body[8 : 8+2*n])
	return e, true
}

// LoginResult is what the server's answer to LOGIN7 says.
type LoginResult struct {
	OK            bool
	Err           *TDSServerError
	ServerVersion string // from LOGINACK
	Database      string // from ENVCHANGE
	PacketSize    string
}

// ParseLoginResponse walks the tokens of the server's answer to LOGIN7. Every
// token there but FEATUREEXTACK and DONE carries a 2-byte length.
func ParseLoginResponse(b []byte) (LoginResult, error) {
	var r LoginResult
	for len(b) > 0 {
		tok := b[0]
		switch tok {
		case TokenDone, TokenDoneProc, TokenDoneInProc:
			if len(b) < tdsDoneTokenSize {
				return r, errNotTDS
			}
			b = b[tdsDoneTokenSize:]
			continue
		case TokenFeatureAck:
			b = b[1:]
			for len(b) > 0 && b[0] != 0xFF {
				if len(b) < 5 {
					return r, errNotTDS
				}
				n := int(binary.LittleEndian.Uint32(b[1:]))
				if 5+n > len(b) {
					return r, errNotTDS
				}
				b = b[5+n:]
			}
			if len(b) > 0 {
				b = b[1:]
			}
			continue
		}
		if len(b) < 3 {
			return r, errNotTDS
		}
		n := int(binary.LittleEndian.Uint16(b[1:]))
		if 3+n > len(b) {
			return r, errNotTDS
		}
		body := b[3 : 3+n]
		b = b[3+n:]
		switch tok {
		case TokenError:
			if e, ok := ParseErrorToken(body); ok && r.Err == nil {
				r.Err = &e
			}
		case TokenLoginAck:
			r.OK = true
			// interface (1), TDS version (4), program name (B_VARCHAR), version (4)
			if len(body) >= 6 {
				if at := 6 + 2*int(body[5]); at+4 <= len(body) {
					v := body[at:]
					r.ServerVersion = strconv.Itoa(int(v[0])) + "." + strconv.Itoa(int(v[1])) + "." + strconv.Itoa(int(binary.BigEndian.Uint16(v[2:])))
				}
			}
		case TokenEnvChange:
			if len(body) >= 2 {
				typ, vn := body[0], int(body[1])
				if 2+2*vn <= len(body) {
					v := FromUCS2(body[2 : 2+2*vn])
					switch typ {
					case 1:
						r.Database = v
					case 4:
						r.PacketSize = v
					}
				}
			}
		case TokenInfo:
		default:
			// An unexpected token: stop reading, the answer is what was seen.
			return r, nil
		}
	}
	return r, nil
}
