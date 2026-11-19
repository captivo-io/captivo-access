package main

import (
	"strings"
	"testing"
	"time"
)

// The same vector is checked by src/lib/gateway/rdp-ticket.test.ts, so a change
// on one side that the other can't verify fails a test.
const (
	ticketVectorSecret = "test-dataplane-secret"
	ticketVector       = "cr1.eyJ0IjoidDEiLCJzIjoic2l0ZTEiLCJ1IjoidXNlcjEiLCJlIjoxODAwMDAwMDAwLCJuIjoiMDAxMTIyMzM0NDU1NjY3NyJ9.F3LYViLlvxkp6Znchtn6_QuFODH5UhNzRcn-vt9PQIM"
)

func TestVerifyRdpTicketVector(t *testing.T) {
	tk, err := verifyRdpTicket(ticketVectorSecret, ticketVector, time.Unix(1_700_000_000, 0))
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if tk.TenantID != "t1" || tk.SiteID != "site1" || tk.UserID != "user1" || tk.Exp != 1_800_000_000 {
		t.Fatalf("ticket = %+v", tk)
	}
}

func TestVerifyRdpTicketRejects(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	if _, err := verifyRdpTicket("other-secret", ticketVector, now); err != errTicketSignature {
		t.Fatalf("wrong key: %v", err)
	}
	if _, err := verifyRdpTicket(ticketVectorSecret, ticketVector, time.Unix(1_800_000_000, 0)); err != errTicketExpired {
		t.Fatalf("expired: %v", err)
	}
	tampered := strings.Replace(ticketVector, "eyJ0IjoidDEi", "eyJ0IjoidDIi", 1)
	if _, err := verifyRdpTicket(ticketVectorSecret, tampered, now); err != errTicketSignature {
		t.Fatalf("tampered: %v", err)
	}
	for _, bad := range []string{"", "cr1.", "cr1.abc", "cr1.abc.", "jwt.abc.def"} {
		if _, err := verifyRdpTicket(ticketVectorSecret, bad, now); err != errTicketMalformed {
			t.Fatalf("%q: %v", bad, err)
		}
	}
	if _, err := verifyRdpTicket("", ticketVector, now); err != errTicketMalformed {
		t.Fatalf("no secret: %v", err)
	}
}
