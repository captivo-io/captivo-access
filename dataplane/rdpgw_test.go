package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf16"

	"github.com/coder/websocket"
)

func mintTestTicket(secret string, tk rdpTicket) string {
	raw, _ := json.Marshal(tk)
	body := base64.RawURLEncoding.EncodeToString(raw)
	m := hmac.New(sha256.New, rdpTicketKey(secret))
	m.Write([]byte(rdpTicketPrefix + body))
	return rdpTicketPrefix + body + "." + base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

func utf16le(s string) []byte {
	var b []byte
	for _, u := range utf16.Encode([]rune(s)) {
		b = binary.LittleEndian.AppendUint16(b, u)
	}
	return b
}

// Client packets, laid out as FreeRDP's rdg.c sends them.
func clientHandshake(extAuth uint16) []byte {
	return tsgPacket(tsgHandshakeRequest, append([]byte{1, 0}, append(le16(0), le16(extAuth)...)...))
}

func clientTunnelCreate(cookie string) []byte {
	c := append(utf16le(cookie), 0, 0)
	body := append(le32(1), le16(tsgFieldPAACookie)...)
	body = append(body, le16(0)...)
	body = append(body, le16(uint16(len(c)))...)
	return tsgPacket(tsgTunnelCreate, append(body, c...))
}

func clientTunnelAuth(name string) []byte {
	n := append(utf16le(name), 0, 0)
	return tsgPacket(tsgTunnelAuth, append(append(le16(0), le16(uint16(len(n)))...), n...))
}

func clientChannelCreate(server string, port uint16) []byte {
	n := append(utf16le(server), 0, 0)
	body := []byte{1, 0}
	body = append(body, le16(port)...)
	body = append(body, le16(3)...)
	body = append(body, le16(uint16(len(n)))...)
	return tsgPacket(tsgChannelCreate, append(body, n...))
}

type fakeRdpAuth struct {
	allow  bool
	target rdpTarget
	err    error
}

func (f *fakeRdpAuth) CheckAccess(string, string, string) (bool, string, error) {
	if !f.allow {
		return false, "expired", nil
	}
	return true, "", nil
}
func (f *fakeRdpAuth) NativeRdpTarget(string, string) (rdpTarget, error) { return f.target, f.err }

// rdgMethod makes coder/websocket's GET handshake an RDG_OUT_DATA one, as mstsc sends it.
type rdgMethod struct{ base http.RoundTripper }

func (m rdgMethod) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Method = rdgMethodOut
	return m.base.RoundTrip(r)
}

type gwHarness struct {
	srv    *httptest.Server
	hub    *SessionHub
	dialed chan string
}

func newGwHarness(t *testing.T, auth *fakeRdpAuth) *gwHarness {
	t.Helper()
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { echo.Close() })
	go func() {
		for {
			c, err := echo.Accept()
			if err != nil {
				return
			}
			go func() { defer c.Close(); _, _ = io.Copy(c, c) }()
		}
	}()
	h := &gwHarness{hub: NewSessionHub(), dialed: make(chan string, 4)}
	deps := rdpgwDeps{
		secret: "s3cret", ctrl: auth, hub: h.hub, now: time.Now,
		dial: func(connectorID, target string) (net.Conn, error) {
			h.dialed <- connectorID + " " + target
			if connectorID == "offline" {
				return nil, errors.New("connector offline")
			}
			return net.Dial("tcp", echo.Addr().String())
		},
	}
	h.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { serveRdpGateway(deps, w, r) }))
	t.Cleanup(h.srv.Close)
	return h
}

func (h *gwHarness) dial(t *testing.T) net.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	u := "ws" + strings.TrimPrefix(h.srv.URL, "http") + rdpgwPath
	c, _, err := websocket.Dial(ctx, u, &websocket.DialOptions{HTTPClient: &http.Client{Transport: rdgMethod{http.DefaultTransport}}})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	conn := websocket.NetConn(context.Background(), c, websocket.MessageBinary)
	t.Cleanup(func() { conn.Close() })
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	return conn
}

func expect(t *testing.T, conn net.Conn, want uint16) []byte {
	t.Helper()
	typ, body, err := readTsgPacket(conn)
	if err != nil {
		t.Fatalf("read (want %#x): %v", want, err)
	}
	if typ != want {
		t.Fatalf("packet type %#x, want %#x", typ, want)
	}
	return body
}

