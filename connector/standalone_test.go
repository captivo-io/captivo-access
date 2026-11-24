package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestConfigFileFillsOnlyWhatIsUnset(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "connector.conf")
	if err := os.WriteFile(p, []byte("\ufeff# a comment\nCONNECTOR_PLATFORM=standalone\nDATA_DIR=\"/srv/captivo\"\n\nBAD LINE\nKEEP_ME=from-file\nEMPTY=\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("KEEP_ME", "from-env")
	t.Setenv("CONNECTOR_PLATFORM", "")
	t.Setenv("DATA_DIR", "")
	if err := loadConfigFile(p); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("CONNECTOR_PLATFORM") != "standalone" || os.Getenv("DATA_DIR") != "/srv/captivo" || os.Getenv("KEEP_ME") != "from-env" {
		t.Fatalf("env: %q %q %q", os.Getenv("CONNECTOR_PLATFORM"), os.Getenv("DATA_DIR"), os.Getenv("KEEP_ME"))
	}
	if loadConfigFile(filepath.Join(dir, "missing")) == nil {
		t.Fatal("a missing file is an error")
	}
	t.Setenv("DATA_DIR", "/srv/captivo")
	if got := dataPath("token"); filepath.ToSlash(got) != "/srv/captivo/token" {
		t.Fatalf("dataPath %q", got)
	}
}

func TestInstallOptionsAreChecked(t *testing.T) {
	ok := installOptions{managerURL: "https://acme.cloud.captivo.io", dataplaneURL: "wss://connect.cloud.captivo.io", pairCode: "abcdEFGH12345678", dataDir: "/var/lib/captivo-connector"}
	if why := ok.validate(); why != "" {
		t.Fatal(why)
	}
	for name, mutate := range map[string]func(*installOptions){
		"manager url":  func(o *installOptions) { o.managerURL = "acme" },
		"tunnel url":   func(o *installOptions) { o.dataplaneURL = "wss://x\nPAIR_CODE=evil" },
		"pair code":    func(o *installOptions) { o.pairCode = "short" },
		"pair newline": func(o *installOptions) { o.pairCode = "abcdEFGH12345678\nEVIL=1" },
		"targets":      func(o *installOptions) { o.allowedTargets = "10.0.0.0/8\nEVIL=1" },
	} {
		o := ok
		mutate(&o)
		if o.validate() == "" {
			t.Errorf("%s was accepted", name)
		}
	}
	ok.allowedTargets = "10.0.5.0/24, db.corp:5432"
	if why := ok.validate(); why != "" {
		t.Fatal(why)
	}
	text := ok.configText("/var/log/c.log")
	for _, want := range []string{"CONNECTOR_PLATFORM=standalone\n", "MANAGER_URL=https://acme.cloud.captivo.io\n", "PAIR_CODE=abcdEFGH12345678\n", "ALLOWED_TARGETS=10.0.5.0/24, db.corp:5432\n", "LOG_FILE=/var/log/c.log\n"} {
		if !strings.Contains(text, want) {
			t.Errorf("config lacks %q:\n%s", want, text)
		}
	}
}

func TestRotatingFileKeepsTheNewest(t *testing.T) {
	p := filepath.Join(t.TempDir(), "c.log")
	r, err := openRotatingFile(p, 100, 2)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 12; i++ {
		fmt.Fprintf(r, "line %02d %s\n", i, strings.Repeat("x", 20))
	}
	for _, f := range []string{p, p + ".1", p + ".2"} {
		if _, err := os.Stat(f); err != nil {
			t.Errorf("missing %s", f)
		}
	}
	if _, err := os.Stat(p + ".3"); err == nil {
		t.Error("kept more files than asked")
	}
	b, _ := os.ReadFile(p)
	if !strings.Contains(string(b), "line 11") {
		t.Errorf("the newest line is not in the live file: %q", b)
	}
}

func TestVersionOrder(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want bool
	}{{"2.65.0", "2.64.9", true}, {"2.64.0", "2.64.0", false}, {"2.9.0", "2.10.0", false}, {"3.0.0", "dev", true}, {"v2.65.1", "2.65.0", true}} {
		if newer(c.a, c.b) != c.want {
			t.Errorf("newer(%q, %q) != %v", c.a, c.b, c.want)
		}
	}
	if assetName("2.65.0", "windows", "amd64") != "captivo-connector_2.65.0_windows_amd64.zip" || assetName("2.65.0", "linux", "arm64") != "captivo-connector_2.65.0_linux_arm64.tar.gz" {
		t.Fatal("asset names")
	}
}

