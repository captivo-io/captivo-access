package main

import (
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// recKeyLen is the AES-256 key length. Recordings are encrypted with this key on
// the connector's own disk and the control plane never receives it: that is the
// whole point of storing recordings here rather than centrally.
const recKeyLen = 32

// loadOrCreateRecKey returns the connector's recording key, generating it on first
// use. The key must survive restarts AND re-pairing -- regenerating it orphans
// every recording already on disk, so a wrong-length file is an error rather than
// something to quietly replace.
func loadOrCreateRecKey(path string) ([]byte, error) {
	b, err := os.ReadFile(path)
	if err == nil {
		if len(b) != recKeyLen {
			return nil, fmt.Errorf("recording key %s is %d bytes, want %d: refusing to replace it (existing recordings would become unreadable)", path, len(b), recKeyLen)
		}
		return b, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	key := make([]byte, recKeyLen)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, key, 0o600); err != nil {
		return nil, err
	}
	return key, nil
}
