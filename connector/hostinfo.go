package main

import (
	"net"
	"os"
	"regexp"
	"strings"
)

// hostInfo is what the card shows about the machine the connector runs on.
// Inside a container the connector sees only itself, so the install command
// passes the host's facts in: --hostname "$(hostname)", HOST_IP (hostname -I)
// and HOST_OS (PRETTY_NAME from /etc/os-release; an env value, not a mount, so
// a host without that file still starts). A connector started without them
// reports nothing rather than the container's own id or bridge address.
type hostInfo struct{ hostname, os, localIP string }

var host = readHostInfo(os.Getenv("HOST_OS"), os.Getenv("HOST_IP"))

// A Docker-assigned hostname: the first 12 hex digits of the container id.
var containerID = regexp.MustCompile(`^[0-9a-f]{12}$`)

func readHostInfo(hostOS, hostIP string) hostInfo {
	var h hostInfo
	if n, err := os.Hostname(); err == nil && !containerID.MatchString(n) {
		h.hostname = clip(n, 128)
	}
	h.os = clip(strings.Trim(strings.TrimSpace(hostOS), `"'`), 128)
	// `hostname -I` lists every address; the first is the primary one.
	if f := strings.Fields(hostIP); len(f) > 0 {
		hostIP = f[0]
	}
	if ip := net.ParseIP(hostIP); ip != nil {
		h.localIP = ip.String()
	}
	return h
}

func clip(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
