package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Installing the connector as a program: a Windows service or a systemd unit.
// `connector service install` writes the settings file the Docker image gets as
// -e flags, puts the binary and the state where the platform keeps them, and
// starts the service. The first start redeems the pairing code; after that the
// token is in the state directory and the code is no use.

type installOptions struct {
	managerURL, dataplaneURL, pairCode string
	allowedTargets, dataDir            string
	configPath                         string
}

var (
	urlRe      = regexp.MustCompile(`^(https?|wss?)://[^\s"']+$`)
	pairCodeRe = regexp.MustCompile(`^[A-Za-z0-9_\-]{8,200}$`)
	targetsRe  = regexp.MustCompile(`^[A-Za-z0-9.:/,\-\[\]_ ]*$`)
)

// validate says what is wrong with the options, or "".
func (o installOptions) validate() string {
	switch {
	case !urlRe.MatchString(o.managerURL):
		return "--manager-url must be the console's address (https://...)"
	case !urlRe.MatchString(o.dataplaneURL):
		return "--dataplane-url must be the connector tunnel's address (wss://...)"
	case !pairCodeRe.MatchString(o.pairCode):
		return "--pair-code is the code the console shows once when the connector is added"
	case strings.ContainsAny(o.dataDir, "\r\n\""):
		return "--data-dir must be a plain path"
	case !targetsRe.MatchString(o.allowedTargets):
		return "--allowed-targets takes addresses, networks and host:port entries separated by commas"
	}
	return ""
}

// configText is the settings file. Values were validated: none holds a quote
// or a line break.
func (o installOptions) configText(logFile string) string {
	var b strings.Builder
	b.WriteString("# Captivo Access connector. Written by `connector service install`.\n")
	b.WriteString("CONNECTOR_PLATFORM=standalone\n")
	fmt.Fprintf(&b, "MANAGER_URL=%s\nDATAPLANE_URL=%s\n", o.managerURL, o.dataplaneURL)
	fmt.Fprintf(&b, "DATA_DIR=%s\n", o.dataDir)
	if o.pairCode != "" {
		fmt.Fprintf(&b, "PAIR_CODE=%s\n", o.pairCode)
	}
	if o.allowedTargets != "" {
		fmt.Fprintf(&b, "ALLOWED_TARGETS=%s\n", o.allowedTargets)
	}
	if logFile != "" {
		fmt.Fprintf(&b, "LOG_FILE=%s\n", logFile)
	}
	return b.String()
}

func serviceCommand(args []string, configPath string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "usage: connector service install|uninstall|status")
		return 2
	}
	sub, args := args[0], args[1:]
	switch sub {
	case "install":
		fs := flag.NewFlagSet("service install", flag.ContinueOnError)
		var o installOptions
		fs.StringVar(&o.managerURL, "manager-url", "", "the console's address")
		fs.StringVar(&o.dataplaneURL, "dataplane-url", "", "the connector tunnel's address")
		fs.StringVar(&o.pairCode, "pair-code", "", "the pairing code from the console")
		fs.StringVar(&o.allowedTargets, "allowed-targets", "", "limit what the connector may reach")
		fs.StringVar(&o.dataDir, "data-dir", defaultDataDir(), "where keys, the token and recordings are kept")
		if err := fs.Parse(args); err != nil {
			return 2
		}
		o.dataDir = filepath.Clean(o.dataDir)
		o.configPath = configPath
		if why := o.validate(); why != "" {
			fmt.Fprintln(os.Stderr, why)
			return 2
		}
		if err := platformInstall(o); err != nil {
			fmt.Fprintln(os.Stderr, "install failed:", err)
			return 1
		}
		return 0
	case "uninstall":
		keep := len(args) > 0 && args[0] == "--keep-data"
		if err := platformUninstall(keep, configPath); err != nil {
			fmt.Fprintln(os.Stderr, "uninstall failed:", err)
			return 1
		}
		return 0
	case "status":
		fmt.Println(platformStatus())
		return 0
	}
	fmt.Fprintf(os.Stderr, "unknown service command %q\n", sub)
	return 2
}

// copyFile writes dst whole or not at all.
func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".new"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, dst)
}
