package main

import (
	"bufio"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// Log forwarding: the control plane hands over audit records already rendered
// as syslog messages, and the connector writes them to a SIEM on its own
// network, which the cloud cannot reach. It is the same reach the raw relays
// (LDAP, RDP) already have: one host:port, checked against the same egress
// boundary, and only bytes the control plane chose. Nothing is kept here; an
// undelivered batch is resent by the control plane.

const (
	logForwardMaxMessages = 2000
	logForwardMaxMessage  = 64 << 10
	// 20 s in all: the data-plane waits 22 s, the control plane 25 s.
	logForwardDialTimeout = 8 * time.Second
	logForwardIOTimeout   = 12 * time.Second
)

func handleLogForward(st io.ReadWriter, allow *TargetMatcher, reqBytes []byte) {
	var req tunnel.LogForwardRequest
	if json.Unmarshal(reqBytes, &req) != nil {
		writeLogForward(st, tunnel.LogForwardResponse{Error: "bad request"})
		return
	}
	start := time.Now()
	sent, err := forwardLogs(req, allow)
	resp := tunnel.LogForwardResponse{Sent: sent, LatencyMs: int(time.Since(start).Milliseconds())}
	if err != nil {
		resp.Error = err.Error()
		logUpstreamErr("syslog", req.Target, resp.Error)
	} else {
		logDebug("syslog: %d message(s) to %s over %s", sent, req.Target, req.Transport)
	}
	writeLogForward(st, resp)
}

func writeLogForward(st io.Writer, resp tunnel.LogForwardResponse) {
	if b, err := json.Marshal(resp); err == nil {
		_ = tunnel.WriteFrame(st, b)
	}
}

// forwardLogs delivers one batch and returns how many messages were written
// before the first failure.
func forwardLogs(req tunnel.LogForwardRequest, allow *TargetMatcher) (int, error) {
	host, port, err := net.SplitHostPort(req.Target)
	if err != nil || host == "" || port == "" {
		return 0, errors.New("bad target")
	}
	if !egressAllowed(allow, req.Target) {
		denied()
		logDenied("syslog", req.Target)
		return 0, errors.New("target not allowed") // egress boundary — fail closed
	}
	if len(req.Messages) > logForwardMaxMessages {
		return 0, errors.New("batch too large")
	}
	conn, err := dialLogTarget(req, host)
	if err != nil {
		return 0, err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(logForwardIOTimeout))

	if req.Transport == "udp" {
		// One message per datagram (RFC 5426).
		for i, m := range req.Messages {
			if _, err := conn.Write([]byte(clipLogMessage(m))); err != nil {
				return i, errors.New("write: " + err.Error())
			}
		}
		return len(req.Messages), nil
	}
	w := bufio.NewWriterSize(conn, 64<<10)
	for i, m := range req.Messages {
		if err := writeFramed(w, req.Framing, clipLogMessage(m)); err != nil {
			return i, errors.New("write: " + err.Error())
		}
	}
	if err := w.Flush(); err != nil {
		// Some of the batch may have left; the control plane resends all of it,
		// which a SIEM sees as duplicates rather than a gap.
		return 0, errors.New("write: " + err.Error())
	}
	return len(req.Messages), nil
}

func dialLogTarget(req tunnel.LogForwardRequest, host string) (net.Conn, error) {
	d := &net.Dialer{Timeout: logForwardDialTimeout}
	switch req.Transport {
	case "udp":
		c, err := d.Dial("udp", req.Target)
		if err != nil {
			return nil, errors.New("unreachable: " + err.Error())
		}
		return c, nil
	case "tcp":
		c, err := d.Dial("tcp", req.Target)
		if err != nil {
			return nil, errors.New("unreachable: " + err.Error())
		}
		return c, nil
	case "tls":
		cfg := &tls.Config{MinVersion: tls.VersionTLS12, ServerName: host}
		if req.ServerName != "" {
			cfg.ServerName = req.ServerName
		}
		if strings.TrimSpace(req.CAPEM) != "" {
			pool := x509.NewCertPool()
			if !pool.AppendCertsFromPEM([]byte(req.CAPEM)) {
				return nil, errors.New("tls: the CA certificate could not be read")
			}
			cfg.RootCAs = pool
		}
		raw, err := d.Dial("tcp", req.Target)
		if err != nil {
			return nil, errors.New("unreachable: " + err.Error())
		}
		c := tls.Client(raw, cfg)
		_ = c.SetDeadline(time.Now().Add(logForwardDialTimeout))
		if err := c.Handshake(); err != nil {
			raw.Close()
			return nil, errors.New("tls: " + strings.TrimPrefix(err.Error(), "tls: "))
		}
		return c, nil
	}
	return nil, errors.New("bad transport")
}

// writeFramed writes one message on a stream transport (RFC 6587).
func writeFramed(w *bufio.Writer, framing, m string) error {
	if framing == tunnel.LogFramingOctet {
		if _, err := w.WriteString(strconv.Itoa(len(m)) + " "); err != nil {
			return err
		}
		_, err := w.WriteString(m)
		return err
	}
	// Newline framing: a line break inside a message would split it in two.
	m = strings.NewReplacer("\r", " ", "\n", " ").Replace(m)
	if _, err := w.WriteString(m); err != nil {
		return err
	}
	return w.WriteByte('\n')
}

func clipLogMessage(m string) string {
	if len(m) > logForwardMaxMessage {
		return m[:logForwardMaxMessage]
	}
	return m
}
