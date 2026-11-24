package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// Kubernetes access: the user's own kubectl (Lens, k9s, Helm) reaches a
// cluster through Captivo with a kubeconfig from the portal:
//
//	server: https://<console host>/k8s/<resource id>
//	token:  <connection ticket>
//
// The front proxy forwards /k8s/ here. The proxy checks the ticket with the
// control plane, holds each request to the resource's rules (read only, the
// namespaces it reaches, port forwarding; kubereq.go), logs it, and passes it
// to the resource's connector, which signs it in to the API server with the
// service account and, with impersonation, as the Captivo user
// (connector/kubeproxy.go). kubectl exec and attach are recorded like a
// terminal and can be watched (kubeexec.go).
//
// A ticket's requests from one address are one session in the console:
// kubectl opens a connection per command, and a session per command would
// bury the list. It ends five minutes after the last request finishes.

const (
	kubePrefix        = "/k8s/"
	kubeMinConnector  = "2.62.0"
	kubeSessionLinger = 5 * time.Minute
	kubeRecheckEvery  = 60 * time.Second
	kubeDialWait      = 30 * time.Second
)

type kubeTarget struct {
	TenantID          string           `json:"tenantId"`
	SiteID            string           `json:"siteId"`
	UserID            string           `json:"userId"`
	SiteName          string           `json:"siteName"`
	Host              string           `json:"targetHost"`
	Port              int              `json:"targetPort"`
	Username          string           `json:"username"`
	CACertPEM         string           `json:"caCertPem"`
	ServerName        string           `json:"serverName"`
	ImpersonateUser   string           `json:"impersonateUser"`
	ImpersonateGroups []string         `json:"impersonateGroups"`
	ReadOnly          bool             `json:"readOnly"`
	Namespaces        []string         `json:"namespaces"`
	PortForward       bool             `json:"portForward"`
	Connectors        []routeCandidate `json:"connectors"`
	Record            bool             `json:"record"`
	Keystrokes        bool             `json:"keystrokeLogging"`
}

func (t kubeTarget) rules() kubeRules {
	return kubeRules{ReadOnly: t.ReadOnly, Namespaces: t.Namespaces, PortForward: t.PortForward}
}

type kubeAuthorizer interface {
	KubeTarget(ticket, clientIP string) (kubeTarget, error)
}

// KubeTarget resolves a kubeconfig's ticket. 404 an unknown or expired ticket
// (or its browser session ended), 403 no access now, 409 a resource that
// can't be reached as a cluster now.
func (c *ControlClient) KubeTarget(ticket, clientIP string) (kubeTarget, error) {
	var out kubeTarget
	err := c.post("/api/internal/gateway/kubernetes", map[string]string{"ticket": ticket, "clientIp": clientIP}, &out)
	return out, err
}

type kubeProxyDeps struct {
	ctrl     kubeAuthorizer
	session  func(connectorID string) *Session
	pick     func([]routeCandidate) routeCandidate
	hub      *SessionHub
	audit    *AuditQueue
	recIndex func(userID, siteID, host string, body []byte) error
	now      func() time.Time
}

type kubeProxy struct {
	d        kubeProxyDeps
	rl       *rateLimiter
	mu       sync.Mutex
	sessions map[string]*kubeSession // ticket + client address
}

func newKubeProxy(d kubeProxyDeps) *kubeProxy {
	p := &kubeProxy{d: d, rl: newRateLimiter(), sessions: map[string]*kubeSession{}}
	go p.recheck()
	return p
}

// writeKubeStatus answers the way the API server would, so kubectl prints
// the message.
func writeKubeStatus(w http.ResponseWriter, code int, msg string) {
	reason := map[int]string{401: "Unauthorized", 403: "Forbidden", 404: "NotFound", 409: "Conflict", 429: "TooManyRequests", 501: "NotImplemented", 502: "BadGateway", 503: "ServiceUnavailable"}[code]
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"kind": "Status", "apiVersion": "v1", "metadata": map[string]any{},
		"status": "Failure", "message": "Captivo Access: " + msg, "reason": reason, "code": code,
	})
}

// kubeBearer is the request's bearer token; kubectl sends it as "Bearer".
func kubeBearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if len(h) > 7 && strings.EqualFold(h[:7], "bearer ") {
		return strings.TrimSpace(h[7:])
	}
	return ""
}

