package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// A log file that keeps itself small: when it passes max bytes it becomes
// name.1 (name.1 becomes name.2, ...), keeping the newest keep files. A
// Windows service has no stderr to read, so it logs here.
type rotatingFile struct {
	mu   sync.Mutex
	path string
	max  int64
	keep int
	f    *os.File
	size int64
}

func openRotatingFile(path string, max int64, keep int) (*rotatingFile, error) {
	r := &rotatingFile{path: path, max: max, keep: keep}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	return r, r.open()
}

func (r *rotatingFile) open() error {
	f, err := os.OpenFile(r.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o640)
	if err != nil {
		return err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	r.f, r.size = f, st.Size()
	return nil
}

func (r *rotatingFile) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.size+int64(len(p)) > r.max && r.size > 0 {
		r.f.Close()
		for i := r.keep - 1; i >= 1; i-- {
			_ = os.Rename(fmt.Sprintf("%s.%d", r.path, i), fmt.Sprintf("%s.%d", r.path, i+1))
		}
		_ = os.Rename(r.path, r.path+".1")
		if err := r.open(); err != nil {
			return 0, err
		}
	}
	n, err := r.f.Write(p)
	r.size += int64(n)
	return n, err
}
