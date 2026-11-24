package main

import (
	"errors"
	"testing"

	"github.com/jfjallid/go-smb/smb"
)

func TestWindowsAccountNames(t *testing.T) {
	for in, want := range map[string]string{`.\alice`: "alice", `WEB01\alice`: "alice", "alice": "alice", " alice ": "alice"} {
		if got := windowsLocalName(in); got != want {
			t.Errorf("windowsLocalName(%q) = %q", in, got)
		}
	}
	if _, err := newWindowsTarget("h", "alice@corp.example", nil); err == nil {
		t.Error("an e-mail style name is a directory account")
	}
	for in, want := range map[string][2]string{`CORP\admin`: {"CORP", "admin"}, `.\Administrator`: {"", "Administrator"}, "Administrator": {"", "Administrator"}} {
		d, u := windowsCredential(in)
		if d != want[0] || u != want[1] {
			t.Errorf("windowsCredential(%q) = %q, %q", in, d, u)
		}
	}
}

func TestWindowsSignInResult(t *testing.T) {
	cases := map[uint32]authKind{
		ntLogonFailure:       authBad,
		ntPasswordExpired:    authExpired,
		ntPasswordMustChange: authExpired,
		ntAccountLockedOut:   authOther,
		ntAccountDisabled:    authOther,
	}
	for code, want := range cases {
		if got := windowsSignInResult(&smb.NTStatusError{Op: "SessionSetup2", Status: code}); got.kind != want {
			t.Errorf("0x%08x: %+v", code, got)
		}
	}
	if got := windowsSignInResult(errors.New("dial tcp: connection refused")); got.kind != authOther {
		t.Errorf("unreachable: %+v", got)
	}
}