func (p *kubeProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, kubePrefix)
	siteID, path, _ := strings.Cut(rest, "/")
	path = "/" + path
	if siteID == "" {
		writeKubeStatus(w, 404, "no such resource")
		return
	}
	ticket := kubeBearer(r)
	if ticket == "" {
		writeKubeStatus(w, 401, "sign in with the kubeconfig from Captivo Access (Get kubeconfig on the resource)")
		return
	}
	clientIP := trustedClientIP(r)
	s, code, msg := p.join(ticket, clientIP, r.UserAgent())
	if s == nil {
		writeKubeStatus(w, code, msg)
		return
	}
	defer p.leave(s)
	t := s.target()
	if t.SiteID != siteID {
		writeKubeStatus(w, 403, "this kubeconfig is for another resource")
		return
	}
	k := parseKubeReq(r.Method, path, r.URL.Query())
	if ok, why := t.rules().check(k); !ok {
		s.refused(k, path, why)
		writeKubeStatus(w, 403, why)
		return
	}
	// Only the connector says who acts on the cluster.
	r.Header.Del("Authorization")
	for h := range r.Header {
		if strings.HasPrefix(http.CanonicalHeaderKey(h), "Impersonate-") {
			r.Header.Del(h)
		}
	}
	if isUpgrade(r) {
		s.upgrade(w, r, path, k)
		return
	}
	s.forward(w, r, path, k)
}

func isUpgrade(r *http.Request) bool {
	if r.Header.Get("Upgrade") == "" {
		return false
	}
	for _, v := range strings.Split(r.Header.Get("Connection"), ",") {
		if strings.EqualFold(strings.TrimSpace(v), "upgrade") {
			return true
		}
	}
	return false
}

// join returns the session for this ticket and address, starting one when
// there is none (one check with the control plane, then none until the
// minute's recheck).
func (p *kubeProxy) join(ticket, clientIP, ua string) (*kubeSession, int, string) {
	key := ticket + "\x00" + clientIP
	p.mu.Lock()
	if s := p.sessions[key]; s != nil {
		s.mu.Lock()
		if !s.ended && p.connected(s.connectorID) {
			if s.linger != nil {
				s.linger.Stop()
				s.linger = nil
			}
			s.active++
			s.mu.Unlock()
			p.mu.Unlock()
			return s, 0, ""
		}
		s.mu.Unlock()
		delete(p.sessions, key)
		go s.terminate()
	}
	p.mu.Unlock()

	if !p.rl.allow(clientIP, 30, time.Minute) {
		return nil, 429, "too many sign-ins from this address; wait a minute"
	}
	t, err := p.d.ctrl.KubeTarget(ticket, clientIP)
	if err != nil {
		switch httpStatus(err) {
		case 404:
			return nil, 401, "this kubeconfig has expired or its sign-in ended; get a new one from Captivo Access"
		case 403:
			return nil, 403, "you don't have access to this resource now"
		case 409:
			return nil, 409, "this resource can't be reached as a cluster now; check it in Captivo Access"
		}
		return nil, 503, "Captivo Access can't check the kubeconfig right now; try again"
	}
	if len(t.Connectors) == 0 {
		return nil, 409, "no connector can carry this resource"
	}
	c := t.Connectors[0]
	if p.d.pick != nil {
		c = p.d.pick(t.Connectors)
	}
	now := p.d.now()
	s := &kubeSession{p: p, key: key, ticket: ticket, id: newSessionID(), connectorID: c.ID, sealed: c.SealedSecret, t: t, clientIP: clientIP, ua: ua, start: now, active: 1, execs: map[*kubeExec]struct{}{}}
	s.ctx, s.cancel = context.WithCancel(context.Background())
	s.tr = &http.Transport{
		DialContext:         func(context.Context, string, string) (net.Conn, error) { return s.dial() },
		MaxIdleConnsPerHost: 8,
		IdleConnTimeout:     90 * time.Second,
		DisableCompression:  true,
	}
	if p.d.hub != nil {
		s.ls = p.d.hub.RegisterNative(s.id, "kubernetes", t.SiteID, t.UserID, t.Host, now, c.ID, clientIP)
		s.ls.mu.Lock()
		s.ls.kind = "database" // a feed of requests, no screen
		s.ls.mu.Unlock()
		s.ls.SetCapture(t.Record, true)
		p.d.hub.clearEnded(t.UserID, t.SiteID)
		p.d.hub.SetCloser(s.id, s.terminate)
	}
	if t.Record {
		recKey := newRecordingKey(t.SiteID, t.UserID)
		sess := func() *Session { return p.d.session(c.ID) }
		s.log = &queryLog{
			tenantID: t.TenantID, key: recKey,
			send:  func(req tunnel.RecWriteRequest) (int, error) { return writeRecChunk(sess(), req) },
			index: &recIndexReporter{send: p.d.recIndex, userID: t.UserID, siteID: t.SiteID, host: t.Host, format: "sql", proto: "kubernetes", connectorID: c.ID},
			done:  func() { notifyRecDone(sess(), t.TenantID, recKey) },
		}
		s.log.start()
	}
	s.audit("ALLOW", "session_open kubernetes", 0, "")
	log.Printf("kube proxy: site=%s user=%s session %s started via connector %s", t.SiteID, t.UserID, s.id, c.ID)

	p.mu.Lock()
	if old := p.sessions[key]; old != nil {
		// Two first requests at once: keep the one already there.
		p.mu.Unlock()
		s.discard()
		return p.join(ticket, clientIP, ua)
	}
	p.sessions[key] = s
	p.mu.Unlock()
	return s, 0, ""
}

