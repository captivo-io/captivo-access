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
	"sync"
	"time"
)

// recStore is the connector's own recording store: chunks live on this host's disk,
// encrypted with the connector's key, and are never shipped to the control plane.
// Layout: <root>/<tenantID>/<recordingKey>/<format>/<seq>.bin
//
// The FORMAT segment is load-bearing, not tidiness. One session writes several
// independent streams under a single recording key -- a guac session records its
// instruction stream and its keystrokes at the same time -- and each writer numbers
// its own chunks from zero. Addressing a chunk by seq alone made those writers
// overwrite each other file for file: the guac stream came back with JSON spliced
// into it and no player could start. The stream is part of a chunk's address.
type recStore struct {
	root string
	key  []byte
	// mu orders whole-recording changes: erasure and retention against the
	// maintenance worker's rewrites (recmaint.go), so a recording being erased is
	// never written back. Chunk appends do not take it.
	mu sync.Mutex
}

type recChunk struct {
	Seq  int
	Data []byte
}

func newRecStore(root string, key []byte) *recStore { return &recStore{root: root, key: key} }

// safeSegment keeps tenant ids and recording keys from escaping the store root.
// Both arrive over the tunnel, so neither is trusted.
var safeSegment = regexp.MustCompile(`^[A-Za-z0-9_.:@-]{1,200}$`)

// recDir is one recording: every stream it holds lives underneath. Deletion and
// retention work at this level, so erasing a recording erases its keystrokes too.
func (s *recStore) recDir(tenantID, recordingKey string) (string, error) {
	if !safeSegment.MatchString(tenantID) || strings.Contains(tenantID, "..") {
		return "", fmt.Errorf("invalid tenant id")
	}
	if !safeSegment.MatchString(recordingKey) || strings.Contains(recordingKey, "..") {
		return "", fmt.Errorf("invalid recording key")
	}
	return filepath.Join(s.root, tenantID, recordingKey), nil
}

