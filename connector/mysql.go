package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha1" // #nosec G505 -- MySQL's mysql_native_password and RSA-OAEP use SHA-1
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// MySQL and MariaDB sign-in for database access (Kind "db", Engine "mysql").
// The connector reads the server's greeting, switches to TLS when the
// resource asks for it, and signs in as the saved account with the
// capability flags the user's client agreed with the data plane, so the
// rest of the connection, relayed raw, reads the way the client expects.

const (
	myLongPassword     = 0x00000001
	myFoundRows        = 0x00000002
	myLongFlag         = 0x00000004
	myConnectWithDB    = 0x00000008
	myNoSchema         = 0x00000010
	myODBC             = 0x00000040
	myIgnoreSpace      = 0x00000100
	myProtocol41       = 0x00000200
	myInteractive      = 0x00000400
	mySSL              = 0x00000800
	myTransactions     = 0x00002000
	mySecureConnection = 0x00008000
	myMultiStatements  = 0x00010000
	myMultiResults     = 0x00020000
	myPSMultiResults   = 0x00040000
	myPluginAuth       = 0x00080000

	// What a client may carry over to the server: flags that change only
	// what a statement does, never how a packet is laid out beyond what
	// every MySQL 5.5+ and MariaDB server sends anyway.
	myPassThrough = myLongPassword | myFoundRows | myLongFlag | myNoSchema | myODBC | myIgnoreSpace |
		myInteractive | myTransactions | myMultiStatements | myMultiResults | myPSMultiResults

	myMaxPacket = 1 << 24
)

// myError is the server's ERR packet during the sign-in.
type myError struct {
	Number   uint16
	SQLState string
	Message  string
}

func (e *myError) Error() string { return e.Message }

// Code is how the data plane hands the error on to the client.
func (e *myError) Code() string { return strconv.Itoa(int(e.Number)) + ":" + e.SQLState }

// myConn reads and writes MySQL packets, keeping the sequence number.
type myConn struct {
	conn net.Conn
	br   *bufio.Reader
	seq  byte
}

func (c *myConn) read() ([]byte, error) {
	var h [4]byte
	if _, err := io.ReadFull(c.br, h[:]); err != nil {
		return nil, err
	}
	n := int(h[0]) | int(h[1])<<8 | int(h[2])<<16
	if n >= myMaxPacket-1 {
		return nil, errors.New("not a MySQL server")
	}
	c.seq = h[3] + 1
	b := make([]byte, n)
	if _, err := io.ReadFull(c.br, b); err != nil {
		return nil, err
	}
	return b, nil
}

func (c *myConn) write(b []byte) error {
	h := []byte{byte(len(b)), byte(len(b) >> 8), byte(len(b) >> 16), c.seq}
	c.seq++
	_, err := c.conn.Write(append(h, b...))
	return err
}

// myGreeting is the part of the server's HandshakeV10 the sign-in needs.
type myGreeting struct {
	version  string
	connID   uint32
	caps     uint32
	scramble []byte
	plugin   string
}

func parseMyGreeting(b []byte) (myGreeting, error) {
	var g myGreeting
	if len(b) > 0 && b[0] == 0xff {
		return g, parseMyError(b)
	}
	if len(b) < 1 || b[0] != 10 {
		return g, errors.New("not a MySQL server (or a version older than 4.1)")
	}
	i := bytes.IndexByte(b[1:], 0)
	if i < 0 {
		return g, errors.New("not a MySQL server")
	}
	g.version = string(b[1 : 1+i])
	b = b[2+i:]
	if len(b) < 4+8+1+2 {
		return g, errors.New("not a MySQL server")
	}
	g.connID = binary.LittleEndian.Uint32(b)
	g.scramble = append([]byte(nil), b[4:12]...)
	g.caps = uint32(binary.LittleEndian.Uint16(b[13:15]))
	b = b[15:]
	if len(b) >= 1+2+2+1+10 {
		g.caps |= uint32(binary.LittleEndian.Uint16(b[3:5])) << 16
		authLen := int(b[5])
		b = b[16:]
		if g.caps&mySecureConnection != 0 {
			n := max(13, authLen-8)
			if n > len(b) {
				n = len(b)
			}
			g.scramble = append(g.scramble, bytes.TrimRight(b[:n], "\x00")...)
			b = b[n:]
		}
		if g.caps&myPluginAuth != 0 {
			name, _, _ := bytes.Cut(b, []byte{0})
			g.plugin = string(name)
		}
	}
	return g, nil
}

func parseMyError(b []byte) error {
	e := &myError{Number: 2013, SQLState: "HY000", Message: "the database server refused the sign-in"}
	if len(b) < 3 || b[0] != 0xff {
		return e
	}
	e.Number = binary.LittleEndian.Uint16(b[1:3])
	rest := b[3:]
	if len(rest) >= 6 && rest[0] == '#' {
		e.SQLState, rest = string(rest[1:6]), rest[6:]
	}
	if len(rest) > 0 {
		e.Message = string(rest)
	}
	return e
}