func (p *kubeProxy) connected(connectorID string) bool {
	s := p.d.session(connectorID)
	return s != nil && s.mux != nil && !s.mux.IsClosed()
}

// leave ends a request's part in the session, which lingers for the next.
func (p *kubeProxy) leave(s *kubeSession) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.active--
	if s.active > 0 || s.ended {
		return
	}
	s.linger = time.AfterFunc(kubeSessionLinger, func() {
		s.mu.Lock()
		idle := s.active == 0
		s.mu.Unlock()
		if idle {
			s.end()
		}
	})
}

// recheck ends sessions whose ticket no longer holds (signed out, expired)
// and takes up rule changes made on the resource. A grant that ends is the
// hub's every-minute check (recheck.go). An unreachable control plane ends
// nothing.
func (p *kubeProxy) recheck() {
	t := time.NewTicker(kubeRecheckEvery)
	defer t.Stop()
	for range t.C {
		p.mu.Lock()
		list := make([]*kubeSession, 0, len(p.sessions))
		for _, s := range p.sessions {
			list = append(list, s)
		}
		p.mu.Unlock()
		for _, s := range list {
			nt, err := p.d.ctrl.KubeTarget(s.ticket, s.clientIP)
			if err == nil {
				s.mu.Lock()
				nt.Connectors = s.t.Connectors
				s.t = nt
				s.mu.Unlock()
				continue
			}
			if code := httpStatus(err); code != 404 && code != 403 {
				continue
			}
			reason := "ticket_ended"
			if httpStatus(err) == 403 {
				reason = "grant_ended"
			}
			if p.d.hub != nil {
				p.d.hub.noteEnded(s.t.UserID, s.t.SiteID, reason)
			}
			s.audit("DENY", "session_end_policy "+reason, 403, "")
			s.terminate()
		}
	}
}

// kubeSession is one ticket's requests from one address: one session in the
// console, one request log.
type kubeSession struct {
	p                                *kubeProxy
	key, ticket, id, connectorID, ua string
	sealed                           string
	clientIP                         string
	start                            time.Time
	ls                               *liveSession
	log                              *queryLog
	tr                               *http.Transport
	ctx                              context.Context
	cancel                           context.CancelFunc

	mu        sync.Mutex
	t         kubeTarget
	active    int
	linger    *time.Timer
	ended     bool
	execs     map[*kubeExec]struct{}
	discovery int
}

func (s *kubeSession) target() kubeTarget {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.t
}

// dial opens a stream to the API server through the session's connector.
func (s *kubeSession) dial() (net.Conn, error) {
	t := s.target()
	cs := s.p.d.session(s.connectorID)
	if cs == nil || cs.mux == nil {
		return nil, errors.New("the resource's connector is offline")
	}
	st, err := cs.mux.Open()
	if err != nil {
		return nil, errors.New("the resource's connector is offline")
	}
	b, _ := json.Marshal(tunnel.KubeDialRequest{
		Kind: "k8s", Host: t.Host, Port: fmt.Sprint(t.Port), Username: t.Username, Sealed: s.sealed,
		CACertPEM: t.CACertPEM, ServerName: t.ServerName, ImpersonateUser: t.ImpersonateUser, ImpersonateGroups: t.ImpersonateGroups,
	})
	if err := tunnel.WriteFrame(st, b); err != nil {
		st.Close()
		return nil, errors.New("the resource's connector is offline")
	}
	_ = st.SetReadDeadline(time.Now().Add(kubeDialWait))
	rb, err := tunnel.ReadFrame(st)
	if err != nil {
		st.Close()
		return nil, errors.New("the connector did not answer; it may need an update to " + kubeMinConnector)
	}
	_ = st.SetReadDeadline(time.Time{})
	var resp tunnel.KubeDialResponse
	if err := json.Unmarshal(rb, &resp); err != nil {
		st.Close()
		return nil, err
	}
	if resp.Error != "" {
		st.Close()
		return nil, errors.New(resp.Error)
	}
	return st, nil
}

