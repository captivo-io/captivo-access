package tunnel

// Policy is a data-plane -> connector frame on the control stream. Extensible:
// later slices add fields; the connector applies what it understands and ignores
// the rest. Every frame the connector reads on the control stream is a Policy
// (direction determines type), so no discriminator is needed.
type Policy struct {
	EgressAllowedTargets string `json:"egressAllowedTargets"` // "" = no console narrowing
	LogLevel             string `json:"logLevel"`             // debug|info|warn|error; "" = leave unchanged

	// Recording retention. The connector owns the recording files, so it owns
	// deleting them: the control plane can only state the policy and ask.
	//
	// TenantID names whose recordings to sweep -- a connector serves one tenant, but
	// its store is partitioned by tenant and a sweep must never cross that line.
	// Zero days means "no retention configured": do NOT treat that as "delete
	// everything", which is the mistake this comment exists to prevent.
	TenantID               string `json:"tenantId,omitempty"`
	RecordingRetentionDays int    `json:"recordingRetentionDays,omitempty"`

	// PurgeRecordingKeys are specific recordings to delete now, for an erasure the
	// control plane accepted (GDPR/KVKK). They are applied when the connector is
	// next online, which is why the index marks them pending until confirmed.
	PurgeRecordingKeys []string `json:"purgeRecordingKeys,omitempty"`
}

// PolicyAck is the connector -> data-plane reply on the control stream, reporting
// what a policy actually did. Retention and erasure are only meaningful if the
// control plane learns they happened: an index row must stop advertising a
// recording whose bytes are gone, and a pending erasure must not clear until the
// connector confirms it.
type PolicyAck struct {
	RetentionRemoved int      `json:"retentionRemoved,omitempty"`
	PurgedKeys       []string `json:"purgedKeys,omitempty"`
}
