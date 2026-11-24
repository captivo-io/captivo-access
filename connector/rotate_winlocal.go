package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"time"

	"github.com/jfjallid/go-smb/dcerpc"
	"github.com/jfjallid/go-smb/dcerpc/mssamr"
	"github.com/jfjallid/go-smb/dcerpc/smbtransport"
	"github.com/jfjallid/go-smb/smb"
	"github.com/jfjallid/go-smb/spnego"
	"github.com/jfjallid/golog"
)

// A local Windows account over SMB (MS-SAMR on the samr pipe), the way
// "net user" and Ctrl+Alt+Del > Change a password do it remotely. A sign-in
// to IPC$ tells whether a password works; the account changes its own with
// SamrUnicodeChangePasswordUser2, which needs no admin right; the reconcile
// account (the built-in Administrator, or a domain account in the server's
// Administrators group) sets it with SamrSetInformationUser2. SMB 3 encrypts
// the session, so neither password crosses the network readable.

var windowsSMBPort = "445"

func init() {
	// The library logs to stdout by default; nothing of it belongs in our log.
	golog.SetAll(golog.LevelNone, 0, io.Discard, io.Discard)
}

type windowsTarget struct {
	host      string
	port      string
	username  string // the account name alone, without ".\" or "HOST\"
	reconcile *reconcileSecret
}

func newWindowsTarget(host, username string, rec *reconcileSecret) (*windowsTarget, error) {
	u := windowsLocalName(username)
	if u == "" || strings.Contains(u, "@") {
		return nil, errors.New("a local Windows account is named NAME, .\\NAME or COMPUTER\\NAME")
	}
	return &windowsTarget{host: host, port: windowsSMBPort, username: u, reconcile: rec}, nil
}