// dir is one stream of one recording. format is validated like the other segments
// because it arrives over the tunnel untrusted.
func (s *recStore) dir(tenantID, recordingKey, format string) (string, error) {
	base, err := s.recDir(tenantID, recordingKey)
	if err != nil {
		return "", err
	}
	if !safeSegment.MatchString(format) || strings.Contains(format, "..") {
		return "", fmt.Errorf("invalid format")
	}
	return filepath.Join(base, format), nil
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
//
// Every stream but video is compressed before it is sealed (see compressible):
// a guac instruction stream is text and base64 images, rrweb and keystrokes are
// JSON, and stored raw they took 2-10 times the disk they need. A compressed
// chunk is <seq>-<plain length>.zst; a raw one <seq>.bin. Writing either removes
// the other for the same seq, so a rewrite never leaves two answers for it.
func (s *recStore) Append(tenantID, recordingKey, format string, seq int, plain []byte) (int, error) {
	d, err := s.dir(tenantID, recordingKey, format)
	if err != nil {
		return 0, err
	}
	// An erased recording stays erased: a writer that was still going (a session
	// ending, a copy in progress on another connector) must not bring it back.
	if s.erased(tenantID, recordingKey) {
		return 0, errErased
	}
	if err := os.MkdirAll(d, 0o700); err != nil {
		return 0, err
	}
	if err := s.writeChunk(d, seq, plain, compressible(format)); err != nil {
		return 0, err
	}
	return len(plain), nil
}

// compressible reports whether a stream's chunks are worth compressing. Video is
// already compressed by its codec, and its chunks are addressed by byte range,
// which needs their plaintext sizes from the file sizes alone.
func compressible(format string) bool { return format != "video" }

// writeChunk seals plain (compressed when asked and when that saves space) into
// dir as chunk seq, replacing whatever that seq held.
func (s *recStore) writeChunk(dir string, seq int, plain []byte, compress bool) error {
	name := strconv.Itoa(seq) + ".bin"
	body := plain
	if compress && len(plain) > 0 {
		if z := zstdEncoder.EncodeAll(plain, nil); len(z) < len(plain) {
			name = strconv.Itoa(seq) + "-" + strconv.Itoa(len(plain)) + ".zst"
			body = z
		}
	}
	sealed, err := s.seal(body)
	if err != nil {
		return err
	}
	if err := writeFileAtomic(filepath.Join(dir, name), sealed); err != nil {
		return err
	}
	// The other spelling of this seq, if any, is now stale.
	if refs, err := chunkFiles(dir); err == nil {
		for _, c := range refs.all {
			if c.seq == seq && filepath.Base(c.path) != name {
				_ = os.Remove(c.path)
			}
		}
	}
	return nil
}

// writeFileAtomic writes through a temporary name and renames, so a reader never
// sees half a chunk and a crash never leaves one.
func writeFileAtomic(path string, data []byte) error {
	tmp := filepath.Join(filepath.Dir(path), "."+filepath.Base(path)+".tmp")
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// openChunk decrypts one chunk file and, for a compressed one, inflates it.
func (s *recStore) openChunk(c chunkRef) ([]byte, error) {
	sealed, err := os.ReadFile(c.path)
	if err != nil {
		return nil, err
	}
	plain, err := s.open(sealed)
	if err != nil {
		return nil, err
	}
	if !c.compressed {
		return plain, nil
	}
	return zstdDecoder.DecodeAll(plain, make([]byte, 0, c.plain))
}

// Read returns the decrypted chunks from fromSeq onward, in sequence order. A chunk
// that fails to decrypt is skipped rather than failing the whole read: one corrupt
// chunk must not make an otherwise good recording unplayable.
func (s *recStore) Read(tenantID, recordingKey, format string, fromSeq int) ([]recChunk, error) {
	idx, err := s.index(tenantID, recordingKey, format)
	if err != nil {
		return nil, err
	}
	var out []recChunk
	for _, c := range idx {
		if c.seq < fromSeq {
			continue
		}
		plain, err := s.openChunk(c)
		if err != nil {
			continue
		}
		out = append(out, recChunk{Seq: c.seq, Data: plain})
	}
	return out, nil
}

// EachChunk hands a stream's decrypted chunks to fn in order, one at a time, so a
// long recording is never held in memory whole. A chunk that does not open is
// skipped, as in Read.
func (s *recStore) EachChunk(tenantID, recordingKey, format string, fromSeq int, fn func([]byte) error) error {
	idx, err := s.index(tenantID, recordingKey, format)
	if err != nil {
		return err
	}
	for _, c := range idx {
		if c.seq < fromSeq {
			continue
		}
		plain, err := s.openChunk(c)
		if err != nil {
			continue
		}
		if err := fn(plain); err != nil {
			return err
		}
	}
	return nil
}

// NoteProtocol remembers which protocol a guac stream records (ssh, rdp, ...),
// once, beside its chunks: the maintenance worker turns graphical sessions into
// video and leaves terminal ones as they are.
func (s *recStore) NoteProtocol(tenantID, recordingKey, format, protocol string) {
	if format != "guac" || !safeSegment.MatchString(protocol) {
		return
	}
	d, err := s.dir(tenantID, recordingKey, format)
	if err != nil {
		return
	}
	p := filepath.Join(d, ".protocol")
	if _, err := os.Stat(p); err == nil {
		return
	}
	_ = os.WriteFile(p, []byte(strings.ToLower(protocol)), 0o600)
}

// Formats lists the streams a recording holds, e.g. ["guac", "keys"]. It replaces
// the former single "format" sidecar file, which could only name one stream and was
// overwritten by whichever writer flushed last. Search uses this to find the
// keystroke stream; a recording with no keystroke stream is simply skipped.
func (s *recStore) Formats(tenantID, recordingKey string) []string {
	d, err := s.recDir(tenantID, recordingKey)
	if err != nil {
		return nil
	}
	entries, err := os.ReadDir(d)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		// A leading dot is work in progress (recmaint.go), not a stream yet.
		if e.IsDir() && !strings.HasPrefix(e.Name(), ".") {
			out = append(out, e.Name())
		}
	}
	sort.Strings(out)
	return out
}

// TotalPlaintextBytes reports the length of the concatenated plaintext -- what a
// player actually receives. It is NOT the on-disk size: every chunk carries a nonce
// and a GCM tag, so the sealed total is larger and using it would put a wrong
// Content-Length on every Range response.
func (s *recStore) TotalPlaintextBytes(tenantID, recordingKey, format string) (int64, error) {
	idx, err := s.index(tenantID, recordingKey, format)
	if err != nil {
		return 0, err
	}
	var total int64
	for _, c := range idx {
		total += c.plain
	}
	return total, nil
}

// sealOverhead is what seal adds to every chunk: a GCM nonce and tag.
const sealOverhead = 12 + 16

type chunkRef struct {
	seq        int
	path       string
	plain      int64
	compressed bool
	sealed     int64
}

// chunkSet is one stream directory's chunk files: all of them, and the one that
// answers for each seq.
type chunkSet struct {
	all    []chunkRef
	byPlay []chunkRef // one per seq, in order
}

// chunkFiles lists a stream directory's chunks with their plaintext sizes, taken
// from the file names and sizes: answering "how long is it" and "where is byte N"
// must not mean decrypting the whole recording, which a player scrubbing a long
// video asks for on every Range request. A seq present in both spellings (a
// rewrite interrupted between its two steps) is answered by the compressed one,
// which is written first.
func chunkFiles(dir string) (chunkSet, error) {
	var set chunkSet
	entries, err := os.ReadDir(dir)
	if err != nil {
		return set, err
	}
	bySeq := map[int]chunkRef{}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || strings.HasPrefix(name, ".") {
			continue
		}
		info, err := e.Info()
		if err != nil || info.Size() < sealOverhead {
			continue
		}
		c := chunkRef{path: filepath.Join(dir, name), sealed: info.Size()}
		switch {
		case strings.HasSuffix(name, ".bin"):
			seq, err := strconv.Atoi(strings.TrimSuffix(name, ".bin"))
			if err != nil {
				continue
			}
			c.seq, c.plain = seq, info.Size()-sealOverhead
		case strings.HasSuffix(name, ".zst"):
			seqStr, lenStr, ok := strings.Cut(strings.TrimSuffix(name, ".zst"), "-")
			seq, err1 := strconv.Atoi(seqStr)
			n, err2 := strconv.ParseInt(lenStr, 10, 64)
			if !ok || err1 != nil || err2 != nil || n < 0 {
				continue
			}
			c.seq, c.plain, c.compressed = seq, n, true
		default:
			continue
		}
		set.all = append(set.all, c)
		if prev, seen := bySeq[c.seq]; !seen || (c.compressed && !prev.compressed) {
			bySeq[c.seq] = c
		}
	}
	for _, c := range bySeq {
		set.byPlay = append(set.byPlay, c)
	}
	sort.Slice(set.byPlay, func(i, j int) bool { return set.byPlay[i].seq < set.byPlay[j].seq })
	return set, nil
}

