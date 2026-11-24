package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

const (
	serviceName = "CaptivoConnector"
	serviceAcct = `NT SERVICE\` + serviceName // a virtual account: no password to keep
)

func defaultDataDir() string {
	return filepath.Join(envOr("ProgramData", `C:\ProgramData`), "Captivo", "Connector", "data")
}

func installDir() string {
	return filepath.Join(envOr("ProgramFiles", `C:\Program Files`), "Captivo", "Connector")
}

// winService is the connector under the service manager.
type winService struct{}

func (winService) Execute(_ []string, req <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	status <- svc.Status{State: svc.StartPending}
	configureLogging()
	go runConnector() // returns only on a fatal error, which log.Fatal turns into an exit
	status <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for c := range req {
		switch c.Cmd {
		case svc.Interrogate:
			status <- c.CurrentStatus
		case svc.Stop, svc.Shutdown:
			status <- svc.Status{State: svc.StopPending}
			// The connector keeps no state that a stop could cut in half: tunnels
			// reconnect and recordings are written in whole chunks.
			os.Exit(0)
		}
	}
	return false, 0
}

// runAsWindowsService runs the connector under the service manager when it
// was started by it.
func runAsWindowsService() (int, bool) {
	isSvc, err := svc.IsWindowsService()
	if err != nil || !isSvc {
		return 0, false
	}
	if err := svc.Run(serviceName, winService{}); err != nil {
		fmt.Fprintln(os.Stderr, "service:", err)
		return 1, true
	}
	return 0, true
}

func platformInstall(o installOptions) error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("could not reach the service manager (run it from an elevated PowerShell): %v", err)
	}
	defer m.Disconnect()
	if s, err := m.OpenService(serviceName); err == nil {
		s.Close()
		return errors.New("the connector service is already installed; `connector.exe service uninstall --keep-data` first, or `connector.exe update` to update it")
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	dir := installDir()
	target := filepath.Join(dir, "connector.exe")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if !strings.EqualFold(self, target) {
		if err := copyFile(self, target); err != nil {
			return err
		}
	}
	cfgPath := o.configPath
	if cfgPath == "" || cfgPath == defaultConfigPath() {
		cfgPath = defaultConfigPath()
	}
	logFile := filepath.Join(o.dataDir, "connector.log")
	for _, d := range []string{o.dataDir, filepath.Dir(cfgPath)} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return err
		}
	}
	if err := os.WriteFile(cfgPath, []byte(o.configText(logFile)), 0o600); err != nil {
		return err
	}
	s, err := m.CreateService(serviceName, target, mgr.Config{
		DisplayName:      "Captivo Access connector",
		Description:      "Connects this network to Captivo Access. Outbound only.",
		StartType:        mgr.StartAutomatic,
		DelayedAutoStart: true,
		ServiceStartName: serviceAcct,
	}, "run", "--config", cfgPath)
	if err != nil {
		return err
	}
	defer s.Close()
	_ = s.SetRecoveryActions([]mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 30 * time.Second},
		{Type: mgr.ServiceRestart, Delay: time.Minute},
	}, 86400)
	// Only the service, SYSTEM and administrators read the keys, the token and
	// the recordings. The service's own account exists once the service does.
	for _, d := range []string{o.dataDir, filepath.Dir(cfgPath)} {
		if out, err := exec.Command("icacls", d, "/inheritance:r", "/grant:r",
			serviceAcct+":(OI)(CI)F", "SYSTEM:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F").CombinedOutput(); err != nil {
			_ = s.Delete()
			return fmt.Errorf("could not restrict %s: %v: %s", d, err, strings.TrimSpace(string(out)))
		}
	}
	if err := s.Start(); err != nil {
		return fmt.Errorf("could not start the service: %v", err)
	}
	for i := 0; i < 30; i++ {
		st, err := s.Query()
		if err == nil && st.State == svc.Running {
			fmt.Printf("Installed and started. Its log is %s\n", logFile)
			return nil
		}
		time.Sleep(time.Second)
	}
	return fmt.Errorf("the service did not stay running; read %s", logFile)
}

func platformUninstall(keepData bool, configPath string) error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("could not reach the service manager (run it from an elevated PowerShell): %v", err)
	}
	defer m.Disconnect()
	if s, err := m.OpenService(serviceName); err == nil {
		_, _ = s.Control(svc.Stop)
		for i := 0; i < 20; i++ {
			if st, err := s.Query(); err != nil || st.State == svc.Stopped {
				break
			}
			time.Sleep(500 * time.Millisecond)
		}
		err := s.Delete()
		s.Close()
		if err != nil {
			return err
		}
	}
	if configPath == "" {
		configPath = defaultConfigPath()
	}
	dataDir := envOr("DATA_DIR", defaultDataDir())
	_ = os.Remove(configPath)
	if keepData {
		fmt.Printf("Removed the service. Keys, the token and recordings stay in %s.\n", dataDir)
		return nil
	}
	if c := filepath.Clean(dataDir); len(c) <= 3 {
		return errors.New("refusing to remove a drive root")
	}
	if err := os.RemoveAll(dataDir); err != nil {
		return err
	}
	fmt.Println("Removed the service and everything it kept, recordings included. The program files stay in", installDir())
	return nil
}

func platformStatus() string {
	m, err := mgr.Connect()
	if err != nil {
		return "unknown (" + err.Error() + ")"
	}
	defer m.Disconnect()
	s, err := m.OpenService(serviceName)
	if err != nil {
		return "not installed"
	}
	defer s.Close()
	st, err := s.Query()
	if err != nil {
		return "unknown"
	}
	switch st.State {
	case svc.Running:
		return "active"
	case svc.Stopped:
		return "inactive"
	}
	return "starting or stopping"
}

// restartService restarts the service after an update.
func restartService() error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(serviceName)
	if err != nil {
		return err
	}
	defer s.Close()
	_, _ = s.Control(svc.Stop)
	for i := 0; i < 20; i++ {
		if st, err := s.Query(); err != nil || st.State == svc.Stopped {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	return s.Start()
}

func serviceBinaryPath() string { return filepath.Join(installDir(), "connector.exe") }
