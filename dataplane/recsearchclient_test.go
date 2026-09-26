package main

import (
	"bytes"
	"encoding/json"
	"net"
	"testing"

	"github.com/hashicorp/yamux"
	"github.com/kurtserdar/captivo-access/tunnel"
)

// answerFrames stands up a yamux pair whose "connector" side replies with the
// given frames in order.
func answerFrames(t *testing.T, frames ...[]byte) (*Session, func()) {
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
	go func() {
		st, err := cli.Accept()
		if err != nil {
			return
		}
		defer st.Close()
		if _, err := tunnel.ReadFrame(st); err != nil {
			return
		}
		for _, f := range frames {
			if tunnel.WriteFrame(st, f) != nil {
				return
			}
		}
	}()
	return &Session{mux: srv}, func() { srv.Close(); cli.Close() }
}

func TestRecSearchReturnsConnectorMatches(t *testing.T) {
	resp, _ := json.Marshal(tunnel.RecSearchResponse{
		Matches:   []tunnel.RecSearchMatch{{RecordingKey: "k1", Seq: 2, Snippet: "rm -rf"}},
		Truncated: true,
	})
	sess, cleanup := answerFrames(t, resp)
	defer cleanup()

	got, err := RecSearch(sess, tunnel.RecSearchRequest{TenantID: "acme", Query: "rm"})
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(got.Matches) != 1 || got.Matches[0].Snippet != "rm -rf" {
		t.Fatalf("matches lost: %+v", got)
	}
	if !got.Truncated {
		t.Fatal("Truncated must survive the hop: it is how a partial answer is told apart from no answer")
	}
}

func TestRecSearchOfflineConnectorIsAnError(t *testing.T) {
	if _, err := RecSearch(nil, tunnel.RecSearchRequest{}); err == nil {
		t.Fatal("want an error for a nil session, not a silent empty result")
	}
}

func TestRecFetchStreamsChunksWithoutBuffering(t *testing.T) {
	head, _ := json.Marshal(tunnel.RecFetchResponse{})
	sess, cleanup := answerFrames(t, head, []byte("one"), []byte("two"))
	defer cleanup()

	var out bytes.Buffer
	if err := RecFetch(sess, tunnel.RecFetchRequest{TenantID: "acme", RecordingKey: "k1"}, &out); err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if out.String() != "onetwo" {
		t.Fatalf("want onetwo, got %q", out.String())
	}
}

func TestRecFetchSurfacesConnectorError(t *testing.T) {
	head, _ := json.Marshal(tunnel.RecFetchResponse{Error: "invalid recording key"})
	sess, cleanup := answerFrames(t, head)
	defer cleanup()

	var out bytes.Buffer
	if err := RecFetch(sess, tunnel.RecFetchRequest{}, &out); err == nil {
		t.Fatal("want the connector's error surfaced")
	}
	if out.Len() != 0 {
		t.Fatalf("wrote body despite an error: %q", out.String())
	}
}

func TestRecFetchOfflineConnectorIsAnError(t *testing.T) {
	var out bytes.Buffer
	if err := RecFetch(nil, tunnel.RecFetchRequest{}, &out); err == nil {
		t.Fatal("want an error for a nil session")
	}
}
