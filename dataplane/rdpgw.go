package main

import (
	"context"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf16"

	"github.com/coder/websocket"
	"github.com/kurtserdar/captivo-access/tunnel"
)

// The RD Gateway: a user's own Remote Desktop client (mstsc, FreeRDP, the
// Windows App) reaches a resource's RDP server through Captivo with a .rdp file
// the portal hands out (src/app/api/portal/rdp). The client speaks the Terminal
// Services Gateway protocol (MS-TSGU) over HTTPS; this serves its WebSocket
// transport only (an RDG_OUT_DATA upgrade, used by current clients). The RDP
// bytes inside are TLS/CredSSP between the client and the server: Captivo checks
// who may open the tunnel and carries it through the connector, but sees no
// screen, so these sessions are never recorded or watched.
//
// Packet layouts follow MS-TSGU 2.2.10 and, where the spec is loose, what
// rdpgw (github.com/bolkedebruin/rdpgw, Apache-2.0) and FreeRDP do.

const (
	tsgHandshakeRequest     = 0x1
	tsgHandshakeResponse    = 0x2
	tsgTunnelCreate         = 0x4
	tsgTunnelResponse       = 0x5
	tsgTunnelAuth           = 0x6
	tsgTunnelAuthResponse   = 0x7
	tsgChannelCreate        = 0x8
	tsgChannelResponse      = 0x9
	tsgData                 = 0xA
	tsgKeepalive            = 0xD
	tsgCloseChannel         = 0x10
	tsgCloseChannelResponse = 0x11
	tsgExtAuthPAA           = 0x2 // HTTP_EXTENDED_AUTH_PAA: the access token in the .rdp file
	tsgFieldPAACookie       = 0x1
	tsgTunnelRespTunnelID   = 0x1
	tsgTunnelRespCaps       = 0x2
	tsgAuthRespRedirFlags   = 0x1
	tsgAuthRespIdleTimeout  = 0x2
	tsgChannelRespChannelID = 0x1
	tsgCapIdleTimeout       = 0x2
	tsgMaxPacket            = 1 << 20
	tsgDataChunk            = 16 << 10
	rdpgwPath               = "/remoteDesktopGateway/"
	rdgMethodOut            = "RDG_OUT_DATA"
	rdgMethodIn             = "RDG_IN_DATA"
	eProxyInternal          = 0x800759D8
	eProxyRAPAccessDenied   = 0x800759DA
	eProxyTSConnectFailed   = 0x800759DD
	eProxyCookieAuthDenied  = 0x800759F8
	eProxyUnsupportedAuth   = 0x800759F9
	eProxyCookieBadPacket   = 0x800759F7
	rdpgwHandshakeDeadline  = 30 * time.Second
	rdpgwIdleTimeoutMinutes = 0 // the gateway sets none; the grant and the server's own policy end sessions
)

// tsgPacket is one MS-TSGU packet: type, reserved, total length (header included).
func tsgPacket(typ uint16, body []byte) []byte {
	b := make([]byte, 8, 8+len(body))
	binary.LittleEndian.PutUint16(b[0:], typ)
	binary.LittleEndian.PutUint32(b[4:], uint32(8+len(body)))
	return append(b, body...)
}

// readTsgPacket reads one packet from the transport stream. Packets may span
// WebSocket messages and a message may hold several, so the stream is read as
// bytes, not per message.
func readTsgPacket(r io.Reader) (uint16, []byte, error) {
	var h [8]byte
	if _, err := io.ReadFull(r, h[:]); err != nil {
		return 0, nil, err
	}
	typ := binary.LittleEndian.Uint16(h[0:])
	n := binary.LittleEndian.Uint32(h[4:])
	if n < 8 || n > tsgMaxPacket {
		return 0, nil, fmt.Errorf("bad packet length %d", n)
	}
	body := make([]byte, n-8)
	if _, err := io.ReadFull(r, body); err != nil {
		return 0, nil, err
	}
	return typ, body, nil
}

