// Command connector is the captivo-access connector agent: it runs inside
// the customer's data center, enrolls with the Manager using a pairing code,
// dials out to the data-plane over WSS, and proxies HTTP requests to
// internal targets the Manager routes to it, optionally constrained by
// ALLOWED_TARGETS. The connector never accepts inbound connections.
package main

import (
	"io"
	"log"
	"os"
	"strings"
)

func main() {
	// Keep stderr (docker logs) and also capture recent lines for the console tail.
	log.SetOutput(io.MultiWriter(os.Stderr, logRingBuf))
	// Initial threshold from env; the Manager can override it live via policy.
	setLogLevel(envOr("LOG_LEVEL", "info"))

	// The install command mounts guacd's drive volume at /drive; prune old
	// per-session dirs. No-op when the volume isn't mounted (directory absent).
	startDriveCleanup("/drive")

	managerURL := os.Getenv("MANAGER_URL")
	dataplaneURL := os.Getenv("DATAPLANE_URL")
	tokenFile := envOr("TOKEN_FILE", "/data/token")
	// Recording bytes stay on this host. The key is generated here and never
	// leaves: that is what makes "the operator cannot read recordings" true
	// rather than a claim.
	recKeyFile := envOr("RECORDING_KEY_FILE", "/data/recording.key")
	recDir := envOr("RECORDING_DIR", "/data/recordings")
	recKey, err := loadOrCreateRecKey(recKeyFile)
	if err != nil {
		// Fail loud at boot: a connector that cannot key its store would accept
		// sessions and silently drop their recordings.
		log.Fatalf("recording key: %v", err)
	}
	store := newRecStore(recDir, recKey)
	// The enrollment pairing code and the long-lived connector token travel over
	// these URLs; a plaintext scheme exposes them on the wire. Warn loudly but
	// don't exit — local/test setups may legitimately use http/ws.
	warnInsecureURL("MANAGER_URL", managerURL)
	warnInsecureURL("DATAPLANE_URL", dataplaneURL)

	allow, err := ParseAllowedTargets(os.Getenv("ALLOWED_TARGETS"))
	if err != nil {
		logError("invalid ALLOWED_TARGETS: %v", err)
		os.Exit(1)
	}

	token := readToken(tokenFile)
	if token == "" {
		pairCode := os.Getenv("PAIR_CODE")
		if pairCode == "" {
			logError("no stored token and no PAIR_CODE set")
			os.Exit(1)
		}
		token, err = enroll(managerURL, pairCode, tokenFile)
		if err != nil {
			logError("enroll failed: %v", err)
			os.Exit(1)
		}
		logInfo("enrolled and stored token")
	}

	logInfo("connector starting (version %s)", Version)
	go logHeartbeat()
	// The install command mounts guacd's log volume at /guaclog; tail guacd's
	// log so the console can show it. When the volume isn't mounted /guaclog is
	// absent and the tail never starts (guacdLogRing stays empty).
	if _, err := os.Stat("/guaclog"); err == nil {
		go tailGuacdLog("/guaclog/guacd.log")
	}
	// The install command mounts the isolated-browser log volume at /kasmlog;
	// tail the broker log so the console can show it. Absent when unmounted.
	if _, err := os.Stat("/kasmlog"); err == nil {
		go tailKasmLog("/kasmlog/kasm.log")
	}
	runClient(dataplaneURL, token, allow, store)
}

// warnInsecureURL logs a hard warning when a control-plane URL uses a plaintext
// scheme (http/ws), over which the enrollment code and connector token would
// travel unencrypted. Non-fatal so local/test setups still work.
func warnInsecureURL(name, raw string) {
	if strings.HasPrefix(raw, "http://") || strings.HasPrefix(raw, "ws://") {
		logWarn("%s uses a plaintext scheme (%s) — the enrollment code and connector token travel unencrypted; use https:// / wss:// in production", name, raw)
	}
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func readToken(f string) string {
	b, err := os.ReadFile(f)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}
