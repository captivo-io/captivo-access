package main

import (
	"fmt"
	"io"
	"log"
	"os"
	"strings"
)

// The connector's command line. With no command it runs the connector, which
// is all the Docker image does; the rest is for a program install (service.go,
// selfupdate.go):
//
//	connector [run] [--config FILE]
//	connector service install --manager-url URL --dataplane-url URL --pair-code CODE [...]
//	connector service uninstall [--keep-data]
//	connector service status
//	connector update [--version X.Y.Z] [--check]
//	connector show-password <resource or host>
//	connector version

// splitConfigFlag takes --config FILE out of args.
func splitConfigFlag(args []string) (rest []string, path string) {
	for i := 0; i < len(args); i++ {
		if args[i] == "--config" && i+1 < len(args) {
			path = args[i+1]
			i++
			continue
		}
		if v, ok := strings.CutPrefix(args[i], "--config="); ok {
			path = v
			continue
		}
		rest = append(rest, args[i])
	}
	return rest, path
}

func runCLI(args []string) int {
	args, cfg := splitConfigFlag(args)
	if cfg == "" {
		cfg = os.Getenv("CONNECTOR_CONFIG")
	}
	explicit := cfg != ""
	if cfg == "" {
		cfg = defaultConfigPath()
	}
	if err := loadConfigFile(cfg); err != nil && explicit {
		fmt.Fprintf(os.Stderr, "config %s: %v\n", cfg, err)
		return 1
	}
	// Read after the file: it may set CONNECTOR_PLATFORM.
	standalone = os.Getenv("CONNECTOR_PLATFORM") == "standalone"
	host = func() hostInfo {
		hostOS, hostIP := os.Getenv("HOST_OS"), os.Getenv("HOST_IP")
		if standalone && hostOS == "" {
			hostOS, hostIP = standaloneHost()
		}
		return readHostInfo(hostOS, hostIP)
	}()

	cmd := "run"
	if len(args) > 0 {
		cmd, args = args[0], args[1:]
	}
	switch cmd {
	case "run":
		if code, handled := runAsWindowsService(); handled {
			return code
		}
		configureLogging()
		runConnector()
		return 1
	case "show-password":
		return showPassword(os.Stdout, args)
	case "service":
		return serviceCommand(args, cfg)
	case "update":
		return updateCommand(args, os.Stdout)
	case "version", "--version":
		fmt.Println(Version)
		return 0
	}
	fmt.Fprintf(os.Stderr, "unknown command %q (run, service, update, show-password, version)\n", cmd)
	return 2
}

// configureLogging sends the log to stderr (docker logs, journald), the
// console's log tail and, when LOG_FILE is set, a rotating file.
func configureLogging() {
	var out io.Writer = io.MultiWriter(os.Stderr, logRingBuf)
	if path := os.Getenv("LOG_FILE"); path != "" {
		if f, err := openRotatingFile(path, 10<<20, 3); err == nil {
			out = io.MultiWriter(os.Stderr, logRingBuf, f)
		} else {
			fmt.Fprintf(os.Stderr, "log file %s: %v\n", path, err)
		}
	}
	log.SetOutput(out)
}
