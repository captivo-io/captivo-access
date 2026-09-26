package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRecKeyIsCreatedOnceAndReused(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "recording.key")
	first, err := loadOrCreateRecKey(p)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if len(first) != 32 {
		t.Fatalf("want 32-byte key, got %d", len(first))
	}
	second, err := loadOrCreateRecKey(p)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if string(first) != string(second) {
		// A regenerated key silently orphans every recording already on disk.
		t.Fatal("key changed on reload")
	}
}

func TestRecKeyFileIsNotWorldReadable(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "recording.key")
	if _, err := loadOrCreateRecKey(p); err != nil {
		t.Fatalf("create: %v", err)
	}
	st, err := os.Stat(p)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("want 0600, got %o", st.Mode().Perm())
	}
}

func TestRecKeyRejectsWrongLength(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "recording.key")
	if err := os.WriteFile(p, []byte("too short"), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, err := loadOrCreateRecKey(p); err == nil {
		// Silently replacing a damaged key would make existing recordings
		// undecryptable with no signal; refusing surfaces it.
		t.Fatal("want error for a wrong-length key file")
	}
}
