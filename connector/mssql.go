package main

import (
	"bufio"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// SQL Server (TDS) for the database proxy: the connector signs in with the
// saved SQL Server login and the user's client's LOGIN7 options, then relays
// the connection raw (dbproxy.go). The data plane hands the client the
// server's own answer to the sign-in (dataplane/mssqlproxy.go).
//
// Encryption follows the resource's TLS setting: "require" and "verify-full"
// ask for it all the way; "disable" asks for the login packet only (SQL
// Server's own minimum), unless the server insists on all of it.

const mssqlMaxReply = 1 << 20

// mssqlTLSConfig is the resource's TLS setting as a client configuration.
func mssqlTLSConfig(req tunnel.DbDialRequest) (*tls.Config, error) {
	cfg := &tls.Config{ServerName: req.Host, MinVersion: tls.VersionTLS12}
	if req.TLS == "verify-full" {
		if strings.TrimSpace(req.CACertPEM) != "" {
			pool := x509.NewCertPool()
			if !pool.AppendCertsFromPEM([]byte(req.CACertPEM)) {
				return nil, errors.New("the resource's CA certificate does not parse")
			}
			cfg.RootCAs = pool
		}
	} else {
		cfg.InsecureSkipVerify = true // #nosec G402 -- "require"/"disable": encrypted, the admin chose not to verify the certificate
	}
	return cfg, nil
}

// mssqlSignIn opens the connection and signs in. It returns the connection to
// write to, the reader holding what follows the sign-in, and the response for
// the data plane (the server's answer to LOGIN7 in LoginReply).
func mssqlSignIn(req tunnel.DbDialRequest, password string) (net.Conn, *bufio.Reader, tunnel.DbDialResponse, error) {
	var resp tunnel.DbDialResponse
	raw, err := net.DialTimeout("tcp", net.JoinHostPort(req.Host, req.Port), 10*time.Second)
	if err != nil {
		return nil, nil, resp, errors.New("the database server can't be reached from the connector")
	}
	fail := func(err error) (net.Conn, *bufio.Reader, tunnel.DbDialResponse, error) {
		raw.Close()
		return nil, nil, resp, err
	}
	_ = raw.SetDeadline(time.Now().Add(dbSignInLimit))
	br := bufio.NewReader(raw)

	want := byte(tunnel.EncryptOn)
	if req.TLS == "disable" || req.TLS == "" {
		want = tunnel.EncryptOff
	}
	pid := make([]byte, 4)
	binary.BigEndian.PutUint32(pid, uint32(os.Getpid()))
	pre := tunnel.BuildPrelogin([]tunnel.PreloginOption{
		{Token: tunnel.PreloginVersion, Data: []byte{0x02, 0x36, 0x00, 0x00, 0x00, 0x00}},
		{Token: tunnel.PreloginEncryption, Data: []byte{want}},
		{Token: tunnel.PreloginInstOpt, Data: []byte{0}},
		{Token: tunnel.PreloginThreadID, Data: pid},
		{Token: tunnel.PreloginMARS, Data: []byte{0}},
	})
	if _, err := raw.Write(tunnel.TDSPackets(tunnel.TDSPrelogin, pre, tunnel.TDSDefaultPkt)); err != nil {
		return fail(errors.New("the database server closed the connection"))
	}
	typ, ans, err := tunnel.ReadTDSMessage(br, 4096)
	if err != nil || typ != tunnel.TDSReply {
		return fail(errors.New("the database server does not answer as SQL Server"))
	}
	opts, err := tunnel.ParsePrelogin(ans)
	if err != nil || len(opts[tunnel.PreloginEncryption]) != 1 {
		return fail(errors.New("the database server does not answer as SQL Server"))
	}
	enc := opts[tunnel.PreloginEncryption][0]
	if want == tunnel.EncryptOn && enc == tunnel.EncryptNotSup {
		return fail(errors.New("the database server does not accept TLS; set the resource's TLS to Off, or give SQL Server a certificate"))
	}

	// writer gets LOGIN7; after it, out and in carry the session.
	var writer io.Writer = raw
	var out net.Conn = raw
	in := br
	if enc != tunnel.EncryptNotSup {
		cfg, err := mssqlTLSConfig(req)
		if err != nil {
			return fail(err)
		}
		hc := &tunnel.TDSHandshakeConn{Conn: raw, R: br}
		tc := tls.Client(hc, cfg)
		if err := tc.Handshake(); err != nil {
			return fail(fmt.Errorf("TLS to the database server failed: %v", err))
		}
		hc.Passthrough = true
		writer = tc
		if enc == tunnel.EncryptOn || enc == tunnel.EncryptReq || want == tunnel.EncryptOn {
			out, in, resp.TLS = tc, bufio.NewReader(tc), true
		}
	}

	l := tunnel.Login7{TDSVersion: tunnel.TDSVersion74, PacketSize: tunnel.TDSDefaultPkt, OptionFlags1: 0xE0, OptionFlags2: 0x03, LCID: 0x0409}
	if req.MSSQL != nil {
		l = *req.MSSQL
	}
	if l.PacketSize < tunnel.TDSMinPacket || l.PacketSize > tunnel.TDSMaxPacket {
		l.PacketSize = tunnel.TDSDefaultPkt
	}
	if l.TDSVersion < 0x72090002 {
		l.TDSVersion = tunnel.TDSVersion74
	}
	l.UserName, l.Database, l.ServerName = req.Username, req.Database, req.Host
	if l.AppName == "" {
		l.AppName = "Captivo Access"
	}
	if _, err := writer.Write(tunnel.TDSPackets(tunnel.TDSLogin7, l.Build(password), int(l.PacketSize))); err != nil {
		return fail(errors.New("the database server closed the connection"))
	}
	typ, reply, err := tunnel.ReadTDSMessage(in, mssqlMaxReply)
	if err != nil || typ != tunnel.TDSReply {
		return fail(errors.New("the database server closed the connection during the sign-in"))
	}
	r, err := tunnel.ParseLoginResponse(reply)
	if err != nil {
		return fail(errors.New("the database server does not answer as SQL Server"))
	}
	if !r.OK {
		if r.Err != nil {
			return fail(r.Err)
		}
		return fail(errors.New("the database server refused the sign-in"))
	}
	_ = raw.SetDeadline(time.Time{})
	resp.ServerVersion, resp.LoginReply = r.ServerVersion, reply
	return out, in, resp, nil
}

// mssqlSession is a signed-in SQL Server connection for rotation (rotate_db.go).
type mssqlSession struct {
	out        net.Conn
	in         *bufio.Reader
	packetSize int
}

func (s *mssqlSession) Close() error { return s.out.Close() }

// exec runs one statement as a SQL batch and returns the server's error, if any.
func (s *mssqlSession) exec(sql string) error {
	// ALL_HEADERS: the transaction descriptor header (none, one request).
	h := binary.LittleEndian.AppendUint32(nil, 22)
	h = binary.LittleEndian.AppendUint32(h, 18)
	h = binary.LittleEndian.AppendUint16(h, 2)
	h = append(h, make([]byte, 8)...)
	h = binary.LittleEndian.AppendUint32(h, 1)
	if _, err := s.out.Write(tunnel.TDSPackets(tunnel.TDSBatch, append(h, tunnel.UCS2(sql)...), s.packetSize)); err != nil {
		return errors.New("the database server closed the connection")
	}
	_ = s.out.SetReadDeadline(time.Now().Add(dbSignInLimit))
	defer func() { _ = s.out.SetReadDeadline(time.Time{}) }()
	typ, reply, err := tunnel.ReadTDSMessage(s.in, mssqlMaxReply)
	if err != nil || typ != tunnel.TDSReply {
		return errors.New("the database server closed the connection")
	}
	r, err := tunnel.ParseLoginResponse(reply) // the same tokens: ERROR, INFO, ENVCHANGE, DONE
	if err != nil {
		return errors.New("the database server does not answer as SQL Server")
	}
	if r.Err != nil {
		return r.Err
	}
	return nil
}

// column runs a query whose one column is an nvarchar (up to 4000 characters;
// CONVERT to it) and returns the rows.
func (s *mssqlSession) column(sql string) ([]string, error) {
	h := binary.LittleEndian.AppendUint32(nil, 22)
	h = binary.LittleEndian.AppendUint32(h, 18)
	h = binary.LittleEndian.AppendUint16(h, 2)
	h = append(h, make([]byte, 8)...)
	h = binary.LittleEndian.AppendUint32(h, 1)
	if _, err := s.out.Write(tunnel.TDSPackets(tunnel.TDSBatch, append(h, tunnel.UCS2(sql)...), s.packetSize)); err != nil {
		return nil, errors.New("the database server closed the connection")
	}
	_ = s.out.SetReadDeadline(time.Now().Add(dbSignInLimit))
	defer func() { _ = s.out.SetReadDeadline(time.Time{}) }()
	typ, reply, err := tunnel.ReadTDSMessage(s.in, mssqlMaxReply)
	if err != nil || typ != tunnel.TDSReply {
		return nil, errors.New("the database server closed the connection")
	}
	return parseTDSNVarcharRows(reply)
}

// parseTDSNVarcharRows reads a reply of one nvarchar column: COLMETADATA, ROWs,
// DONE. Anything else (an error token first of all) is reported or refused.
func parseTDSNVarcharRows(b []byte) ([]string, error) {
	var rows []string
	for len(b) > 0 {
		tok := b[0]
		b = b[1:]
		switch tok {
		case 0x81: // COLMETADATA: count, then per column UserType(4) Flags(2) TYPE_INFO ColName
			if len(b) < 2 {
				return nil, errors.New("the database server's answer is cut short")
			}
			n := int(binary.LittleEndian.Uint16(b))
			b = b[2:]
			if n != 1 {
				return nil, errors.New("unexpected columns in the database server's answer")
			}
			// UserType, Flags, type 0xE7 (nvarchar), max length (2), collation (5), name.
			if len(b) < 4+2+1+2+5+1 || b[6] != 0xE7 {
				return nil, errors.New("unexpected column type in the database server's answer")
			}
			b = b[4+2+1+2+5:]
			nameLen := int(b[0])
			if len(b) < 1+nameLen*2 {
				return nil, errors.New("the database server's answer is cut short")
			}
			b = b[1+nameLen*2:]
		case 0xD1: // ROW: USHORT length and UTF-16LE; 0xFFFF is NULL
			if len(b) < 2 {
				return nil, errors.New("the database server's answer is cut short")
			}
			l := int(binary.LittleEndian.Uint16(b))
			b = b[2:]
			if l == 0xFFFF {
				rows = append(rows, "")
				continue
			}
			if l > len(b) {
				return nil, errors.New("the database server's answer is cut short")
			}
			rows = append(rows, tunnel.FromUCS2(b[:l]))
			b = b[l:]
		case 0xFD, 0xFE, 0xFF: // DONE, DONEPROC, DONEINPROC: status(2) curcmd(2) rowcount(8)
			if len(b) < 12 {
				return nil, errors.New("the database server's answer is cut short")
			}
			b = b[12:]
		case 0xAA: // ERROR
			if len(b) > 2 {
				if e, ok := tunnel.ParseErrorToken(b[2:]); ok {
					return nil, &e
				}
			}
			return nil, errors.New("the database server refused the query")
		case 0xAB, 0xE3, 0xAD, 0xA9, 0x79: // INFO, ENVCHANGE, LOGINACK, RETURNSTATUS: skip (length-prefixed, or 4 bytes)
			if tok == 0x79 {
				if len(b) < 4 {
					return nil, errors.New("the database server's answer is cut short")
				}
				b = b[4:]
				continue
			}
			if len(b) < 2 {
				return nil, errors.New("the database server's answer is cut short")
			}
			l := int(binary.LittleEndian.Uint16(b))
			if len(b) < 2+l {
				return nil, errors.New("the database server's answer is cut short")
			}
			b = b[2+l:]
		default:
			return nil, errors.New("unexpected data in the database server's answer")
		}
	}
	return rows, nil
}

// msIdent quotes a SQL Server identifier; msString a Unicode string literal.
func msIdent(s string) string  { return "[" + strings.ReplaceAll(s, "]", "]]") + "]" }
func msString(s string) string { return "N'" + strings.ReplaceAll(s, "'", "''") + "'" }