func le16(v uint16) []byte { return binary.LittleEndian.AppendUint16(nil, v) }
func le32(v uint32) []byte { return binary.LittleEndian.AppendUint32(nil, v) }

func decodeUTF16(b []byte) string {
	if len(b)%2 == 1 {
		b = b[:len(b)-1]
	}
	u := make([]uint16, len(b)/2)
	for i := range u {
		u[i] = binary.LittleEndian.Uint16(b[2*i:])
	}
	for len(u) > 0 && u[len(u)-1] == 0 {
		u = u[:len(u)-1]
	}
	return string(utf16.Decode(u))
}

// handshakeResponse: error code, the client's version echoed, server version, extended auth.
func handshakeResponse(code uint32, major, minor byte) []byte {
	body := append(le32(code), major, minor)
	body = append(body, le16(0)...)
	body = append(body, le16(tsgExtAuthPAA)...)
	return tsgPacket(tsgHandshakeResponse, body)
}

// parseHandshake returns the client's version and the extended auth it asks for.
func parseHandshake(b []byte) (major, minor byte, extAuth uint16, err error) {
	if len(b) < 6 {
		return 0, 0, 0, errors.New("short handshake")
	}
	return b[0], b[1], binary.LittleEndian.Uint16(b[4:]), nil
}

// parseTunnelCreate returns the PAA cookie (the .rdp file's gatewayaccesstoken).
func parseTunnelCreate(b []byte) (string, error) {
	if len(b) < 8 {
		return "", errors.New("short tunnel create")
	}
	fields := binary.LittleEndian.Uint16(b[4:])
	if fields&tsgFieldPAACookie == 0 {
		return "", nil
	}
	if len(b) < 10 {
		return "", errors.New("short PAA cookie")
	}
	n := int(binary.LittleEndian.Uint16(b[8:]))
	if len(b) < 10+n {
		return "", errors.New("short PAA cookie")
	}
	return strings.TrimSpace(decodeUTF16(b[10 : 10+n])), nil
}

func tunnelResponse(code uint32) []byte {
	body := append(le16(0), le32(code)...)
	if code != 0 {
		body = append(body, le16(0)...)
		body = append(body, le16(0)...)
		return tsgPacket(tsgTunnelResponse, body)
	}
	body = append(body, le16(tsgTunnelRespTunnelID|tsgTunnelRespCaps)...)
	body = append(body, le16(0)...)
	body = append(body, le32(1)...) // tunnel id
	body = append(body, le32(tsgCapIdleTimeout)...)
	return tsgPacket(tsgTunnelResponse, body)
}

// parseTunnelAuth returns the client's computer name (FieldsPresent, cbClientName, name).
func parseTunnelAuth(b []byte) string {
	if len(b) < 4 {
		return ""
	}
	n := int(binary.LittleEndian.Uint16(b[2:]))
	if len(b) < 4+n {
		return ""
	}
	return decodeUTF16(b[4 : 4+n])
}

func tunnelAuthResponse(code, redirectFlags uint32) []byte {
	body := le32(code)
	if code != 0 {
		body = append(body, le16(0)...)
		body = append(body, le16(0)...)
		return tsgPacket(tsgTunnelAuthResponse, body)
	}
	body = append(body, le16(tsgAuthRespRedirFlags|tsgAuthRespIdleTimeout)...)
	body = append(body, le16(0)...)
	body = append(body, le32(redirectFlags)...)
	body = append(body, le32(rdpgwIdleTimeoutMinutes)...)
	return tsgPacket(tsgTunnelAuthResponse, body)
}

// parseChannelCreate returns the first server name and the port the client asks for.
func parseChannelCreate(b []byte) (server string, port uint16, err error) {
	if len(b) < 8 || b[0] == 0 {
		return "", 0, errors.New("short channel create")
	}
	port = binary.LittleEndian.Uint16(b[2:])
	n := int(binary.LittleEndian.Uint16(b[6:]))
	if len(b) < 8+n {
		return "", 0, errors.New("short channel create")
	}
	return decodeUTF16(b[8 : 8+n]), port, nil
}

