package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// recStore is the connector's own recording store: chunks live on this host's disk,
// encrypted with the connector's key, and are never shipped to the control plane.
// Layout: <root>/<tenantID>/<recordingKey>/<seq>.bin
type recStore struct {
	root string
	key  []byte
}

type recChunk struct {
	Seq  int
	Data []byte
}

func newRecStore(root string, key []byte) *recStore { return &recStore{root: root, key: key} }

// safeSegment keeps tenant ids and recording keys from escaping the store root.
// Both arrive over the tunnel, so neither is trusted.
var safeSegment = regexp.MustCompile(`^[A-Za-z0-9_.:@-]{1,200}$`)

func (s *recStore) dir(tenantID, recordingKey string) (string, error) {
	if !safeSegment.MatchString(tenantID) || strings.Contains(tenantID, "..") {
		return "", fmt.Errorf("invalid tenant id")
	}
	if !safeSegment.MatchString(recordingKey) || strings.Contains(recordingKey, "..") {
		return "", fmt.Errorf("invalid recording key")
	}
	return filepath.Join(s.root, tenantID, recordingKey), nil
}

func (s *recStore) seal(plain []byte) ([]byte, error) {
	block, err := aes.NewCipher(s.key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return append(nonce, gcm.Seal(nil, nonce, plain, nil)...), nil
}

func (s *recStore) open(sealed []byte) ([]byte, error) {
	block, err := aes.NewCipher(s.key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(sealed) < gcm.NonceSize() {
		return nil, errors.New("short ciphertext")
	}
	return gcm.Open(nil, sealed[:gcm.NonceSize()], sealed[gcm.NonceSize():], nil)
}

// Append seals one chunk and writes it. Returns the plaintext byte count so the
// caller can keep the central byte counter honest.
func (s *recStore) Append(tenantID, recordingKey string, seq int, plain []byte) (int, error) {
	d, err := s.dir(tenantID, recordingKey)
	if err != nil {
		return 0, err
	}
	if err := os.MkdirAll(d, 0o700); err != nil {
		return 0, err
	}
	sealed, err := s.seal(plain)
	if err != nil {
		return 0, err
	}
	if err := os.WriteFile(filepath.Join(d, strconv.Itoa(seq)+".bin"), sealed, 0o600); err != nil {
		return 0, err
	}
	return len(plain), nil
}

// Read returns the decrypted chunks from fromSeq onward, in sequence order. A chunk
// that fails to decrypt is skipped rather than failing the whole read: one corrupt
// chunk must not make an otherwise good recording unplayable.
func (s *recStore) Read(tenantID, recordingKey string, fromSeq int) ([]recChunk, error) {
	d, err := s.dir(tenantID, recordingKey)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(d)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	var out []recChunk
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".bin") {
			continue
		}
		seq, err := strconv.Atoi(strings.TrimSuffix(e.Name(), ".bin"))
		if err != nil || seq < fromSeq {
			continue
		}
		sealed, err := os.ReadFile(filepath.Join(d, e.Name()))
		if err != nil {
			continue
		}
		plain, err := s.open(sealed)
		if err != nil {
			continue
		}
		out = append(out, recChunk{Seq: seq, Data: plain})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Seq < out[j].Seq })
	return out, nil
}

// SetFormat records a recording's format beside its chunks. Search needs it: a
// guac stream is protocol bytes, not text, and matching a query against it
// produces meaningless hits. Written once per recording, on the first chunk.
func (s *recStore) SetFormat(tenantID, recordingKey, format string) error {
	if !safeSegment.MatchString(format) {
		return fmt.Errorf("invalid format")
	}
	d, err := s.dir(tenantID, recordingKey)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(d, 0o700); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(d, "format"), []byte(format), 0o600)
}

// Format reports a recording's format, or "" when it was never set.
func (s *recStore) Format(tenantID, recordingKey string) string {
	d, err := s.dir(tenantID, recordingKey)
	if err != nil {
		return ""
	}
	b, err := os.ReadFile(filepath.Join(d, "format"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// Bytes reports what the disk actually holds for one recording (sealed sizes).
func (s *recStore) Bytes(tenantID, recordingKey string) (int64, error) {
	d, err := s.dir(tenantID, recordingKey)
	if err != nil {
		return 0, err
	}
	entries, err := os.ReadDir(d)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return 0, nil
		}
		return 0, err
	}
	var total int64
	for _, e := range entries {
		// Only chunks count; the "format" sidecar is metadata, not recording data.
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".bin") {
			continue
		}
		if info, err := e.Info(); err == nil {
			total += info.Size()
		}
	}
	return total, nil
}

// Purge removes every recording for a tenant whose directory was last modified
// before olderThan, and reports how many it removed. The connector owns the files,
// so it owns retention.
func (s *recStore) Purge(tenantID string, olderThan time.Time) (int, error) {
	if !safeSegment.MatchString(tenantID) {
		return 0, fmt.Errorf("invalid tenant id")
	}
	base := filepath.Join(s.root, tenantID)
	entries, err := os.ReadDir(base)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return 0, nil
		}
		return 0, err
	}
	removed := 0
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil || !info.ModTime().Before(olderThan) {
			continue
		}
		if os.RemoveAll(filepath.Join(base, e.Name())) == nil {
			removed++
		}
	}
	return removed, nil
}

// setModTimeForTest ages a recording directory so retention can be tested without
// sleeping. Test-only, but it lives here because it needs the layout.
func (s *recStore) setModTimeForTest(tenantID, recordingKey string, t time.Time) error {
	d, err := s.dir(tenantID, recordingKey)
	if err != nil {
		return err
	}
	return os.Chtimes(d, t, t)
}
