package main

import (
	"bufio"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// tcpSink accepts one connection and returns everything written to it.
func tcpSink(t *testing.T, ln net.Listener) <-chan string {
	t.Helper()
	out := make(chan string, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			out <- ""
			return
		}
		defer c.Close()
		_ = c.SetDeadline(time.Now().Add(5 * time.Second))
		b, _ := io.ReadAll(c)
		out <- string(b)
	}()
	return out
}

func TestLogForwardTCPNewline(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	got := tcpSink(t, ln)
	n, err := forwardLogs(tunnel.LogForwardRequest{
		Transport: "tcp", Target: ln.Addr().String(),
		Messages: []string{"<134>1 one", "<134>1 two\nhalf"},
	}, openMatcher(t))
	if err != nil || n != 2 {
		t.Fatalf("sent=%d err=%v", n, err)
	}
	if s := <-got; s != "<134>1 one\n<134>1 two half\n" {
		t.Fatalf("stream = %q", s)
	}
}

func TestLogForwardTCPOctetCounting(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	got := tcpSink(t, ln)
	if _, err := forwardLogs(tunnel.LogForwardRequest{
		Transport: "tcp", Target: ln.Addr().String(), Framing: tunnel.LogFramingOctet,
		Messages: []string{"abc", "çé"},
	}, openMatcher(t)); err != nil {
		t.Fatal(err)
	}
	// Octet counting counts bytes, not characters.
	if s := <-got; s != "3 abc4 çé" {
		t.Fatalf("stream = %q", s)
	}
}

func TestLogForwardUDPOneDatagramPerMessage(t *testing.T) {
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	if _, err := forwardLogs(tunnel.LogForwardRequest{
		Transport: "udp", Target: pc.LocalAddr().String(), Messages: []string{"first", "second"},
	}, openMatcher(t)); err != nil {
		t.Fatal(err)
	}
	_ = pc.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 2048)
	var got []string
	for i := 0; i < 2; i++ {
		n, _, err := pc.ReadFrom(buf)
		if err != nil {
			t.Fatal(err)
		}
		got = append(got, string(buf[:n]))
	}
	if strings.Join(got, ",") != "first,second" {
		t.Fatalf("datagrams = %v", got)
	}
}

func TestLogForwardTLSWithOwnCA(t *testing.T) {
	cert, caPEM := selfSigned(t, "siem.test")
	ln, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{cert}})
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	got := make(chan string, 1)
	go func() {
		// The first connection is the refused one; keep accepting until a line arrives.
		for {
			c, err := ln.Accept()
			if err != nil {
				got <- ""
				return
			}
			line, _ := bufio.NewReader(c).ReadString('\n')
			c.Close()
			if line != "" {
				got <- line
				return
			}
		}
	}()
	req := tunnel.LogForwardRequest{Transport: "tls", Target: ln.Addr().String(), ServerName: "siem.test", Messages: []string{"hello"}}

	// Not trusted by the system roots: refused.
	if _, err := forwardLogs(req, openMatcher(t)); err == nil || !strings.HasPrefix(err.Error(), "tls: ") {
		t.Fatalf("untrusted certificate accepted: %v", err)
	}
	req.CAPEM = caPEM
	if _, err := forwardLogs(req, openMatcher(t)); err != nil {
		t.Fatal(err)
	}
	select {
	case s := <-got:
		if s != "hello\n" {
			t.Fatalf("line = %q", s)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("nothing arrived")
	}
}

func TestLogForwardHonoursEgressBoundary(t *testing.T) {
	only, _ := ParseAllowedTargets("10.9.9.9")
	if _, err := forwardLogs(tunnel.LogForwardRequest{Transport: "tcp", Target: "127.0.0.1:514", Messages: []string{"x"}}, only); err == nil || err.Error() != "target not allowed" {
		t.Fatalf("err = %v", err)
	}
	if _, err := forwardLogs(tunnel.LogForwardRequest{Transport: "udp", Target: "169.254.169.254:514", Messages: []string{"x"}}, openMatcher(t)); err == nil || err.Error() != "target not allowed" {
		t.Fatalf("metadata address: err = %v", err)
	}
}

func TestLogForwardRejectsBadInput(t *testing.T) {
	for _, req := range []tunnel.LogForwardRequest{
		{Transport: "tcp", Target: "no-port"},
		{Transport: "ftp", Target: "127.0.0.1:514"},
		{Transport: "udp", Target: "127.0.0.1:514", Messages: make([]string, logForwardMaxMessages+1)},
	} {
		if _, err := forwardLogs(req, openMatcher(t)); err == nil {
			t.Fatalf("accepted %+v", req.Transport)
		}
	}
}

func TestLogForwardOverStream(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	got := tcpSink(t, ln)
	a, b := net.Pipe()
	defer a.Close()
	req, _ := json.Marshal(tunnel.LogForwardRequest{Kind: "logforward", Transport: "tcp", Target: ln.Addr().String(), Messages: []string{"m"}})
	go handleStream(b, openMatcher(t), nil)
	if err := tunnel.WriteFrame(a, req); err != nil {
		t.Fatal(err)
	}
	rb, err := tunnel.ReadFrame(a)
	if err != nil {
		t.Fatal(err)
	}
	var resp tunnel.LogForwardResponse
	if err := json.Unmarshal(rb, &resp); err != nil || resp.Sent != 1 || resp.Error != "" {
		t.Fatalf("resp = %+v err=%v", resp, err)
	}
	if s := <-got; s != "m\n" {
		t.Fatalf("stream = %q", s)
	}
}

func selfSigned(t *testing.T, name string) (tls.Certificate, string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: name}, DNSNames: []string{name},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, _ := x509.MarshalECPrivateKey(key)
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	cert, err := tls.X509KeyPair(certPEM, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}))
	if err != nil {
		t.Fatal(err)
	}
	return cert, string(certPEM)
}
