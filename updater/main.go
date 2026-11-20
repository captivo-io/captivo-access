// Command updater runs beside a connector and is the only part of a connector
// host with Docker access. It updates or removes the connector when the console
// asks, and nothing else.
//
// It takes no input from the network (its container has none). The connector
// writes a request into the shared hostctl volume (tunnel.HostRequest); the
// updater reads it, and the most a request can choose is an action and a
// release version. Image names and the commands run are fixed in this image:
// recipe.sh is generated from the same code as the install command the console
// shows (src/lib/connector/repair.ts).
//
// An update:
//  1. pulls every image of the requested version first; nothing changes if any
//     pull fails,
//  2. tags the images the host runs now as :rollback,
//  3. runs recipe.sh from the NEW updater image in a one-shot container, which
//     recreates the connector, guacd, the isolated browser and, last, this
//     updater,
//  4. waits for the new connector to say the data-plane took its tunnel
//     (tunnel.ConnectorMark); whichever updater is alive by then (usually the
//     new one) does the waiting,
//  5. runs the recipe again with the :rollback images if that does not happen
//     within applyTimeout.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// Version is set at build time (-ldflags "-X main.Version=...").
var Version = "dev"

// imagePrefix is where our images live. Keep in step with IMAGE_PREFIX in
// src/lib/images.ts (the TypeScript test reads this line).
const imagePrefix = "ghcr.io/captivo-io/captivo-access"

const (
	runnerName    = "captivo-updater-run"
	selfName      = "captivo-updater"
	dockerSock    = "/var/run/docker.sock"
	recipePath    = "/usr/local/bin/recipe.sh"
	pollEvery     = 3 * time.Second
	beatEvery     = 30 * time.Second
	applyTimeout  = 4 * time.Minute
	runnerMaxWait = 15 * time.Minute
)

var versionRe = regexp.MustCompile(`^\d+\.\d+\.\d+$`)

// The containers an update replaces, and the image each one runs.
var managed = []struct{ container, image string }{
	{"access-connector", "connector"},
	{"captivo-guacd", "guacd"},
	{"captivo-kasm", "kasm-browser"},
}

type updater struct {
	dir    string
	docker string // the docker CLI
	now    func() time.Time
	self   string // this container's image, for runs that keep it
}

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	u := &updater{dir: envOr("HOSTCTL_DIR", "/hostctl"), docker: envOr("DOCKER_BIN", "docker"), now: time.Now}
	u.self = u.selfImage()
	log.Printf("captivo updater %s (image %s), watching %s", Version, u.self, u.dir)
	var lastBeat time.Time
	for {
		if u.now().Sub(lastBeat) >= beatEvery {
			u.beat()
			lastBeat = u.now()
		}
		u.step()
		time.Sleep(pollEvery)
	}
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func image(name, tag string) string { return fmt.Sprintf("%s-%s:%s", imagePrefix, name, tag) }

// ---- the hostctl files ----

func (u *updater) read(name string, v any) bool {
	b, err := os.ReadFile(filepath.Join(u.dir, name))
	return err == nil && json.Unmarshal(b, v) == nil
}

func (u *updater) write(name string, v any) {
	b, _ := json.Marshal(v)
	tmp := filepath.Join(u.dir, "."+name+".tmp")
	if err := os.WriteFile(tmp, b, 0o644); err == nil {
		err = os.Rename(tmp, filepath.Join(u.dir, name))
		if err == nil {
			return
		}
	}
	log.Printf("could not write %s", name)
}

func (u *updater) stamp() string { return u.now().UTC().Format(time.RFC3339) }

func (u *updater) setStatus(st tunnel.HostActionStatus) {
	st.At = u.stamp()
	u.write(tunnel.HostStatusFile, st)
	log.Printf("%s %s: %s %s", st.Action, st.ID, st.State, st.Detail)
}

func (u *updater) beat() {
	_, err := u.run(10*time.Second, "version", "--format", "{{.Server.Version}}")
	u.write(tunnel.UpdaterBeatFile, tunnel.UpdaterBeat{Version: Version, DockerOK: err == nil, At: u.stamp()})
}

// ---- docker ----

func (u *updater) run(timeout time.Duration, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, u.docker, args...).CombinedOutput()
	s := strings.TrimSpace(string(out))
	if err != nil {
		if len(s) > 300 {
			s = s[len(s)-300:]
		}
		return s, fmt.Errorf("docker %s: %v: %s", args[0], err, s)
	}
	return s, nil
}

