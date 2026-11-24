//go:build !linux && !windows

package main

import "errors"

func defaultDataDir() string { return "/var/lib/captivo-connector" }

func runAsWindowsService() (int, bool) { return 0, false }

func platformInstall(installOptions) error {
	return errors.New("installing as a service is supported on Windows and on Linux with systemd; run `connector run` under your own supervisor")
}

func platformUninstall(bool, string) error { return errors.New("not installed as a service") }

func platformStatus() string { return "not installed" }

func restartService() error { return errors.New("no service to restart") }

func serviceBinaryPath() string { return "" }
