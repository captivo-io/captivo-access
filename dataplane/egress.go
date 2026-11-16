package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// kasmEgress is an isolated resource's network rule (the manager resolves it;
// connector/egress.go enforces it).
type kasmEgress struct {
	Mode       string   `json:"mode"`
	Hosts      []string `json:"hosts"`
	ReportOnly bool     `json:"reportOnly"`
}

// egressCall registers or releases a session's rule on the connector. A
// connector that predates the egress proxy answers with no token: the session
// then runs as before (its browser still has a network of its own).
func egressCall(s *Session, req tunnel.EgressRequest) (tunnel.EgressResponse, error) {
	var out tunnel.EgressResponse
	if s == nil || s.mux == nil {
		return out, errors.New("connector offline")
	}
	st, err := s.mux.Open()
	if err != nil {
		return out, err
	}
	defer st.Close()
	_ = st.SetDeadline(time.Now().Add(10 * time.Second))
	req.Kind = "egress"
	b, _ := json.Marshal(req)
	if err := tunnel.WriteFrame(st, b); err != nil {
		return out, err
	}
	rb, err := tunnel.ReadFrame(st)
	if err != nil {
		return out, err
	}
	if err := json.Unmarshal(rb, &out); err != nil {
		return out, err
	}
	if out.Error != "" {
		return out, errors.New(out.Error)
	}
	return out, nil
}

// egressAudit turns what a session's rule refused (or, report-only, would
// have) into audit events on that session's resource.
func egressAudit(events []tunnel.EgressEvent, userID, siteID string, r *http.Request) []AuditEvent {
	out := make([]AuditEvent, 0, len(events))
	for _, e := range events {
		decision, reason := "DENY", "egress_blocked"
		if !e.Blocked {
			decision, reason = "ALLOW", "egress_would_block"
		}
		out = append(out, auditEvent(decision, reason+" "+e.Reason+" x"+strconv.Itoa(e.Count), userID, siteID, e.Dest, r, http.StatusForbidden, 0))
	}
	return out
}
