package main

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net"
	"strings"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// Password rotation. The control plane decides when a resource's saved
// password changes; this connector does the change, so the new password exists
// only here and on the target:
//
//  1. prepare: generate it and seal it to every connector key that serves the
//     resource. The control plane stores those seals as "pending" BEFORE the
//     target is touched, so a crash mid-change can never leave a password that
//     nobody has.
//  2. apply: open the current and the pending seal, change the account on the
//     target, and check the new one signs in.
//
// Each seal opens only for the target it was entered for (vault.go), and the
// host this code connects to is that same target -- for an AD account, the
// directory's host is bound into the reconcile account's seal instead.
const (
	rotateTimeout   = 24 * time.Second // inside the dataplane's 27 s and the console's 29 s
	rotatedPassLen  = 24
	maxRotateTo     = 16
	rotateRecordEnv = "ROTATED_FILE"
)

// accountTarget is one way of reaching an account: SSH for a Linux account,
// SMB for a local Windows account, LDAP for a directory account.
type accountTarget interface {
	// check signs in with pw (and signs out).
	check(ctx context.Context, pw string) authResult
	// selfChange makes the account change its own password.
	selfChange(ctx context.Context, cur, next string) error
	// reset sets the password through the reconcile account.
	reset(ctx context.Context, next string) error
	// canReset is false without a reconcile account.
	canReset() bool
}

type authKind int

const (
	authOK      authKind = iota
	authBad              // the target says the password is wrong
	authExpired          // right password, but the account must change it first
	authOther            // could not tell: unreachable, locked, refused
)

type authResult struct {
	kind   authKind
	detail string
}

var errNoReconcile = errors.New("no reconcile account")

// Characters that survive every shell, RDP client and form we hand them to:
// no quotes, backslash, colon (chpasswd), spaces or look-alikes (0/O, 1/l/I).
const (
	passUpper  = "ABCDEFGHJKLMNPQRSTUVWXYZ"
	passLower  = "abcdefghijkmnopqrstuvwxyz"
	passDigit  = "23456789"
	passSymbol = "-_.!@#%+="
)

// generatePassword returns a random password with every character class, so
// the usual complexity rules (AD, pam_pwquality) accept it.
func generatePassword(n int) (string, error) {
	all := passUpper + passLower + passDigit + passSymbol
	for {
		b := make([]byte, n)
		for i := range b {
			x, err := rand.Int(rand.Reader, big.NewInt(int64(len(all))))
			if err != nil {
				return "", err
			}
			b[i] = all[x.Int64()]
		}
		s := string(b)
		if strings.ContainsAny(s, passUpper) && strings.ContainsAny(s, passLower) && strings.ContainsAny(s, passDigit) && strings.ContainsAny(s, passSymbol) {
			return s, nil
		}
	}
}

func handleRotate(st io.ReadWriter, allow *TargetMatcher, reqBytes []byte) {
	var req tunnel.RotateRequest
	var resp tunnel.RotateResponse
	if err := json.Unmarshal(reqBytes, &req); err != nil {
		resp = tunnel.RotateResponse{Error: "bad request"}
	} else {
		ctx, cancel := context.WithTimeout(context.Background(), rotateTimeout)
		resp = rotate(ctx, vaultKey, allow, req)
		cancel()
		who := req.Username + "@" + net.JoinHostPort(req.Host, req.Port)
		switch {
		case resp.Error != "":
			logWarn("vault: %s for %s refused: %s", req.Op, who, resp.Error)
		case req.Op == "apply":
			logInfo("vault: password rotation for %s: %s%s", who, resp.Outcome, rotateNote(resp))
		case req.Op == "reveal":
			// The customer's own record that a password left this host for an admin.
			logInfo("vault: sealed the saved password of %s to an administrator's browser", who)
		case req.Op == "verify":
			logInfo("vault: checked the saved password of %s: %s", who, resp.Outcome)
		}
	}
	b, _ := json.Marshal(resp)
	_ = tunnel.WriteFrame(st, b)
}

func rotateNote(r tunnel.RotateResponse) string {
	var parts []string
	if r.OutOfSync {
		parts = append(parts, "the saved password no longer worked")
	}
	if r.Reconciled {
		parts = append(parts, "set by the reconcile account")
	}
	if r.Detail != "" && r.Outcome != "rotated" {
		parts = append(parts, r.Detail)
	}
	if len(parts) == 0 {
		return ""
	}
	return " (" + strings.Join(parts, "; ") + ")"
}

