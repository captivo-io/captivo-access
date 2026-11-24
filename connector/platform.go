package main

import (
	"bufio"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// Where the connector runs. The default is the Docker image: its state lives in
// /data, and guacd (remote desktops) and the isolated browser run beside it.
// CONNECTOR_PLATFORM=standalone is a connector installed as a program, a
// Windows service or a systemd unit (service.go): its state lives in DATA_DIR,
// it has no engines beside it, and it serves web apps, databases, Kubernetes
// clusters and TCP tunnels. It tells the data plane which it is, so the console
// never routes a remote desktop or an isolated browser to it.

// standalone is true for a connector installed as a program.
var standalone = os.Getenv("CONNECTOR_PLATFORM") == "standalone"

// platformName is what the connector reports: "" for the Docker image, else
// the operating system ("windows", "linux").
func platformName() string {
	if !standalone {
		return ""
	}
	return runtime.GOOS
}

// dataPath is a file or directory under the connector's state directory.
func dataPath(name string) string {
	return filepath.Join(envOr("DATA_DIR", "/data"), name)
}

// defaultConfigPath is where a program install keeps its settings.
func defaultConfigPath() string {
	if runtime.GOOS == "windows" {
		return filepath.Join(envOr("ProgramData", `C:\ProgramData`), "Captivo", "Connector", "connector.conf")
	}
	return "/etc/captivo-connector/connector.conf"
}

// loadConfigFile reads KEY=VALUE lines (blank lines and # comments ignored)
// into the environment, without overriding what is already set: one place for
// a program install to keep what the Docker image gets as -e flags.
func loadConfigFile(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(strings.TrimPrefix(sc.Text(), "\ufeff"))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		k = strings.TrimSpace(k)
		if !ok || k == "" {
			continue
		}
		if os.Getenv(k) == "" {
			_ = os.Setenv(k, strings.Trim(strings.TrimSpace(v), `"`))
		}
	}
	return sc.Err()
}

// standaloneHost fills in what the Docker install command passes as flags: the
// connector sees the machine it runs on.
func standaloneHost() (osName, ip string) {
	switch runtime.GOOS {
	case "windows":
		if out, err := exec.Command("cmd", "/c", "ver").Output(); err == nil {
			osName = strings.TrimSpace(string(out))
		}
	case "linux":
		if f, err := os.Open("/etc/os-release"); err == nil {
			defer f.Close()
			sc := bufio.NewScanner(f)
			for sc.Scan() {
				if v, ok := strings.CutPrefix(sc.Text(), "PRETTY_NAME="); ok {
					osName = strings.Trim(v, `"'`)
				}
			}
		}
	}
	if osName == "" {
		osName = runtime.GOOS + "/" + runtime.GOARCH
	}
	// The address the machine reaches the network with: no packet is sent.
	if c, err := net.Dial("udp", "192.0.2.1:9"); err == nil {
		ip, _, _ = net.SplitHostPort(c.LocalAddr().String())
		c.Close()
	}
	return osName, ip
}