// myNativeScramble is mysql_native_password's answer:
// SHA1(password) XOR SHA1(scramble + SHA1(SHA1(password))).
func myNativeScramble(password string, scramble []byte) []byte {
	if password == "" {
		return nil
	}
	h1 := sha1.Sum([]byte(password)) // #nosec G401 -- the protocol's own construction
	h2 := sha1.Sum(h1[:])            // #nosec G401
	h := sha1.New()                  // #nosec G401
	h.Write(scramble[:min(20, len(scramble))])
	h.Write(h2[:])
	h3 := h.Sum(nil)
	for i := range h3 {
		h3[i] ^= h1[i]
	}
	return h3
}

// mySha2Scramble is caching_sha2_password's fast answer:
// SHA256(password) XOR SHA256(SHA256(SHA256(password)) + scramble).
func mySha2Scramble(password string, scramble []byte) []byte {
	if password == "" {
		return nil
	}
	h1 := sha256.Sum256([]byte(password))
	h2 := sha256.Sum256(h1[:])
	h := sha256.New()
	h.Write(h2[:])
	h.Write(scramble[:min(20, len(scramble))])
	h3 := h.Sum(nil)
	for i := range h3 {
		h3[i] ^= h1[i]
	}
	return h3
}

// myRSAPassword encrypts the password for a server's public key, as
// caching_sha2_password and sha256_password do on a connection without TLS.
func myRSAPassword(password string, scramble []byte, keyPEM []byte) ([]byte, error) {
	blk, _ := pem.Decode(keyPEM)
	if blk == nil {
		return nil, errors.New("the database server sent no usable public key")
	}
	k, err := x509.ParsePKIXPublicKey(blk.Bytes)
	if err != nil {
		return nil, errors.New("the database server sent no usable public key")
	}
	pub, ok := k.(*rsa.PublicKey)
	if !ok || len(scramble) == 0 {
		return nil, errors.New("the database server sent no usable public key")
	}
	plain := append([]byte(password), 0)
	for i := range plain {
		plain[i] ^= scramble[i%len(scramble)]
	}
	return rsa.EncryptOAEP(sha1.New(), rand.Reader, pub, plain, nil) // #nosec G401 -- what the server decrypts with
}

// myDial connects and reads the greeting; with TLS on, it switches to TLS
// before anything about the account is sent.
func myDial(req tunnel.DbDialRequest, caps uint32) (*myConn, myGreeting, uint32, bool, error) {
	addr := net.JoinHostPort(req.Host, req.Port)
	raw, err := net.DialTimeout("tcp", addr, 10*time.Second)
	if err != nil {
		return nil, myGreeting{}, 0, false, errors.New("the database server can't be reached from the connector")
	}
	_ = raw.SetDeadline(time.Now().Add(dbSignInLimit))
	c := &myConn{conn: raw, br: bufio.NewReader(raw)}
	b, err := c.read()
	if err != nil {
		raw.Close()
		return nil, myGreeting{}, 0, false, errors.New("the database server closed the connection")
	}
	g, err := parseMyGreeting(b)
	if err != nil {
		raw.Close()
		return nil, g, 0, false, err
	}
	if g.caps&myProtocol41 == 0 || g.caps&mySecureConnection == 0 {
		raw.Close()
		return nil, g, 0, false, errors.New("the database server is too old (MySQL 5.5 or later is needed)")
	}
	caps = caps&g.caps | myProtocol41 | mySecureConnection | myLongPassword
	if g.caps&myPluginAuth != 0 {
		caps |= myPluginAuth
	}
	if req.Database != "" && g.caps&myConnectWithDB != 0 {
		caps |= myConnectWithDB
	}
	if req.TLS == "disable" || req.TLS == "" {
		return c, g, caps, false, nil
	}
	if g.caps&mySSL == 0 {
		raw.Close()
		return nil, g, 0, false, errors.New("the database server does not accept TLS; set the resource's TLS to Off, or turn on TLS on the server")
	}
	if err := c.write(myHandshakeHead(caps|mySSL, req.Collation)); err != nil {
		raw.Close()
		return nil, g, 0, false, errors.New("the database server closed the connection")
	}
	cfg := &tls.Config{ServerName: req.Host, MinVersion: tls.VersionTLS12}
	if req.TLS == "verify-full" {
		if strings.TrimSpace(req.CACertPEM) != "" {
			pool := x509.NewCertPool()
			if !pool.AppendCertsFromPEM([]byte(req.CACertPEM)) {
				raw.Close()
				return nil, g, 0, false, errors.New("the resource's CA certificate does not parse")
			}
			cfg.RootCAs = pool
		}
	} else {
		cfg.InsecureSkipVerify = true // #nosec G402 -- "require": encrypted, the admin chose not to verify the certificate
	}
	tc := tls.Client(raw, cfg)
	if err := tc.Handshake(); err != nil {
		raw.Close()
		if strings.Contains(err.Error(), "handshake failure") {
			// MySQL 5.7 built with OpenSSL 1.0 offers only DHE key exchange.
			return nil, g, 0, false, errors.New("TLS to the database server failed: it offers no cipher the connector uses (an older MySQL 5.7 build offers only DHE); turn on ECDHE ciphers on the server, or set the resource's TLS to Off")
		}
		return nil, g, 0, false, fmt.Errorf("TLS to the database server failed: %v", err)
	}
	c.conn, c.br = tc, bufio.NewReader(tc)
	return c, g, caps | mySSL, true, nil
}

