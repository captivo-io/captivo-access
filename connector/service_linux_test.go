package main

import (
	"strings"
	"testing"
)

func TestUnitRunsAsItsOwnUserAndWritesOnlyItsState(t *testing.T) {
	u := unitText("/etc/captivo-connector/connector.conf", "/var/lib/captivo-connector")
	for _, want := range []string{"User=captivo-connector", "ExecStart=/usr/local/bin/captivo-connector run --config /etc/captivo-connector/connector.conf", "Restart=always", "ProtectSystem=strict", "ReadWritePaths=/var/lib/captivo-connector", "NoNewPrivileges=true"} {
		if !strings.Contains(u, want) {
			t.Errorf("unit lacks %q", want)
		}
	}
}
