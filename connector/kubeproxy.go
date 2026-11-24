package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
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

// Kubernetes access (Kind "k8s"): the user's kubectl (Lens, k9s, Helm) talks
// to the cluster through the data plane (dataplane/kubeproxy.go), and this
// side signs each request in. The service account token opens here only, for
// the target it was sealed for; neither the user's client nor the control
// plane ever holds it. With impersonation each request acts as the Captivo
// user, so the cluster's own RBAC and audit log see the person.
//
// The stream is plain HTTP/1.1 from the data plane once the API server is
// reached; upgrades (exec, attach, port-forward) pass through as raw bytes.

const kubeDialLimit = 10 * time.Second

func handleKube(st io.ReadWriteCloser, allow *TargetMatcher, reqBytes []byte) {
	var req tunnel.KubeDialRequest
	if json.Unmarshal(reqBytes, &req) != nil {
		writeKubeErr(st, "bad request")
		return
	}
	addr := net.JoinHostPort(req.Host, req.Port)
	if !egressAllowed(allow, addr) {
		denied()
		logDenied("k8s", addr)
		writeKubeErr(st, "target not allowed")
		return
	}
	token, err := openSealed(vaultKey, req.Sealed, vaultTargetAAD(req.Host, req.Port, req.Username))
	if err != nil {
		writeKubeErr(st, "the saved token does not open on this connector; enter it again")
		return
	}
	tc, err := kubeTLS(req)
	if err != nil {
		writeKubeErr(st, err.Error())
		return
	}
	// Reach the API server once, so a wrong address or certificate is an
	// error the user sees instead of a failed request later.
	first, err := tls.DialWithDialer(&net.Dialer{Timeout: kubeDialLimit}, "tcp", addr, tc)
	if err != nil {
		logUpstreamErr("k8s", addr, err.Error())
		writeKubeErr(st, kubeDialError(err))
		return
	}
	b, _ := json.Marshal(tunnel.KubeDialResponse{})
	if tunnel.WriteFrame(st, b) != nil {
		first.Close()
		return
	}
	tr := kubeTransport(addr, tc, first)
	defer tr.CloseIdleConnections()
	l := newStreamListener(kubeStreamConn{st})
	srv := &http.Server{Handler: kubeSigner(addr, token, req, tr), ReadHeaderTimeout: time.Minute, ErrorLog: log.New(io.Discard, "", 0)}
	_ = srv.Serve(l)
}

func kubeTLS(req tunnel.KubeDialRequest) (*tls.Config, error) {
	tc := &tls.Config{MinVersion: tls.VersionTLS12, ServerName: req.Host, NextProtos: []string{"http/1.1"}}
	if req.ServerName != "" {
		tc.ServerName = req.ServerName
	}
	if strings.TrimSpace(req.CACertPEM) != "" {
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM([]byte(req.CACertPEM)) {
			return nil, errors.New("the cluster's CA certificate isn't valid PEM")
		}
		tc.RootCAs = pool
	}
	return tc, nil
}

// kubeDialError says why the API server couldn't be reached, in words an
// admin can act on.
func kubeDialError(err error) string {
	var unknown x509.UnknownAuthorityError
	var host x509.HostnameError
	switch {
	case errors.As(err, &unknown):
		return "the API server's certificate isn't signed by the cluster CA saved on the resource"
	case errors.As(err, &host):
		return "the API server's certificate doesn't name " + host.Host + "; set the certificate name on the resource"
	}
	return "the API server can't be reached: " + err.Error()
}

// kubeTransport speaks HTTP/1.1 only (an upgrade can't cross HTTP/2) and
// starts with the connection the dial check already made.
func kubeTransport(addr string, tc *tls.Config, first net.Conn) *http.Transport {
	var mu sync.Mutex
	spare := first
	d := &tls.Dialer{NetDialer: &net.Dialer{Timeout: kubeDialLimit, KeepAlive: 30 * time.Second}, Config: tc}
	return &http.Transport{
		DialTLSContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			mu.Lock()
			c := spare
			spare = nil
			mu.Unlock()
			if c != nil {
				return c, nil
			}
			return d.DialContext(ctx, "tcp", addr)
		},
		TLSNextProto:        map[string]func(string, *tls.Conn) http.RoundTripper{},
		MaxIdleConnsPerHost: 4,
		IdleConnTimeout:     90 * time.Second,
	}
}