// windowsLocalName drops a ".\" or "COMPUTER\" prefix.
func windowsLocalName(username string) string {
	u := strings.TrimSpace(username)
	if i := strings.LastIndex(u, `\`); i >= 0 {
		u = u[i+1:]
	}
	return u
}

// windowsCredential splits "DOMAIN\name" for the reconcile account; a bare
// name or ".\name" is an account of the server itself.
func windowsCredential(username string) (domain, user string) {
	u := strings.TrimSpace(username)
	i := strings.LastIndex(u, `\`)
	if i < 0 {
		return "", u
	}
	d := u[:i]
	if d == "." {
		d = ""
	}
	return d, u[i+1:]
}

func (t *windowsTarget) canReset() bool { return t.reconcile != nil }

func (t *windowsTarget) connect(ctx context.Context, domain, user, pw string) (*smb.Connection, error) {
	port := 445
	_, _ = fmt.Sscanf(t.port, "%d", &port)
	timeout := 8 * time.Second
	if dl, ok := ctx.Deadline(); ok && time.Until(dl) < timeout {
		timeout = time.Until(dl)
	}
	return smb.NewConnection(smb.Options{
		Host:        t.host,
		Port:        port,
		DialTimeout: timeout,
		Initiator:   &spnego.NTLMInitiator{User: user, Password: pw, Domain: domain, LocalUser: domain == ""},
	})
}

// samrOver opens the samr pipe on an authenticated connection.
func samrOver(c *smb.Connection) (*mssamr.RPCCon, error) {
	if err := c.TreeConnect("IPC$"); err != nil {
		return nil, err
	}
	f, err := c.OpenFile("IPC$", mssamr.MSRPCSamrPipe)
	if err != nil {
		return nil, err
	}
	tr, err := smbtransport.NewSMBTransport(f)
	if err != nil {
		return nil, err
	}
	b, err := dcerpc.Bind(tr, mssamr.MSRPCUuidSamr, mssamr.MSRPCSamrMajorVersion, mssamr.MSRPCSamrMinorVersion, dcerpc.MSRPCUuidNdr)
	if err != nil {
		return nil, err
	}
	return mssamr.NewRPCCon(b), nil
}

const (
	ntWrongPassword       uint32 = 0xc000006a
	ntPasswordRestriction uint32 = 0xc000006c
	ntLogonFailure        uint32 = 0xc000006d
	ntAccountRestriction  uint32 = 0xc000006e
	ntInvalidLogonHours   uint32 = 0xc000006f
	ntPasswordExpired     uint32 = 0xc0000071
	ntAccountDisabled     uint32 = 0xc0000072
	ntAccountExpired      uint32 = 0xc0000193
	ntPasswordMustChange  uint32 = 0xc0000224
	ntAccountLockedOut    uint32 = 0xc0000234
	ntAccessDenied        uint32 = 0xc0000022
	ntNoSuchUser          uint32 = 0xc0000064
)

func ntStatus(err error) (uint32, bool) {
	var se *smb.NTStatusError
	if errors.As(err, &se) {
		return se.Status, true
	}
	var re *dcerpc.StatusError
	if errors.As(err, &re) {
		return re.Code, true
	}
	return 0, false
}

// windowsSignInResult reads a failed SMB sign-in.
func windowsSignInResult(err error) authResult {
	code, ok := ntStatus(err)
	if !ok {
		return authResult{kind: authOther, detail: "could not reach the server over SMB (port " + windowsSMBPort + "): " + err.Error()}
	}
	switch code {
	case ntLogonFailure, ntWrongPassword, ntNoSuchUser:
		return authResult{kind: authBad, detail: "the password was not accepted"}
	case ntPasswordExpired, ntPasswordMustChange:
		return authResult{kind: authExpired, detail: "the password has expired or must be changed at next sign-in"}
	case ntAccountLockedOut:
		return authResult{kind: authOther, detail: "the account is locked out"}
	case ntAccountDisabled, ntAccountExpired:
		return authResult{kind: authOther, detail: "the account is disabled or expired"}
	case ntAccountRestriction, ntInvalidLogonHours:
		return authResult{kind: authOther, detail: "the account may not sign in over the network now (account restriction or logon hours)"}
	}
	return authResult{kind: authOther, detail: "SMB sign-in: " + err.Error()}
}

func (t *windowsTarget) check(ctx context.Context, pw string) authResult {
	c, err := t.connect(ctx, "", t.username, pw)
	if err != nil {
		return windowsSignInResult(err)
	}
	c.Close()
	return authResult{kind: authOK}
}

func windowsChangeError(err error, who string) error {
	code, _ := ntStatus(err)
	switch code {
	case ntPasswordRestriction, ntAccountRestriction: // Samba answers a minimum age with the latter
		return errors.New("the server refused the new password (minimum password age, history or complexity rule)")
	case ntWrongPassword:
		return errors.New("the server did not accept the current password")
	case ntAccessDenied:
		return errors.New(who + " is not allowed to change this password")
	}
	return fmt.Errorf("the server refused the change: %v", err)
}

func (t *windowsTarget) selfChange(ctx context.Context, cur, next string) error {
	c, err := t.connect(ctx, "", t.username, cur)
	if err != nil {
		return errors.New(windowsSignInResult(err).detail)
	}
	defer c.Close()
	r, err := samrOver(c)
	if err != nil {
		return fmt.Errorf("could not open the account service (samr): %v", err)
	}
	if err := r.SamrChangePassword2(t.username, cur, next, nil); err != nil {
		return windowsChangeError(err, "the account")
	}
	return nil
}

func (t *windowsTarget) reset(ctx context.Context, next string) error {
	if t.reconcile == nil {
		return errNoReconcile
	}
	domain, user := windowsCredential(t.reconcile.username)
	c, err := t.connect(ctx, domain, user, t.reconcile.secret)
	if err != nil {
		return errors.New("the reconcile account could not sign in: " + windowsSignInResult(err).detail)
	}
	defer c.Close()
	r, err := samrOver(c)
	if err != nil {
		return fmt.Errorf("could not open the account service (samr): %v", err)
	}
	// Remote UAC strips the admin right from every local administrator except
	// the built-in one, which shows here as access denied.
	denied := func(err error) error {
		if code, _ := ntStatus(err); code == ntAccessDenied {
			return errors.New("the reconcile account has no administrator right over the network: use the built-in Administrator or a domain account in the server's Administrators group")
		}
		return err
	}
	h, err := r.SamrConnect5("")
	if err != nil {
		return denied(err)
	}
	defer func() { _ = r.SamrCloseHandle(h) }()
	// The server's own account domain: the one that is not "Builtin".
	doms, err := r.SamrEnumDomains(h)
	if err != nil {
		return denied(err)
	}
	var local string
	for _, d := range doms {
		if !strings.EqualFold(d, "Builtin") {
			local = d
			break
		}
	}
	if local == "" {
		return errors.New("the server lists no local account domain")
	}
	sid, err := r.SamrLookupDomain(h, local)
	if err != nil {
		return denied(err)
	}
	const maximumAllowed = 0x02000000
	dh, err := r.SamrOpenDomain(h, maximumAllowed, sid)
	if err != nil {
		return denied(err)
	}
	defer func() { _ = r.SamrCloseHandle(dh) }()
	ids, err := r.SamrLookupNamesInDomain(dh, []string{t.username})
	if err != nil {
		if code, _ := ntStatus(err); code == 0xc0000073 { // STATUS_NONE_MAPPED
			return fmt.Errorf("the server has no local account %q", t.username)
		}
		return denied(err)
	}
	if len(ids) != 1 {
		return fmt.Errorf("the server has no local account %q", t.username)
	}
	uh, err := r.SamrOpenUser(dh, maximumAllowed, ids[0].RID)
	if err != nil {
		return denied(err)
	}
	defer func() { _ = r.SamrCloseHandle(uh) }()
	if err := r.SamrSetUserInfo2(uh, &mssamr.SamrUserInfoInput{NewPassword: next}); err != nil {
		return windowsChangeError(err, "the reconcile account")
	}
	return nil
}

// windowsAddr is where the connector reaches the server for a rotation.
func windowsAddr(host string) string { return net.JoinHostPort(host, windowsSMBPort) }
