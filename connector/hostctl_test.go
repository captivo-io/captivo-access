package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

func withHostctl(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	prev := hostctlDir
	hostctlDir = dir
	idleSince = time.Time{}
	t.Cleanup(func() { hostctlDir = prev; activeOverride.Store(nil) })
	return dir
}

func writeBeat(t *testing.T, dir string, at time.Time) {
	t.Helper()
	b, _ := json.Marshal(tunnel.UpdaterBeat{Version: "2.41.0", DockerOK: true, At: at.UTC().Format(time.RFC3339)})
	if err := os.WriteFile(filepath.Join(dir, tunnel.UpdaterBeatFile), b, 0o644); err != nil {
		t.Fatal(err)
	}
}

func readReq(t *testing.T, dir string) (tunnel.HostRequest, bool) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, tunnel.HostRequestFile))
	if err != nil {
		return tunnel.HostRequest{}, false
	}
	var r tunnel.HostRequest
	if err := json.Unmarshal(b, &r); err != nil {
		t.Fatal(err)
	}
	return r, true
}

func setActive(n int) {
	f := func() int { return n }
	activeOverride.Store(&f)
}

const testID = "act_0123456789"

func TestHostAction_RefusedWithoutVolumeOrUpdater(t *testing.T) {
	prev := hostctlDir
	hostctlDir = filepath.Join(t.TempDir(), "missing")
	defer func() { hostctlDir = prev }()
	now := time.Now()
	if a := applyHostAction(tunnel.HostAction{ID: testID, Action: "update", Version: "2.41.0"}, now); a.Error != "no_hostctl" {
		t.Fatalf("no volume: %+v", a)
	}

	dir := withHostctl(t)
	if a := applyHostAction(tunnel.HostAction{ID: testID, Action: "update", Version: "2.41.0"}, now); a.Error != "no_updater" {
		t.Fatalf("no heartbeat: %+v", a)
	}
	writeBeat(t, dir, now.Add(-2*time.Minute))
	if a := applyHostAction(tunnel.HostAction{ID: testID, Action: "update", Version: "2.41.0"}, now); a.Error != "no_updater" {
		t.Fatalf("stale heartbeat: %+v", a)
	}
	if updaterInfo(now) != nil {
		t.Fatal("stale heartbeat reported as an updater")
	}
	if _, ok := readReq(t, dir); ok {
		t.Fatal("a refused action left a request behind")
	}
}

func TestHostAction_RejectsAnythingButAVersion(t *testing.T) {
	dir := withHostctl(t)
	now := time.Now()
	writeBeat(t, dir, now)
	for _, a := range []tunnel.HostAction{
		{ID: testID, Action: "update", Version: "latest"},
		{ID: testID, Action: "update", Version: "2.41.0; rm -rf /"},
		{ID: testID, Action: "update", Version: ""},
		{ID: testID, Action: "exec", Version: "2.41.0"},
		{ID: "x", Action: "update", Version: "2.41.0"},
		{ID: "../../etc/passwd", Action: "update", Version: "2.41.0"},
	} {
		if ack := applyHostAction(a, now); ack.Error != "invalid" {
			t.Errorf("%+v: got %+v, want invalid", a, ack)
		}
	}
	if _, ok := readReq(t, dir); ok {
		t.Fatal("an invalid action left a request behind")
	}
}

func TestHostAction_UpdateHandedOver(t *testing.T) {
	dir := withHostctl(t)
	now := time.Now()
	writeBeat(t, dir, now)
	if u := updaterInfo(now); u == nil || u.Version != "2.41.0" || !u.DockerOK {
		t.Fatalf("updater info: %+v", u)
	}
	ack := applyHostAction(tunnel.HostAction{Kind: "hostaction", ID: testID, Action: "update", Version: "2.41.0"}, now)
	if ack.Error != "" || ack.ID != testID || ack.Kind != "hostactionack" {
		t.Fatalf("ack: %+v", ack)
	}
	r, ok := readReq(t, dir)
	if !ok || !r.Ready || r.Version != "2.41.0" || r.Action != "update" {
		t.Fatalf("request: %+v", r)
	}
	// The updater has it and has not finished: a second one must wait.
	if a := applyHostAction(tunnel.HostAction{ID: "act_second_one", Action: "uninstall"}, now); a.Error != "busy" {
		t.Fatalf("second while running: %+v", a)
	}
	st, _ := json.Marshal(tunnel.HostActionStatus{ID: testID, Action: "update", State: "done"})
	_ = os.WriteFile(filepath.Join(dir, tunnel.HostStatusFile), st, 0o644)
	if a := applyHostAction(tunnel.HostAction{ID: "act_second_one", Action: "uninstall", KeepData: true}, now); a.Error != "" {
		t.Fatalf("after the first finished: %+v", a)
	}
	if r, _ := readReq(t, dir); r.Action != "uninstall" || !r.KeepData || !r.Ready {
		t.Fatalf("uninstall request: %+v", r)
	}
	if s := hostActionStatus(); s == nil || s.ID != testID || s.State != "done" {
		t.Fatalf("status: %+v", s)
	}
}

