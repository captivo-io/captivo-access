package main

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// recordingVolumeWarning returns a non-empty warning when the recording store does
// not sit on a mounted volume, and would therefore die with the container.
//
// This matters because of what moving recordings to the connector traded away: they
// used to live in Postgres and were captured by whatever backed the database up. Now
// they are files on this host, and if the path is in the container's writable layer a
// `docker rm` destroys every recording the customer believes they hold -- quietly
// falsifying the product's central claim.
//
// It reads /proc/self/mountinfo rather than guessing from the path, because guessing
// was wrong in both directions: warning on every path outside /data trains operators
// to ignore warnings, and accepting any existing directory misses the case this check
// exists for. A container really can enumerate its mounts.
func recordingVolumeWarning(dir string) string {
	f, err := os.Open("/proc/self/mountinfo")
	if err != nil {
		// Not Linux, or no procfs: cannot tell, so say nothing rather than cry wolf.
		return ""
	}
	defer f.Close()
	return recordingVolumeWarningFrom(dir, f)
}

// recordingVolumeWarningFrom is the testable half: it takes mountinfo content so the
// check can be exercised without a real container.
func recordingVolumeWarningFrom(dir string, mountinfo interface{ Read([]byte) (int, error) }) string {
	clean := filepath.Clean(dir)
	var mounts []string
	sc := bufio.NewScanner(mountinfo)
	for sc.Scan() {
		// mountinfo field 5 is the mount point: "36 35 98:0 /src /dst rw,..."
		parts := strings.Fields(sc.Text())
		if len(parts) < 5 {
			continue
		}
		mp := filepath.Clean(parts[4])
		if mp == "/" {
			continue // everything is under /, so it proves nothing
		}
		mounts = append(mounts, mp)
	}
	for _, mp := range mounts {
		if clean == mp || strings.HasPrefix(clean, mp+string(filepath.Separator)) {
			return ""
		}
	}
	return fmt.Sprintf(
		"recording store %s is NOT on a mounted volume: every recording is lost when this container is removed. Mount a volume there and include it in your backups -- recordings are no longer held by the control plane, so nobody else has a copy.",
		clean,
	)
}