func channelResponse(code uint32) []byte {
	body := le32(code)
	if code != 0 {
		body = append(body, le16(0)...)
		body = append(body, le16(0)...)
		return tsgPacket(tsgChannelResponse, body)
	}
	body = append(body, le16(tsgChannelRespChannelID)...)
	body = append(body, le16(0)...)
	body = append(body, le32(1)...) // channel id; Windows clients need it
	return tsgPacket(tsgChannelResponse, body)
}

func dataPacket(p []byte) []byte {
	return tsgPacket(tsgData, append(le16(uint16(len(p))), p...))
}

// rdpgwAuthorizer is the part of ControlClient the gateway uses.
type rdpgwAuthorizer interface {
	CheckAccess(userID, siteID, clientIP string) (allow bool, reason string, err error)
	NativeRdpTarget(userID, siteID string) (rdpTarget, error)
}

// rdpgwDeps is what one gateway tunnel needs: the ticket key, the manager, and
// how to reach the resource's server through its connector.
type rdpgwDeps struct {
	secret string
	ctrl   rdpgwAuthorizer
	dial   func(connectorID, target string) (net.Conn, error)
	pick   func([]routeCandidate) routeCandidate // nil: the target's own connector
	// A recorded resource: the connector signs in (rdprec.go), and the
	// client's TLS ends here with the console's certificate.
	dialRec func(connectorID string, req tunnel.RdpRecRequest) (net.Conn, tunnel.RdpRecResponse, error)
	cert    func(*tls.ClientHelloInfo) (*tls.Certificate, error)
	rec     sshRecDeps // where a recorded session's recording goes
	hub     *SessionHub
	audit   *AuditQueue
	now     func() time.Time
}

// serveRdpGateway answers /remoteDesktopGateway/. Only the WebSocket transport
// is served; a client that falls back to the two-request HTTP transport is told
// it isn't implemented, and gives up with a gateway error.
func serveRdpGateway(d rdpgwDeps, w http.ResponseWriter, r *http.Request) {
	if r.Method != rdgMethodOut || !isWebSocketUpgrade(r) {
		if r.Method == rdgMethodIn || r.Method == rdgMethodOut {
			log.Printf("rdpgw: %s without a WebSocket upgrade from %s: HTTP transport not supported", r.Method, trustedClientIP(r))
		}
		http.Error(w, "use the WebSocket transport", http.StatusNotImplemented)
		return
	}
	clientIP := trustedClientIP(r)
	method := r.Method
	r.Method = http.MethodGet // the upgrade arrives as RDG_OUT_DATA
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		log.Printf("rdpgw: ws accept from %s failed: %v", clientIP, err)
		return
	}
	defer c.CloseNow()
	c.SetReadLimit(tsgMaxPacket + 16)
	r.Method = method
	conn := websocket.NetConn(context.Background(), c, websocket.MessageBinary)
	t := &rdpgwTunnel{d: d, r: r, conn: conn, clientIP: clientIP}
	t.run()
}

type rdpgwTunnel struct {
	d        rdpgwDeps
	r        *http.Request
	conn     net.Conn
	clientIP string
	wmu      sync.Mutex

	ticket rdpTicket
	target rdpTarget
	remote net.Conn

	lsMu sync.Mutex
	ls   *liveSession // the console's entry, for a recorded session's typed text
}

func (t *rdpgwTunnel) live() *liveSession {
	t.lsMu.Lock()
	defer t.lsMu.Unlock()
	return t.ls
}

func (t *rdpgwTunnel) write(p []byte) error {
	t.wmu.Lock()
	defer t.wmu.Unlock()
	_, err := t.conn.Write(p)
	return err
}