// release serves a fake release: an archive of the right kind with a "binary" in
// it, its checksums, and the "latest" redirect.
func release(t *testing.T, version, content string, corrupt bool) *httptest.Server {
	t.Helper()
	name := assetName(version, runtime.GOOS, runtime.GOARCH)
	var archive bytes.Buffer
	exe := "connector"
	if runtime.GOOS == "windows" {
		exe = "connector.exe"
		zw := zip.NewWriter(&archive)
		w, _ := zw.Create("captivo-connector/" + exe)
		_, _ = w.Write([]byte(content))
		_ = zw.Close()
	} else {
		gz := gzip.NewWriter(&archive)
		tw := tar.NewWriter(gz)
		_ = tw.WriteHeader(&tar.Header{Name: "captivo-connector/" + exe, Typeflag: tar.TypeReg, Mode: 0o755, Size: int64(len(content))})
		_, _ = tw.Write([]byte(content))
		_ = tw.Close()
		_ = gz.Close()
	}
	sum := sha256.Sum256(archive.Bytes())
	sums := hex.EncodeToString(sum[:]) + "  " + name + "\n" + strings.Repeat("0", 64) + "  other.zip\n"
	if corrupt {
		sums = strings.Repeat("0", 64) + "  " + name + "\n"
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/latest", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/releases/tag/v"+version, http.StatusFound)
	})
	mux.HandleFunc("/download/v"+version+"/SHA256SUMS", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(sums)) })
	mux.HandleFunc("/download/v"+version+"/"+name, func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(archive.Bytes()) })
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	t.Setenv("CONNECTOR_RELEASE_BASE", srv.URL)
	return srv
}

func TestUpdateFindsTheLatestAndChecksTheDownload(t *testing.T) {
	release(t, "9.9.9", "new connector bytes", false)
	if v, err := latestVersion(); err != nil || v != "9.9.9" {
		t.Fatalf("latest %q %v", v, err)
	}
	bin, err := fetchRelease("9.9.9", runtime.GOOS, runtime.GOARCH)
	if err != nil || string(bin) != "new connector bytes" {
		t.Fatalf("fetch: %q %v", bin, err)
	}
	if _, err := fetchRelease("9.9.9", "plan9", "amd64"); err == nil {
		t.Fatal("a platform the release has no archive for")
	}
}

func TestUpdateRefusesADownloadThatDoesNotMatch(t *testing.T) {
	release(t, "9.9.9", "tampered", true)
	if _, err := fetchRelease("9.9.9", runtime.GOOS, runtime.GOARCH); err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("a bad checksum was accepted: %v", err)
	}
}

func TestReplaceExecutableSwapsAndKeepsTheOldOneOnFailure(t *testing.T) {
	dir := t.TempDir()
	dst := filepath.Join(dir, "connector")
	if err := os.WriteFile(dst, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := replaceExecutable(dst, []byte("new")); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(dst); string(b) != "new" {
		t.Fatalf("got %q", b)
	}
	if err := replaceExecutable(filepath.Join(dir, "missing", "connector"), []byte("x")); err == nil {
		t.Fatal("replaced a file that is not there")
	}
}

func TestUpdateCommandUpToDateAndCheck(t *testing.T) {
	release(t, "9.9.9", "x", false)
	old := Version
	defer func() { Version = old }()
	Version = "9.9.9"
	var out bytes.Buffer
	if code := updateCommand(nil, &out); code != 0 || !strings.Contains(out.String(), "already up to date") {
		t.Fatalf("%d %s", code, out.String())
	}
	Version = "9.9.8"
	out.Reset()
	if code := updateCommand([]string{"--check"}, &out); code != 10 {
		t.Fatalf("--check with a newer release: %d %s", code, out.String())
	}
	if code := updateCommand([]string{"--version", "nine"}, &out); code != 2 {
		t.Fatalf("a bad --version: %d", code)
	}
}

func TestPlatformHeaderOnlyForAProgramInstall(t *testing.T) {
	vaultKey = newVaultTestKey(t)
	old := standalone
	defer func() { standalone = old }()
	standalone = false
	if connectHeader("tok").Get("X-Connector-Platform") != "" {
		t.Fatal("the Docker image reports a platform")
	}
	standalone = true
	if got := connectHeader("tok").Get("X-Connector-Platform"); got != runtime.GOOS {
		t.Fatalf("platform %q", got)
	}
}
