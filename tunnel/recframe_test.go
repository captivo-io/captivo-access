package tunnel

import (
	"encoding/json"
	"testing"
)

func TestRecWriteRequestRoundTrip(t *testing.T) {
	in := RecWriteRequest{
		Kind: "recwrite", TenantID: "t1", RecordingKey: "site-user-1-ab",
		Seq: 3, Format: "guac", Protocol: "ssh", Data: []byte{1, 2, 3},
	}
	b, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var out RecWriteRequest
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.Kind != "recwrite" || out.Seq != 3 || string(out.Data) != "\x01\x02\x03" {
		t.Fatalf("round trip lost data: %+v", out)
	}
}

func TestRecSearchResponseCarriesTruncation(t *testing.T) {
	// Truncated must survive the wire: it is how the caller learns the answer is
	// partial rather than empty, which is the difference between "no match" and
	// "we stopped looking".
	b, _ := json.Marshal(RecSearchResponse{
		Matches:   []RecSearchMatch{{RecordingKey: "k", Seq: 1, Snippet: "rm -rf"}},
		Truncated: true,
	})
	var out RecSearchResponse
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !out.Truncated || len(out.Matches) != 1 || out.Matches[0].Snippet != "rm -rf" {
		t.Fatalf("unexpected: %+v", out)
	}
}
