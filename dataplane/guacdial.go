package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// dialGuacd opens a raw relay stream to guacd through the connector and returns
// it as a net.Conn. The Guacamole protocol runs end-to-end over this — the
// connector is an opaque byte pipe. Mirrors dialLdap.
func dialGuacd(s *Session, target string) (net.Conn, error) {
	return dialGuacdReq(s, tunnel.GuacdDialRequest{Kind: "guacd", Target: target})
}

// dialGuacdSealed is dialGuacd for a handshake whose secret is sealed to the
// connector: the connector opens it for the target in the connect instruction
// and swaps it in for placeholder.
func dialGuacdSealed(s *Session, target, sealed, placeholder string) (net.Conn, error) {
	return dialGuacdReq(s, tunnel.GuacdDialRequest{Kind: "guacd", Target: target, Sealed: sealed, Placeholder: placeholder})
}

func dialGuacdReq(s *Session, req tunnel.GuacdDialRequest) (net.Conn, error) {
	if s == nil || s.mux == nil {
		return nil, errors.New("connector offline")
	}
	st, err := s.mux.Open()
	if err != nil {
		return nil, err
	}
	reqBytes, err := json.Marshal(req)
	if err != nil {
		st.Close()
		return nil, err
	}
	if err := tunnel.WriteFrame(st, reqBytes); err != nil {
		st.Close()
		return nil, err
	}
	respBytes, err := tunnel.ReadFrame(st)
	if err != nil {
		st.Close()
		return nil, err
	}
	var resp tunnel.GuacdDialResponse
	if err := json.Unmarshal(respBytes, &resp); err != nil {
		st.Close()
		return nil, err
	}
	if resp.Error != "" {
		st.Close()
		return nil, errors.New(resp.Error)
	}
	return st, nil // yamux.Stream satisfies net.Conn
}

var errConnectorNoNativeRdp = errors.New("connector does not support native RDP")

// dialRdp opens a raw relay stream to a resource's RDP server through the
// connector, for a native Remote Desktop client on the RD Gateway (rdpgw.go).
func dialRdp(s *Session, target string) (net.Conn, error) {
	if s == nil || s.mux == nil {
		return nil, errors.New("connector offline")
	}
	st, err := s.mux.Open()
	if err != nil {
		return nil, err
	}
	reqBytes, _ := json.Marshal(tunnel.RdpDialRequest{Kind: "rdp", Target: target})
	if err := tunnel.WriteFrame(st, reqBytes); err != nil {
		st.Close()
		return nil, err
	}
	respBytes, err := tunnel.ReadFrame(st)
	if err != nil {
		st.Close()
		return nil, err
	}
	var resp tunnel.RdpDialResponse
	if err := json.Unmarshal(respBytes, &resp); err != nil {
		st.Close()
		return nil, err
	}
	if resp.Error != "" {
		st.Close()
		// A connector older than 2.39.0 takes the unknown kind for a proxied
		// HTTP request without a URL.
		if resp.Error == "bad upstream url" {
			return nil, errConnectorNoNativeRdp
		}
		return nil, errors.New(resp.Error)
	}
	return st, nil
}

// vaultPlaceholder is a random stand-in for a sealed secret in the guacd
// handshake; it cannot collide with a real value.
func vaultPlaceholder() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return "\x00captivo-vault:" + hex.EncodeToString(b)
}