// forward carries an ordinary request (watches included) to the cluster.
func (s *kubeSession) forward(w http.ResponseWriter, r *http.Request, path string, k kubeReq) {
	began := time.Now()
	logged := false
	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.Out.URL = &url.URL{Scheme: "http", Host: "kubernetes", Path: path, RawQuery: r.URL.RawQuery}
			pr.Out.Host = "kubernetes"
		},
		Transport:     s.tr,
		FlushInterval: -1,
		ModifyResponse: func(res *http.Response) error {
			logged = true
			s.request(k, path, res.StatusCode, time.Since(began), "")
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			if errors.Is(err, context.Canceled) {
				return
			}
			if !logged {
				logged = true
				s.request(k, path, 502, time.Since(began), "")
			}
			writeKubeStatus(w, 502, err.Error())
		},
	}
	ctx, stop := context.WithCancel(r.Context())
	defer stop()
	go func() {
		select {
		case <-s.ctx.Done():
			stop()
		case <-ctx.Done():
		}
	}()
	rp.ServeHTTP(w, r.WithContext(ctx))
}

// upgrade carries a request that switches protocols: exec and attach are
// recorded (kubeexec.go), port forwarding is passed through and logged.
func (s *kubeSession) upgrade(w http.ResponseWriter, r *http.Request, path string, k kubeReq) {
	began := time.Now()
	up, err := s.dial()
	if err != nil {
		s.request(k, path, 502, time.Since(began), "")
		writeKubeStatus(w, 502, err.Error())
		return
	}
	out := r.Clone(context.Background())
	out.URL = &url.URL{Path: path, RawQuery: r.URL.RawQuery}
	out.Host = "kubernetes"
	out.RequestURI = ""
	if err := out.Write(up); err != nil {
		up.Close()
		writeKubeStatus(w, 502, "the connector closed the connection")
		return
	}
	br := bufio.NewReader(up)
	res, err := http.ReadResponse(br, out)
	if err != nil {
		up.Close()
		s.request(k, path, 502, time.Since(began), "")
		writeKubeStatus(w, 502, "the API server didn't answer")
		return
	}
	s.request(k, path, res.StatusCode, time.Since(began), "")
	if res.StatusCode != http.StatusSwitchingProtocols {
		defer up.Close()
		defer res.Body.Close()
		copyHeader(w.Header(), res.Header)
		w.WriteHeader(res.StatusCode)
		_, _ = bufio.NewReader(res.Body).WriteTo(w)
		return
	}
	t := s.target()
	var tap streamTap
	if k.interactive() {
		tap = newStreamTap(res.Header)
		if tap == nil && t.Record {
			up.Close()
			s.refused(k, path, "unrecordable exec protocol "+res.Header.Get("Upgrade"))
			writeKubeStatus(w, 501, "this session is recorded, and kubectl's "+res.Header.Get("Upgrade")+" stream can't be; update kubectl")
			return
		}
	}
	cc, cbr, err := http.NewResponseController(w).Hijack()
	if err != nil {
		up.Close()
		return
	}
	if err := writeSwitch(cc, res); err != nil {
		cc.Close()
		up.Close()
		return
	}
	if k.interactive() {
		s.runExec(k, r.URL.Query(), tap, cc, cbr.Reader, up, br)
		return
	}
	s.audit("ALLOW", "kubernetes_"+k.Sub+" "+k.Namespace+"/"+k.Name, 200, k.Namespace)
	s.event("Port forward to " + k.Namespace + "/" + k.Name)
	relayRaw(s, cc, cbr.Reader, up, br)
}

func writeSwitch(c net.Conn, res *http.Response) error {
	var b strings.Builder
	b.WriteString("HTTP/1.1 101 Switching Protocols\r\n")
	_ = res.Header.Write(&b)
	b.WriteString("\r\n")
	_, err := c.Write([]byte(b.String()))
	return err
}

func copyHeader(dst, src http.Header) {
	for k, vs := range src {
		if hopByHopHeaders[strings.ToLower(k)] {
			continue
		}
		for _, v := range vs {
			dst.Add(k, v)
		}
	}
}

// relayRaw pipes an upgraded connection both ways until either side ends or
// the session is terminated.
func relayRaw(s *kubeSession, cc net.Conn, cr *bufio.Reader, up net.Conn, ur *bufio.Reader) {
	stop := context.AfterFunc(s.ctx, func() { cc.Close(); up.Close() })
	defer stop()
	done := make(chan struct{}, 2)
	go func() { _, _ = ur.WriteTo(cc); done <- struct{}{} }()
	go func() { _, _ = cr.WriteTo(up); done <- struct{}{} }()
	<-done
	cc.Close()
	up.Close()
	<-done
}

