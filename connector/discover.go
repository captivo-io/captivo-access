package main

import (
	"context"
	"crypto/ecdh"
	"fmt"
	"github.com/jfjallid/go-smb/dcerpc/mssamr"
	"net"
	"regexp"
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
	if req.Method != "linux" && req.Method != "windows" && req.Method != "postgres" && req.Method != "mysql" {
		return tunnel.RotateResponse{Error: "accounts can be listed on a Linux or a Windows server, or in PostgreSQL or MySQL"}
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
	if req.Method == "postgres" || req.Method == "mysql" {
		if r.SecretKey {
			return tunnel.RotateResponse{Error: "a database administrator account signs in with a password"}
		}
		addr := net.JoinHostPort(req.Host, req.Port)
		if !egressAllowed(allow, addr) {
			denied()
			logDenied("discover", addr)
			return tunnel.RotateResponse{Error: "target not allowed"}
		}
		t := &dbAccountTarget{engine: req.Method, host: req.Host, port: req.Port, username: req.Username}
		if req.DB != nil {
			t.db = *req.DB
		}
		return discoverDatabase(t, r.Username, secret)
	}
	if req.Method == "windows" {
		if r.SecretKey {
			return tunnel.RotateResponse{Error: "a Windows administrator account signs in with a password"}
		}
		if !egressAllowed(allow, windowsAddr(req.Host)) {
			denied()
			logDenied("discover", windowsAddr(req.Host))
			return tunnel.RotateResponse{Error: "the server's file-sharing port is not allowed by this connector"}
		}
		return discoverWindows(ctx, &windowsTarget{host: req.Host, port: windowsSMBPort, reconcile: &reconcileSecret{username: r.Username, secret: secret}})
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

// SAMR's account flags (MS-SAMR 2.2.1.12).
const (
	samUserDisabled   = 0x1
	samUserNoPassword = 0x4
	samUserNormal     = 0x10
	samUserAutoLocked = 0x400
	samEnumMax        = 0xffff
)

// discoverWindows lists the local accounts of a Windows server over SMB (samr)
// as its administrator account: which are normal accounts that can sign in,
// which are in the Administrators group, which are disabled, locked or need
// no password, and how old each password is. The uid column is the RID.
func discoverWindows(ctx context.Context, wt *windowsTarget) tunnel.RotateResponse {
	s, builtin, err := wt.openSamr(ctx)
	if err != nil {
		return tunnel.RotateResponse{Error: err.Error()}
	}
	defer s.close()
	ah, err := s.adminsAlias(builtin)
	if err != nil {
		return tunnel.RotateResponse{Error: err.Error()}
	}
	members, err := s.r.SamrGetMembersInAlias(ah)
	if err != nil {
		return tunnel.RotateResponse{Error: "could not read the Administrators group: " + err.Error()}
	}
	users, err := s.r.SamrEnumDomainUsers(s.local, 0, samEnumMax)
	if err != nil {
		return tunnel.RotateResponse{Error: "could not list the server's accounts: " + err.Error()}
	}
	now := time.Now()
	var out []tunnel.DiscoveredAccount
	for _, u := range users {
		name := u.Name.Value
		if name == "" || !windowsNameRe.MatchString(name) {
			continue
		}
		a := tunnel.DiscoveredAccount{Name: name, UID: int(u.RelativeId), PassAgeDays: -1}
		if sid, err := s.r.SamrRidToSid(s.local, u.RelativeId); err == nil {
			a.Admin = hasSID(members, sid)
		}
		uh, err := s.r.SamrOpenUser(s.local, maximumAllowed, u.RelativeId)
		if err == nil {
			if info, err := s.r.SamrGetUserInfo2(uh, mssamr.UserAllInformation); err == nil && info != nil {
				f := info.UserAccountControl
				a.Login = f&samUserNormal != 0 && f&samUserDisabled == 0
				a.Locked = f&samUserDisabled != 0 || f&samUserAutoLocked != 0
				a.NoPass = f&samUserNoPassword != 0
				if t := filetimeToTime(info.PasswordLastSet); !t.IsZero() {
					a.PassAgeDays = int(now.Sub(t).Hours() / 24)
				}
			}
			_ = s.r.SamrCloseHandle(uh)
		}
		out = append(out, a)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Login != out[j].Login {
			return out[i].Login
		}
		return out[i].UID < out[j].UID
	})
	if len(out) > discoverMax {
		out = out[:discoverMax]
	}
	return tunnel.RotateResponse{Outcome: "ok", Accounts: out}
}

// A Windows account name Captivo can use as a resource's user name.
var windowsNameRe = regexp.MustCompile(`^[A-Za-z0-9._$-]{1,20}$`)

// discoverDatabase lists the accounts of a PostgreSQL or MySQL server as its
// administrator account: who can sign in, who is an administrator, which are
// locked, and how old a MySQL password is. Only those facts leave; never a
// hash. A MySQL user that exists for several hosts is listed once and cannot
// be taken over (a reset cannot tell which one is meant).
func discoverDatabase(t *dbAccountTarget, adminUser, adminPW string) tunnel.RotateResponse {
	s, err := t.signIn(adminUser, adminPW)
	if err != nil {
		return tunnel.RotateResponse{Error: "the administrator account can't sign in: " + err.Error()}
	}
	defer s.Close()
	var rows []string
	if t.engine == "postgres" {
		rows, err = s.column(`SELECT rolname || '|' || rolcanlogin::text || '|' || rolsuper::text FROM pg_roles WHERE rolname NOT LIKE 'pg\_%' ORDER BY rolname`)
	} else {
		// MySQL 8 knows when a password changed and whether the account is locked; MariaDB and older servers lack those columns.
		rows, err = s.column(`SELECT CONCAT_WS('|', User, Host, account_locked, IFNULL(DATEDIFF(NOW(), password_last_changed), -1), Super_priv) FROM mysql.user WHERE User <> '' ORDER BY User`)
		if err != nil {
			rows, err = s.column(`SELECT CONCAT_WS('|', User, Host, 'N', -1, Super_priv) FROM mysql.user WHERE User <> '' ORDER BY User`)
		}
	}
	if err != nil {
		return tunnel.RotateResponse{Error: "the administrator account can't read the server's accounts: " + err.Error()}
	}
	return tunnel.RotateResponse{Outcome: "ok", Accounts: parseDatabaseAccounts(t.engine, rows)}
}

func parseDatabaseAccounts(engine string, rows []string) []tunnel.DiscoveredAccount {
	var out []tunnel.DiscoveredAccount
	hosts := map[string]int{}
	var parsed [][]string
	for _, r := range rows {
		f := strings.Split(r, "|")
		if engine == "postgres" && len(f) == 3 || engine == "mysql" && len(f) == 5 {
			parsed = append(parsed, f)
			if engine == "mysql" {
				hosts[f[0]]++
			}
		}
	}
	seen := map[string]bool{}
	for _, f := range parsed {
		a := tunnel.DiscoveredAccount{Name: f[0], PassAgeDays: -1}
		if !dbAccountNameRe.MatchString(a.Name) || seen[a.Name] {
			continue
		}
		seen[a.Name] = true
		if engine == "postgres" {
			a.Login = f[1] == "true"
			a.Admin = f[2] == "true"
			a.Locked = !a.Login
		} else {
			a.Locked = f[2] == "Y"
			a.Login = !a.Locked
			a.Admin = f[4] == "Y"
			if n, err := strconv.Atoi(f[3]); err == nil {
				a.PassAgeDays = n
			}
			if hosts[a.Name] > 1 {
				a.Blocked = fmt.Sprintf("This user exists for %d hosts; Captivo cannot tell which one to take over.", hosts[a.Name])
			}
		}
		out = append(out, a)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Login != out[j].Login {
			return out[i].Login
		}
		return out[i].Name < out[j].Name
	})
	if len(out) > discoverMax {
		out = out[:discoverMax]
	}
	return out
}

// A database account name that is safe to show and to use as a resource's user name.
var dbAccountNameRe = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.@$-]{0,62}$`)
