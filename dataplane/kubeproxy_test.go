package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hashicorp/yamux"
	"github.com/kurtserdar/captivo-access/tunnel"
	"github.com/moby/spdystream/spdy"
)

type fakeKubeCtrl struct {
	mu sync.Mutex
	t  kubeTarget
	n  int
}

func (f *fakeKubeCtrl) KubeTarget(ticket, _ string) (kubeTarget, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.n++
	if ticket != "good-ticket" {
		return kubeTarget{}, &httpError{code: 404}
	}
	return f.t, nil
}

// oneConnListener serves one connection to an http.Server.
type oneConnListener struct {
	c    net.Conn
	once sync.Once
	done chan struct{}
}

func (l *oneConnListener) Accept() (net.Conn, error) {
	var c net.Conn
	l.once.Do(func() { c = l.c })
	if c != nil {
		return c, nil
	}
	<-l.done
	return nil, net.ErrClosed
}
func (l *oneConnListener) Close() error   { return nil }
func (l *oneConnListener) Addr() net.Addr { return l.c.LocalAddr() }

type recChunks struct {
	mu  sync.Mutex
	all []tunnel.RecWriteRequest
}

func (r *recChunks) text(format string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var b strings.Builder
	for _, c := range r.all {
		if c.Format == format {
			b.Write(c.Data)
		}
	}
	return b.String()
}

// kubeConnector plays the connector: it serves Kind "k8s" streams with api
// as the cluster, and keeps recording chunks.
func kubeConnector(t *testing.T, api http.Handler, rec *recChunks, seen chan<- tunnel.KubeDialRequest) *Registry {
	t.Helper()
	a, b := net.Pipe()
	srv, err := yamux.Server(a, tunnel.SessionConfig())
	if err != nil {
		t.Fatal(err)
	}
	cli, err := yamux.Client(b, tunnel.SessionConfig())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { srv.Close(); cli.Close() })
	go func() {
		for {
			st, err := cli.Accept()
			if err != nil {
				return
			}
			go func(st net.Conn) {
				defer st.Close()
				rb, err := tunnel.ReadFrame(st)
				if err != nil {
					return
				}
				var peek struct{ Kind string }
				_ = json.Unmarshal(rb, &peek)
				switch peek.Kind {
				case "k8s":
					var req tunnel.KubeDialRequest
					_ = json.Unmarshal(rb, &req)
					if seen != nil {
						seen <- req
					}
					ok, _ := json.Marshal(tunnel.KubeDialResponse{})
					_ = tunnel.WriteFrame(st, ok)
					l := &oneConnListener{c: st, done: make(chan struct{})}
					_ = (&http.Server{Handler: api, ConnState: func(_ net.Conn, s http.ConnState) {
						if s == http.StateClosed || s == http.StateHijacked {
							select {
							case <-l.done:
							default:
								if s == http.StateClosed {
									close(l.done)
								}
							}
						}
					}}).Serve(l)
				case "recwrite":
					var req tunnel.RecWriteRequest
					_ = json.Unmarshal(rb, &req)
					rec.mu.Lock()
					rec.all = append(rec.all, req)
					rec.mu.Unlock()
					out, _ := json.Marshal(tunnel.RecWriteResponse{Written: len(req.Data)})
					_ = tunnel.WriteFrame(st, out)
				}
			}(st)
		}
	}()
	reg := NewRegistry()
	reg.Set("c1", &Session{mux: srv})
	return reg
}

// wsFrame builds one WebSocket frame; client frames are masked.
func wsFrame(op byte, payload []byte, mask bool) []byte {
	var b bytes.Buffer
	b.WriteByte(0x80 | op)
	m := byte(0)
	if mask {
		m = 0x80
	}
	switch n := len(payload); {
	case n < 126:
		b.WriteByte(m | byte(n))
	case n < 65536:
		b.WriteByte(m | 126)
		_ = binary.Write(&b, binary.BigEndian, uint16(n))
	default:
		b.WriteByte(m | 127)
		_ = binary.Write(&b, binary.BigEndian, uint64(n))
	}
	p := append([]byte(nil), payload...)
	if mask {
		key := []byte{0x11, 0x22, 0x33, 0x44}
		b.Write(key)
		for i := range p {
			p[i] ^= key[i%4]
		}
	}
	b.Write(p)
	return b.Bytes()
}