func status(b []byte, off int) uint32 { return binary.LittleEndian.Uint32(b[off:]) }

func goodAuth() *fakeRdpAuth {
	return &fakeRdpAuth{allow: true, target: rdpTarget{Host: "dc.corp.local", Port: "3389", ConnectorID: "c1", TenantID: "t1", RedirectFlags: 0x8}}
}

func goodTicket() string {
	return mintTestTicket("s3cret", rdpTicket{TenantID: "t1", SiteID: "site1", UserID: "u1", Exp: time.Now().Add(time.Minute).Unix(), Nonce: "ab"})
}

func TestRdpGatewayTunnelEndToEnd(t *testing.T) {
	h := newGwHarness(t, goodAuth())
	conn := h.dial(t)

	_, _ = conn.Write(clientHandshake(tsgExtAuthPAA))
	hs := expect(t, conn, tsgHandshakeResponse)
	if status(hs, 0) != 0 || binary.LittleEndian.Uint16(hs[8:]) != tsgExtAuthPAA {
		t.Fatalf("handshake response %x", hs)
	}
	_, _ = conn.Write(clientTunnelCreate(goodTicket()))
	if tr := expect(t, conn, tsgTunnelResponse); status(tr, 2) != 0 {
		t.Fatalf("tunnel response %x", tr)
	}
	_, _ = conn.Write(clientTunnelAuth("LAPTOP-1"))
	ar := expect(t, conn, tsgTunnelAuthResponse)
	if status(ar, 0) != 0 || status(ar, 8) != 0x8 {
		t.Fatalf("tunnel auth response %x", ar)
	}
	// The file asked for another host: the tunnel still goes to the resource.
	_, _ = conn.Write(clientChannelCreate("evil.example", 3389))
	if cr := expect(t, conn, tsgChannelResponse); status(cr, 0) != 0 {
		t.Fatalf("channel response %x", cr)
	}
	if got := <-h.dialed; got != "c1 dc.corp.local:3389" {
		t.Fatalf("dialed %q", got)
	}
	// Two data packets in one WebSocket message, and back as data packets.
	_, _ = conn.Write(append(dataPacket([]byte("\x03\x00")), dataPacket([]byte("\x00\x0b"))...))
	var echoed []byte
	for len(echoed) < 4 {
		d := expect(t, conn, tsgData)
		n := binary.LittleEndian.Uint16(d)
		echoed = append(echoed, d[2:2+n]...)
	}
	if string(echoed) != "\x03\x00\x00\x0b" {
		t.Fatalf("echoed %q", echoed)
	}
	list := h.hub.List()
	if len(list) != 1 || !list[0].Native || list[0].Kind != "gateway" || list[0].SiteID != "site1" || list[0].UserID != "u1" {
		t.Fatalf("hub = %+v", list)
	}
	_, _ = conn.Write(tsgPacket(tsgCloseChannel, le32(0)))
	expect(t, conn, tsgCloseChannelResponse)
	waitFor(t, func() bool { return len(h.hub.List()) == 0 })
}

func TestRdpGatewayTerminateEndsTunnel(t *testing.T) {
	h := newGwHarness(t, goodAuth())
	conn := h.dial(t)
	_, _ = conn.Write(clientHandshake(tsgExtAuthPAA))
	expect(t, conn, tsgHandshakeResponse)
	_, _ = conn.Write(clientTunnelCreate(goodTicket()))
	expect(t, conn, tsgTunnelResponse)
	_, _ = conn.Write(clientTunnelAuth("x"))
	expect(t, conn, tsgTunnelAuthResponse)
	_, _ = conn.Write(clientChannelCreate("dc.corp.local", 3389))
	expect(t, conn, tsgChannelResponse)
	var id string
	waitFor(t, func() bool {
		l := h.hub.List()
		if len(l) == 1 {
			id = l[0].SessionID
		}
		return id != ""
	})
	if !h.hub.Terminate(id) {
		t.Fatal("terminate")
	}
	expect(t, conn, tsgCloseChannel)
	waitFor(t, func() bool { return len(h.hub.List()) == 0 })
}