func (u *updater) selfImage() string {
	if h, err := os.Hostname(); err == nil {
		if img, err := u.run(10*time.Second, "inspect", "-f", "{{.Config.Image}}", h); err == nil && img != "" {
			return img
		}
	}
	if img, err := u.run(10*time.Second, "inspect", "-f", "{{.Config.Image}}", selfName); err == nil && img != "" {
		return img
	}
	return image("updater", "latest")
}

func (u *updater) runnerRunning() bool {
	out, err := u.run(10*time.Second, "inspect", "-f", "{{.State.Running}}", runnerName)
	return err == nil && out == "true"
}

// hostFacts are what the running connector was started with, so the new one
// is started the same way.
func (u *updater) hostFacts() (map[string]string, error) {
	out, err := u.run(10*time.Second, "inspect", "-f", "{{json .Config}}", "access-connector")
	if err != nil {
		return nil, err
	}
	var cfg struct {
		Hostname string
		Env      []string
	}
	if err := json.Unmarshal([]byte(out), &cfg); err != nil {
		return nil, err
	}
	facts := map[string]string{"HOST_NAME": cfg.Hostname}
	for _, kv := range cfg.Env {
		k, v, _ := strings.Cut(kv, "=")
		switch k {
		case "MANAGER_URL", "DATAPLANE_URL", "HOST_IP", "HOST_OS":
			facts[k] = v
		}
	}
	if facts["MANAGER_URL"] == "" || facts["DATAPLANE_URL"] == "" {
		return nil, fmt.Errorf("the connector container has no MANAGER_URL or DATAPLANE_URL")
	}
	return facts, nil
}

// launch starts recipe.sh from runner (an updater image) in a one-shot,
// detached container. Detached on purpose: the recipe replaces this updater's
// container, and an attached client would take the run down with it.
func (u *updater) launch(runner, action string, env map[string]string) error {
	if u.runnerRunning() {
		return fmt.Errorf("another run is still going")
	}
	_, _ = u.run(30*time.Second, "rm", "-f", runnerName)
	args := []string{"run", "-d", "--rm", "--name", runnerName, "--network", "none", "-v", dockerSock + ":" + dockerSock}
	for k, v := range env {
		args = append(args, "-e", k+"="+v)
	}
	args = append(args, "--entrypoint", "/bin/sh", runner, recipePath, action)
	_, err := u.run(time.Minute, args...)
	return err
}

// ---- the work ----

func (u *updater) step() {
	var req tunnel.HostRequest
	if !u.read(tunnel.HostRequestFile, &req) || !req.Ready || req.ID == "" {
		return
	}
	var st tunnel.HostActionStatus
	u.read(tunnel.HostStatusFile, &st)
	if st.ID != req.ID {
		u.start(req)
		return
	}
	switch st.State {
	case "preparing":
		// start runs to completion before the next step, so this updater was
		// stopped while downloading. Nothing was changed; say so rather than guess.
		st.State, st.Detail = "failed", "the updater stopped while downloading; nothing was changed"
		u.setStatus(st)
	case "applying":
		u.verify(req, st)
	case "rolling_back":
		u.verifyRollback(st)
	}
}

