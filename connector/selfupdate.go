package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// `connector update` for a program install (the Docker image is updated by the
// updater beside it, updater/). It downloads the release's archive for this
// operating system, checks it against the release's SHA256SUMS, swaps the
// installed binary and restarts the service. Both files come from the project's
// public GitHub releases over TLS; CONNECTOR_RELEASE_BASE points it at a mirror
// for a network that cannot reach GitHub.

var releaseBase = func() string {
	return strings.TrimRight(envOr("CONNECTOR_RELEASE_BASE", "https://github.com/captivo-io/captivo-access/releases"), "/")
}

const maxArchive = 200 << 20

var versionRe = regexp.MustCompile(`^\d+\.\d+\.\d+$`)

// assetName is the release archive for an operating system and architecture.
func assetName(version, goos, goarch string) string {
	ext := "tar.gz"
	if goos == "windows" {
		ext = "zip"
	}
	return fmt.Sprintf("captivo-connector_%s_%s_%s.%s", version, goos, goarch, ext)
}

// newer is true when a is a later X.Y.Z than b; "dev" (a build without a
// version) is older than everything.
func newer(a, b string) bool {
	pa, pb := versionParts(a), versionParts(b)
	for i := range pa {
		if pa[i] != pb[i] {
			return pa[i] > pb[i]
		}
	}
	return false
}

func versionParts(v string) [3]int {
	var out [3]int
	for i, s := range strings.SplitN(strings.TrimPrefix(v, "v"), ".", 3) {
		out[i], _ = strconv.Atoi(s)
	}
	return out
}

var updateClient = &http.Client{Timeout: 5 * time.Minute}

func httpGet(url string, limit int64) ([]byte, error) {
	resp, err := updateClient.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: %s", url, resp.Status)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, fmt.Errorf("%s is larger than %d MB", url, limit>>20)
	}
	return b, nil
}

// latestVersion follows the releases' "latest" redirect to its tag.
func latestVersion() (string, error) {
	c := &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := c.Get(releaseBase() + "/latest")
	if err != nil {
		return "", err
	}
	resp.Body.Close()
	loc := resp.Header.Get("Location")
	tag := path.Base(strings.TrimRight(loc, "/"))
	v := strings.TrimPrefix(tag, "v")
	if !versionRe.MatchString(v) {
		return "", fmt.Errorf("could not tell the latest release from %q", loc)
	}
	return v, nil
}

// checksumFor reads a file's hash out of a SHA256SUMS file.
func checksumFor(sums []byte, name string) (string, bool) {
	for _, line := range strings.Split(string(sums), "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == name && len(f[0]) == 64 {
			return strings.ToLower(f[0]), true
		}
	}
	return "", false
}

// extractBinary returns the connector executable inside a release archive.
func extractBinary(archive []byte, goos string) ([]byte, error) {
	want := "connector"
	if goos == "windows" {
		want = "connector.exe"
	}
	if goos == "windows" {
		zr, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
		if err != nil {
			return nil, err
		}
		for _, f := range zr.File {
			if path.Base(f.Name) == want && !f.FileInfo().IsDir() {
				rc, err := f.Open()
				if err != nil {
					return nil, err
				}
				defer rc.Close()
				return io.ReadAll(io.LimitReader(rc, maxArchive))
			}
		}
		return nil, errors.New("the archive has no " + want)
	}
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return nil, err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return nil, errors.New("the archive has no " + want)
		}
		if err != nil {
			return nil, err
		}
		if h.Typeflag == tar.TypeReg && path.Base(h.Name) == want {
			return io.ReadAll(io.LimitReader(tr, maxArchive))
		}
	}
}

// fetchRelease downloads the connector binary of a release and checks it
// against the release's checksums.
func fetchRelease(version, goos, goarch string) ([]byte, error) {
	base := fmt.Sprintf("%s/download/v%s/", releaseBase(), version)
	name := assetName(version, goos, goarch)
	sums, err := httpGet(base+"SHA256SUMS", 1<<20)
	if err != nil {
		return nil, fmt.Errorf("checksums: %w", err)
	}
	want, ok := checksumFor(sums, name)
	if !ok {
		return nil, fmt.Errorf("release %s has no %s", version, name)
	}
	archive, err := httpGet(base+name, maxArchive)
	if err != nil {
		return nil, err
	}
	got := sha256.Sum256(archive)
	if hex.EncodeToString(got[:]) != want {
		return nil, errors.New("the download does not match the release's checksum; nothing was changed")
	}
	return extractBinary(archive, goos)
}

// replaceExecutable puts newBin where the installed binary is. The old file is
// renamed out of the way first, which both Windows and Linux allow for a
// program that is running.
func replaceExecutable(dst string, newBin []byte) error {
	tmp := dst + ".new"
	if err := os.WriteFile(tmp, newBin, 0o755); err != nil {
		return err
	}
	old := dst + ".old"
	_ = os.Remove(old)
	if err := os.Rename(dst, old); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Rename(old, dst)
		return err
	}
	_ = os.Remove(old) // refused on Windows while the old one runs; the next update removes it
	return nil
}

func updateCommand(args []string, out io.Writer) int {
	fs := flag.NewFlagSet("update", flag.ContinueOnError)
	fs.SetOutput(out)
	version := fs.String("version", "", "the release to install (default: the latest)")
	check := fs.Bool("check", false, "only say whether a newer release exists (exit 10 if so)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	target := *version
	if target == "" {
		v, err := latestVersion()
		if err != nil {
			fmt.Fprintln(out, "could not find the latest release:", err)
			return 1
		}
		target = v
	} else if !versionRe.MatchString(target) {
		fmt.Fprintln(out, "--version is X.Y.Z")
		return 2
	}
	fmt.Fprintf(out, "installed %s, release %s\n", Version, target)
	if *version == "" && !newer(target, Version) {
		fmt.Fprintln(out, "already up to date")
		return 0
	}
	if *check {
		if newer(target, Version) {
			return 10
		}
		return 0
	}
	bin, err := fetchRelease(target, runtime.GOOS, runtime.GOARCH)
	if err != nil {
		fmt.Fprintln(out, "update failed:", err)
		return 1
	}
	dst := installedBinary()
	if err := replaceExecutable(dst, bin); err != nil {
		fmt.Fprintln(out, "could not replace", filepath.Clean(dst)+":", err, "(run it as root or from an elevated shell)")
		return 1
	}
	fmt.Fprintf(out, "installed %s in %s\n", target, dst)
	if err := restartService(); err != nil {
		fmt.Fprintln(out, "the new version is in place but the service was not restarted:", err)
		return 1
	}
	fmt.Fprintln(out, "restarted the service")
	return 0
}

// installedBinary is the binary the service runs, or this one when no service
// is installed.
func installedBinary() string {
	if p := serviceBinaryPath(); p != "" {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	p, _ := os.Executable()
	return p
}
