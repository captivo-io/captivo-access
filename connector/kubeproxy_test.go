package main

import (
	"bufio"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// A fake API server behind TLS, and a stream to the connector's k8s handler.
func kubeRig(t *testing.T, h http.Handler, mutate func(*tunnel.KubeDialRequest)) (net.Conn, tunnel.KubeDialResponse) {
	t.Helper()
	srv := httptest.NewUnstartedServer(h)
	srv.EnableHTTP2 = false
	srv.StartTLS()
	t.Cleanup(srv.Close)
	k, _ := ecdh.X25519().GenerateKey(rand.Reader)
	old := vaultKey
	vaultKey = k
	t.Cleanup(func() { vaultKey = old })
	host, port, _ := net.SplitHostPort(srv.Listener.Addr().String())
	req := tunnel.KubeDialRequest{
		Kind: "k8s", Host: host, Port: port, Username: "captivo",
		Sealed:          sealForTest(t, k.PublicKey(), "sa-token", vaultTargetAAD(host, port, "captivo")),
		CACertPEM:       string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw})),
		ImpersonateUser: "ana@northwind.test", ImpersonateGroups: []string{"captivo-users", "northwind"},
	}
	if mutate != nil {
		mutate(&req)
	}
	b, _ := json.Marshal(req)
	a, c := net.Pipe()
	go handleKube(c, openMatcher(t), b)
	t.Cleanup(func() { a.Close() })
	_ = a.SetDeadline(time.Now().Add(10 * time.Second))
	rb, err := tunnel.ReadFrame(a)
	if err != nil {
		t.Fatal(err)
	}
	var resp tunnel.KubeDialResponse
	_ = json.Unmarshal(rb, &resp)
	return a, resp
}

func TestKubeSignsInAsTheServiceAccountActingAsTheUser(t *testing.T) {
	type seen struct {
		auth, user string
		groups     []string
		path       string
	}
	got := make(chan seen, 2)
	conn, resp := kubeRig(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got <- seen{r.Header.Get("Authorization"), r.Header.Get("Impersonate-User"), r.Header.Values("Impersonate-Group"), r.URL.RequestURI()}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"kind":"PodList"}`)
	}), nil)
	if resp.Error != "" {
		t.Fatal(resp.Error)
	}
	br := bufio.NewReader(conn)
	for i := range 2 { // one connection carries several requests
		req, _ := http.NewRequest("GET", "http://cluster/api/v1/namespaces/web/pods?limit=500", nil)
		req.Header.Set("Authorization", "Bearer users-own-ticket")
		req.Header.Set("Impersonate-User", "system:admin")
		req.Header.Add("Impersonate-Group", "system:masters")
		req.Header.Set("Impersonate-Extra-Scopes", "x")
		if err := req.Write(conn); err != nil {
			t.Fatal(err)
		}
		res, err := http.ReadResponse(br, req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode != 200 || string(body) != `{"kind":"PodList"}` {
			t.Fatalf("request %d: %d %s", i, res.StatusCode, body)
		}
		s := <-got
		if s.auth != "Bearer sa-token" || s.user != "ana@northwind.test" || strings.Join(s.groups, ",") != "captivo-users,northwind" {
			t.Fatalf("the API server saw %+v", s)
		}
		if s.path != "/api/v1/namespaces/web/pods?limit=500" {
			t.Fatalf("path %q", s.path)
		}
	}
}

func TestKubeActsAsTheServiceAccountWithoutImpersonation(t *testing.T) {
	got := make(chan http.Header, 1)
	conn, _ := kubeRig(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { got <- r.Header.Clone() }), func(r *tunnel.KubeDialRequest) {
		r.ImpersonateUser, r.ImpersonateGroups = "", nil
	})
	req, _ := http.NewRequest("GET", "http://cluster/version", nil)
	req.Header.Set("Impersonate-User", "system:admin")
	_ = req.Write(conn)
	if _, err := http.ReadResponse(bufio.NewReader(conn), req); err != nil {
		t.Fatal(err)
	}
	h := <-got
	if h.Get("Authorization") != "Bearer sa-token" || h.Get("Impersonate-User") != "" {
		t.Fatalf("headers %v", h)
	}
}

func TestKubeUpgradePassesThrough(t *testing.T) {
	conn, _ := kubeRig(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Upgrade") != "SPDY/3.1" || r.Header.Get("Authorization") != "Bearer sa-token" {
			w.WriteHeader(400)
			return
		}
		c, rw, _ := w.(http.Hijacker).Hijack()
		defer c.Close()
		_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: SPDY/3.1\r\n\r\n")
		_ = rw.Flush()
		buf := make([]byte, 5)
		if _, err := io.ReadFull(rw, buf); err == nil {
			_, _ = c.Write([]byte(strings.ToUpper(string(buf))))
		}
	}), nil)
	req, _ := http.NewRequest("POST", "http://cluster/api/v1/namespaces/web/pods/p/exec?command=sh&stdin=true", nil)
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "SPDY/3.1")
	_ = req.Write(conn)
	br := bufio.NewReader(conn)
	res, err := http.ReadResponse(br, req)
	if err != nil || res.StatusCode != 101 {
		t.Fatalf("%v %v", res, err)
	}
	_, _ = conn.Write([]byte("hello"))
	out := make([]byte, 5)
	if _, err := io.ReadFull(br, out); err != nil || string(out) != "HELLO" {
		t.Fatalf("%q %v", out, err)
	}
}

func TestKubeRefusesAnUntrustedCertificate(t *testing.T) {
	// Every httptest server shares one certificate: make another CA.
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "other-ca"}, NotBefore: time.Now(), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	der, _ := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	_, resp := kubeRig(t, http.NotFoundHandler(), func(r *tunnel.KubeDialRequest) {
		r.CACertPEM = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
	})
	if !strings.Contains(resp.Error, "cluster CA") {
		t.Fatalf("error %q", resp.Error)
	}
}

func TestKubeRefusesASealForAnotherTarget(t *testing.T) {
	_, resp := kubeRig(t, http.NotFoundHandler(), func(r *tunnel.KubeDialRequest) { r.Username = "someone-else" })
	if !strings.Contains(resp.Error, "enter it again") {
		t.Fatalf("error %q", resp.Error)
	}
}
