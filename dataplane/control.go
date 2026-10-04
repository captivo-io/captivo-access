package main

import (
	"encoding/json"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// runControl opens the control stream to a freshly-connected connector, sends the
// hello, and stores each telemetry frame the connector reports. Returns when the
// stream (or session) dies. Safe against old connectors: they don't understand the
// control kind, the stream errors out, and telemetry simply stays nil.
func runControl(sess *Session, connectorID string, ctrl *ControlClient, initialPolicy, initialLogLevel string, rec RecordingPolicy) {
	if sess == nil || sess.mux == nil {
		return
	}
	st, err := sess.mux.Open()
	if err != nil {
		return
	}
	defer st.Close()
	sess.setControl(st)
	hello, _ := json.Marshal(tunnel.ControlHello{Kind: "control"})
	if tunnel.WriteFrame(st, hello) != nil {
		return
	}
	// Push the connector's saved policy on connect, INCLUDING the recording half
	// (retention window + any erasures it still owes) so a reconnecting connector
	// resumes sweeping and completes pending deletions without waiting for an
	// unrelated policy change.
	_ = sess.PushPolicy(tunnel.Policy{
		EgressAllowedTargets:   initialPolicy,
		LogLevel:               initialLogLevel,
		TenantID:               rec.TenantID,
		RecordingRetentionDays: rec.RetentionDays,
		PurgeRecordingKeys:     rec.PurgeKeys,
	})
	for {
		b, err := tunnel.ReadFrame(st)
		if err != nil {
			return
		}
		// A frame on this stream is either telemetry or a PolicyAck. The ack carries
		// retentionRemoved/purgedKeys; relay those to the control plane so the index
		// rows are dropped. Anything else is telemetry.
		var ack tunnel.PolicyAck
		if json.Unmarshal(b, &ack) == nil && (ack.RetentionRemoved > 0 || len(ack.PurgedKeys) > 0) {
			if ctrl != nil {
				go ctrl.ReportErasureAck(connectorID, ack.RetentionRemoved, ack.PurgedKeys)
			}
			continue
		}
		var t tunnel.Telemetry
		if json.Unmarshal(b, &t) == nil {
			sess.SetTelemetry(&t)
		}
	}
}
