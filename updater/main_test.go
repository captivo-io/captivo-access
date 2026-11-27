package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// fakeDocker answers like the docker CLI for what the updater asks, and logs
// every call (one per line) to $FAKE_LOG.
const fakeDocker = `#!/bin/sh
echo "$*" >> "$FAKE_LOG"
case "$1" in
version) echo 27.0.0 ;;
inspect)
  case "$*" in
    *"{{json .Config}} access-connector"*) echo '{"Hostname":"host-1","Env":["PATH=/bin","MANAGER_URL=https://m.example","DATAPLANE_URL=wss://d.example","HOST_IP=10.0.0.5 ","HOST_OS=\"Debian 13\"","PAIR_CODE=old"]}' ;;
    *"{{.State.Running}} captivo-updater-run"*) [ -f "$FAKE_DIR/runner" ] && echo true || exit 1 ;;
    *"{{.Image}} captivo-kasm"*) [ -f "$FAKE_DIR/nokasm" ] && exit 1 || echo sha256:kasm ;;
    *"{{.Image}} "*) echo "sha256:${4}" ;;
    *) exit 1 ;;
  esac ;;
run) case "$*" in *"--network host"*) [ -f "$FAKE_DIR/noroute" ] && exit 1; echo "192.0.2.1 via 192.168.1.1 dev eth0 src 192.168.1.77 uid 0" ;; esac ;;
pull) case "$2" in *"$FAIL_PULL"*) [ -n "$FAIL_PULL" ] && { echo "manifest unknown" >&2; exit 1; } ;; esac ;;
image)
  case "$2" in
    inspect) case "$3" in *"$FAIL_INSPECT"*) [ -n "$FAIL_INSPECT" ] && exit 1 ;; esac ;;
  esac ;;
esac
exit 0
`

type rig struct {
	t   *testing.T
	u   *updater
	dir string
	log string
	now time.Time
}

func newRig(t *testing.T) *rig {
	t.Helper()
	base := t.TempDir()
	dir := filepath.Join(base, "hostctl")
	_ = os.Mkdir(dir, 0o755)
	bin := filepath.Join(base, "docker")
	if err := os.WriteFile(bin, []byte(fakeDocker), 0o755); err != nil {
		t.Fatal(err)
	}
	r := &rig{t: t, dir: dir, log: filepath.Join(base, "calls.log"), now: time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)}
	t.Setenv("FAKE_LOG", r.log)
	t.Setenv("FAKE_DIR", base)
	t.Setenv("FAIL_PULL", "")
	t.Setenv("FAIL_INSPECT", "")
	r.u = &updater{dir: dir, docker: bin, now: func() time.Time { return r.now }, self: image("updater", "2.41.0")}
	return r
}

func (r *rig) put(name string, v any) {
	b, _ := json.Marshal(v)
	if err := os.WriteFile(filepath.Join(r.dir, name), b, 0o644); err != nil {
		r.t.Fatal(err)
	}
}

func (r *rig) status() tunnel.HostActionStatus {
	var st tunnel.HostActionStatus
	r.u.read(tunnel.HostStatusFile, &st)
	return st
}

func (r *rig) calls() string {
	b, _ := os.ReadFile(r.log)
	return string(b)
}

func (r *rig) resetCalls() { _ = os.Remove(r.log) }

func (r *rig) mark(version string) {
	r.put(tunnel.ConnectorMarkFile, tunnel.ConnectorMark{Version: version, At: r.now.UTC().Format(time.RFC3339)})
}

func (r *rig) request(req tunnel.HostRequest) {
	req.At = r.now.Format(time.RFC3339)
	r.put(tunnel.HostRequestFile, req)
}

const id = "act_0123456789"