// kubeSigner forwards each request to the API server as the service account,
// acting as the user the data plane named.
func kubeSigner(addr, token string, req tunnel.KubeDialRequest, tr http.RoundTripper) http.Handler {
	target := &url.URL{Scheme: "https", Host: addr}
	return &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			h := pr.Out.Header
			for k := range h {
				if strings.HasPrefix(http.CanonicalHeaderKey(k), "Impersonate-") {
					h.Del(k)
				}
			}
			h.Set("Authorization", "Bearer "+token)
			if req.ImpersonateUser != "" {
				h.Set("Impersonate-User", req.ImpersonateUser)
				for _, g := range req.ImpersonateGroups {
					h.Add("Impersonate-Group", g)
				}
			}
		},
		Transport:     tr,
		FlushInterval: -1, // watches stream their events as they come
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			if !errors.Is(err, context.Canceled) {
				logUpstreamErr("k8s", addr, err.Error())
			}
			writeKubeStatus(w, http.StatusBadGateway, "the API server didn't answer: "+err.Error())
		},
	}
}

// writeKubeStatus answers the way the API server would, so kubectl shows the
// message.
func writeKubeStatus(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"kind": "Status", "apiVersion": "v1", "metadata": map[string]any{},
		"status": "Failure", "message": "Captivo Access: " + msg, "code": code,
	})
}

func writeKubeErr(st io.Writer, msg string) {
	b, _ := json.Marshal(tunnel.KubeDialResponse{Error: msg})
	_ = tunnel.WriteFrame(st, b)
}

// kubeStreamConn is the stream as an HTTP server's connection. Unlike the SSH
// server's, its read deadline must work: the server aborts its background read
// with one before it hands a connection over for an upgrade.
type kubeStreamConn struct{ io.ReadWriteCloser }

func (kubeStreamConn) LocalAddr() net.Addr  { return sshStreamAddr{} }
func (kubeStreamConn) RemoteAddr() net.Addr { return sshStreamAddr{} }
func (c kubeStreamConn) SetDeadline(t time.Time) error {
	return streamDeadline(c.ReadWriteCloser, t, 0)
}
func (c kubeStreamConn) SetReadDeadline(t time.Time) error {
	return streamDeadline(c.ReadWriteCloser, t, 1)
}
func (c kubeStreamConn) SetWriteDeadline(t time.Time) error {
	return streamDeadline(c.ReadWriteCloser, t, 2)
}

// streamDeadline sets the deadline (0 both, 1 read, 2 write) on the stream
// underneath, when it has them.
func streamDeadline(st io.ReadWriteCloser, t time.Time, which int) error {
	for {
		if c, ok := st.(*countingStream); ok {
			st = c.ReadWriteCloser
			continue
		}
		d, ok := st.(interface {
			SetDeadline(time.Time) error
			SetReadDeadline(time.Time) error
			SetWriteDeadline(time.Time) error
		})
		if !ok {
			return nil
		}
		switch which {
		case 1:
			return d.SetReadDeadline(t)
		case 2:
			return d.SetWriteDeadline(t)
		}
		return d.SetDeadline(t)
	}
}

// streamListener hands an HTTP server the one connection it serves; Accept
// waits until that connection is closed and then stops the server.
type streamListener struct {
	conn net.Conn
	once sync.Once
	done chan struct{}
	mu   sync.Mutex
	used bool
}

func newStreamListener(c net.Conn) *streamListener {
	l := &streamListener{done: make(chan struct{})}
	l.conn = &closeNotifyConn{Conn: c, closed: func() { l.once.Do(func() { close(l.done) }) }}
	return l
}

func (l *streamListener) Accept() (net.Conn, error) {
	l.mu.Lock()
	used := l.used
	l.used = true
	l.mu.Unlock()
	if !used {
		return l.conn, nil
	}
	<-l.done
	return nil, net.ErrClosed
}

func (l *streamListener) Close() error {
	l.once.Do(func() { close(l.done) })
	return nil
}

func (l *streamListener) Addr() net.Addr { return sshStreamAddr{} }

type closeNotifyConn struct {
	net.Conn
	closed func()
}

func (c *closeNotifyConn) Close() error {
	err := c.Conn.Close()
	c.closed()
	return err
}
