package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// TestMaintE2E runs the worker with the image's real guacenc, ffmpeg and ffprobe
// on recordings in CAPTIVO_E2E_SAMPLES (rdp.guac, ssh.guac). Run inside the
// connector image; skipped elsewhere.
func TestMaintE2E(t *testing.T) {
	dir := os.Getenv("CAPTIVO_E2E_SAMPLES")
	tools := findMediaTools()
	if dir == "" || tools == nil {
		t.Skip("needs CAPTIVO_E2E_SAMPLES and the connector image's encoders")
	}
	store := newRecStore(t.TempDir(), testKey())
	put := func(key, format, protocol string, data []byte) {
		for seq := 0; len(data) > 0; seq++ {
			n := min(256<<10, len(data))
			if _, err := store.Append("t1", key, format, seq, data[:n]); err != nil {
				t.Fatal(err)
			}
			if protocol != "" {
				store.NoteProtocol("t1", key, format, protocol)
			}
			data = data[n:]
		}
	}
	rdp, err := os.ReadFile(filepath.Join(dir, "rdp.guac"))
	if err != nil {
		t.Fatal(err)
	}
	ssh, err := os.ReadFile(filepath.Join(dir, "ssh.guac"))
	if err != nil {
		t.Fatal(err)
	}
	put("rdp", "guac", "rdp", rdp)
	put("ssh", "guac", "ssh", ssh)
	// An isolated-browser video cut off before its end was written: ffmpeg
	// writing WebM to a pipe cannot go back for the duration and cues.
	cut := filepath.Join(t.TempDir(), "cut.webm")
	sh := "ffmpeg -v error -f lavfi -i testsrc=duration=20:size=640x360:rate=10 -c:v libvpx-vp9 -deadline realtime -f webm pipe:1 > " + cut
	if out, err := exec.Command("sh", "-c", sh).CombinedOutput(); err != nil {
		t.Fatalf("make cut video: %v %s", err, out)
	}
	cutBytes, _ := os.ReadFile(cut)
	put("cut", "video", "", cutBytes)
	if _, ok, _ := tools.Duration(context.Background(), cut); ok {
		t.Fatal("setup: the cut video should state no duration")
	}

	m := newRecMaint(store, tools)
	m.settle = 0
	start := time.Now()
	m.cycle(context.Background())
	t.Logf("cycle took %s", time.Since(start).Round(time.Millisecond))

	var scanP guacParser
	_ = scanP.feed(rdp)
	want := time.Duration(scanP.scan.lastSync-scanP.scan.firstSync) * time.Millisecond
	st := loadMaintState(filepath.Join(store.root, "t1", "rdp"))
	if st.Video != "converted" {
		t.Fatalf("rdp state %+v", st)
	}
	video := filepath.Join(t.TempDir(), "rdp.webm")
	f, _ := os.Create(video)
	_ = store.EachChunk("t1", "rdp", "video", 0, func(b []byte) error { _, err := f.Write(b); return err })
	f.Close()
	got, ok, err := tools.Duration(context.Background(), video)
	if err != nil || !ok {
		t.Fatalf("converted video has no duration: %v", err)
	}
	info, _ := os.Stat(video)
	t.Logf("rdp: %d bytes -> %d bytes, recording %s, video %s", len(rdp), info.Size(), want, got)
	out, _ := exec.Command("ffprobe", "-v", "error", "-select_streams", "v", "-show_entries", "stream=codec_name,width,height", "-of", "csv=p=0", video).Output()
	t.Logf("rdp video stream: %s", out)

	if st := loadMaintState(filepath.Join(store.root, "t1", "ssh")); st.Video != "terminal" {
		t.Fatalf("ssh state %+v", st)
	}
	sshDisk, _ := store.Bytes("t1", "ssh")
	t.Logf("ssh: %d bytes -> %d on disk", len(ssh), sshDisk)

	cst := loadMaintState(filepath.Join(store.root, "t1", "cut"))
	if !cst.VideoChecked || cst.DurationMs < 19_000 || cst.DurationMs > 21_000 {
		t.Fatalf("cut video state %+v", cst)
	}
	t.Logf("cut video repaired: %d ms", cst.DurationMs)
}