func TestUpdate_HappyPath(t *testing.T) {
	r := newRig(t)
	r.mark("2.40.0")
	r.request(tunnel.HostRequest{ID: id, Action: "update", Version: "2.41.0", Ready: true})
	r.u.step()

	st := r.status()
	if st.State != "applying" || st.From != "2.40.0" || st.Version != "2.41.0" {
		t.Fatalf("status %+v", st)
	}
	calls := r.calls()
	for _, want := range []string{
		"pull " + image("connector", "2.41.0"),
		"pull " + image("guacd", "2.41.0"),
		"pull " + image("kasm-browser", "2.41.0"),
		"pull " + image("updater", "2.41.0"),
		"tag sha256:access-connector " + image("connector", "rollback"),
		"tag sha256:captivo-guacd " + image("guacd", "rollback"),
		"tag sha256:kasm " + image("kasm-browser", "rollback"),
		"-e MANAGER_URL=https://m.example",
		"-e DATAPLANE_URL=wss://d.example",
		"-e HOST_NAME=host-1",
		`-e HOST_OS="Debian 13"`,
		"-e CONNECTOR_IMAGE=" + image("connector", "2.41.0"),
		"--entrypoint /bin/sh " + image("updater", "2.41.0") + " /usr/local/bin/recipe.sh update",
		"--network none -v /var/run/docker.sock:/var/run/docker.sock",
	} {
		if !strings.Contains(calls, want) {
			t.Errorf("missing %q in\n%s", want, calls)
		}
	}
	if strings.Contains(calls, "PAIR_CODE") {
		t.Error("the old pair code was carried into the new connector")
	}
	// Every pull comes before the first change.
	if strings.LastIndex(calls, "pull ") > strings.Index(calls, "tag ") || strings.Index(calls, "run -d") < strings.LastIndex(calls, "tag ") {
		t.Errorf("order:\n%s", calls)
	}

	// Not connected yet: nothing happens.
	r.now = r.now.Add(time.Minute)
	r.resetCalls()
	r.u.step()
	if r.status().State != "applying" {
		t.Fatalf("status %+v", r.status())
	}
	// The old version reconnecting does not count.
	r.mark("2.40.0")
	r.u.step()
	if r.status().State != "applying" {
		t.Fatalf("old version counted: %+v", r.status())
	}
	r.mark("2.41.0")
	r.u.step()
	if st := r.status(); st.State != "done" {
		t.Fatalf("status %+v", st)
	}
	if !strings.Contains(r.calls(), "image rm "+image("connector", "rollback")) {
		t.Errorf("rollback tags kept:\n%s", r.calls())
	}
	// Done is done.
	r.resetCalls()
	r.u.step()
	if strings.Contains(r.calls(), "run ") || strings.Contains(r.calls(), "pull ") {
		t.Errorf("acted again on a finished request:\n%s", r.calls())
	}
}

func TestUpdate_DownloadFailureChangesNothing(t *testing.T) {
	r := newRig(t)
	r.mark("2.40.0")
	t.Setenv("FAIL_PULL", "kasm-browser:2.41.0")
	t.Setenv("FAIL_INSPECT", "kasm-browser:2.41.0")
	r.request(tunnel.HostRequest{ID: id, Action: "update", Version: "2.41.0", Ready: true})
	r.u.step()
	st := r.status()
	if st.State != "failed" || !strings.Contains(st.Detail, "kasm-browser:2.41.0") {
		t.Fatalf("status %+v", st)
	}
	if c := r.calls(); strings.Contains(c, "tag ") || strings.Contains(c, "run -d") || strings.Contains(c, "rm -f") {
		t.Fatalf("changed the host after a failed download:\n%s", c)
	}
}

func TestUpdate_ImageAlreadyOnTheHostIsEnough(t *testing.T) {
	r := newRig(t)
	r.mark("2.40.0")
	t.Setenv("FAIL_PULL", "guacd:2.41.0") // registry unreachable, image present
	r.request(tunnel.HostRequest{ID: id, Action: "update", Version: "2.41.0", Ready: true})
	r.u.step()
	if st := r.status(); st.State != "applying" {
		t.Fatalf("status %+v", st)
	}
}

func TestUpdate_RollsBackWhenTheNewVersionNeverConnects(t *testing.T) {
	r := newRig(t)
	r.mark("2.40.0")
	r.request(tunnel.HostRequest{ID: id, Action: "update", Version: "2.41.0", Ready: true})
	r.u.step()
	r.resetCalls()

	r.now = r.now.Add(applyTimeout - time.Second)
	r.u.step()
	if r.status().State != "applying" {
		t.Fatalf("gave up early: %+v", r.status())
	}
	// The recipe is still running (slow host): keep waiting.
	_ = os.WriteFile(filepath.Join(filepath.Dir(r.dir), "runner"), nil, 0o644)
	r.now = r.now.Add(2 * time.Minute)
	r.u.step()
	if r.status().State != "applying" {
		t.Fatalf("rolled back under a running recipe: %+v", r.status())
	}
	_ = os.Remove(filepath.Join(filepath.Dir(r.dir), "runner"))
	r.u.step()
	st := r.status()
	if st.State != "rolling_back" || !strings.Contains(st.Detail, "did not connect") {
		t.Fatalf("status %+v", st)
	}
	calls := r.calls()
	for _, want := range []string{
		"-e CONNECTOR_IMAGE=" + image("connector", "rollback"),
		"-e GUACD_IMAGE=" + image("guacd", "rollback"),
		"-e UPDATER_IMAGE=" + r.u.self,
		"--entrypoint /bin/sh " + r.u.self + " /usr/local/bin/recipe.sh update",
	} {
		if !strings.Contains(calls, want) {
			t.Errorf("missing %q in\n%s", want, calls)
		}
	}

	r.now = r.now.Add(30 * time.Second)
	r.mark("2.40.0")
	r.u.step()
	if st := r.status(); st.State != "rolled_back" || !strings.Contains(st.Detail, "did not connect") {
		t.Fatalf("status %+v", st)
	}
}