// index lists a stream's chunks in order, one per seq, with their plaintext sizes.
func (s *recStore) index(tenantID, recordingKey, format string) ([]chunkRef, error) {
	d, err := s.dir(tenantID, recordingKey, format)
	if err != nil {
		return nil, err
	}
	set, err := chunkFiles(d)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	return set.byPlay, nil
}

// ReadRange returns the plaintext bytes from..to INCLUSIVE, measured over the
// concatenated recording, mapping the request onto whichever chunks it spans. `to`
// beyond the end is clamped rather than refused: an open-ended HTTP Range is normal
// and erroring on it would surface as a broken video.
func (s *recStore) ReadRange(tenantID, recordingKey, format string, from, to int64) ([]byte, error) {
	if from < 0 || to < from {
		return nil, fmt.Errorf("invalid range")
	}
	idx, err := s.index(tenantID, recordingKey, format)
	if err != nil {
		return nil, err
	}
	var out []byte
	var offset int64
	for _, c := range idx {
		start := offset
		end := offset + c.plain - 1 // inclusive
		offset += c.plain
		if end < from || c.plain == 0 {
			continue // wholly before the range
		}
		if start > to {
			break // wholly after it; chunks are in order
		}
		if _, err := os.Stat(c.path); err != nil {
			return nil, err
		}
		plain, err := s.openChunk(c)
		if err != nil || int64(len(plain)) != c.plain {
			// A chunk that does not open still holds its place: zeros of its
			// length keep every later byte where the total said it was, and a
			// video decoder skips them. One bad chunk must not make the rest of
			// the recording unreachable.
			plain = make([]byte, c.plain)
		}
		lo := int64(0)
		if from > start {
			lo = from - start
		}
		hi := int64(len(plain)) - 1
		if to < end {
			hi = to - start
		}
		out = append(out, plain[lo:hi+1]...)
	}
	return out, nil
}

