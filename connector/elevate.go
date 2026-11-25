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
// A Linux account that is an ordinary user all day gets a sudoers entry while
// someone has a recorded SSH session on it, and loses it when the last one
// ends:
//
//	/etc/sudoers.d/captivo-<user>:  <user> ALL=(ALL:ALL) NOPASSWD: ALL
//
// The entry is written by the resource's administrator account (the reconcile
// account: root, or one with sudo), checked with visudo before it is put in
// place, and removed when the session closes. Sessions on the same account
// share one entry; it goes with the last. An entry a crash left behind is
// removed by the next elevation once it is a day old.

// sudoers.d skips names with a dot, so the account name is narrower here than
// for a password change.
var elevateUserRe = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)

var elevations = struct {
	sync.Mutex
	n map[string]int
}{n: map[string]int{}}

const elevateStaleMinutes = 24 * 60

func elevateWriteCmd(user string) string {
	return `sh -c 'set -e; find /etc/sudoers.d -maxdepth 1 -name "captivo-*" -mmin +` + fmt.Sprint(elevateStaleMinutes) + ` -delete; ` +
		`t=$(mktemp /etc/sudoers.d/.captivo.XXXXXX); trap "rm -f $t" EXIT; cat > $t; visudo -cf $t >/dev/null; chmod 440 $t; ` +
		`mv $t /etc/sudoers.d/captivo-` + user + `; trap - EXIT'`
}

func elevateRemoveCmd(user string) string {
	return "rm -f /etc/sudoers.d/captivo-" + user
}

func elevateLine(user string) string {
	return "# Captivo Access: administrator rights for the length of a session\n" + user + " ALL=(ALL:ALL) NOPASSWD: ALL\n"
}

// elevateAccount gives req.Username administrator rights and returns what
// takes them away again.
func elevateAccount(ctx context.Context, allow *TargetMatcher, req tunnel.SshDialRequest) (func(), error) {
	e := req.Elevate
	user := req.Username
	if !elevateUserRe.MatchString(user) || user == "root" {
		return nil, errors.New("administrator rights are given to an ordinary account named in lower case letters, digits, _ and -")
	}
	if e.Host != req.Host || e.Port != req.Port {
		return nil, errors.New("the administrator account is for another host")
	}
	s, err := openSealed(vaultKey, e.Sealed, vaultReconcileAAD(e.Host, e.Port, e.Username))
	if err != nil {
		return nil, errors.New("the administrator account does not open on this connector; enter it again")
	}
	addr := net.JoinHostPort(req.Host, req.Port)
	t := &linuxTarget{addr: addr, username: user, pinned: req.PinnedHostKey, reconcile: &reconcileSecret{username: e.Username, secret: s, isKey: e.SecretKey}}
	key := addr + "/" + user

	elevations.Lock()
	defer elevations.Unlock()
	if elevations.n[key] == 0 {
		c, err := t.adminClient(ctx)
		if err != nil {
			return nil, err
		}
		defer c.Close()
		if err := t.adminRun(c, elevateWriteCmd(user), elevateLine(user), s); err != nil {
			return nil, fmt.Errorf("could not give %s administrator rights: %v", user, err)
		}
	}
	elevations.n[key]++
	return func() {
		elevations.Lock()
		defer elevations.Unlock()
		elevations.n[key]--
		if elevations.n[key] > 0 {
			return
		}
		delete(elevations.n, key)
		c, err := t.adminClient(context.Background())
		if err == nil {
			defer c.Close()
			err = t.adminRun(c, elevateRemoveCmd(user), "", s)
		}
		if err != nil {
			logWarn("could not take administrator rights from %s on %s: %v (the entry is removed by the next session, or after a day)", user, addr, err)
		}
	}, nil
}