func TestUpdate_NoRollbackWithoutThePreviousImages(t *testing.T) {
	r := newRig(t)
	r.mark("2.40.0")
	r.request(tunnel.HostRequest{ID: id, Action: "update", Version: "2.41.0", Ready: true})
	r.u.step()
	t.Setenv("FAIL_INSPECT", "connector:rollback")
	r.resetCalls()
	r.now = r.now.Add(applyTimeout + time.Second)
	r.u.step()
	if st := r.status(); st.State != "failed" {
		t.Fatalf("status %+v", st)
	}
	if strings.Contains(r.calls(), "run -d") {
		t.Fatalf("ran a rollback with nothing to roll back to:\n%s", r.calls())
	}
}

func TestUpdate_RestartWhileDownloadingFails(t *testing.T) {
	r := newRig(t)
	r.request(tunnel.HostRequest{ID: id, Action: "update", Version: "2.41.0", Ready: true})
	r.put(tunnel.HostStatusFile, tunnel.HostActionStatus{ID: id, Action: "update", State: "preparing", At: r.now.Format(time.RFC3339)})
	r.u.step()
	if st := r.status(); st.State != "failed" || !strings.Contains(st.Detail, "nothing was changed") {
		t.Fatalf("status %+v", st)
	}
	if strings.Contains(r.calls(), "run -d") {
		t.Fatal("ran something after an interrupted download")
	}
}

func TestUpdate_IgnoresHeldAndInvalidRequests(t *testing.T) {
	r := newRig(t)
	r.request(tunnel.HostRequest{ID: id, Action: "update", Version: "2.41.0", Ready: false})
	r.u.step()
	if r.status().ID != "" || r.calls() != "" {
		t.Fatal("acted on a request held for idle")
	}
	r.request(tunnel.HostRequest{ID: id, Action: "update", Version: "latest", Ready: true})
	r.u.step()
	if st := r.status(); st.State != "failed" {
		t.Fatalf("status %+v", st)
	}
	if r.calls() != "" {
		t.Fatalf("called docker for an invalid version:\n%s", r.calls())
	}
}

func TestUninstall(t *testing.T) {
	for _, keep := range []bool{true, false} {
		r := newRig(t)
		r.request(tunnel.HostRequest{ID: id, Action: "uninstall", KeepData: keep, Ready: true})
		r.u.step()
		if st := r.status(); st.State != "removing" {
			t.Fatalf("status %+v", st)
		}
		want := "-e KEEP_DATA=0"
		if keep {
			want = "-e KEEP_DATA=1"
		}
		c := r.calls()
		if !strings.Contains(c, want) || !strings.Contains(c, r.u.self+" /usr/local/bin/recipe.sh uninstall") || strings.Contains(c, "pull ") {
			t.Fatalf("keep=%v:\n%s", keep, c)
		}
	}
}

func TestBeat(t *testing.T) {
	r := newRig(t)
	r.u.beat()
	var b tunnel.UpdaterBeat
	if !r.u.read(tunnel.UpdaterBeatFile, &b) || !b.DockerOK || b.Version != Version || b.At == "" {
		t.Fatalf("beat %+v", b)
	}
	r.u.docker = filepath.Join(r.dir, "missing-docker")
	r.u.beat()
	r.u.read(tunnel.UpdaterBeatFile, &b)
	if b.DockerOK {
		t.Fatal("docker reported reachable without a docker CLI")
	}
}

// The image prefix is fixed in this binary; it must name where we publish.
func TestImagePrefixMatchesTheConsole(t *testing.T) {
	b, err := os.ReadFile("../src/lib/images.ts")
	if err != nil {
		t.Skip("console source not here")
	}
	s := string(b)
	if !strings.Contains(s, `IMAGE_REGISTRY = "ghcr.io"`) || !strings.Contains(s, `IMAGE_OWNER = "captivo-io"`) || !strings.Contains(s, "${IMAGE_REGISTRY}/${IMAGE_OWNER}/captivo-access") {
		t.Fatalf("images.ts no longer matches %s", imagePrefix)
	}
}

// The host's address is read from the host network, kept in the beat, read again
// only every hostIPEvery, and a failed read keeps the last value.
func TestBeatCarriesHostIP(t *testing.T) {
	r := newRig(t)
	r.u.beat()
	var b tunnel.UpdaterBeat
	r.u.read(tunnel.UpdaterBeatFile, &b)
	if b.HostIP != "192.168.1.77" {
		t.Fatalf("host ip %q", b.HostIP)
	}
	reads := func() int { return strings.Count(r.calls(), "--network host") }
	r.u.beat()
	if reads() != 1 {
		t.Fatalf("read again inside %v: %d runs", hostIPEvery, reads())
	}
	r.u.now = func() time.Time { return r.now.Add(hostIPEvery + time.Second) }
	if err := os.WriteFile(filepath.Join(filepath.Dir(r.log), "noroute"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	r.u.beat()
	r.u.read(tunnel.UpdaterBeatFile, &b)
	if reads() != 2 || b.HostIP != "192.168.1.77" {
		t.Fatalf("a failed read must keep the last address: runs=%d ip=%q", reads(), b.HostIP)
	}
}