func rotate(ctx context.Context, k *ecdh.PrivateKey, allow *TargetMatcher, req tunnel.RotateRequest) tunnel.RotateResponse {
	if k == nil {
		return tunnel.RotateResponse{Error: "no vault key"}
	}
	// Discovery needs the administrator account only; the resource's own password is not involved.
	if req.Op == "discover" {
		return discoverAccounts(ctx, k, allow, req)
	}
	aad := vaultTargetAAD(req.Host, req.Port, req.Username)
	cur, err := openSealed(k, req.Current, aad)
	if err != nil {
		return tunnel.RotateResponse{Error: "the saved password does not open here"}
	}
	// A credential kept in the customer's own vault is never rotated or shown
	// from here; "verify" only checks that the vault still hands it out.
	if _, isRef, _ := parseSecretRef(cur); isRef {
		if req.Op != "verify" {
			return tunnel.RotateResponse{Error: "this resource's credential lives in an external vault; change or rotate it there"}
		}
		got, err := openSecretOrCA(k, req.Current, aad)
		if err != nil {
			return tunnel.RotateResponse{Outcome: "mismatch", Detail: err.Error()}
		}
		if got == sshCAMarker {
			return verifyCertSignIn(allow, req)
		}
		return tunnel.RotateResponse{Outcome: "ok"}
	}
	switch req.Op {
	case "prepare":
		if len(req.To) == 0 || len(req.To) > maxRotateTo {
			return tunnel.RotateResponse{Error: "bad recipients"}
		}
		next, err := generatePassword(rotatedPassLen)
		if err != nil {
			return tunnel.RotateResponse{Error: "no randomness"}
		}
		seals := map[string]string{}
		for _, to := range req.To {
			s, err := sealToKey(to, next, aad)
			if err != nil {
				return tunnel.RotateResponse{Error: "bad recipient key"}
			}
			seals[to] = s
		}
		return tunnel.RotateResponse{Seals: seals}
	case "reveal":
		if len(req.To) != 1 {
			return tunnel.RotateResponse{Error: "bad recipients"}
		}
		s, err := sealToKey(req.To[0], cur, aad)
		if err != nil {
			return tunnel.RotateResponse{Error: "bad recipient key"}
		}
		return tunnel.RotateResponse{Seals: map[string]string{req.To[0]: s}}
	}

	t, hostKey, err := newAccountTarget(k, allow, req)
	if err != nil {
		return tunnel.RotateResponse{Error: err.Error()}
	}
	var resp tunnel.RotateResponse
	switch req.Op {
	case "verify":
		var pending string
		if req.Pending != "" {
			if pending, err = openSealed(k, req.Pending, aad); err != nil {
				return tunnel.RotateResponse{Error: "the prepared password does not open here"}
			}
		}
		resp = verifyAccount(ctx, t, cur, pending)
	case "apply":
		next, err := openSealed(k, req.Pending, aad)
		if err != nil {
			return tunnel.RotateResponse{Error: "the prepared password does not open here"}
		}
		resp = applyRotation(ctx, t, cur, next)
		if resp.Outcome == "rotated" || resp.Outcome == "already" {
			recordRotated(req)
		}
	default:
		return tunnel.RotateResponse{Error: "unknown op"}
	}
	resp.SSHHostKey = hostKey()
	return resp
}

// applyRotation moves the account from cur to next. Whatever goes wrong, the
// answer says which of the two the target uses now, as far as it can tell:
// the control plane keeps both until it knows.
func applyRotation(ctx context.Context, t accountTarget, cur, next string) tunnel.RotateResponse {
	var resp tunnel.RotateResponse
	var changeErr error
	switch r := t.check(ctx, cur); r.kind {
	case authOK:
		changeErr = t.selfChange(ctx, cur, next)
		if changeErr != nil && t.canReset() && !nextWorks(ctx, t, next) {
			// Refused (password age, history, policy): the reconcile account may.
			if err := t.reset(ctx, next); err == nil {
				resp.Reconciled = true
				changeErr = nil
			} else {
				changeErr = errors.New(changeErr.Error() + "; reconcile account: " + err.Error())
			}
		}
	case authExpired:
		if !t.canReset() {
			return tunnel.RotateResponse{Outcome: "failed", Detail: r.detail + "; add a reconcile account to reset it"}
		}
		if changeErr = t.reset(ctx, next); changeErr == nil {
			resp.Reconciled = true
		}
	case authBad:
		if nextWorks(ctx, t, next) {
			return tunnel.RotateResponse{Outcome: "already"}
		}
		resp.OutOfSync = true
		if !t.canReset() {
			resp.Outcome, resp.Detail = "failed", "the saved password no longer signs in and there is no reconcile account"
			return resp
		}
		if changeErr = t.reset(ctx, next); changeErr == nil {
			resp.Reconciled = true
		}
	default:
		return tunnel.RotateResponse{Outcome: "failed", Detail: r.detail}
	}

	// Whatever was reported, ask the target which password it takes now.
	if r := t.check(ctx, next); r.kind == authOK {
		resp.Outcome = "rotated"
		if changeErr != nil {
			resp.Detail = "changed despite: " + changeErr.Error()
		}
		return resp
	}
	if changeErr != nil && t.check(ctx, cur).kind == authOK {
		resp.Outcome, resp.Detail = "failed", changeErr.Error()
		return resp
	}
	resp.Outcome = "unknown"
	if changeErr != nil {
		resp.Detail = changeErr.Error()
	} else {
		resp.Detail = "the new password did not sign in after the change"
	}
	return resp
}