func TestRdpGatewayRefusals(t *testing.T) {
	cases := []struct {
		name   string
		auth   *fakeRdpAuth
		ticket string
	}{
		{"bad signature", goodAuth(), mintTestTicket("other", rdpTicket{TenantID: "t1", SiteID: "s", UserID: "u", Exp: time.Now().Add(time.Minute).Unix()})},
		{"expired", goodAuth(), mintTestTicket("s3cret", rdpTicket{TenantID: "t1", SiteID: "s", UserID: "u", Exp: time.Now().Add(-time.Second).Unix()})},
		{"grant gone", &fakeRdpAuth{allow: false}, goodTicket()},
		{"native off", &fakeRdpAuth{allow: true, err: errors.New("control-plane returned non-200")}, goodTicket()},
		{"other tenant", &fakeRdpAuth{allow: true, target: rdpTarget{Host: "h", Port: "3389", ConnectorID: "c1", TenantID: "t2"}}, goodTicket()},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := newGwHarness(t, c.auth)
			conn := h.dial(t)
			_, _ = conn.Write(clientHandshake(tsgExtAuthPAA))
			expect(t, conn, tsgHandshakeResponse)
			_, _ = conn.Write(clientTunnelCreate(c.ticket))
			if tr := expect(t, conn, tsgTunnelResponse); status(tr, 2) == 0 {
				t.Fatalf("tunnel allowed: %x", tr)
			}
			if _, _, err := readTsgPacket(conn); err == nil {
				t.Fatal("tunnel stayed open")
			}
		})
	}
}

func TestRdpGatewayNeedsToken(t *testing.T) {
	h := newGwHarness(t, goodAuth())
	conn := h.dial(t)
	_, _ = conn.Write(clientHandshake(0x4)) // NTLM
	if hs := expect(t, conn, tsgHandshakeResponse); status(hs, 0) != eProxyUnsupportedAuth {
		t.Fatalf("handshake %x", hs)
	}
}

func TestRdpGatewayConnectorOffline(t *testing.T) {
	auth := goodAuth()
	auth.target.ConnectorID = "offline"
	h := newGwHarness(t, auth)
	conn := h.dial(t)
	_, _ = conn.Write(clientHandshake(tsgExtAuthPAA))
	expect(t, conn, tsgHandshakeResponse)
	_, _ = conn.Write(clientTunnelCreate(goodTicket()))
	expect(t, conn, tsgTunnelResponse)
	_, _ = conn.Write(clientTunnelAuth("x"))
	expect(t, conn, tsgTunnelAuthResponse)
	_, _ = conn.Write(clientChannelCreate("dc.corp.local", 3389))
	if cr := expect(t, conn, tsgChannelResponse); status(cr, 0) != eProxyTSConnectFailed {
		t.Fatalf("channel response %x", cr)
	}
}

func TestRdpGatewayHTTPTransportNotServed(t *testing.T) {
	h := newGwHarness(t, goodAuth())
	for _, m := range []string{rdgMethodIn, rdgMethodOut, http.MethodGet} {
		req, _ := http.NewRequest(m, h.srv.URL+rdpgwPath, nil)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusNotImplemented {
			t.Fatalf("%s: %d", m, res.StatusCode)
		}
	}
}

func TestParseTunnelCreateWithoutCookie(t *testing.T) {
	body := append(le32(1), le16(0)...)
	body = append(body, le16(0)...)
	if c, err := parseTunnelCreate(body); err != nil || c != "" {
		t.Fatalf("%q %v", c, err)
	}
	if _, err := parseTunnelCreate([]byte{1, 2}); err == nil {
		t.Fatal("short packet accepted")
	}
}

func TestReadTsgPacketRejectsBadLength(t *testing.T) {
	bad := tsgPacket(tsgData, nil)
	binary.LittleEndian.PutUint32(bad[4:], 4)
	if _, _, err := readTsgPacket(strings.NewReader(string(bad))); err == nil {
		t.Fatal("length below the header accepted")
	}
	binary.LittleEndian.PutUint32(bad[4:], tsgMaxPacket+1)
	if _, _, err := readTsgPacket(strings.NewReader(string(bad))); err == nil {
		t.Fatal("oversized packet accepted")
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
