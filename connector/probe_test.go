package main

import (
	"encoding/json"
	"net"
	"testing"

	"github.com/kurtserdar/captivo-access/tunnel"
)

func probe(t *testing.T, allow *TargetMatcher, upstreamUrl string) tunnel.ProbeResponse {
	t.Helper()
	dataplane, connector := pairedSessions(t)
	go serveStreams(connector, allow, testStore(t))
	st, err := dataplane.Open()
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer st.Close()
	reqBytes, _ := json.Marshal(tunnel.ProbeRequest{Kind: "probe", UpstreamUrl: upstreamUrl})
	if err := tunnel.WriteFrame(st, reqBytes); err != nil {
		t.Fatalf("WriteFrame: %v", err)
	}
	respBytes, err := tunnel.ReadFrame(st)
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	var resp tunnel.ProbeResponse
	if err := json.Unmarshal(respBytes, &resp); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	return resp
}

func TestProbeReachable(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer ln.Close()
	resp := probe(t, openMatcher(t), "http://"+ln.Addr().String())
	if !resp.Ok {
		t.Fatalf("expected reachable, got %+v", resp)
	}
}

func TestProbeRefused(t *testing.T) {
	// Reserve a port then close it so nothing is listening.
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := ln.Addr().String()
	ln.Close()
	resp := probe(t, openMatcher(t), "http://"+addr)
	if resp.Ok {
		t.Fatalf("expected unreachable for a closed port, got %+v", resp)
	}
}

func TestProbeOutOfBoundary(t *testing.T) {
	allow, _ := ParseAllowedTargets("10.99.99.0/24")
	resp := probe(t, allow, "http://127.0.0.1:9")
	if resp.Ok || resp.Error != "target not allowed" {
		t.Fatalf("expected target not allowed, got %+v", resp)
	}
}

func TestProbeBadScheme(t *testing.T) {
	resp := probe(t, openMatcher(t), "ftp://x/")
	if resp.Ok || resp.Error != "bad upstream url" {
		t.Fatalf("expected bad upstream url, got %+v", resp)
	}
}