// The fake API server's exec: a prompt, then the typed command's output and
// its exit status.
func fakeExec(t *testing.T, w http.ResponseWriter, r *http.Request) {
	c, rw, err := w.(http.Hijacker).Hijack()
	if err != nil {
		t.Error(err)
		return
	}
	defer c.Close()
	_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Protocol: v5.channel.k8s.io\r\n\r\n")
	_, _ = rw.Write(wsFrame(2, append([]byte{chStdout}, "$ "...), false))
	_ = rw.Flush()
	var typed bytes.Buffer
	p := wsParser{emit: func(ch int, b []byte) {
		if ch == chStdin {
			typed.Write(b)
		}
	}}
	buf := make([]byte, 512)
	for !strings.Contains(typed.String(), "\r") {
		n, err := rw.Read(buf)
		if err != nil {
			return
		}
		p.feed(buf[:n])
	}
	_, _ = rw.Write(wsFrame(2, append([]byte{chStdout}, "ls\r\nkubeconfig.yaml\r\n"...), false))
	_, _ = rw.Write(wsFrame(2, append([]byte{chError}, `{"metadata":{},"status":"Success"}`...), false))
	_, _ = rw.Write(wsFrame(8, nil, false))
	_ = rw.Flush()
}

func TestKubeProxyEndToEnd(t *testing.T) {
	apiSaw := make(chan http.Header, 8)
	api := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		apiSaw <- r.Header.Clone()
		switch {
		case strings.HasSuffix(r.URL.Path, "/exec"):
			fakeExec(t, w, r)
		case r.URL.Path == "/api/v1/namespaces/web/pods":
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"kind":"PodList","items":[]}`)
		default:
			w.WriteHeader(404)
		}
	})
	rec := &recChunks{}
	dialed := make(chan tunnel.KubeDialRequest, 8)
	reg := kubeConnector(t, api, rec, dialed)
	ctrl := &fakeKubeCtrl{t: kubeTarget{
		TenantID: "t1", SiteID: "site1", UserID: "u1", SiteName: "Prod cluster", Host: "10.0.0.9", Port: 6443, Username: "captivo",
		ImpersonateUser: "ana@northwind.test", ImpersonateGroups: []string{"captivo-users"},
		Namespaces: []string{"web"}, Connectors: []routeCandidate{{ID: "c1", SealedSecret: "cv1:sealed"}}, Record: true, Keystrokes: true,
	}}
	hub := NewSessionHub()
	audit := NewAuditQueue(100)
	p := &kubeProxy{d: kubeProxyDeps{ctrl: ctrl, session: reg.Get, hub: hub, audit: audit, now: time.Now, recIndex: func(string, string, string, []byte) error { return nil }}, rl: newRateLimiter(), sessions: map[string]*kubeSession{}}
	front := httptest.NewServer(p)
	defer front.Close()

	get := func(path, ticket string) (int, string) {
		req, _ := http.NewRequest("GET", front.URL+path, nil)
		req.Header.Set("Authorization", "Bearer "+ticket)
		req.Header.Set("Impersonate-User", "system:admin")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}

	if code, body := get("/k8s/site1/api/v1/namespaces/web/pods", "bad-ticket"); code != 401 || !strings.Contains(body, "expired") {
		t.Fatalf("an unknown ticket: %d %s", code, body)
	}
	if code, body := get("/k8s/site1/api/v1/namespaces/web/pods", "good-ticket"); code != 200 || !strings.Contains(body, "PodList") {
		t.Fatalf("list pods: %d %s", code, body)
	}
	if h := <-apiSaw; h.Get("Authorization") != "" || h.Get("Impersonate-User") != "" {
		t.Fatalf("the user's own Authorization or Impersonate-User reached the connector: %v", h)
	}
	if d := <-dialed; d.ImpersonateUser != "ana@northwind.test" || d.Sealed != "cv1:sealed" || d.Port != "6443" {
		t.Fatalf("dial request %+v", d)
	}
	if code, body := get("/k8s/site1/api/v1/namespaces/kube-system/pods", "good-ticket"); code != 403 || !strings.Contains(body, "only the namespaces web") {
		t.Fatalf("another namespace: %d %s", code, body)
	}
	if code, _ := get("/k8s/other-site/api/v1/namespaces/web/pods", "good-ticket"); code != 403 {
		t.Fatalf("a kubeconfig for another resource: %d", code)
	}
	if ctrl.n != 2 {
		t.Fatalf("the control plane was asked %d times; one session, one check (plus the bad ticket)", ctrl.n)
	}

	// kubectl exec -it over WebSocket.
	c, err := net.Dial("tcp", strings.TrimPrefix(front.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(10 * time.Second))
	_, _ = io.WriteString(c, "GET /k8s/site1/api/v1/namespaces/web/pods/api-1/exec?command=sh&container=app&stdin=true&stdout=true&tty=true HTTP/1.1\r\n"+
		"Host: x\r\nAuthorization: Bearer good-ticket\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: v5.channel.k8s.io\r\n\r\n")
	br := bufio.NewReader(c)
	res, err := http.ReadResponse(br, nil)
	if err != nil || res.StatusCode != 101 {
		t.Fatalf("exec upgrade: %v %v", res, err)
	}
	var shown bytes.Buffer
	cp := wsParser{emit: func(ch int, b []byte) {
		if ch == chStdout {
			shown.Write(b)
		}
	}}
	readUntil := func(want string) {
		buf := make([]byte, 512)
		for !strings.Contains(shown.String(), want) {
			n, err := br.Read(buf)
			if err != nil {
				t.Fatalf("waiting for %q: %v (got %q)", want, err, shown.String())
			}
			cp.feed(buf[:n])
		}
	}
	readUntil("$ ")
	var live *liveSession
	for _, s := range hub.List() {
		if s.Protocol == "kubectl" {
			live = hub.Get(s.SessionID)
		}
	}
	if live == nil {
		t.Fatal("the exec is not a live session")
	}
	_, _ = c.Write(wsFrame(2, append([]byte{chResize}, `{"Width":120,"Height":40}`...), true))
	_, _ = c.Write(wsFrame(2, append([]byte{chStdin}, "ls"...), true))
	_, _ = c.Write(wsFrame(2, append([]byte{chStdin}, "\r"...), true))
	readUntil("kubeconfig.yaml")
	_, _ = io.Copy(io.Discard, br)

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && hub.Get(live.id) != nil {
		time.Sleep(20 * time.Millisecond)
	}
	if hub.Get(live.id) != nil {
		t.Fatal("the exec session did not end")
	}
	for _, s := range p.sessions {
		s.terminate()
	}
	time.Sleep(100 * time.Millisecond)
	term := rec.text("term")
	for _, want := range []string{`"r","120x40"`, "kubeconfig.yaml", "Exited with code 0"} {
		if !strings.Contains(term, want) {
			t.Errorf("the terminal recording lacks %q:\n%s", want, term)
		}
	}
	keys := rec.text("keys")
	for _, want := range []string{`"text":"ls"`, `"text":"list pods"`, "Refused by Captivo", `"text":"kubectl exec -n web api-1 -c app -- sh"`} {
		if !strings.Contains(keys, want) {
			t.Errorf("the logs lack %q:\n%s", want, keys)
		}
	}
	var reasons []string
	for _, e := range audit.drain(100) {
		reasons = append(reasons, e.Decision+" "+e.Reason)
	}
	all := strings.Join(reasons, "\n")
	for _, want := range []string{"ALLOW session_open kubernetes", "DENY kubernetes_refused list pods", "ALLOW session_open kubernetes_exec web/api-1"} {
		if !strings.Contains(all, want) {
			t.Errorf("audit lacks %q:\n%s", want, all)
		}
	}
}

// An exec whose stream protocol can't be read is refused on a recorded resource.
func TestKubeProxyRefusesAnUnrecordableExec(t *testing.T) {
	api := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, rw, _ := w.(http.Hijacker).Hijack()
		defer c.Close()
		_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Protocol: something.new\r\n\r\n")
		_ = rw.Flush()
		time.Sleep(200 * time.Millisecond)
	})
	reg := kubeConnector(t, api, &recChunks{}, nil)
	ctrl := &fakeKubeCtrl{t: kubeTarget{SiteID: "site1", UserID: "u1", Connectors: []routeCandidate{{ID: "c1"}}, Record: true}}
	p := &kubeProxy{d: kubeProxyDeps{ctrl: ctrl, session: reg.Get, hub: NewSessionHub(), now: time.Now}, rl: newRateLimiter(), sessions: map[string]*kubeSession{}}
	front := httptest.NewServer(p)
	defer front.Close()
	req, _ := http.NewRequest("POST", front.URL+"/k8s/site1/api/v1/namespaces/web/pods/a/exec?command=sh", nil)
	req.Header.Set("Authorization", "Bearer good-ticket")
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(res.Body)
	if res.StatusCode != 501 || !strings.Contains(string(b), "recorded") {
		t.Fatalf("%d %s", res.StatusCode, b)
	}
}

type sinkRec struct {
	in, out, errOut bytes.Buffer
	sizes           []string
	statuses        []string
}

func (s *sinkRec) stdin(b []byte) { s.in.Write(b) }
func (s *sinkRec) output(b []byte, stderr bool) {
	if stderr {
		s.errOut.Write(b)
	} else {
		s.out.Write(b)
	}
}
func (s *sinkRec) resize(c, r int) { s.sizes = append(s.sizes, strconv.Itoa(c)+"x"+strconv.Itoa(r)) }
func (s *sinkRec) status(b []byte) { s.statuses = append(s.statuses, string(b)) }

func TestWsTapFollowsFramesFedPieceByPiece(t *testing.T) {
	var sink sinkRec
	tap := &wsTap{}
	tap.start(&sink)
	big := strings.Repeat("y", 70000) // a 64-bit length
	stream := append(wsFrame(2, append([]byte{chStdin}, "whoami\r"...), true), wsFrame(9, []byte("ping"), true)...)
	stream = append(stream, wsFrame(2, append([]byte{chResize}, `{"Width":90,"Height":30}`...), true)...)
	for i := range stream { // one byte at a time
		tap.up(stream[i : i+1])
	}
	down := append(wsFrame(2, append([]byte{chStdout}, "root\r\n"...), false), wsFrame(2, append([]byte{chStderr}, big...), false)...)
	down = append(down, wsFrame(2, append([]byte{chError}, `{"status":"Failure"}`...), false)...)
	for len(down) > 0 {
		n := min(1000, len(down))
		tap.down(down[:n])
		down = down[n:]
	}
	if sink.in.String() != "whoami\r" || sink.out.String() != "root\r\n" || sink.errOut.Len() != 70000 {
		t.Fatalf("in %q out %q err %d", sink.in.String(), sink.out.String(), sink.errOut.Len())
	}
	if strings.Join(sink.sizes, ",") != "90x30" || len(sink.statuses) != 1 {
		t.Fatalf("sizes %v statuses %v", sink.sizes, sink.statuses)
	}

	// The base64 variant: the channel is a digit, the data base64.
	var b64 sinkRec
	t64 := &wsTap{base64: true}
	t64.start(&b64)
	t64.down(wsFrame(1, []byte("1aGVsbG8="), false))
	if b64.out.String() != "hello" {
		t.Fatalf("base64 stdout %q", b64.out.String())
	}
}

func TestSpdyTapReadsStreamsByType(t *testing.T) {
	var up, down bytes.Buffer
	fu, _ := spdy.NewFramer(&up, &bytes.Buffer{})
	fd, _ := spdy.NewFramer(&down, &bytes.Buffer{})
	for id, typ := range map[spdy.StreamId]string{1: "error", 3: "stdin", 5: "stdout", 7: "resize"} {
		_ = fu.WriteFrame(&spdy.SynStreamFrame{StreamId: id, Headers: http.Header{"Streamtype": {typ}}})
	}
	_ = fu.WriteFrame(&spdy.DataFrame{StreamId: 7, Data: []byte(`{"Width":100,"Height":50}` + "\n")})
	_ = fu.WriteFrame(&spdy.DataFrame{StreamId: 3, Data: []byte("id\r")})
	_ = fd.WriteFrame(&spdy.SynReplyFrame{StreamId: 5, Headers: http.Header{}})
	_ = fd.WriteFrame(&spdy.DataFrame{StreamId: 5, Data: []byte("uid=0(root)\r\n")})
	_ = fd.WriteFrame(&spdy.DataFrame{StreamId: 1, Data: []byte(`{"status":"Success"}`)})

	var sink sinkRec
	tap := &spdyTap{types: map[spdy.StreamId]string{}}
	tap.start(&sink)
	tap.up(up.Bytes())
	time.Sleep(50 * time.Millisecond) // the stream types are read first, as on a real connection
	tap.down(down.Bytes())
	tap.close()
	if sink.in.String() != "id\r" || sink.out.String() != "uid=0(root)\r\n" || strings.Join(sink.sizes, ",") != "100x50" || len(sink.statuses) != 1 || tap.broken {
		t.Fatalf("in %q out %q sizes %v statuses %v broken %v", sink.in.String(), sink.out.String(), sink.sizes, sink.statuses, tap.broken)
	}
}

func TestKubeProxyEnforcesTheCommandListOnExec(t *testing.T) {
	api := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(404) })
	rec := &recChunks{}
	reg := kubeConnector(t, api, rec, make(chan tunnel.KubeDialRequest, 8))
	ctrl := &fakeKubeCtrl{t: kubeTarget{
		TenantID: "t1", SiteID: "site1", UserID: "u1", SiteName: "Prod cluster", Host: "10.0.0.9", Port: 6443, Username: "captivo",
		ImpersonateUser: "ana@northwind.test", Namespaces: []string{"web"}, Connectors: []routeCandidate{{ID: "c1", SealedSecret: "cv1:sealed"}},
		Commands: &CommandPolicy{Mode: "deny", Entries: []string{"rm"}, Name: "No rm"},
	}}
	p := &kubeProxy{d: kubeProxyDeps{ctrl: ctrl, session: reg.Get, hub: NewSessionHub(), audit: NewAuditQueue(100), now: time.Now, recIndex: func(string, string, string, []byte) error { return nil }}, rl: newRateLimiter(), sessions: map[string]*kubeSession{}}
	front := httptest.NewServer(p)
	defer front.Close()
	exec := func(query string) (int, string) {
		req, _ := http.NewRequest("POST", front.URL+"/k8s/site1/api/v1/namespaces/web/pods/p/exec?"+query, nil)
		req.Header.Set("Authorization", "Bearer good-ticket")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}
	if code, body := exec("command=rm&command=-rf&command=/data&stdout=1"); code != 403 || !strings.Contains(body, "command refused") {
		t.Fatalf("a refused exec: %d %s", code, body)
	}
	if code, body := exec("command=sh&command=-c&command=rm%20-rf%20/data&stdout=1"); code != 403 || !strings.Contains(body, "command refused") {
		t.Fatalf("a refused script: %d %s", code, body)
	}
	if code, body := exec("command=ls&stdout=1"); code == 403 && strings.Contains(body, "command refused") {
		t.Fatalf("an allowed exec was refused: %d %s", code, body)
	}
}
