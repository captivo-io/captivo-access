package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// The journal of administrator rights this connector has given and not yet
// taken away (elevations.json in the data directory). It holds the seal of the
// administrator account, which opens only with this connector's vault key, so
// a connector that stops mid-session finishes the job when it starts: nothing
// stays an administrator because a process died.

type journalEntry struct {
	Key      string                 `json:"key"`
	Platform string                 `json:"platform"`
	Host     string                 `json:"host"`
	Port     string                 `json:"port"`
	Account  string                 `json:"account"`
	Admin    tunnel.RotateReconcile `json:"admin"`
	Pinned   string                 `json:"pinned,omitempty"`
	At       time.Time              `json:"at"`
}

var journal struct {
	sync.Mutex
	path string
}

func journalFile() string {
	if journal.path != "" {
		return journal.path
	}
	return dataPath("elevations.json")
}

func journalRead() []journalEntry {
	b, err := os.ReadFile(journalFile())
	if err != nil {
		return nil
	}
	var out []journalEntry
	_ = json.Unmarshal(b, &out)
	return out
}

func journalWrite(es []journalEntry) error {
	if len(es) == 0 {
		err := os.Remove(journalFile())
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	b, _ := json.Marshal(es)
	if err := os.MkdirAll(filepath.Dir(journalFile()), 0o700); err != nil {
		return err
	}
	tmp := journalFile() + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, journalFile())
}

func journalAdd(sp elevSpec) error {
	journal.Lock()
	defer journal.Unlock()
	es := journalRead()
	for _, e := range es {
		if e.Key == sp.key() {
			return nil
		}
	}
	return journalWrite(append(es, journalEntry{Key: sp.key(), Platform: sp.platform, Host: sp.host, Port: sp.port, Account: sp.account, Admin: *sp.admin, Pinned: sp.pinned, At: time.Now()}))
}

func journalDone(key string) {
	journal.Lock()
	defer journal.Unlock()
	var keep []journalEntry
	for _, e := range journalRead() {
		if e.Key != key {
			keep = append(keep, e)
		}
	}
	_ = journalWrite(keep)
}

// recoverElevations takes away whatever a stopped connector left. It tries
// again every two minutes while something is left (the server may be down
// too), for up to a day.
func recoverElevations(allow *TargetMatcher) {
	for i := 0; i < 720; i++ {
		left := 0
		for _, e := range journalRead() {
			elevations.Lock()
			live := elevations.n[e.Key] > 0 // a session since this start owns it now
			elevations.Unlock()
			if live {
				continue
			}
			admin := e.Admin
			ops, _, err := elevSpec{platform: e.Platform, host: e.Host, port: e.Port, account: e.Account, admin: &admin, pinned: e.Pinned}.ops(allow)
			if err == nil {
				ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				err = ops.revoke(ctx)
				cancel()
			}
			if err != nil {
				logWarn("could not take away the administrator rights left on %s: %v", e.Key, err)
				left++
				continue
			}
			logInfo("took away the administrator rights a stopped connector left on %s", e.Key)
			journalDone(e.Key)
		}
		if left == 0 {
			return
		}
		time.Sleep(2 * time.Minute)
	}
}