// request logs a finished request (its answer's status) to the session's
// log and the console's feed. Discovery is counted, not logged.
func (s *kubeSession) request(k kubeReq, path string, status int, took time.Duration, why string) {
	if k.discovery() {
		s.mu.Lock()
		s.discovery++
		s.mu.Unlock()
		return
	}
	text := k.text(path)
	e := queryEvent{AtMs: s.p.d.now().Sub(s.start).Milliseconds(), Kind: "query", Text: text, Ms: took.Milliseconds(), Code: fmt.Sprint(status), Db: k.Namespace}
	if status >= 400 {
		e.Error = http.StatusText(status)
		if why != "" {
			e.Error = why
		}
	}
	if s.ls != nil {
		now := time.Now()
		s.ls.mu.Lock()
		s.ls.act.shift(now)
		s.ls.act.buckets[activityBuckets-1]++
		feed := text
		if k.Namespace != "" {
			feed += " -n " + k.Namespace
		}
		if status >= 400 {
			feed += "  ✗ " + fmt.Sprint(status)
		}
		s.ls.act.addEvent("command", feed, now)
		s.ls.mu.Unlock()
	}
	if s.log != nil {
		s.log.add(e)
	}
}

// refused logs and audits a request the resource's rules stopped.
func (s *kubeSession) refused(k kubeReq, path, why string) {
	s.request(k, path, 403, 0, "Refused by Captivo: "+why)
	s.audit("DENY", "kubernetes_refused "+k.text(path), 403, k.Namespace)
}

func (s *kubeSession) event(text string) {
	if s.ls != nil {
		s.ls.event("text", text)
	}
	if s.log != nil {
		s.log.add(queryEvent{AtMs: s.p.d.now().Sub(s.start).Milliseconds(), Kind: "session", Text: text})
	}
}

func (s *kubeSession) audit(decision, reason string, status int, ns string) {
	if s.p.d.audit == nil {
		return
	}
	t := s.target()
	path := "/"
	if ns != "" {
		path += ns
	}
	s.p.d.audit.Enqueue(AuditEvent{
		Timestamp: time.Now(), UserID: t.UserID, SiteID: t.SiteID, Host: t.SiteName,
		Method: "K8S", Path: path, Status: status, Decision: decision, Reason: reason,
		ClientIP: s.clientIP, UserAgent: s.ua,
	})
}

// terminate ends every request and exec now (an admin's Terminate, a
// recheck) and the session.
func (s *kubeSession) terminate() {
	s.cancel()
	s.mu.Lock()
	execs := make([]*kubeExec, 0, len(s.execs))
	for e := range s.execs {
		execs = append(execs, e)
	}
	s.mu.Unlock()
	for _, e := range execs {
		e.close()
	}
	s.end()
}

// discard drops a session that lost the race to be the first.
func (s *kubeSession) discard() {
	s.mu.Lock()
	s.ended = true
	s.mu.Unlock()
	s.cancel()
	s.tr.CloseIdleConnections()
	if s.p.d.hub != nil {
		s.p.d.hub.Remove(s.id)
	}
	if s.log != nil {
		s.log.stop()
	}
}

func (s *kubeSession) end() {
	s.mu.Lock()
	if s.ended {
		s.mu.Unlock()
		return
	}
	s.ended = true
	if s.linger != nil {
		s.linger.Stop()
	}
	discovery := s.discovery
	s.mu.Unlock()
	s.cancel()
	s.tr.CloseIdleConnections()
	p := s.p
	p.mu.Lock()
	if p.sessions[s.key] == s {
		delete(p.sessions, s.key)
	}
	p.mu.Unlock()
	if p.d.hub != nil {
		p.d.hub.Remove(s.id)
	}
	dur := p.d.now().Sub(s.start)
	if s.log != nil {
		if discovery > 0 {
			s.log.add(queryEvent{AtMs: dur.Milliseconds(), Kind: "session", Text: fmt.Sprintf("%d discovery requests (what the cluster serves) not listed", discovery)})
		}
		s.log.add(queryEvent{AtMs: dur.Milliseconds(), Kind: "session", Text: "Session ended"})
		s.log.stop()
	}
	s.audit("ALLOW", "session_close "+compactDur(dur), 0, "")
	t := s.target()
	log.Printf("kube proxy: site=%s user=%s session %s closed after %s", t.SiteID, t.UserID, s.id, compactDur(dur))
}
