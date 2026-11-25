package main

import (
	"context"
	"fmt"
)

// Linux: a sudoers entry for the account, written by the administrator
// account, checked with visudo before it is put in place, removed when the
// last session closes. An entry nobody removed is a day old before the next
// elevation sweeps it.

const elevateStaleMinutes = 24 * 60

type linuxElev struct {
	t      *linuxTarget
	secret string
}

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

func (l *linuxElev) grant(ctx context.Context) (bool, error) {
	c, err := l.t.adminClient(ctx)
	if err != nil {
		return false, err
	}
	defer c.Close()
	return false, l.t.adminRun(c, elevateWriteCmd(l.t.username), elevateLine(l.t.username), l.secret)
}

func (l *linuxElev) revoke(ctx context.Context) error {
	c, err := l.t.adminClient(ctx)
	if err != nil {
		return err
	}
	defer c.Close()
	return l.t.adminRun(c, elevateRemoveCmd(l.t.username), "", l.secret)
}
