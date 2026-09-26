package main

import (
	"testing"

	"github.com/kurtserdar/captivo-access/tunnel"
)

func setPolicy(s string) { applyPolicy(tunnel.Policy{EgressAllowedTargets: s}, nil) }

func TestEgressAllowedAndsEnvWithPolicy(t *testing.T) {
	env, _ := ParseAllowedTargets("10.0.0.0/24") // ceiling
	setPolicy("")                                 // no narrowing
	if !egressAllowed(env, "10.0.0.5:80") {
		t.Fatal("empty policy must not narrow")
	}
	if egressAllowed(env, "8.8.8.8:80") {
		t.Fatal("env ceiling must still deny out-of-range")
	}
	setPolicy("10.0.0.5") // narrow to one host
	if !egressAllowed(env, "10.0.0.5:80") {
		t.Fatal("policy allows this host")
	}
	if egressAllowed(env, "10.0.0.6:80") {
		t.Fatal("policy must narrow away 10.0.0.6")
	}
	setPolicy("8.8.8.8") // policy can't widen beyond env
	if egressAllowed(env, "8.8.8.8:80") {
		t.Fatal("policy must never widen past the env ceiling")
	}
	setPolicy("") // reset for other tests
}
