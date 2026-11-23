package main

import (
	"bufio"
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/pem"
	"math/big"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// fakeMy is a MySQL server for one sign-in: it checks the password the way
// the server does (from what it stores, never the password itself).
type fakeMy struct {
	plugin    string // the greeting's default
	account   string // the account's own plugin: a different one makes the server switch
	password  string
	ssl       bool
	cached    bool // caching_sha2_password: the fast path succeeds
	refuse    bool
	gotCaps   uint32
	gotDB     string
	gotUser   string
	rsaKey    *rsa.PrivateKey
	tlsConfig *tls.Config
}

// readerConn reads through a buffer that may already hold bytes.
type readerConn struct {
	net.Conn
	r *bufio.Reader
}

func (c *readerConn) Read(p []byte) (int, error) { return c.r.Read(p) }

var fakeScramble = []byte("abcdefghij0123456789")

func (f *fakeMy) serve(t *testing.T, ln net.Listener) {
	raw, err := ln.Accept()
	if err != nil {
		return
	}
	defer raw.Close()
	_ = raw.SetDeadline(time.Now().Add(5 * time.Second))
	c := &myConn{conn: raw, br: bufio.NewReader(raw)}
	caps := uint32(myProtocol41 | mySecureConnection | myPluginAuth | myConnectWithDB | myLongPassword | myTransactions | myMultiResults | 0x01000000)
	if f.ssl {
		caps |= mySSL
	}
	g := []byte{10}
	g = append(append(g, "8.0.36-fake"...), 0)
	g = binary.LittleEndian.AppendUint32(g, 4242)
	g = append(append(g, fakeScramble[:8]...), 0)
	g = binary.LittleEndian.AppendUint16(g, uint16(caps))
	g = append(g, 45)
	g = binary.LittleEndian.AppendUint16(g, 2)
	g = binary.LittleEndian.AppendUint16(g, uint16(caps>>16))
	g = append(g, 21)
	g = append(g, make([]byte, 10)...)
	g = append(append(g, fakeScramble[8:]...), 0)
	g = append(append(g, f.plugin...), 0)
	c.seq = 0
	if c.write(g) != nil {
		return
	}
	p, err := c.read()
	if err != nil {
		return
	}
	if len(p) == 32 && binary.LittleEndian.Uint32(p)&mySSL != 0 {
		tc := tls.Server(&readerConn{Conn: raw, r: c.br}, f.tlsConfig) // the ClientHello may be in the buffer already
		if tc.Handshake() != nil {
			return
		}
		c.conn, c.br = tc, bufio.NewReader(tc)
		if p, err = c.read(); err != nil {
			return
		}
	}
	_, encrypted := c.conn.(*tls.Conn)
	f.gotCaps = binary.LittleEndian.Uint32(p)
	rest := p[32:]
	user, rest, _ := bytes.Cut(rest, []byte{0})
	f.gotUser = string(user)
	n := int(rest[0])
	ans, rest := rest[1:1+n], rest[1+n:]
	if f.gotCaps&myConnectWithDB != 0 {
		var db []byte
		db, rest, _ = bytes.Cut(rest, []byte{0})
		f.gotDB = string(db)
	}
	plugin, _, _ := bytes.Cut(rest, []byte{0})
	ok := []byte{0, 0, 0, 2, 0, 0, 0}
	fail := []byte("\xff\x15\x04#28000Access denied for user 'app'@'10.0.0.5' (using password: YES)")
	if f.refuse {
		_ = c.write(fail)
		return
	}
	account := f.account
	if account == "" {
		account = f.plugin
	}
	if string(plugin) != account {
		sw := append(append([]byte{0xfe}, account...), 0)
		if c.write(append(append(sw, fakeScramble...), 0)) != nil {
			return
		}
		if ans, err = c.read(); err != nil {
			return
		}
	}
	switch account {
	case "mysql_native_password":
		stored := sha1.Sum(func() []byte { h := sha1.Sum([]byte(f.password)); return h[:] }())
		h := sha1.New()
		h.Write(fakeScramble)
		h.Write(stored[:])
		x := h.Sum(nil)
		for i := range x {
			x[i] ^= ans[i%len(ans)]
		}
		if len(ans) != 20 || sha1.Sum(x) != stored {
			_ = c.write(fail)
			return
		}
	case "caching_sha2_password":
		if f.cached {
			h1 := sha256.Sum256([]byte(f.password))
			h2 := sha256.Sum256(h1[:])
			h := sha256.New()
			h.Write(h2[:])
			h.Write(fakeScramble)
			x := h.Sum(nil)
			for i := range x {
				x[i] ^= ans[i%len(ans)]
			}
			if sha256.Sum256(x) != h2 {
				_ = c.write(fail)
				return
			}
			_ = c.write([]byte{1, 3})
			break
		}
		_ = c.write([]byte{1, 4})
		got, err := c.read()
		if err != nil {
			return
		}
		if !encrypted {
			if !bytes.Equal(got, []byte{2}) {
				_ = c.write(fail)
				return
			}
			der, _ := x509.MarshalPKIXPublicKey(&f.rsaKey.PublicKey)
			_ = c.write(append([]byte{1}, pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})...))
			enc, err := c.read()
			if err != nil {
				return
			}
			plain, err := rsa.DecryptOAEP(sha1.New(), nil, f.rsaKey, enc, nil)
			if err != nil {
				_ = c.write(fail)
				return
			}
			for i := range plain {
				plain[i] ^= fakeScramble[i%len(fakeScramble)]
			}
			got = plain
		}
		if string(got) != f.password+"\x00" {
			_ = c.write(fail)
			return
		}
	}
	_ = c.write(ok)
	// The relay: answer one COM_PING.
	c.seq = 0
	if q, err := c.read(); err == nil && len(q) == 1 && q[0] == 0x0e {
		_ = c.write(ok)
	}
}

