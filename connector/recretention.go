package main

import (
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// applyRecordingPolicy carries out the recording half of a pushed policy: sweep
// anything past retention, and erase specific recordings the control plane has
// accepted a deletion request for.
//
// The connector owns the files, so it owns deleting them -- the control plane can
// only state the policy and be told what happened. That is why this returns an ack:
// an index row must stop advertising a recording whose bytes are gone, and a pending
// erasure must not clear until the deletion is confirmed here.
//
// Two refusals are deliberate, because both mistakes destroy customer data:
//
//   - Zero retention days means "not configured", never "delete everything". The
//     first policy that omitted the field would otherwise wipe the store.
//   - A policy with no tenant is ignored. A sweep has to know which subtree to walk,
//     and guessing deletes somebody's recordings. NOTE: recStore's own segment
//     validation already refuses an empty tenant, so this check is a fail-fast, not
//     the enforcement -- a mutation removing it does not break any test. Do not
//     "simplify" the store's validation on the strength of this line.
func applyRecordingPolicy(store *recStore, p tunnel.Policy) tunnel.PolicyAck {
	var ack tunnel.PolicyAck
	if store == nil || p.TenantID == "" {
		return ack
	}

	if p.RecordingRetentionDays > 0 {
		cutoff := time.Now().AddDate(0, 0, -p.RecordingRetentionDays)
		if n, err := store.Purge(p.TenantID, cutoff); err == nil {
			ack.RetentionRemoved = n
		} else {
			logInfo("recording retention: sweep failed tenant=%s err=%v", p.TenantID, err)
		}
	}

	for _, key := range p.PurgeRecordingKeys {
		if err := store.Delete(p.TenantID, key); err != nil {
			logInfo("recording erasure: %s failed err=%v", key, err)
			continue
		}
		// A recording that is already absent still confirms: the desired state holds,
		// and refusing to confirm would leave the erasure pending forever.
		ack.PurgedKeys = append(ack.PurgedKeys, key)
	}
	return ack
}
