package main

import (
	"bufio"
	"crypto/tls"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/hashicorp/yamux"
	"github.com/kurtserdar/captivo-access/tunnel"
)

// maxConcurrentStreams bounds how many tunnel streams the connector services at
// once, so a hostile/compromised control plane can't exhaust the connector
// host's goroutines, file descriptors, and ephemeral ports by opening streams
// without limit. Accepting blocks past the cap (backpressure), never dropping.
const maxConcurrentStreams = 256

// serveStreams accepts streams opened by the data-plane over mux and handles
// each one independently until the session dies.
func serveStreams(mux *yamux.Session, allow *TargetMatcher, store *recStore) {
	sem := make(chan struct{}, maxConcurrentStreams)
	for {
		st, err := mux.Accept()
		if err != nil {
			return
		}
		sem <- struct{}{} // backpressure: block accepting new streams past the cap
		go func(s io.ReadWriteCloser) {
			defer func() { <-sem }()
			handleStream(s, allow, store)
		}(st)
	}
}

// resolveUpstreamTarget validates a tunnel upstream URL + path against the
// egress boundary (allow) and the host-confusion rules, returning the resolved
// target URL and the base URL, or a non-empty errMsg. Shared by handleDial and
// handleWS so the connector's core security boundary lives in exactly one place.
func resolveUpstreamTarget(upstreamURL, path string, allow *TargetMatcher) (target, base *url.URL, errMsg string) {
	base, err := url.Parse(upstreamURL)
	if err != nil || (base.Scheme != "http" && base.Scheme != "https") || base.Hostname() == "" {
		return nil, nil, "bad upstream url"
	}
	if !egressAllowed(allow, base.Host) {
		denied()
		return nil, nil, "target not allowed" // egress boundary — fail closed
	}
	if !strings.HasPrefix(path, "/") {
		return nil, nil, "invalid path"
	}
	ref, err := url.Parse(path)
	if err != nil || ref.IsAbs() || ref.Host != "" {
		return nil, nil, "invalid path"
	}
	target = base.ResolveReference(ref)
	if target.Scheme != base.Scheme || target.Host != base.Host {
		return nil, nil, "invalid path"
	}
	return target, base, ""
}

// handleStream reads the first control frame, peeks its kind, and dispatches
// to the dial (proxied HTTP) or probe (TCP reachability) handler.
func handleStream(st io.ReadWriteCloser, allow *TargetMatcher, store *recStore) {
	defer st.Close()
	reqBytes, err := tunnel.ReadFrame(st)
	if err != nil {
		return
	}
	var peek struct {
		Kind string `json:"kind"`
	}
	_ = json.Unmarshal(reqBytes, &peek)
	if peek.Kind == "control" {
		handleControl(st, store)
		return
	}
	// Relay stream: count it, and wrap st so bytes are tallied for every kind.
	connOpen()
	defer connClose()
	cst := &countingStream{ReadWriteCloser: st}
	switch peek.Kind {
	case "probe":
		handleProbe(cst, allow, reqBytes)
	case "ws":
		handleWS(cst, allow, reqBytes)
	case "ldap":
		handleLdap(cst, allow, reqBytes)
	case "guacd":
		handleGuacd(cst, allow, reqBytes)
	case "recwrite":
		handleRecWrite(cst, store, reqBytes)
	case "recsearch":
		handleRecSearch(cst, store, reqBytes)
	case "recfetch":
		handleRecFetch(cst, store, reqBytes)
	default:
		handleDial(cst, allow, reqBytes)
	}
}

// handleControl runs the control stream both ways: it reads pushed policy frames
// (applying them live) and writes telemetry every 10s, until the stream dies.
// (The opening ControlHello was already read as the dispatch frame.)
func handleControl(st io.ReadWriteCloser, store *recStore) {
	defer st.Close()
	done := make(chan struct{})
	// reader: apply pushed policy frames
	go func() {
		defer close(done)
		for {
			b, err := tunnel.ReadFrame(st)
			if err != nil {
				return
			}
			var p tunnel.Policy
			if json.Unmarshal(b, &p) == nil {
				ack := applyPolicy(p, store)
				// Only speak up when something happened. The telemetry writer shares
				// this stream, and an ack per policy tick would be noise the control
				// plane has to filter.
				if ack.RetentionRemoved > 0 || len(ack.PurgedKeys) > 0 {
					if ab, err := json.Marshal(ack); err == nil {
						_ = tunnel.WriteFrame(st, ab)
					}
				}
			}
		}
	}()
	// writer: telemetry every 10s
	tick := time.NewTicker(10 * time.Second)
	defer tick.Stop()
	for {
		b, err := json.Marshal(snapshot())
		if err == nil {
			if err := tunnel.WriteFrame(st, b); err != nil {
				return
			}
		}
		select {
		case <-done:
			return
		case <-tick.C:
		}
	}
}