// myHandshakeHead is the fixed start of a HandshakeResponse41, which is also
// the whole SSLRequest.
func myHandshakeHead(caps uint32, collation uint8) []byte {
	b := binary.LittleEndian.AppendUint32(nil, caps)
	b = binary.LittleEndian.AppendUint32(b, myMaxPacket-1)
	if collation == 0 {
		collation = 45 // utf8mb4_general_ci
	}
	b = append(b, collation)
	return append(b, make([]byte, 23)...)
}

// myAnswer is the first answer to an auth plugin's challenge.
func myAnswer(plugin, password string, scramble []byte, encrypted bool) ([]byte, error) {
	switch plugin {
	case "mysql_native_password":
		return myNativeScramble(password, scramble), nil
	case "caching_sha2_password":
		return mySha2Scramble(password, scramble), nil
	case "sha256_password":
		if password == "" {
			return []byte{0}, nil
		}
		if encrypted {
			return append([]byte(password), 0), nil
		}
		return []byte{1}, nil // ask for the server's public key
	case "mysql_clear_password":
		if !encrypted {
			return nil, errors.New("the database account signs in with a cleartext password, which the connector sends only over TLS; set the resource's TLS to Required")
		}
		return append([]byte(password), 0), nil
	}
	return nil, fmt.Errorf("the database account uses the %s sign-in method, which the connector does not support (use caching_sha2_password or mysql_native_password)", plugin)
}

// mySignIn opens the connection and signs in. It returns the connection past
// the server's OK, with the flags it settled on.
func mySignIn(req tunnel.DbDialRequest, password string) (net.Conn, *bufio.Reader, tunnel.DbDialResponse, error) {
	var resp tunnel.DbDialResponse
	c, g, caps, encrypted, err := myDial(req, req.Capabilities&myPassThrough)
	if err != nil {
		return nil, nil, resp, err
	}
	fail := func(err error) (net.Conn, *bufio.Reader, tunnel.DbDialResponse, error) {
		c.conn.Close()
		return nil, nil, resp, err
	}
	plugin := g.plugin
	if plugin != "caching_sha2_password" && plugin != "mysql_native_password" {
		plugin = "mysql_native_password" // the server switches us to the account's own method
	}
	ans, err := myAnswer(plugin, password, g.scramble, encrypted)
	if err != nil {
		return fail(err)
	}
	b := myHandshakeHead(caps, req.Collation)
	b = append(append(b, req.Username...), 0)
	b = append(append(b, byte(len(ans))), ans...)
	if caps&myConnectWithDB != 0 {
		b = append(append(b, req.Database...), 0)
	}
	if caps&myPluginAuth != 0 {
		b = append(append(b, plugin...), 0)
	}
	if err := c.write(b); err != nil {
		return fail(errors.New("the database server closed the connection"))
	}
	scramble := g.scramble
	for {
		p, err := c.read()
		if err != nil {
			return fail(errors.New("the database server closed the connection during the sign-in"))
		}
		if len(p) == 0 {
			return fail(errors.New("not a MySQL server"))
		}
		switch p[0] {
		case 0x00: // OK
			_ = c.conn.SetDeadline(time.Time{})
			resp = tunnel.DbDialResponse{TLS: encrypted, ConnID: g.connID, ServerVersion: g.version, Capabilities: caps &^ mySSL}
			return c.conn, c.br, resp, nil
		case 0xff:
			return fail(parseMyError(p))
		case 0xfe: // AuthSwitchRequest
			name, data, _ := bytes.Cut(p[1:], []byte{0})
			plugin = string(name)
			scramble = bytes.TrimRight(data, "\x00")
			ans, err := myAnswer(plugin, password, scramble, encrypted)
			if err != nil {
				return fail(err)
			}
			if err := c.write(ans); err != nil {
				return fail(errors.New("the database server closed the connection"))
			}
		case 0x01: // AuthMoreData
			var out []byte
			switch {
			case plugin == "caching_sha2_password" && len(p) == 2 && p[1] == 3:
				continue // the server knew the password from its cache; OK follows
			case plugin == "caching_sha2_password" && len(p) == 2 && p[1] == 4:
				if encrypted {
					out = append([]byte(password), 0)
				} else {
					out = []byte{2} // ask for the public key
				}
			case (plugin == "caching_sha2_password" || plugin == "sha256_password") && bytes.Contains(p, []byte("PUBLIC KEY")):
				if out, err = myRSAPassword(password, scramble, p[1:]); err != nil {
					return fail(err)
				}
			default:
				return fail(errors.New("unexpected answer from the database server during the sign-in"))
			}
			if err := c.write(out); err != nil {
				return fail(errors.New("the database server closed the connection"))
			}
		default:
			return fail(errors.New("unexpected answer from the database server during the sign-in"))
		}
	}
}
