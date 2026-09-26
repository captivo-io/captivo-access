package main

import (
	"net"
	"sync/atomic"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// policyMatcher holds the console-pushed egress narrowing. Initialised to an
// empty (allow-all) matcher so nothing is narrowed until a policy arrives.
var policyMatcher atomic.Pointer[TargetMatcher]

func init() {
	m, _ := ParseAllowedTargets("") // open=true, allows everything
	policyMatcher.Store(m)
}

// applyPolicy parses a pushed policy into the narrowing matcher and applies the
// pushed log level. On a matcher parse error it keeps the previous matcher
// (fail-safe: never loosen on bad input); the log level is orthogonal (no
// security bearing) and applied independently.
// applyPolicy applies a pushed policy and returns what the recording half of it
// actually did, so the control plane can trim its index and clear a confirmed
// erasure. store may be nil in tests that only exercise egress/log policy.
func applyPolicy(p tunnel.Policy, store *recStore) tunnel.PolicyAck {
	setLogLevel(p.LogLevel) // "" / invalid = no-op (keeps current level)
	if m, err := ParseAllowedTargets(p.EgressAllowedTargets); err == nil {
		policyMatcher.Store(m)
	}
	ack := applyRecordingPolicy(store, p)
	if ack.RetentionRemoved > 0 || len(ack.PurgedKeys) > 0 {
		logInfo("recording policy applied: retention removed=%d erased=%d", ack.RetentionRemoved, len(ack.PurgedKeys))
	}
	logInfo("policy applied: egress=%q logLevel=%s", p.EgressAllowedTargets, p.LogLevel)
	return ack
}

func policyAllowed(authority string) bool {
	m := policyMatcher.Load()
	return m == nil || m.Allowed(authority)
}

// isBlockedTarget hard-denies link-local / cloud-metadata destinations
// (169.254.0.0/16, fe80::/10) regardless of the egress matchers — these are
// never legitimate resource targets and are the classic SSRF pivot to a cloud
// instance's credential endpoint. Loopback and RFC-1918 LAN are deliberately
// NOT blocked: those are valid on-prem resource targets. Only IP-literal
// targets are inspected (hostnames resolve at dial time; the realistic
// metadata vector is a literal 169.254.169.254).
func isBlockedTarget(authority string) bool {
	host, _, err := net.SplitHostPort(authority)
	if err != nil {
		host = authority
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	return ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast()
}

// egressAllowed is the effective boundary: link-local/metadata is always denied,
// then the local env ceiling AND the console policy. Never widens past the env.
func egressAllowed(allow *TargetMatcher, authority string) bool {
	if isBlockedTarget(authority) {
		return false
	}
	return allow.Allowed(authority) && policyAllowed(authority)
}
