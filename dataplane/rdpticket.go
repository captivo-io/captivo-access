package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// A native RDP ticket is what the manager puts in a downloaded .rdp file as the
// RD Gateway access token (gatewayaccesstoken): who, which resource, until when.
// It is signed with a key both sides derive from DATAPLANE_SECRET, so the
// gateway checks it without a round trip; the grant itself is checked against
// the manager when the tunnel opens and every minute after (recheck.go).
// Format: "cr1." + b64url(json) + "." + b64url(HMAC-SHA256(key, "cr1." + b64url(json))).
// The manager side is src/lib/gateway/rdp-ticket.ts.

const rdpTicketPrefix = "cr1."

type rdpTicket struct {
	TenantID string `json:"t"`
	SiteID   string `json:"s"`
	UserID   string `json:"u"`
	Exp      int64  `json:"e"` // unix seconds
	Nonce    string `json:"n"`
}

var (
	errTicketMalformed = errors.New("malformed ticket")
	errTicketSignature = errors.New("bad ticket signature")
	errTicketExpired   = errors.New("ticket expired")
)

func rdpTicketKey(secret string) []byte {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte("captivo-rdp-ticket-v1"))
	return m.Sum(nil)
}

func verifyRdpTicket(secret, token string, now time.Time) (rdpTicket, error) {
	var t rdpTicket
	if secret == "" || !strings.HasPrefix(token, rdpTicketPrefix) {
		return t, errTicketMalformed
	}
	rest := token[len(rdpTicketPrefix):]
	dot := strings.IndexByte(rest, '.')
	if dot <= 0 || dot == len(rest)-1 {
		return t, errTicketMalformed
	}
	body, sig := rest[:dot], rest[dot+1:]
	got, err := base64.RawURLEncoding.DecodeString(sig)
	if err != nil {
		return t, errTicketMalformed
	}
	m := hmac.New(sha256.New, rdpTicketKey(secret))
	m.Write([]byte(rdpTicketPrefix + body))
	if !hmac.Equal(got, m.Sum(nil)) {
		return t, errTicketSignature
	}
	raw, err := base64.RawURLEncoding.DecodeString(body)
	if err != nil || json.Unmarshal(raw, &t) != nil || t.SiteID == "" || t.UserID == "" || t.TenantID == "" {
		return rdpTicket{}, errTicketMalformed
	}
	if now.Unix() >= t.Exp {
		return rdpTicket{}, errTicketExpired
	}
	return t, nil
}
