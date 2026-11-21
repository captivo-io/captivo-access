package main

import (
	"encoding/json"
	"net"
	"testing"

	"github.com/hashicorp/yamux"
	"github.com/kurtserdar/captivo-access/tunnel"
)

func TestResealRoundTripsOneStream(t *testing.T) {
	a, b := net.Pipe()
	dp, _ := yamux.Client(a, nil)
	conn, _ := yamux.Server(b, nil)
	t.Cleanup(func() { dp.Close(); conn.Close() })
	go func() {
		st, err := conn.AcceptStream()
		if err != nil {
			return
		}
		defer st.Close()
		f, _ := tunnel.ReadFrame(st)
		var req tunnel.ResealRequest
		_ = json.Unmarshal(f, &req)
		resp := tunnel.ResealResponse{}
		for _, it := range req.Items {
			resp.Items = append(resp.Items, tunnel.ResealResult{ID: it.ID + ":" + req.Kind, Seals: map[string]string{it.To[0]: "cv1:x"}})
		}
		out, _ := json.Marshal(resp)
		_ = tunnel.WriteFrame(st, out)
	}()
	res, err := Reseal(&Session{mux: dp}, tunnel.ResealRequest{Items: []tunnel.ResealItem{{ID: "v1", To: []string{"K"}}}})
	if err != nil || len(res.Items) != 1 || res.Items[0].ID != "v1:reseal" || res.Items[0].Seals["K"] != "cv1:x" {
		t.Fatalf("got %+v %v", res, err)
	}
	if _, err := Reseal(nil, tunnel.ResealRequest{}); err == nil {
		t.Fatal("offline connector: error")
	}
}

func TestRotateRoundTripsOneStream(t *testing.T) {
	a, b := net.Pipe()
	dp, _ := yamux.Client(a, nil)
	conn, _ := yamux.Server(b, nil)
	t.Cleanup(func() { dp.Close(); conn.Close() })
	go func() {
		st, err := conn.AcceptStream()
		if err != nil {
			return
		}
		defer st.Close()
		f, _ := tunnel.ReadFrame(st)
		var req tunnel.RotateRequest
		_ = json.Unmarshal(f, &req)
		out, _ := json.Marshal(tunnel.RotateResponse{Outcome: req.Kind + ":" + req.Op + ":" + req.Host})
		_ = tunnel.WriteFrame(st, out)
	}()
	res, err := Rotate(&Session{mux: dp}, tunnel.RotateRequest{Op: "apply", Host: "h"})
	if err != nil || res.Outcome != "rotate:apply:h" {
		t.Fatalf("got %+v %v", res, err)
	}
	if _, err := Rotate(nil, tunnel.RotateRequest{}); err == nil {
		t.Fatal("offline connector: error")
	}
}
