package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"strings"
	"sync"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// The isolated browser runs on a Docker network with no way out
// (captivo-isolated, --internal); its only door is this proxy. Each session
// presents its own token (the session extension answers the proxy's 407), and
// the proxy applies that session's rule: so a vendor reaches the resource they
// were given -- and, by default, the public internet for sign-in pages and
// CDNs -- but not the rest of the customer's network. That is the zero-trust
// promise for the isolated browser: an application, never a network.
//
// Destinations are checked by the address actually dialled (names are
// resolved here), so DNS tricks cannot turn an allowed name into an internal
// address.

var egressProxyAddr = envOr("EGRESS_PROXY_ADDR", "access-connector:3128") // as the isolated browser reaches it

const (
	egressRuleTTL   = 7 * 24 * time.Hour // a rule whose release was lost
	egressMaxEvents = 200
)

type egressRule struct {
	mode       string
	hosts      []string
	reportOnly bool
	created    time.Time

	mu     sync.Mutex
	events map[string]*tunnel.EgressEvent
}

var egressRules = struct {
	sync.Mutex
	m map[string]*egressRule
}{m: map[string]*egressRule{}}

func registerEgress(req tunnel.EgressRequest) (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	tok := hex.EncodeToString(b)
	mode := req.Mode
	if mode != "strict" && mode != "open" {
		mode = "internet"
	}
	var hosts []string
	for _, h := range req.Hosts {
		if h = strings.ToLower(strings.TrimSpace(h)); h != "" {
			hosts = append(hosts, h)
		}
	}
	egressRules.Lock()
	defer egressRules.Unlock()
	now := time.Now()
	for t, r := range egressRules.m {
		if now.Sub(r.created) > egressRuleTTL {
			delete(egressRules.m, t)
		}
	}
	egressRules.m[tok] = &egressRule{mode: mode, hosts: hosts, reportOnly: req.ReportOnly, created: now, events: map[string]*tunnel.EgressEvent{}}
	return tok, nil
}

func releaseEgress(tok string) []tunnel.EgressEvent {
	egressRules.Lock()
	r := egressRules.m[tok]
	delete(egressRules.m, tok)
	egressRules.Unlock()
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]tunnel.EgressEvent, 0, len(r.events))
	for _, e := range r.events {
		out = append(out, *e)
	}
	return out
}

func egressRuleFor(tok string) *egressRule {
	egressRules.Lock()
	defer egressRules.Unlock()
	return egressRules.m[tok]
}

func (r *egressRule) note(dest, reason string, blocked bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if e := r.events[dest]; e != nil {
		e.Count++
		return
	}
	if len(r.events) >= egressMaxEvents {
		return
	}
	r.events[dest] = &tunnel.EgressEvent{Dest: dest, Reason: reason, Count: 1, Blocked: blocked}
}

func hostListed(hosts []string, host string) bool {
	for _, h := range hosts {
		if h == host {
			return true
		}
		if strings.HasPrefix(h, "*.") && (host == h[2:] || strings.HasSuffix(host, h[1:])) {
			return true
		}
	}
	return false
}

// neverAllowed: loopback (the connector itself), link-local / cloud metadata,
// unspecified and multicast addresses -- no rule opens these.
func neverAllowed(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsMulticast() || ip.IsInterfaceLocalMulticast()
}

var egressNeverAllowed = neverAllowed // tests reach a loopback server

var cgnat = &net.IPNet{IP: net.IPv4(100, 64, 0, 0), Mask: net.CIDRMask(10, 32)}

// internalIP: the customer's own network (RFC 1918, ULA, CGNAT).
func internalIP(ip net.IP) bool {
	return ip.IsPrivate() || cgnat.Contains(ip)
}

// The session engines and the connector are never a destination.
var egressServiceNames = map[string]bool{"localhost": true, "access-connector": true, "captivo-kasm": true, "captivo-guacd": true}

type egressResolver func(ctx context.Context, host string) ([]net.IP, error)

func systemResolve(ctx context.Context, host string) ([]net.IP, error) {
	addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	ips := make([]net.IP, 0, len(addrs))
	for _, a := range addrs {
		ips = append(ips, a.IP)
	}
	return ips, nil
}

// decide returns the address to dial for host:port under rule r, or a reason
// it is refused. Report-only rules record what they would refuse and allow it,
// except what is never allowed.
func decide(ctx context.Context, r *egressRule, allow *TargetMatcher, resolve egressResolver, host, port string) (string, string) {
	host = strings.ToLower(strings.TrimSuffix(strings.Trim(host, "[]"), "."))
	dest := net.JoinHostPort(host, port)
	if egressServiceNames[host] {
		r.note(dest, "connector service", true)
		return "", "connector service"
	}
	var ips []net.IP
	if ip := net.ParseIP(host); ip != nil {
		ips = []net.IP{ip}
	} else {
		rctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		got, err := resolve(rctx, host)
		cancel()
		if err != nil || len(got) == 0 {
			return "", "cannot resolve"
		}
		ips = got
	}
	var usable, public []net.IP
	for _, ip := range ips {
		if egressNeverAllowed(ip) {
			continue
		}
		usable = append(usable, ip)
		if !internalIP(ip) {
			public = append(public, ip)
		}
	}
	if len(usable) == 0 {
		r.note(dest, "never allowed", true)
		return "", "never allowed"
	}
	listed := hostListed(r.hosts, host)
	pick, reason := usable, ""
	switch {
	case r.mode == "open" || listed:
	case r.mode == "strict":
		reason = "not on the resource's list"
	case len(public) > 0:
		pick = public
	default:
		reason = "internal network"
	}
	// The connector's own egress boundary still applies to the internal network.
	if reason == "" && internalIP(pick[0]) && !egressAllowed(allow, dest) {
		reason = "outside the connector's allowed targets"
	}
	if reason != "" {
		r.note(dest, reason, !r.reportOnly)
		if !r.reportOnly {
			return "", reason
		}
	}
	return net.JoinHostPort(pick[0].String(), port), ""
}

