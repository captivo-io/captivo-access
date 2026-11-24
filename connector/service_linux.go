package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	serviceUser = "captivo-connector"
	unitPath    = "/etc/systemd/system/captivo-connector.service"
	binaryPath  = "/usr/local/bin/captivo-connector"
)

func defaultDataDir() string { return "/var/lib/captivo-connector" }

func runAsWindowsService() (int, bool) { return 0, false }

// unitText is the systemd unit: the connector runs as its own user, can write
// only its state directory, and is started again whatever stopped it.
func unitText(configPath, dataDir string) string {
	return fmt.Sprintf(`[Unit]
Description=Captivo Access connector
Documentation=https://captivo.io
After=network-online.target
Wants=network-online.target

[Service]
User=%s
ExecStart=%s run --config %s
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=%s

[Install]
WantedBy=multi-user.target
`, serviceUser, binaryPath, configPath, dataDir)
}

func run(name string, args ...string) error {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s: %v: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

func platformInstall(o installOptions) error {
	if os.Geteuid() != 0 {
		return errors.New("run it as root (sudo)")
	}
	if _, err := exec.LookPath("systemctl"); err != nil {
		return errors.New("this host has no systemd; run the connector with its Docker image instead")
	}
	cfgPath := o.configPath
	if cfgPath == "" {
		cfgPath = defaultConfigPath()
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	if self != binaryPath {
		if err := copyFile(self, binaryPath); err != nil {
			return err
		}
	}
	if _, err := user.Lookup(serviceUser); err != nil {
		if err := run("useradd", "--system", "--home-dir", o.dataDir, "--no-create-home", "--shell", "/usr/sbin/nologin", serviceUser); err != nil {
			return err
		}
	}
	u, err := user.Lookup(serviceUser)
	if err != nil {
		return err
	}
	uid, _ := strconv.Atoi(u.Uid)
	gid, _ := strconv.Atoi(u.Gid)
	if err := os.MkdirAll(o.dataDir, 0o700); err != nil {
		return err
	}
	if err := os.Chown(o.dataDir, uid, gid); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(cfgPath), 0o750); err != nil {
		return err
	}
	if err := os.WriteFile(cfgPath, []byte(o.configText("")), 0o640); err != nil {
		return err
	}
	if err := os.Chown(filepath.Dir(cfgPath), 0, gid); err != nil {
		return err
	}
	if err := os.Chown(cfgPath, 0, gid); err != nil {
		return err
	}
	if err := os.WriteFile(unitPath, []byte(unitText(cfgPath, o.dataDir)), 0o644); err != nil {
		return err
	}
	if err := run("systemctl", "daemon-reload"); err != nil {
		return err
	}
	if err := run("systemctl", "enable", "--now", "captivo-connector"); err != nil {
		return err
	}
	// A unit can start and fall over (a container host that refuses the sandbox
	// settings, a tunnel that cannot be reached): say so instead of "installed".
	for i := 0; i < 15; i++ {
		time.Sleep(time.Second)
		if platformStatus() == "active" && i >= 4 {
			fmt.Println("Installed and started. Follow it with: journalctl -u captivo-connector -f")
			return nil
		}
	}
	out, _ := exec.Command("journalctl", "-u", "captivo-connector", "--no-pager", "-n", "8", "-o", "cat").CombinedOutput()
	return fmt.Errorf("the service did not stay running. Its last log lines:\n%s", strings.TrimSpace(string(out)))
}

func platformUninstall(keepData bool, configPath string) error {
	if os.Geteuid() != 0 {
		return errors.New("run it as root (sudo)")
	}
	_ = run("systemctl", "disable", "--now", "captivo-connector")
	_ = os.Remove(unitPath)
	_ = run("systemctl", "daemon-reload")
	_ = os.Remove(binaryPath)
	if configPath == "" {
		configPath = defaultConfigPath()
	}
	dataDir := envOr("DATA_DIR", defaultDataDir())
	_ = os.Remove(configPath)
	_ = os.Remove(filepath.Dir(configPath))
	if keepData {
		fmt.Printf("Removed the service. Keys, the token and recordings stay in %s.\n", dataDir)
		return nil
	}
	if filepath.Clean(dataDir) == "/" || dataDir == "" {
		return errors.New("refusing to remove an empty or root data directory")
	}
	if err := os.RemoveAll(dataDir); err != nil {
		return err
	}
	_ = run("userdel", serviceUser)
	fmt.Println("Removed the service and everything it kept, recordings included.")
	return nil
}

func platformStatus() string {
	out, _ := exec.Command("systemctl", "is-active", "captivo-connector").Output()
	if s := strings.TrimSpace(string(out)); s != "" {
		return s
	}
	return "not installed"
}

// restartService restarts the unit after an update.
func restartService() error { return run("systemctl", "restart", "captivo-connector") }

func serviceBinaryPath() string { return binaryPath }
