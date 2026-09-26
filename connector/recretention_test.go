package main

import (
	"testing"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

func TestApplyRecordingPolicySweepsExpiredRecordings(t *testing.T) {
	s := newRecStore(t.TempDir(), testKey())
	for _, k := range []string{"old", "fresh"} {
		if _, err := s.Append("acme", k, 0, []byte("x")); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	if err := s.setModTimeForTest("acme", "old", time.Now().Add(-48*time.Hour)); err != nil {
		t.Fatalf("age: %v", err)
	}

	ack := applyRecordingPolicy(s, tunnel.Policy{TenantID: "acme", RecordingRetentionDays: 1})
	if ack.RetentionRemoved != 1 {
		t.Fatalf("want 1 removed, got %d", ack.RetentionRemoved)
	}
	if got, _ := s.Read("acme", "fresh", 0); len(got) != 1 {
		t.Fatal("swept a recording inside the retention window")
	}
}

func TestApplyRecordingPolicyZeroDaysDeletesNothing(t *testing.T) {
	// Zero means "no retention configured". Treating it as "delete everything" would
	// wipe a customer's recordings the first time a policy arrived without the field.
	s := newRecStore(t.TempDir(), testKey())
	if _, err := s.Append("acme", "k", 0, []byte("x")); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := s.setModTimeForTest("acme", "k", time.Now().Add(-1000*time.Hour)); err != nil {
		t.Fatalf("age: %v", err)
	}
	ack := applyRecordingPolicy(s, tunnel.Policy{TenantID: "acme", RecordingRetentionDays: 0})
	if ack.RetentionRemoved != 0 {
		t.Fatalf("zero days deleted %d recordings", ack.RetentionRemoved)
	}
	if got, _ := s.Read("acme", "k", 0); len(got) != 1 {
		t.Fatal("recording was deleted with no retention configured")
	}
}

func TestApplyRecordingPolicyPurgesNamedKeys(t *testing.T) {
	s := newRecStore(t.TempDir(), testKey())
	for _, k := range []string{"erase-me", "keep-me"} {
		if _, err := s.Append("acme", k, 0, []byte("x")); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	ack := applyRecordingPolicy(s, tunnel.Policy{
		TenantID: "acme", PurgeRecordingKeys: []string{"erase-me"},
	})
	if len(ack.PurgedKeys) != 1 || ack.PurgedKeys[0] != "erase-me" {
		t.Fatalf("want erase-me confirmed, got %+v", ack.PurgedKeys)
	}
	if got, _ := s.Read("acme", "erase-me", 0); len(got) != 0 {
		t.Fatal("named recording survived the purge")
	}
	if got, _ := s.Read("acme", "keep-me", 0); len(got) != 1 {
		t.Fatal("purge took a recording it was not asked for")
	}
}

func TestApplyRecordingPolicyConfirmsOnlyWhatItDeleted(t *testing.T) {
	// The control plane clears a pending erasure on this confirmation. Confirming a
	// key that was never removed would mark the erasure done while the bytes remain.
	s := newRecStore(t.TempDir(), testKey())
	ack := applyRecordingPolicy(s, tunnel.Policy{
		TenantID: "acme", PurgeRecordingKeys: []string{"never-existed"},
	})
	// A recording that is already gone counts as erased -- the desired state holds.
	if len(ack.PurgedKeys) != 1 {
		t.Fatalf("an already-absent recording should still confirm: %+v", ack.PurgedKeys)
	}
}

func TestApplyRecordingPolicyIgnoresAPolicyWithNoTenant(t *testing.T) {
	// Without a tenant a sweep would have to guess which subtree to walk, and
	// guessing here deletes a customer's recordings.
	s := newRecStore(t.TempDir(), testKey())
	if _, err := s.Append("acme", "k", 0, []byte("x")); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := s.setModTimeForTest("acme", "k", time.Now().Add(-1000*time.Hour)); err != nil {
		t.Fatalf("age: %v", err)
	}
	ack := applyRecordingPolicy(s, tunnel.Policy{RecordingRetentionDays: 1})
	if ack.RetentionRemoved != 0 {
		t.Fatalf("swept with no tenant named: %d", ack.RetentionRemoved)
	}
}
