package main

import (
	"context"
	"crypto/ecdh"
	"net"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// Account discovery (rotate op "discover"): the accounts of a Linux server, as
// the resource's administrator account (the reconcile account: root, or one
// with sudo) sees them. It reads /etc/passwd, /etc/group and /etc/shadow and
// reports what an admin needs to decide which accounts Captivo should own:
// who can sign in, who is an administrator, whose password is locked, empty
// or old. A password hash is never sent, only what it says about the account.

const discoverMax = 500

var adminGroups = map[string]bool{"sudo": true, "wheel": true, "admin": true}

func discoverAccounts(ctx context.Context, k *ecdh.PrivateKey, allow *TargetMatcher, req tunnel.RotateRequest) tunnel.RotateResponse {
	if k == nil {
		return tunnel.RotateResponse{Error: "no vault key"}
	}
	if req.Method != "linux" {
		return tunnel.RotateResponse{Error: "accounts can be listed on a Linux server only"}
	}
	if req.Reconcile == nil {
		return tunnel.RotateResponse{Error: "listing accounts needs the administrator account"}
	}
	r := req.Reconcile
	if r.Host != req.Host || r.Port != req.Port {
		return tunnel.RotateResponse{Error: "the administrator account is for another host"}
	}
	secret, err := openSealed(k, r.Sealed, vaultReconcileAAD(r.Host, r.Port, r.Username))
	if err != nil {
		return tunnel.RotateResponse{Error: "the administrator account does not open here"}
	}
	addr := net.JoinHostPort(req.Host, req.Port)
	if !egressAllowed(allow, addr) {
		denied()
		logDenied("discover", addr)
		return tunnel.RotateResponse{Error: "target not allowed"}
	}
	t := &linuxTarget{addr: addr, pinned: req.SSHHostKey, reconcile: &reconcileSecret{username: r.Username, secret: secret, isKey: r.SecretKey}}
	c, err := t.adminClient(ctx)
	if err != nil {
		return tunnel.RotateResponse{Error: err.Error()}
	}
	defer c.Close()
	passwd, err := t.adminOutput(c, "getent passwd")
	if err != nil {
		return tunnel.RotateResponse{Error: err.Error()}
	}
	group, err := t.adminOutput(c, "getent group")
	if err != nil {
		return tunnel.RotateResponse{Error: err.Error()}
	}
	shadow, serr := t.adminOutput(c, "cat /etc/shadow") // without it the password columns stay unknown
	if serr != nil {
		logWarn("discover: could not read the password file on %s: %v", addr, serr)
	}
	return tunnel.RotateResponse{Outcome: "ok", Accounts: parseAccounts(passwd, group, shadow, time.Now()), SSHHostKey: t.seen}
}

// parseAccounts joins the three files into one list, system accounts last.
func parseAccounts(passwd, group, shadow string, now time.Time) []tunnel.DiscoveredAccount {
	admins := map[string]bool{}
	adminGIDs := map[int]bool{}
	for _, l := range strings.Split(group, "\n") {
		f := strings.Split(l, ":")
		if len(f) < 4 || !adminGroups[f[0]] {
			continue
		}
		if gid, err := strconv.Atoi(f[2]); err == nil {
			adminGIDs[gid] = true
		}
		for _, m := range strings.Split(f[3], ",") {
			if m = strings.TrimSpace(m); m != "" {
				admins[m] = true
			}
		}
	}
	type sh struct {
		hash string
		last int
	}
	shadows := map[string]sh{}
	for _, l := range strings.Split(shadow, "\n") {
		f := strings.Split(l, ":")
		if len(f) < 3 {
			continue
		}
		last := -1
		if n, err := strconv.Atoi(f[2]); err == nil {
			last = n
		}
		shadows[f[0]] = sh{hash: f[1], last: last}
	}
	today := int(now.Unix() / 86400)
	var out []tunnel.DiscoveredAccount
	for _, l := range strings.Split(passwd, "\n") {
		f := strings.Split(l, ":")
		if len(f) < 7 || !linuxUserRe.MatchString(f[0]) {
			continue
		}
		uid, err := strconv.Atoi(f[2])
		if err != nil {
			continue
		}
		gid, _ := strconv.Atoi(f[3])
		a := tunnel.DiscoveredAccount{Name: f[0], UID: uid, Home: f[5], Shell: f[6], PassAgeDays: -1}
		a.Admin = uid == 0 || admins[f[0]] || adminGIDs[gid]
		a.Login = !strings.HasSuffix(a.Shell, "/nologin") && !strings.HasSuffix(a.Shell, "/false") && a.Shell != ""
		if s, ok := shadows[f[0]]; ok {
			a.NoPass = s.hash == ""
			a.Locked = strings.HasPrefix(s.hash, "!") || strings.HasPrefix(s.hash, "*")
			if s.last > 0 {
				a.PassAgeDays = today - s.last
			}
		}
		out = append(out, a)
	}
	// People first (a real shell, an ordinary uid), then the rest; each by uid.
	rank := func(a tunnel.DiscoveredAccount) int {
		switch {
		case a.Login && a.UID >= 1000:
			return 0
		case a.Login:
			return 1
		}
		return 2
	}
	sort.SliceStable(out, func(i, j int) bool {
		if ri, rj := rank(out[i]), rank(out[j]); ri != rj {
			return ri < rj
		}
		return out[i].UID < out[j].UID
	})
	if len(out) > discoverMax {
		out = out[:discoverMax]
	}
	return out
}