func (u *updater) start(req tunnel.HostRequest) {
	st := tunnel.HostActionStatus{ID: req.ID, Action: req.Action, Version: req.Version}
	fail := func(detail string) {
		st.State, st.Detail = "failed", detail
		u.setStatus(st)
	}
	switch req.Action {
	case "uninstall":
		env := map[string]string{
			"CONNECTOR_IMAGE": image("connector", "latest"),
			"GUACD_IMAGE":     image("guacd", "latest"),
			"KASM_IMAGE":      image("kasm-browser", "latest"),
			"UPDATER_IMAGE":   u.self,
			"KEEP_DATA":       "0",
		}
		if req.KeepData {
			env["KEEP_DATA"] = "1"
		}
		st.State = "removing"
		u.setStatus(st)
		if err := u.launch(u.self, "uninstall", env); err != nil {
			fail("could not start the removal: " + err.Error())
		}
		return
	case "update":
		if !versionRe.MatchString(req.Version) {
			fail("not a release version")
			return
		}
	default:
		fail("unknown action")
		return
	}

	var mark tunnel.ConnectorMark
	u.read(tunnel.ConnectorMarkFile, &mark)
	st.From = mark.Version
	facts, err := u.hostFacts()
	if err != nil {
		fail("could not read the running connector: " + err.Error())
		return
	}
	// "preparing" until the first container is touched: a restart in this state
	// (step) knows nothing on the host has changed yet.
	st.State, st.Detail = "preparing", "downloading "+req.Version
	u.setStatus(st)

	// Everything is downloaded before anything is touched: a registry or disk
	// problem leaves the host exactly as it was.
	targets := map[string]string{
		"CONNECTOR_IMAGE": image("connector", req.Version),
		"GUACD_IMAGE":     image("guacd", req.Version),
		"KASM_IMAGE":      image("kasm-browser", req.Version),
		"UPDATER_IMAGE":   image("updater", req.Version),
	}
	for _, img := range targets {
		if _, err := u.run(20*time.Minute, "pull", img); err != nil {
			if _, ierr := u.run(10*time.Second, "image", "inspect", img); ierr != nil {
				fail("could not download " + img + ": " + err.Error())
				return
			}
		}
	}
	for _, m := range managed {
		id, err := u.run(10*time.Second, "inspect", "-f", "{{.Image}}", m.container)
		if err != nil {
			continue // not on this host (an older install); the recipe adds it
		}
		if _, err := u.run(30*time.Second, "tag", id, image(m.image, "rollback")); err != nil {
			fail("could not keep the current version for a rollback: " + err.Error())
			return
		}
	}

	env := map[string]string{}
	for k, v := range facts {
		env[k] = v
	}
	for k, v := range targets {
		env[k] = v
	}
	st.State, st.Detail = "applying", "replacing containers"
	u.setStatus(st)
	if err := u.launch(targets["UPDATER_IMAGE"], "update", env); err != nil {
		fail("could not start the update: " + err.Error())
	}
}

func (u *updater) markSince(version string, since time.Time) bool {
	var mark tunnel.ConnectorMark
	if !u.read(tunnel.ConnectorMarkFile, &mark) || mark.Version != version {
		return false
	}
	at, err := time.Parse(time.RFC3339, mark.At)
	return err == nil && !at.Before(since.Truncate(time.Second))
}

func (u *updater) verify(req tunnel.HostRequest, st tunnel.HostActionStatus) {
	started, _ := time.Parse(time.RFC3339, st.At)
	if u.markSince(req.Version, started) {
		st.State, st.Detail = "done", ""
		u.setStatus(st)
		for _, m := range managed {
			_, _ = u.run(30*time.Second, "image", "rm", image(m.image, "rollback"))
		}
		_, _ = u.run(5*time.Minute, "image", "prune", "-f", "--filter", "label=org.opencontainers.image.title=captivo-access")
		return
	}
	waited := u.now().Sub(started)
	if waited < applyTimeout || (u.runnerRunning() && waited < runnerMaxWait) {
		return
	}
	// A rollback recreates the containers from the :rollback images; without
	// them it would remove the connector and fail to bring anything back.
	if _, err := u.run(10*time.Second, "image", "inspect", image("connector", "rollback")); err != nil {
		st.State, st.Detail = "failed", req.Version+" did not connect and there is no previous version to go back to"
		u.setStatus(st)
		return
	}
	facts, err := u.hostFacts()
	if err != nil {
		st.State, st.Detail = "failed", "the new version did not connect, and the rollback could not start: "+err.Error()
		u.setStatus(st)
		return
	}
	env := map[string]string{
		"CONNECTOR_IMAGE": image("connector", "rollback"),
		"GUACD_IMAGE":     image("guacd", "rollback"),
		"KASM_IMAGE":      image("kasm-browser", "rollback"),
		"UPDATER_IMAGE":   u.self,
	}
	for k, v := range facts {
		env[k] = v
	}
	st.State, st.Detail = "rolling_back", fmt.Sprintf("%s did not connect within %d minutes", req.Version, int(applyTimeout.Minutes()))
	u.setStatus(st)
	if err := u.launch(u.self, "update", env); err != nil {
		st.State, st.Detail = "failed", st.Detail+"; the rollback could not start: "+err.Error()
		u.setStatus(st)
	}
}

func (u *updater) verifyRollback(st tunnel.HostActionStatus) {
	started, _ := time.Parse(time.RFC3339, st.At)
	if st.From != "" && u.markSince(st.From, started) {
		st.State = "rolled_back"
		u.setStatus(st)
		return
	}
	waited := u.now().Sub(started)
	if waited < applyTimeout || (u.runnerRunning() && waited < runnerMaxWait) {
		return
	}
	st.State, st.Detail = "failed", st.Detail+"; the previous version did not connect again either"
	u.setStatus(st)
}
