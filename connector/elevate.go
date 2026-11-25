package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"regexp"
	"sync"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// Administrator rights for the length of a session (zero standing privilege).
// An account that is an ordinary user all day gets administrator rights while
// someone has a session on it, and loses them when the last one ends.
//
//	Linux   a sudoers entry, /etc/sudoers.d/captivo-<user> (elevate_linux.go)
//	Windows membership of the local Administrators group (elevate_windows.go)
//
// The administrator account (the resource's reconcile account: root or a
// sudoer on Linux, the built-in Administrator on Windows) does the change. The
// rights go with the session: sessions on the same account share them, and
// they are taken away when the last one closes. What is granted is written to
// a journal first, so a connector that stopped in the middle takes them away
// when it starts again (elevate_journal.go).

type elevSpec struct {
	platform string // "linux" | "windows"
	host     string
	port     string
	account  string
	admin    *tunnel.RotateReconcile
	pinned   string // Linux: the server's SSH host key
}

// elevOps is one platform's way to give and take away the rights.
type elevOps interface {
	grant(ctx context.Context) (alreadyHad bool, err error)
	revoke(ctx context.Context) error
}

var elevations = struct {
	sync.Mutex
	n map[string]int
}{n: map[string]int{}}

func (sp elevSpec) key() string {
	return sp.platform + "/" + net.JoinHostPort(sp.host, sp.port) + "/" + sp.account
}

// Sudoers.d skips names with a dot, so a Linux account name is narrower here
// than for a password change.
var elevateUserRe = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)

func (sp elevSpec) ops(allow *TargetMatcher) (elevOps, string, error) {
	if sp.admin == nil {
		return nil, "", errors.New("no administrator account was given")
	}
	e := sp.admin
	if e.Host != sp.host || e.Port != sp.port {
		return nil, "", errors.New("the administrator account is for another host")
	}
	secret, err := openSealed(vaultKey, e.Sealed, vaultReconcileAAD(e.Host, e.Port, e.Username))
	if err != nil {
		return nil, "", errors.New("the administrator account does not open on this connector; enter it again")
	}
	switch sp.platform {
	case "linux":
		if !elevateUserRe.MatchString(sp.account) || sp.account == "root" {
			return nil, "", errors.New("administrator rights are given to an ordinary account named in lower case letters, digits, _ and -")
		}
		addr := net.JoinHostPort(sp.host, sp.port)
		return &linuxElev{t: &linuxTarget{addr: addr, username: sp.account, pinned: sp.pinned, reconcile: &reconcileSecret{username: e.Username, secret: secret, isKey: e.SecretKey}}, secret: secret}, secret, nil
	case "windows":
		if e.SecretKey {
			return nil, "", errors.New("a Windows administrator account signs in with a password")
		}
		wt, err := newWindowsTarget(sp.host, sp.account, &reconcileSecret{username: e.Username, secret: secret})
		if err != nil {
			return nil, "", err
		}
		if !egressAllowed(allow, windowsAddr(sp.host)) {
			denied()
			logDenied("elevate", windowsAddr(sp.host))
			return nil, "", errors.New("the server's file-sharing port is not allowed by this connector")
		}
		return &windowsElev{t: wt}, secret, nil
	}
	return nil, "", fmt.Errorf("administrator rights are not given on %q", sp.platform)
}

// elevateAccount gives the account administrator rights and returns what takes
// them away again.
func elevateAccount(ctx context.Context, allow *TargetMatcher, sp elevSpec) (func(), error) {
	ops, _, err := sp.ops(allow)
	if err != nil {
		return nil, err
	}
	key := sp.key()
	elevations.Lock()
	defer elevations.Unlock()
	if elevations.n[key] == 0 {
		// The journal first: if this connector stops after the change and before
		// the session ends, the next start takes the rights away.
		if err := journalAdd(sp); err != nil {
			return nil, fmt.Errorf("could not record the change before making it: %v", err)
		}
		had, err := ops.grant(ctx)
		if err != nil {
			journalDone(key)
			return nil, fmt.Errorf("could not give %s administrator rights: %v", sp.account, err)
		}
		if had {
			// It already was an administrator: nothing of ours to take away.
			journalDone(key)
			elevations.n[key] = 1
			return func() { releaseElevation(key, nil) }, nil
		}
	}
	elevations.n[key]++
	return func() { releaseElevation(key, ops) }, nil
}

// releaseElevation takes the rights away when the last session on the account closes.
func releaseElevation(key string, ops elevOps) {
	elevations.Lock()
	defer elevations.Unlock()
	elevations.n[key]--
	if elevations.n[key] > 0 {
		return
	}
	delete(elevations.n, key)
	if ops == nil {
		return
	}
	if err := ops.revoke(context.Background()); err != nil {
		logWarn("could not take administrator rights away (%s): %v; it is tried again", key, err)
		return // the journal keeps it; the recovery loop retries
	}
	journalDone(key)
}
