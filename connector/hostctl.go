package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"sync/atomic"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// The connector's side of updates and removal from the console. The connector
// has no Docker access and must not get any: it takes orders from the network.
// The updater beside it (updater/) has Docker and takes nothing from the
// network; the two meet in the hostctl volume (tunnel.HostRequestFile and
// friends). A connector started without that volume, or without an updater,
// refuses every host action and the console shows the manual command instead.

var hostctlDir = envOr("HOSTCTL_DIR", "/hostctl")

// An updater heartbeat older than this means no updater (stopped, removed, or
// never installed).
const updaterBeatMaxAge = 90 * time.Second

// waitIdle: how long no tunnel may have been open before a held update is
// released to the updater.
const idleFor = 30 * time.Second

var (
	hostctlMu      sync.Mutex
	idleSince      time.Time // zero: not idle, or not yet seen idle
	hostVersionRe  = regexp.MustCompile(`^\d+\.\d+\.\d+$`)
	hostIDRe       = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)
	activeOverride atomic.Pointer[func() int] // tests
)

func hostctlPath(name string) string { return filepath.Join(hostctlDir, name) }

func readJSONFile(name string, v any) bool {
	b, err := os.ReadFile(hostctlPath(name))
	if err != nil {
		return false
	}
	return json.Unmarshal(b, v) == nil
}

// writeJSONFile replaces a hostctl file atomically: the updater may read it at
// any moment and must never see half of it.
func writeJSONFile(name string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	tmp := hostctlPath("." + name + ".tmp")
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, hostctlPath(name))
}

func hostctlAvailable() bool {
	st, err := os.Stat(hostctlDir)
	return err == nil && st.IsDir()
}

// updaterInfo is the updater's heartbeat when it is fresh, nil otherwise.
func updaterInfo(now time.Time) *tunnel.UpdaterInfo {
	if !hostctlAvailable() {
		return nil
	}
	var beat tunnel.UpdaterBeat
	if !readJSONFile(tunnel.UpdaterBeatFile, &beat) {
		return nil
	}
	at, err := time.Parse(time.RFC3339, beat.At)
	if err != nil || now.Sub(at) > updaterBeatMaxAge || at.Sub(now) > updaterBeatMaxAge {
		return nil
	}
	return &tunnel.UpdaterInfo{Version: beat.Version, DockerOK: beat.DockerOK, HostIP: beat.HostIP}
}

// hostActionStatus is what the console shows: an update still held for idle,
// otherwise the updater's own status.
func hostActionStatus() *tunnel.HostActionStatus {
	if !hostctlAvailable() {
		return nil
	}
	var req tunnel.HostRequest
	if readJSONFile(tunnel.HostRequestFile, &req) && !req.Ready {
		return &tunnel.HostActionStatus{ID: req.ID, Action: req.Action, State: "waiting_idle", Version: req.Version, At: req.At}
	}
	var st tunnel.HostActionStatus
	if readJSONFile(tunnel.HostStatusFile, &st) && st.ID != "" {
		return &st
	}
	return nil
}

// markConnected tells the updater this version is up and the data-plane took
// its tunnel. Best-effort: without the volume there is no updater to tell.
func markConnected() {
	if !hostctlAvailable() {
		return
	}
	if err := writeJSONFile(tunnel.ConnectorMarkFile, tunnel.ConnectorMark{Version: Version, At: time.Now().UTC().Format(time.RFC3339)}); err != nil {
		logWarn("hostctl: could not write the connector mark: %v", err)
	}
}

// applyHostAction hands a console request to the updater and says whether it
// was taken. Running it is the updater's business; its progress comes back
// through hostActionStatus.
func applyHostAction(a tunnel.HostAction, now time.Time) tunnel.HostActionAck {
	ack := tunnel.HostActionAck{Kind: "hostactionack", ID: a.ID}
	fail := func(code string) tunnel.HostActionAck { ack.Error = code; return ack }
	if !hostIDRe.MatchString(a.ID) {
		return fail("invalid")
	}
	if !hostctlAvailable() {
		return fail("no_hostctl")
	}
	hostctlMu.Lock()
	defer hostctlMu.Unlock()

	var cur tunnel.HostRequest
	hasReq := readJSONFile(tunnel.HostRequestFile, &cur)
	var st tunnel.HostActionStatus
	readJSONFile(tunnel.HostStatusFile, &st)
	// A request the updater has taken but not finished (status not yet terminal
	// for that id) must not be replaced under it.
	running := hasReq && cur.Ready && !(st.ID == cur.ID && hostStateFinal(st.State))

	switch a.Action {
	case "cancel":
		if !hasReq || cur.Ready || (a.ID != cur.ID) {
			return fail("not_pending")
		}
		if err := os.Remove(hostctlPath(tunnel.HostRequestFile)); err != nil {
			return fail("write_failed")
		}
		logInfo("hostctl: held update %s cancelled from the console", cur.ID)
		return ack
	case "update":
		if !hostVersionRe.MatchString(a.Version) {
			return fail("invalid")
		}
	case "uninstall":
	default:
		return fail("invalid")
	}
	if updaterInfo(now) == nil {
		return fail("no_updater")
	}
	if running {
		return fail("busy")
	}
	req := tunnel.HostRequest{ID: a.ID, Action: a.Action, Version: a.Version, KeepData: a.KeepData, Ready: !a.WaitIdle || a.Action != "update", At: now.UTC().Format(time.RFC3339)}
	if err := writeJSONFile(tunnel.HostRequestFile, req); err != nil {
		logWarn("hostctl: could not hand over %s: %v", a.Action, err)
		return fail("write_failed")
	}
	idleSince = time.Time{}
	if req.Ready {
		logInfo("hostctl: %s %s handed to the updater (%s)", a.Action, a.Version, a.ID)
	} else {
		logInfo("hostctl: update %s held until the connector is idle (%s)", a.Version, a.ID)
	}
	return ack
}

func hostStateFinal(s string) bool {
	return s == "done" || s == "rolled_back" || s == "failed"
}

func activeNow() int {
	if f := activeOverride.Load(); f != nil {
		return (*f)()
	}
	return int(atomic.LoadInt64(&statActive))
}

// releaseIfIdle runs on every telemetry tick: an update held for idle goes to
// the updater once no tunnel has been open for idleFor. The request lives in
// the volume, so a connector restart keeps waiting.
func releaseIfIdle(now time.Time) {
	if !hostctlAvailable() {
		return
	}
	hostctlMu.Lock()
	defer hostctlMu.Unlock()
	var req tunnel.HostRequest
	if !readJSONFile(tunnel.HostRequestFile, &req) || req.Ready || activeNow() > 0 {
		idleSince = time.Time{}
		return
	}
	if idleSince.IsZero() {
		idleSince = now
	}
	if now.Sub(idleSince) < idleFor {
		return
	}
	req.Ready = true
	req.At = now.UTC().Format(time.RFC3339)
	if err := writeJSONFile(tunnel.HostRequestFile, req); err != nil {
		logWarn("hostctl: could not release the held update: %v", err)
		return
	}
	idleSince = time.Time{}
	logInfo("hostctl: connector idle, update %s handed to the updater (%s)", req.Version, req.ID)
}