func nextWorks(ctx context.Context, t accountTarget, next string) bool {
	return t.check(ctx, next).kind == authOK
}

func verifyAccount(ctx context.Context, t accountTarget, cur, pending string) tunnel.RotateResponse {
	switch r := t.check(ctx, cur); r.kind {
	case authOK:
		return tunnel.RotateResponse{Outcome: "ok"}
	case authExpired:
		return tunnel.RotateResponse{Outcome: "ok", Detail: r.detail}
	case authBad:
		if pending != "" && nextWorks(ctx, t, pending) {
			return tunnel.RotateResponse{Outcome: "pending"}
		}
		return tunnel.RotateResponse{Outcome: "mismatch", OutOfSync: true}
	default:
		return tunnel.RotateResponse{Error: r.detail}
	}
}

func newAccountTarget(k *ecdh.PrivateKey, allow *TargetMatcher, req tunnel.RotateRequest) (accountTarget, func() string, error) {
	var rec *reconcileSecret
	if req.Reconcile != nil {
		r := req.Reconcile
		// The reconcile account is bound to where it is used: the resource's
		// own host for a Linux, Windows or database account, the domain
		// controller for AD.
		wantHost, wantPort := req.Host, req.Port
		if req.Method == "ad" && req.Directory != nil {
			wantHost, wantPort = req.Directory.Host, req.Directory.Port
		}
		if r.Host != wantHost || r.Port != wantPort {
			return nil, nil, errors.New("the reconcile account is for another host")
		}
		s, err := openSealed(k, r.Sealed, vaultReconcileAAD(r.Host, r.Port, r.Username))
		if err != nil {
			return nil, nil, errors.New("the reconcile account does not open here")
		}
		rec = &reconcileSecret{username: r.Username, secret: s, isKey: r.SecretKey}
	}
	switch req.Method {
	case "linux":
		addr := net.JoinHostPort(req.Host, req.Port)
		if !egressAllowed(allow, addr) {
			denied()
			logDenied("rotate", addr)
			return nil, nil, errors.New("target not allowed")
		}
		t := &linuxTarget{addr: addr, username: req.Username, pinned: req.SSHHostKey, reconcile: rec}
		return t, func() string { return t.seen }, nil
	case "postgres", "mysql", "mssql":
		addr := net.JoinHostPort(req.Host, req.Port)
		if !egressAllowed(allow, addr) {
			denied()
			logDenied("rotate", addr)
			return nil, nil, errors.New("target not allowed")
		}
		if rec != nil && rec.isKey {
			return nil, nil, errors.New("a database reconcile account signs in with a password")
		}
		var db tunnel.RotateDB
		if req.DB != nil {
			db = *req.DB
		}
		t := &dbAccountTarget{engine: req.Method, host: req.Host, port: req.Port, username: req.Username, db: db, reconcile: rec}
		return t, func() string { return "" }, nil
	case "windows":
		addr := windowsAddr(req.Host)
		if !egressAllowed(allow, addr) {
			denied()
			logDenied("rotate", addr)
			return nil, nil, errors.New("target not allowed")
		}
		if rec != nil && rec.isKey {
			return nil, nil, errors.New("a Windows reconcile account signs in with a password")
		}
		t, err := newWindowsTarget(req.Host, req.Username, rec)
		if err != nil {
			return nil, nil, err
		}
		return t, func() string { return "" }, nil
	case "ad":
		if req.Directory == nil {
			return nil, nil, errors.New("no directory")
		}
		addr := net.JoinHostPort(req.Directory.Host, req.Directory.Port)
		if !egressAllowed(allow, addr) {
			denied()
			logDenied("rotate", addr)
			return nil, nil, errors.New("directory not allowed")
		}
		t, err := newADTarget(*req.Directory, req.Username, rec)
		if err != nil {
			return nil, nil, err
		}
		return t, func() string { return "" }, nil
	}
	return nil, nil, errors.New("unknown method")
}

type reconcileSecret struct {
	username string
	secret   string
	isKey    bool
}

// redact keeps passwords out of anything a target echoes back into an error.
func redact(s string, secrets ...string) string {
	for _, x := range secrets {
		if x != "" {
			s = strings.ReplaceAll(s, x, "***")
		}
	}
	return s
}
