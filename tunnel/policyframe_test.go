package tunnel

import (
	"encoding/json"
	"testing"
)

func TestPolicyRoundTrip(t *testing.T) {
	in := Policy{EgressAllowedTargets: "10.0.0.0/24,db:5432"}
	b, _ := json.Marshal(in)
	var out Policy
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	if out.EgressAllowedTargets != in.EgressAllowedTargets || out.LogLevel != in.LogLevel {
		t.Fatalf("mismatch: %+v != %+v", out, in)
	}
}
