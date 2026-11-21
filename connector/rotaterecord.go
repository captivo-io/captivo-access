package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// The connector's own copy of every password it rotated, sealed to its own
// key, in /data next to that key. Once a password rotates no person knows it;
// if Captivo cannot be reached, the customer reads it on this host:
//
//	docker exec captivo-connector connector show-password <resource or host>
//
// Only someone who can run commands in this container (who could read the key
// anyway) can open it.

type rotatedEntry struct {
	Label    string    `json:"label"`
	Host     string    `json:"host"`
	Port     string    `json:"port"`
	Username string    `json:"username"`
	Sealed   string    `json:"sealed"`
	At       time.Time `json:"at"`
}

var rotatedMu sync.Mutex

func rotatedFile() string { return envOr(rotateRecordEnv, "/data/rotated.json") }

func loadRotated(path string) (map[string]rotatedEntry, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]rotatedEntry{}, nil
	}
	if err != nil {
		return nil, err
	}
	m := map[string]rotatedEntry{}
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, err
	}
	return m, nil
}

// recordRotated keeps the connector's own seal of the password now in use.
func recordRotated(req tunnel.RotateRequest) {
	if err := writeRotated(rotatedFile(), req, time.Now()); err != nil {
		logWarn("vault: could not keep the local copy of a rotated password: %v", err)
	}
}

func writeRotated(path string, req tunnel.RotateRequest, now time.Time) error {
	rotatedMu.Lock()
	defer rotatedMu.Unlock()
	m, err := loadRotated(path)
	if err != nil {
		m = map[string]rotatedEntry{} // unreadable: start over rather than lose this one
	}
	key := req.Username + "@" + net.JoinHostPort(req.Host, req.Port)
	m[key] = rotatedEntry{Label: req.Label, Host: req.Host, Port: req.Port, Username: req.Username, Sealed: req.Pending, At: now.UTC()}
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// showPassword is the show-password command.
func showPassword(w io.Writer, args []string) int {
	keyFile := envOr("VAULT_KEY_FILE", "/data/vault.key")
	if _, err := os.Stat(keyFile); err != nil {
		fmt.Fprintf(w, "vault key: %v\n", err)
		return 1
	}
	k, err := loadOrCreateVaultKey(keyFile)
	if err != nil {
		fmt.Fprintf(w, "vault key: %v\n", err)
		return 1
	}
	m, err := loadRotated(rotatedFile())
	if err != nil {
		fmt.Fprintf(w, "rotated passwords: %v\n", err)
		return 1
	}
	if len(m) == 0 {
		fmt.Fprintln(w, "This connector has not rotated any password.")
		return 0
	}
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	if len(args) == 0 {
		fmt.Fprintln(w, "Passwords this connector rotated (pass a resource name or host to show one):")
		for _, key := range keys {
			e := m[key]
			fmt.Fprintf(w, "  %-28s %s  rotated %s\n", e.Label, key, e.At.Format(time.RFC3339))
		}
		return 0
	}
	q := strings.ToLower(strings.Join(args, " "))
	shown := 0
	for _, key := range keys {
		e := m[key]
		if !strings.Contains(strings.ToLower(e.Label), q) && !strings.Contains(strings.ToLower(key), q) {
			continue
		}
		pw, err := openSealed(k, e.Sealed, vaultTargetAAD(e.Host, e.Port, e.Username))
		if err != nil {
			fmt.Fprintf(w, "%s (%s): does not open with this connector's key\n", e.Label, key)
			continue
		}
		fmt.Fprintf(w, "%s (%s), rotated %s:\n  %s\n", e.Label, key, e.At.Format(time.RFC3339), pw)
		shown++
	}
	if shown == 0 {
		fmt.Fprintf(w, "No rotated password matches %q.\n", q)
		return 1
	}
	return 0
}