type egressProxy struct {
	allow   *TargetMatcher
	resolve egressResolver
	dialer  net.Dialer
}

func proxyToken(h string) string {
	const p = "Basic "
	if !strings.HasPrefix(h, p) {
		return ""
	}
	b, err := base64.StdEncoding.DecodeString(h[len(p):])
	if err != nil {
		return ""
	}
	_, tok, _ := strings.Cut(string(b), ":")
	return tok
}

type egressCtxKey struct{}

func (p *egressProxy) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	rule := egressRuleFor(proxyToken(req.Header.Get("Proxy-Authorization")))
	if rule == nil {
		w.Header().Set("Proxy-Authenticate", `Basic realm="captivo-access"`)
		http.Error(w, "proxy authentication required", http.StatusProxyAuthRequired)
		return
	}
	if req.Method == http.MethodConnect {
		p.connect(w, req, rule)
		return
	}
	if req.URL.Scheme != "http" || req.URL.Host == "" {
		http.Error(w, "unsupported", http.StatusBadRequest)
		return
	}
	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.Out.URL = pr.In.URL
			pr.Out.Host = pr.In.Host
			pr.Out.Header.Del("Proxy-Authorization")
			pr.Out.Header.Del("Proxy-Connection")
		},
		Transport: &http.Transport{
			Proxy: nil,
			DialContext: func(ctx context.Context, _, addr string) (net.Conn, error) {
				host, port, err := net.SplitHostPort(addr)
				if err != nil {
					return nil, err
				}
				to, why := decide(ctx, rule, p.allow, p.resolve, host, port)
				if why != "" {
					return nil, &egressDenied{why}
				}
				return p.dialer.DialContext(ctx, "tcp", to)
			},
			MaxIdleConns:    0,
			IdleConnTimeout: 30 * time.Second,
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			if d, ok := err.(*egressDenied); ok {
				http.Error(w, "blocked by Captivo Access: "+d.reason, http.StatusForbidden)
				return
			}
			http.Error(w, "upstream unreachable", http.StatusBadGateway)
		},
	}
	rp.ServeHTTP(w, req)
}

type egressDenied struct{ reason string }

func (e *egressDenied) Error() string { return "egress denied: " + e.reason }

func (p *egressProxy) connect(w http.ResponseWriter, req *http.Request, rule *egressRule) {
	host, port, err := net.SplitHostPort(req.Host)
	if err != nil {
		http.Error(w, "bad target", http.StatusBadRequest)
		return
	}
	to, why := decide(req.Context(), rule, p.allow, p.resolve, host, port)
	if why != "" {
		http.Error(w, "blocked by Captivo Access: "+why, http.StatusForbidden)
		return
	}
	up, err := p.dialer.DialContext(req.Context(), "tcp", to)
	if err != nil {
		http.Error(w, "upstream unreachable", http.StatusBadGateway)
		return
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		up.Close()
		http.Error(w, "unsupported", http.StatusInternalServerError)
		return
	}
	c, buf, err := hj.Hijack()
	if err != nil {
		up.Close()
		return
	}
	_, _ = c.Write([]byte("HTTP/1.1 200 Connection established\r\n\r\n"))
	if n := buf.Reader.Buffered(); n > 0 {
		b, _ := buf.Reader.Peek(n)
		_, _ = up.Write(b)
	}
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(up, c); done <- struct{}{} }()
	go func() { _, _ = io.Copy(c, up); done <- struct{}{} }()
	<-done
	c.Close()
	up.Close()
}

// startEgressProxy listens for the isolated browser. Reachable only by
// presenting a registered session token.
func startEgressProxy(listen string, allow *TargetMatcher) {
	srv := &http.Server{Addr: listen, Handler: &egressProxy{allow: allow, resolve: systemResolve, dialer: net.Dialer{Timeout: 15 * time.Second}}, ReadHeaderTimeout: 15 * time.Second}
	go func() {
		if err := srv.ListenAndServe(); err != nil {
			logError("egress proxy on %s stopped: %v", listen, err)
		}
	}()
}

// handleEgress serves the data-plane's register/release calls.
func handleEgress(st io.ReadWriteCloser, reqBytes []byte) {
	var req tunnel.EgressRequest
	var resp tunnel.EgressResponse
	if json.Unmarshal(reqBytes, &req) != nil {
		resp.Error = "bad request"
	} else {
		switch req.Op {
		case "register":
			tok, err := registerEgress(req)
			if err != nil {
				resp.Error = err.Error()
			} else {
				resp.Token, resp.Proxy = tok, egressProxyAddr
			}
		case "release":
			resp.Events = releaseEgress(req.Token)
		default:
			resp.Error = "bad op"
		}
	}
	if b, err := json.Marshal(resp); err == nil {
		_ = tunnel.WriteFrame(st, b)
	}
}
