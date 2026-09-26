package main

import (
	"strings"
	"testing"
)

// A realistic mountinfo excerpt: root overlay plus one bind-mounted volume.
const mountinfoWithVolume = `25 30 0:23 / / rw,relatime - overlay overlay rw
36 25 8:1 /var/lib/docker/volumes/access_connector_data/_data /data rw,relatime - ext4 /dev/sda1 rw
41 25 0:44 / /proc rw,nosuid - proc proc rw
`

const mountinfoNoVolume = `25 30 0:23 / / rw,relatime - overlay overlay rw
41 25 0:44 / /proc rw,nosuid - proc proc rw
`

func TestStoreOnAMountedVolumeDoesNotWarn(t *testing.T) {
	if w := recordingVolumeWarningFrom("/data/recordings", strings.NewReader(mountinfoWithVolume)); w != "" {
		t.Fatalf("warned about a mounted path: %s", w)
	}
}

func TestStoreOnAnUnmountedPathWarns(t *testing.T) {
	// The case this check exists for: the store is in the container's writable layer,
	// so `docker rm` destroys recordings the customer believes they hold.
	w := recordingVolumeWarningFrom("/data/recordings", strings.NewReader(mountinfoNoVolume))
	if w == "" {
		t.Fatal("no warning for an unmounted store")
	}
	if !strings.Contains(w, "backups") {
		t.Fatalf("the warning must name the fix: %s", w)
	}
	if !strings.Contains(w, "no longer held by the control plane") {
		// An operator needs to know nobody else has a copy; that is what makes this
		// urgent rather than tidy.
		t.Fatalf("the warning must say there is no other copy: %s", w)
	}
}

func TestAnyMountedPathIsAccepted(t *testing.T) {
	// An operator who mounts at /srv/recordings is doing nothing wrong. Warning on
	// every path outside /data would train them to ignore warnings.
	mi := `25 30 0:23 / / rw - overlay overlay rw
36 25 8:1 /vol /srv/recordings rw - ext4 /dev/sda1 rw
`
	if w := recordingVolumeWarningFrom("/srv/recordings/x", strings.NewReader(mi)); w != "" {
		t.Fatalf("warned about a mounted custom path: %s", w)
	}
}

func TestRootMountAloneNeverCounts(t *testing.T) {
	// Every path is under "/", so treating it as a volume would silence the check
	// entirely.
	mi := "25 30 0:23 / / rw - overlay overlay rw\n"
	if w := recordingVolumeWarningFrom("/data/recordings", strings.NewReader(mi)); w == "" {
		t.Fatal("the root mount was accepted as a volume")
	}
}