func (t *rdpgwTunnel) run() {
	const (
		stInitial = iota
		stHandshake
		stTunnel
		stAuthorized
		stOpen
	)
	state := stInitial
	_ = t.conn.SetReadDeadline(time.Now().Add(rdpgwHandshakeDeadline))
	for {
		typ, body, err := readTsgPacket(t.conn)
		if err != nil {
			if t.remote != nil {
				t.remote.Close()
			}
			return
		}
		switch typ {
		case tsgHandshakeRequest:
			if state != stInitial {
				return
			}
			major, minor, extAuth, err := parseHandshake(body)
			if err != nil {
				return
			}
			if extAuth&tsgExtAuthPAA == 0 {
				// No access token: the client was set up by hand, not from the portal's .rdp file.
				log.Printf("rdpgw: client %s asked for auth %#x, not a token", t.clientIP, extAuth)
				_ = t.write(handshakeResponse(eProxyUnsupportedAuth, major, minor))
				return
			}
			if t.write(handshakeResponse(0, major, minor)) != nil {
				return
			}
			state = stHandshake
		case tsgTunnelCreate:
			if state != stHandshake {
				return
			}
			code := t.authorize(body)
			_ = t.write(tunnelResponse(code))
			if code != 0 {
				return
			}
			state = stTunnel
		case tsgTunnelAuth:
			if state != stTunnel {
				return
			}
			name := parseTunnelAuth(body)
			if t.write(tunnelAuthResponse(0, t.target.RedirectFlags)) != nil {
				return
			}
			log.Printf("rdpgw: site=%s user=%s client=%q from %s authorized", t.ticket.SiteID, t.ticket.UserID, name, t.clientIP)
			state = stAuthorized
		case tsgChannelCreate:
			if state != stAuthorized {
				return
			}
			server, port, err := parseChannelCreate(body)
			if err != nil {
				return
			}
			if !strings.EqualFold(server, t.target.Host) || fmt.Sprint(port) != t.target.Port {
				// The tunnel goes where the ticket says, whatever the file was edited to ask for.
				log.Printf("rdpgw: site=%s client asked for %s:%d, using the resource's %s:%s", t.ticket.SiteID, server, port, t.target.Host, t.target.Port)
			}
			if t.d.pick != nil && len(t.target.Candidates) > 0 {
				t.target.ConnectorID = t.d.pick(t.target.Candidates).ID
			}
			var remote net.Conn
			if t.target.Recorded {
				remote, err = t.openRecorded()
			} else {
				remote, err = t.d.dial(t.target.ConnectorID, net.JoinHostPort(t.target.Host, t.target.Port))
			}
			if err != nil {
				log.Printf("rdpgw: site=%s dial %s:%s via connector %s failed: %v", t.ticket.SiteID, t.target.Host, t.target.Port, t.target.ConnectorID, err)
				if t.target.Recorded {
					t.auditDeny("native_rdp_sign_in_failed")
				}
				_ = t.write(channelResponse(eProxyTSConnectFailed))
				return
			}
			t.remote = remote
			if t.write(channelResponse(0)) != nil {
				remote.Close()
				return
			}
			_ = t.conn.SetReadDeadline(time.Time{})
			state = stOpen
			done := t.open()
			defer done()
		case tsgData:
			if state != stOpen || len(body) < 2 {
				return
			}
			n := int(binary.LittleEndian.Uint16(body))
			if len(body) < 2+n {
				return
			}
			if _, err := t.remote.Write(body[2 : 2+n]); err != nil {
				return
			}
		case tsgKeepalive:
			// Sent while idle; nothing to answer.
		case tsgCloseChannel:
			_ = t.write(tsgPacket(tsgCloseChannelResponse, le32(0)))
			if t.remote != nil {
				t.remote.Close()
			}
			return
		default:
			log.Printf("rdpgw: unexpected packet type %#x from %s", typ, t.clientIP)
		}
	}
}

