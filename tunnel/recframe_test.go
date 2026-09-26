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

func TestRecFetchRequestCarriesAByteRange(t *testing.T) {
	// The range must survive the wire, or a video player can only replay from the
	// start -- and answering Range centrally would mean buffering the whole
	// recording in the control plane, which is the copy this design removes.
	b, _ := json.Marshal(RecFetchRequest{
		Kind: "recfetch", TenantID: "t1", RecordingKey: "k", FromByte: 1024, ToByte: 4095,
	})
	var out RecFetchRequest
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.FromByte != 1024 || out.ToByte != 4095 {
		t.Fatalf("range lost: %+v", out)
	}
}

func TestRecFetchResponseCarriesTotalBytes(t *testing.T) {
	b, _ := json.Marshal(RecFetchResponse{TotalBytes: 98765})
	var out RecFetchResponse
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.TotalBytes != 98765 {
		t.Fatal("Content-Range cannot be built without the total")
	}
}

func TestPolicyCarriesRetentionAndPurgeList(t *testing.T) {
	b, _ := json.Marshal(Policy{
		TenantID: "acme", RecordingRetentionDays: 30,
		PurgeRecordingKeys: []string{"k1", "k2"},
	})
	var out Policy
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.TenantID != "acme" || out.RecordingRetentionDays != 30 || len(out.PurgeRecordingKeys) != 2 {
		t.Fatalf("policy lost fields: %+v", out)
	}
}

func TestPolicyAckReportsWhatHappened(t *testing.T) {
	// Without the ack the control plane cannot trim its index or clear a pending
	// erasure, so both would drift from what the connector actually holds.
	b, _ := json.Marshal(PolicyAck{RetentionRemoved: 3, PurgedKeys: []string{"k1"}})
	var out PolicyAck
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.RetentionRemoved != 3 || len(out.PurgedKeys) != 1 {
		t.Fatalf("ack lost fields: %+v", out)
	}
}