// handleLdap services a raw LDAP relay. The first frame is a
// tunnel.LdapDialRequest carrying a "host:port"; handleLdap validates it against
// the connector's egress boundary (allow), plain-TCP-dials it, and relays bytes
// bidirectionally. It does NO TLS or LDAP parsing — LDAPS/StartTLS is negotiated
// end-to-end between the data-plane's LDAP client and the directory, tunnelled
// as opaque bytes. Same fail-closed egress boundary as handleDial/handleWS.
func handleLdap(st io.ReadWriteCloser, allow *TargetMatcher, reqBytes []byte) {
	var lr tunnel.LdapDialRequest
	if json.Unmarshal(reqBytes, &lr) != nil {
		return
	}
	host, port, err := net.SplitHostPort(lr.Target)
	if err != nil || host == "" || port == "" {
		writeLdapErr(st, "bad target")
		return
	}
	if !egressAllowed(allow, lr.Target) {
		denied()
		logDenied("ldap", lr.Target)
		writeLdapErr(st, "target not allowed") // egress boundary — fail closed
		return
	}
	upstream, err := net.DialTimeout("tcp", lr.Target, 10*time.Second)
	if err != nil {
		logUpstreamErr("ldap", lr.Target, err.Error())
		writeLdapErr(st, "directory unreachable")
		return
	}
	defer upstream.Close()
	if b, mErr := json.Marshal(tunnel.LdapDialResponse{}); mErr == nil {
		if tunnel.WriteFrame(st, b) != nil {
			return
		}
	} else {
		return
	}
	// Raw bidirectional relay until either side closes; closing st/upstream
	// unblocks the other io.Copy.
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(st, upstream); done <- struct{}{} }() // directory -> tunnel
	go func() { _, _ = io.Copy(upstream, st); done <- struct{}{} }() // tunnel -> directory
	<-done
}

// handleGuacd services a raw relay to guacd — a byte-for-byte clone of the LDAP
// relay. The first frame is a tunnel.GuacdDialRequest carrying guacd's "host:port";
// it validates against the egress boundary, plain-TCP-dials guacd, and relays the
// Guacamole protocol opaquely (guacd, not the connector, speaks it).
func handleGuacd(st io.ReadWriteCloser, allow *TargetMatcher, reqBytes []byte) {
	var gr tunnel.GuacdDialRequest
	if json.Unmarshal(reqBytes, &gr) != nil {
		return
	}
	host, port, err := net.SplitHostPort(gr.Target)
	if err != nil || host == "" || port == "" {
		writeGuacdErr(st, "bad target")
		return
	}
	if !egressAllowed(allow, gr.Target) {
		denied()
		logDenied("guacd", gr.Target)
		writeGuacdErr(st, "target not allowed") // egress boundary — fail closed
		return
	}
	upstream, err := net.DialTimeout("tcp", gr.Target, 10*time.Second)
	if err != nil {
		logUpstreamErr("guacd", gr.Target, err.Error())
		writeGuacdErr(st, "guacd unreachable")
		return
	}
	defer upstream.Close()
	if b, mErr := json.Marshal(tunnel.GuacdDialResponse{}); mErr == nil {
		if tunnel.WriteFrame(st, b) != nil {
			return
		}
	} else {
		return
	}
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(st, upstream); done <- struct{}{} }() // guacd -> tunnel
	go func() { _, _ = io.Copy(upstream, st); done <- struct{}{} }() // tunnel -> guacd
	<-done
}

func writeGuacdErr(st io.Writer, msg string) {
	if b, err := json.Marshal(tunnel.GuacdDialResponse{Error: msg}); err == nil {
		_ = tunnel.WriteFrame(st, b)
	}
}

func writeLdapErr(st io.Writer, msg string) {
	b, err := json.Marshal(tunnel.LdapDialResponse{Error: msg})
	if err != nil {
		return
	}
	_ = tunnel.WriteFrame(st, b)
}