// authorize checks the ticket, then the grant and the resource with the manager.
// It returns the MS-TSGU status for the tunnel response (0 = allowed).
func (t *rdpgwTunnel) authorize(body []byte) uint32 {
	cookie, err := parseTunnelCreate(body)
	if err != nil {
		return eProxyCookieBadPacket
	}
	tk, err := verifyRdpTicket(t.d.secret, cookie, t.d.now())
	if err != nil {
		log.Printf("rdpgw: ticket from %s refused: %v", t.clientIP, err)
		return eProxyCookieAuthDenied
	}
	t.ticket = tk
	allow, why, err := t.d.ctrl.CheckAccess(tk.UserID, tk.SiteID, t.clientIP)
	if err != nil {
		log.Printf("rdpgw: site=%s user=%s access check failed: %v", tk.SiteID, tk.UserID, err)
		return eProxyInternal
	}
	if !allow {
		log.Printf("rdpgw: site=%s user=%s refused (%s)", tk.SiteID, tk.UserID, why)
		t.auditDeny("native_rdp_" + strings.ReplaceAll(why, " ", "_"))
		return eProxyRAPAccessDenied
	}
	target, err := t.d.ctrl.NativeRdpTarget(tk.UserID, tk.SiteID)
	if err != nil {
		log.Printf("rdpgw: site=%s user=%s native target refused: %v", tk.SiteID, tk.UserID, err)
		t.auditDeny("native_rdp_not_allowed")
		return eProxyRAPAccessDenied
	}
	if target.TenantID != tk.TenantID {
		log.Printf("rdpgw: site=%s ticket tenant %s != resource tenant %s", tk.SiteID, tk.TenantID, target.TenantID)
		return eProxyRAPAccessDenied
	}
	t.target = target
	return 0
}

func (t *rdpgwTunnel) auditDeny(reason string) {
	if t.d.audit != nil {
		t.d.audit.Enqueue(auditEvent("DENY", reason, t.ticket.UserID, t.ticket.SiteID, "", t.r, http.StatusForbidden, 0))
	}
}

// open starts the server -> client pump and puts the session in the hub, where
// the console lists it, an admin can end it, and the grant is rechecked every
// minute. The returned func tears it down.
func (t *rdpgwTunnel) open() func() {
	tk, host := t.ticket, t.target.Host
	sessionID := newSessionID()
	start := t.d.now()
	if t.d.hub != nil {
		ls := t.d.hub.RegisterNative(sessionID, "rdp", tk.SiteID, tk.UserID, host, start, t.target.ConnectorID, t.clientIP)
		if t.target.Recorded {
			ls.SetCapture(true, t.target.Keystrokes)
		}
		t.lsMu.Lock()
		t.ls = ls
		t.lsMu.Unlock()
		t.d.hub.clearEnded(tk.UserID, tk.SiteID)
		t.d.hub.SetCloser(sessionID, func() {
			_ = t.write(tsgPacket(tsgCloseChannel, le32(0)))
			t.remote.Close()
			t.conn.Close()
		})
	}
	if t.d.audit != nil {
		reason := "session_open native_rdp"
		if t.target.Recorded {
			reason = "session_open native_rdp_recorded"
		}
		t.d.audit.Enqueue(auditEvent("ALLOW", reason, tk.UserID, tk.SiteID, host, t.r, http.StatusSwitchingProtocols, 0))
	}
	log.Printf("rdpgw: site=%s user=%s live session id=%s target=%s:%s", tk.SiteID, tk.UserID, sessionID, host, t.target.Port)
	var down atomic.Int64 // server→client, the close audit's bytesOut
	go func() {
		buf := make([]byte, tsgDataChunk)
		for {
			n, err := t.remote.Read(buf)
			if n > 0 {
				down.Add(int64(n))
				if t.write(dataPacket(buf[:n])) != nil {
					break
				}
			}
			if err != nil {
				break
			}
		}
		t.conn.Close() // the server hung up: end the client's read loop
	}()
	return func() {
		t.remote.Close()
		if t.d.hub != nil {
			t.d.hub.Remove(sessionID)
		}
		if t.d.audit != nil {
			t.d.audit.Enqueue(auditEvent("ALLOW", "session_close "+compactDur(t.d.now().Sub(start)), tk.UserID, tk.SiteID, host, t.r, http.StatusSwitchingProtocols, down.Load()))
		}
		log.Printf("rdpgw: site=%s user=%s session %s closed after %s (down %d B)", tk.SiteID, tk.UserID, sessionID, compactDur(t.d.now().Sub(start)), down.Load())
	}
}