// Bytes reports what the disk actually holds for one recording (sealed sizes),
// summed across every stream it holds.
func (s *recStore) Bytes(tenantID, recordingKey string) (int64, error) {
	d, err := s.recDir(tenantID, recordingKey)
	if err != nil {
		return 0, err
	}
	streams, err := os.ReadDir(d)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return 0, nil
		}
		return 0, err
	}
	var total int64
	for _, sd := range streams {
		if !sd.IsDir() || strings.HasPrefix(sd.Name(), ".") {
			continue
		}
		set, err := chunkFiles(filepath.Join(d, sd.Name()))
		if err != nil {
			continue
		}
		for _, c := range set.all {
			total += c.sealed
		}
	}
	return total, nil
}

// Delete removes one recording and everything under it. An already-absent recording
// is not an error: the caller's goal is "these bytes are gone", which already holds.
func (s *recStore) Delete(tenantID, recordingKey string) error {
	d, err := s.recDir(tenantID, recordingKey)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.RemoveAll(d); err != nil {
		return err
	}
	s.tombstone(tenantID, recordingKey)
	return nil
}

// Purge removes every recording for a tenant whose directory was last modified
// before olderThan, and reports how many it removed. The connector owns the files,
// so it owns retention.
func (s *recStore) Purge(tenantID string, olderThan time.Time) (int, error) {
	if !safeSegment.MatchString(tenantID) {
		return 0, fmt.Errorf("invalid tenant id")
	}
	base := filepath.Join(s.root, tenantID)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepTombstones(tenantID, time.Now())
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
	d, err := s.recDir(tenantID, recordingKey)
	if err != nil {
		return err
	}
	return os.Chtimes(d, t, t)
}

// errErased is what writing to an erased recording answers.
var errErased = errors.New("recording erased")

// tombstoneKeep is how long the record of an erasure is kept. A late writer is
// seconds to minutes behind, not months.
const tombstoneKeep = 90 * 24 * time.Hour

func (s *recStore) tombstonePath(tenantID, recordingKey string) string {
	return filepath.Join(s.root, ".erased", tenantID, recordingKey)
}

// tombstone records that a recording was erased on purpose (an administrator's
// request), as an empty file outside the recording's own directory.
func (s *recStore) tombstone(tenantID, recordingKey string) {
	p := s.tombstonePath(tenantID, recordingKey)
	if os.MkdirAll(filepath.Dir(p), 0o700) != nil {
		return
	}
	_ = os.WriteFile(p, nil, 0o600)
}

// erased reports whether the recording was erased on purpose.
func (s *recStore) erased(tenantID, recordingKey string) bool {
	_, err := os.Stat(s.tombstonePath(tenantID, recordingKey))
	return err == nil
}

// sweepTombstones forgets erasures older than tombstoneKeep.
func (s *recStore) sweepTombstones(tenantID string, now time.Time) {
	dir := filepath.Join(s.root, ".erased", tenantID)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if info, err := e.Info(); err == nil && now.Sub(info.ModTime()) > tombstoneKeep {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}