// upstreamTransport builds the HTTP transport used to dial an internal app.
// Its phase timeouts bound a misconfigured upstream so it fails fast with a
// clear error instead of hanging until the 30s client timeout. The motivating
// case: a Site addressed as http:// pointing at a TLS-only port (e.g.
// Proxmox's 8006) — the TCP connects, the plaintext request is written, and
// the server waits forever for a TLS handshake, so no response header ever
// arrives. ResponseHeaderTimeout turns that indefinite wait into a bounded
// failure; the dial/handshake timeouts bound the connect phase similarly.
func upstreamTransport(insecure bool) *http.Transport {
	t := &http.Transport{
		DialContext:           (&net.Dialer{Timeout: 8 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout:   8 * time.Second,
		ResponseHeaderTimeout: 12 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		// A fresh transport is built per request (handleDial), so there is no
		// cross-request connection reuse to preserve. Not pooling idle
		// connections avoids the benign but noisy "Unsolicited response
		// received on idle HTTP channel" log some upstreams (Proxmox pveproxy,
		// embedded router UIs) trigger by trailing a chunk terminator onto a
		// parked keep-alive connection, and closes each upstream connection
		// cleanly after its response.
		DisableKeepAlives: true,
	}
	if insecure {
		t.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	}
	return t
}

// handleDial services a single proxied HTTP request. The first frame on the
// stream is a tunnel.DialRequest carrying the full upstream URL to dial;
// handleDial validates that URL (scheme must be http/https, host must be
// non-empty) and checks it against the connector's optional egress boundary
// (allow) before ever dialing it. If ALLOWED_TARGETS is unset the boundary
// is open and any well-formed http(s) URL is dialed; if it's set, targets
// outside it are rejected with a DialResponse error and the stream is
// closed — this is the connector's core security boundary.
func handleDial(st io.ReadWriteCloser, allow *TargetMatcher, reqBytes []byte) {
	var dr tunnel.DialRequest
	if json.Unmarshal(reqBytes, &dr) != nil {
		return
	}

	target, _, errMsg := resolveUpstreamTarget(dr.UpstreamUrl, dr.Path, allow)
	if errMsg != "" {
		if errMsg == "target not allowed" {
			logDenied("http", hostOf(dr.UpstreamUrl))
		} else {
			logReject("http", hostOf(dr.UpstreamUrl), errMsg)
		}
		writeErr(st, errMsg)
		return
	}

	client := &http.Client{
		Timeout: 30 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
		// Per-Site opt-in on InsecureSkipVerify: the operator has marked this
		// upstream a trusted internal device with a self-signed/unverifiable
		// certificate.
		Transport: upstreamTransport(dr.InsecureSkipVerify),
	}
	req, err := http.NewRequest(orGet(dr.Method), target.String(), tunnel.NewBodyReader(st))
	if err != nil {
		writeErr(st, "bad request")
		return
	}
	for k, vs := range dr.Header {
		for _, v := range vs {
			req.Header.Add(k, v)
		}
	}
	// http.Client ignores a manually-added Content-Length header on a body
	// of unknown length (our tunnel.BodyReader isn't *bytes.Reader/*strings.Reader,
	// so Go can't infer length itself) and instead sends chunked
	// transfer-encoding. A strict upstream that only understands
	// Content-Length then sees an empty body. Honor an incoming
	// Content-Length by setting req.ContentLength directly so Go emits a
	// fixed-length request instead of chunking it.
	if cl := req.Header.Get("Content-Length"); cl != "" {
		if n, e := strconv.ParseInt(cl, 10, 64); e == nil && n >= 0 {
			req.ContentLength = n
		}
		req.Header.Del("Content-Length") // Go emits Content-Length from req.ContentLength
	}
	start := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		logUpstreamErr("http", target.Host, err.Error())
		writeErr(st, "upstream unreachable")
		return
	}
	defer resp.Body.Close()
	d := time.Since(start)
	logDebug("http %d %s in %s", resp.StatusCode, target.Host, d.Round(time.Millisecond))
	if d > slowUpstreamThreshold {
		logSlowUpstream(target.Host, d)
	}

	respMeta, err := json.Marshal(tunnel.DialResponse{Status: resp.StatusCode, Header: resp.Header})
	if err != nil {
		return
	}
	if tunnel.WriteFrame(st, respMeta) != nil {
		return
	}
	_ = tunnel.WriteBody(st, resp.Body)
}

func writeErr(st io.Writer, msg string) {
	b, err := json.Marshal(tunnel.DialResponse{Status: 0, Error: msg})
	if err != nil {
		return
	}
	_ = tunnel.WriteFrame(st, b)
}

// handleWS services a WebSocket-passthrough stream: it validates the upstream
// against the SAME egress boundary as handleDial, raw-dials it (TLS for https,
// honoring the per-Site InsecureSkipVerify), replays the browser's upgrade
// request, reads the upstream handshake response, and — on a 101 — relays raw
// bytes in both directions between the tunnel stream and the upstream socket.
// The WS body is never HTTP-body-framed; it is a transparent byte pipe, so any
// subprotocol/extension passes through untouched.
func handleWS(st io.ReadWriteCloser, allow *TargetMatcher, reqBytes []byte) {
	var wr tunnel.WsDialRequest
	if json.Unmarshal(reqBytes, &wr) != nil {
		return
	}
	target, base, errMsg := resolveUpstreamTarget(wr.UpstreamUrl, wr.Path, allow)
	if errMsg != "" {
		if errMsg == "target not allowed" {
			logDenied("ws", hostOf(wr.UpstreamUrl))
		} else {
			logReject("ws", hostOf(wr.UpstreamUrl), errMsg)
		}
		writeWsErr(st, errMsg)
		return
	}

	// Validate headers for CR/LF injection before dialing. The connector is the
	// security boundary — don't rely on the data-plane to sanitize headers.
	for k, vs := range wr.Header {
		if strings.ContainsAny(k, "\r\n") {
			writeWsErr(st, "invalid header")
			return
		}
		for _, v := range vs {
			if strings.ContainsAny(v, "\r\n") {
				writeWsErr(st, "invalid header")
				return
			}
		}
	}

	hostPort := base.Host
	if base.Port() == "" {
		if base.Scheme == "https" {
			hostPort = net.JoinHostPort(base.Hostname(), "443")
		} else {
			hostPort = net.JoinHostPort(base.Hostname(), "80")
		}
	}
	var upstream net.Conn
	var err error
	if base.Scheme == "https" {
		upstream, err = tls.DialWithDialer(&net.Dialer{Timeout: 10 * time.Second}, "tcp", hostPort,
			&tls.Config{InsecureSkipVerify: wr.InsecureSkipVerify, ServerName: base.Hostname()})
	} else {
		upstream, err = net.DialTimeout("tcp", hostPort, 10*time.Second)
	}
	if err != nil {
		logUpstreamErr("ws", hostPort, err.Error())
		writeWsErr(st, "upstream unreachable")
		return
	}
	defer upstream.Close()

	// Set a read deadline for the handshake phase only. A slow/malicious
	// upstream that accepts then stalls would hang the goroutine forever.
	// The deadline is cleared after the handshake so the long-lived WS relay
	// stays unbounded.
	upstream.SetReadDeadline(time.Now().Add(10 * time.Second))

	// Replay the upgrade request to the upstream. target.RequestURI() carries
	// the validated, host-less path+query.
	var b strings.Builder
	b.WriteString("GET " + target.RequestURI() + " HTTP/1.1\r\n")
	b.WriteString("Host: " + base.Host + "\r\n")
	for k, vs := range wr.Header {
		if strings.EqualFold(k, "Host") {
			continue
		}
		for _, v := range vs {
			b.WriteString(k + ": " + v + "\r\n")
		}
	}
	b.WriteString("\r\n")
	if _, err := io.WriteString(upstream, b.String()); err != nil {
		writeWsErr(st, "upstream write failed")
		return
	}

	// Read the upstream handshake head manually (status line + headers up to a
	// blank line). Manual parsing keeps the relay transparent — no http.Client
	// body-framing semantics on the 101 — and any bytes the upstream already
	// sent past the header terminator stay buffered in br for the relay.
	br := bufio.NewReader(upstream)
	statusLine, err := br.ReadString('\n')
	if err != nil {
		writeWsErr(st, "upstream handshake failed")
		return
	}
	status := 0
	if parts := strings.SplitN(strings.TrimSpace(statusLine), " ", 3); len(parts) >= 2 {
		status, _ = strconv.Atoi(parts[1])
	}
	header := map[string][]string{}
	// Bound the header block to 64 KiB total so a hostile/broken upstream can't
	// stream headers with no terminating blank line and grow memory until the
	// read deadline. Read from br directly (not a wrapping reader) so no post-
	// handshake WS body bytes are buffered away from the relay that follows.
	const maxHeaderBytes = 64 << 10
	headerBytes := 0
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			writeWsErr(st, "upstream handshake failed")
			return
		}
		headerBytes += len(line)
		if headerBytes > maxHeaderBytes {
			writeWsErr(st, "upstream handshake too large")
			return
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			break
		}
		if i := strings.IndexByte(line, ':'); i >= 0 {
			k := strings.TrimSpace(line[:i])
			v := strings.TrimSpace(line[i+1:])
			header[k] = append(header[k], v)
		}
	}

	respMeta, err := json.Marshal(tunnel.WsDialResponse{Status: status, Header: header})
	if err != nil {
		return
	}
	if tunnel.WriteFrame(st, respMeta) != nil {
		return
	}
	if status != 101 {
		return // upstream declined the upgrade; data-plane surfaces the failure
	}

	// Clear the handshake read deadline. The long-lived WS relay must stay
	// unbounded — no timeouts on the bidirectional byte relay.
	upstream.SetReadDeadline(time.Time{})

	// Raw bidirectional relay. Read the upstream side from br (it holds any
	// post-handshake bytes already buffered). When either direction ends, close
	// both conns so the other io.Copy unblocks.
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(st, br); done <- struct{}{} }()       // upstream → tunnel
	go func() { _, _ = io.Copy(upstream, st); done <- struct{}{} }() // tunnel → upstream
	<-done
	_ = upstream.Close()
	_ = st.Close()
	<-done
}