func TestHostAction_WaitIdle(t *testing.T) {
	dir := withHostctl(t)
	now := time.Now()
	writeBeat(t, dir, now)
	if a := applyHostAction(tunnel.HostAction{ID: testID, Action: "update", Version: "2.41.0", WaitIdle: true}, now); a.Error != "" {
		t.Fatalf("ack: %+v", a)
	}
	if r, _ := readReq(t, dir); r.Ready {
		t.Fatal("a held update was released at once")
	}
	if s := hostActionStatus(); s == nil || s.State != "waiting_idle" || s.ID != testID {
		t.Fatalf("status while held: %+v", s)
	}

	setActive(2)
	releaseIfIdle(now)
	releaseIfIdle(now.Add(time.Minute))
	if r, _ := readReq(t, dir); r.Ready {
		t.Fatal("released with tunnels open")
	}
	setActive(0)
	releaseIfIdle(now.Add(2 * time.Minute))
	releaseIfIdle(now.Add(2*time.Minute + 20*time.Second))
	if r, _ := readReq(t, dir); r.Ready {
		t.Fatal("released before idleFor")
	}
	setActive(1) // a session starts: the clock starts over
	releaseIfIdle(now.Add(2*time.Minute + 25*time.Second))
	setActive(0)
	releaseIfIdle(now.Add(2*time.Minute + 30*time.Second))
	releaseIfIdle(now.Add(2*time.Minute + 50*time.Second))
	if r, _ := readReq(t, dir); r.Ready {
		t.Fatal("idle clock did not restart after a session")
	}
	releaseIfIdle(now.Add(3*time.Minute + 5*time.Second))
	if r, _ := readReq(t, dir); !r.Ready {
		t.Fatal("not released after idleFor")
	}
}

func TestHostAction_CancelOnlyAHeldUpdate(t *testing.T) {
	dir := withHostctl(t)
	now := time.Now()
	writeBeat(t, dir, now)
	if a := applyHostAction(tunnel.HostAction{ID: testID, Action: "cancel"}, now); a.Error != "not_pending" {
		t.Fatalf("cancel with nothing held: %+v", a)
	}
	applyHostAction(tunnel.HostAction{ID: testID, Action: "update", Version: "2.41.0", WaitIdle: true}, now)
	if a := applyHostAction(tunnel.HostAction{ID: "act_other_one", Action: "cancel"}, now); a.Error != "not_pending" {
		t.Fatalf("cancel of another id: %+v", a)
	}
	if a := applyHostAction(tunnel.HostAction{ID: testID, Action: "cancel"}, now); a.Error != "" {
		t.Fatalf("cancel: %+v", a)
	}
	if _, ok := readReq(t, dir); ok {
		t.Fatal("request still there after cancel")
	}
	applyHostAction(tunnel.HostAction{ID: testID, Action: "update", Version: "2.41.0"}, now)
	if a := applyHostAction(tunnel.HostAction{ID: testID, Action: "cancel"}, now); a.Error != "not_pending" {
		t.Fatalf("cancel after hand-over: %+v", a)
	}
}

func TestMarkConnected(t *testing.T) {
	dir := withHostctl(t)
	markConnected()
	var m tunnel.ConnectorMark
	b, err := os.ReadFile(filepath.Join(dir, tunnel.ConnectorMarkFile))
	if err != nil || json.Unmarshal(b, &m) != nil || m.Version != Version || m.At == "" {
		t.Fatalf("mark: %s %v", b, err)
	}
}