func fakeTLS(t *testing.T) *tls.Config {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "db"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}}
}

func runFakeMy(t *testing.T, f *fakeMy, tlsMode string) (tunnel.DbDialResponse, error) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	done := make(chan struct{})
	go func() { f.serve(t, ln); close(done) }()
	host, port, _ := net.SplitHostPort(ln.Addr().String())
	conn, br, resp, err := mySignIn(tunnel.DbDialRequest{
		Engine: "mysql", Host: host, Port: port, Username: "app", Database: "crm", TLS: tlsMode,
		Capabilities: myProtocol41 | myMultiResults | myTransactions | 0x01000000 /* DEPRECATE_EOF */ | mySSL,
	}, "s3cret pw")
	if err == nil {
		// The connection is past the sign-in: a ping goes straight through.
		_, _ = conn.Write([]byte{1, 0, 0, 0, 0x0e})
		h := make([]byte, 4)
		if _, err := br.Read(h); err != nil || h[3] != 1 {
			t.Fatalf("no answer to a ping through the signed-in connection: %v %v", h, err)
		}
		conn.Close()
	}
	<-done
	return resp, err
}

func TestMySQLNativePassword(t *testing.T) {
	f := &fakeMy{plugin: "mysql_native_password", password: "s3cret pw"}
	resp, err := runFakeMy(t, f, "disable")
	if err != nil {
		t.Fatal(err)
	}
	if resp.ConnID != 4242 || resp.ServerVersion != "8.0.36-fake" || resp.TLS {
		t.Fatalf("response %+v", resp)
	}
	if f.gotUser != "app" || f.gotDB != "crm" {
		t.Fatalf("signed in as %q to %q", f.gotUser, f.gotDB)
	}
	if f.gotCaps&0x01000000 != 0 || f.gotCaps&mySSL != 0 {
		t.Fatalf("passed on a flag that changes the packets: %#x", f.gotCaps)
	}
	if f.gotCaps&myMultiResults == 0 || resp.Capabilities&myMultiResults == 0 {
		t.Fatalf("dropped a flag the client asked for: %#x", f.gotCaps)
	}
}

func TestMySQLCachingSha2(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	t.Run("fast", func(t *testing.T) {
		if _, err := runFakeMy(t, &fakeMy{plugin: "caching_sha2_password", password: "s3cret pw", cached: true}, "disable"); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("full over RSA", func(t *testing.T) {
		if _, err := runFakeMy(t, &fakeMy{plugin: "caching_sha2_password", password: "s3cret pw", rsaKey: key}, "disable"); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("full over TLS", func(t *testing.T) {
		resp, err := runFakeMy(t, &fakeMy{plugin: "caching_sha2_password", password: "s3cret pw", ssl: true, tlsConfig: fakeTLS(t)}, "require")
		if err != nil || !resp.TLS {
			t.Fatalf("%v %+v", err, resp)
		}
	})
}

func TestMySQLAuthSwitch(t *testing.T) {
	f := &fakeMy{plugin: "caching_sha2_password", account: "mysql_native_password", password: "s3cret pw"}
	if _, err := runFakeMy(t, f, "disable"); err != nil {
		t.Fatal(err)
	}
}

func TestMySQLRefusals(t *testing.T) {
	_, err := runFakeMy(t, &fakeMy{plugin: "mysql_native_password", password: "s3cret pw", refuse: true}, "disable")
	me, ok := err.(*myError)
	if !ok || me.Code() != "1045:28000" || !strings.Contains(me.Message, "Access denied") {
		t.Fatalf("got %v", err)
	}
	_, err = runFakeMy(t, &fakeMy{plugin: "mysql_native_password", password: "other"}, "disable")
	if _, ok := err.(*myError); !ok {
		t.Fatalf("a wrong password: got %v", err)
	}
	_, err = runFakeMy(t, &fakeMy{plugin: "mysql_native_password", password: "s3cret pw"}, "require")
	if err == nil || !strings.Contains(err.Error(), "does not accept TLS") {
		t.Fatalf("TLS on a server without it: got %v", err)
	}
	_, err = runFakeMy(t, &fakeMy{plugin: "client_ed25519", account: "client_ed25519", password: "s3cret pw"}, "disable")
	if err == nil || !strings.Contains(err.Error(), "client_ed25519") {
		t.Fatalf("an unsupported method: got %v", err)
	}
}

func TestMySQLGreetingError(t *testing.T) {
	err := parseMyError([]byte("\xff\x69\x04Host '10.0.0.5' is blocked"))
	me := err.(*myError)
	if me.Number != 1129 || me.Message != "Host '10.0.0.5' is blocked" {
		t.Fatalf("got %+v", me)
	}
	if _, err := parseMyGreeting([]byte("\xff\x69\x04blocked")); err == nil {
		t.Fatal("an ERR greeting was taken as a greeting")
	}
}