func writeWsErr(st io.Writer, msg string) {
	b, err := json.Marshal(tunnel.WsDialResponse{Status: 0, Error: msg})
	if err != nil {
		return
	}
	_ = tunnel.WriteFrame(st, b)
}

func orGet(m string) string {
	if m == "" {
		return "GET"
	}
	return m
}

// handleProbe services a TCP reachability check. The first frame is a
// tunnel.ProbeRequest carrying the upstream URL; handleProbe validates it
// (scheme must be http/https, host must be non-empty) and checks it against
// the connector's optional egress boundary (allow) before ever dialing it —
// the same boundary a proxied dial uses, since a probe reaches the same
// network as a dial and must not be a way to bypass ALLOWED_TARGETS. It then
// TCP-connects to the derived host:port (default 80/443 by scheme) and
// reports success/failure and latency, never making an HTTP request.
func handleProbe(st io.Writer, allow *TargetMatcher, reqBytes []byte) {
	var pr tunnel.ProbeRequest
	if json.Unmarshal(reqBytes, &pr) != nil {
		return
	}
	baseURL, err := url.Parse(pr.UpstreamUrl)
	if err != nil || (baseURL.Scheme != "http" && baseURL.Scheme != "https") || baseURL.Hostname() == "" {
		writeProbe(st, tunnel.ProbeResponse{Ok: false, Error: "bad upstream url"})
		return
	}
	if !egressAllowed(allow, baseURL.Host) {
		writeProbe(st, tunnel.ProbeResponse{Ok: false, Error: "target not allowed"}) // egress boundary — fail closed
		return
	}
	port := baseURL.Port()
	if port == "" {
		if baseURL.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	// net.JoinHostPort brackets IPv6 hosts correctly (baseURL.Hostname strips them).
	hostPort := net.JoinHostPort(baseURL.Hostname(), port)
	start := time.Now()
	conn, err := net.DialTimeout("tcp", hostPort, 5*time.Second)
	if err != nil {
		detail := "unreachable"
		if ne, ok := err.(net.Error); ok && ne.Timeout() {
			detail = "timeout"
		} else if strings.Contains(err.Error(), "refused") {
			detail = "connection refused"
		}
		writeProbe(st, tunnel.ProbeResponse{Ok: false, Error: detail})
		return
	}
	conn.Close()
	writeProbe(st, tunnel.ProbeResponse{Ok: true, LatencyMs: int(time.Since(start).Milliseconds())})
}

func writeProbe(st io.Writer, pr tunnel.ProbeResponse) {
	b, err := json.Marshal(pr)
	if err != nil {
		return
	}
	_ = tunnel.WriteFrame(st, b)
}
