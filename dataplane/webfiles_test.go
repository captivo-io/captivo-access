package main

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// multipartBody builds a form with text fields and (name, content) files.
func multipartBody(t *testing.T, fields map[string]string, files [][2]string) (*bytes.Buffer, string) {
	t.Helper()
	var b bytes.Buffer
	mw := multipart.NewWriter(&b)
	for k, v := range fields {
		_ = mw.WriteField(k, v)
	}
	for _, f := range files {
		fw, err := mw.CreateFormFile("upload", f[0])
		if err != nil {
			t.Fatal(err)
		}
		_, _ = fw.Write([]byte(f[1]))
	}
	_ = mw.Close()
	return &b, mw.FormDataContentType()
}

func TestScreenUploadReplaysFormWithoutFiles(t *testing.T) {
	body, ct := multipartBody(t, map[string]string{"title": "hello", "note": strings.Repeat("x", 100_000)}, nil)
	want := body.String()
	r := httptest.NewRequest(http.MethodPost, "/", body)
	r.Header.Set("Content-Type", ct)
	boundary, ok := multipartBoundary(r)
	if !ok {
		t.Fatal("not multipart")
	}
	fwd, f := screenUpload(r.Body, boundary)
	if f != nil {
		t.Fatalf("form without files blocked as %+v", f)
	}
	got, _ := io.ReadAll(fwd)
	if string(got) != want {
		t.Fatalf("replayed body differs: %d bytes, want %d", len(got), len(want))
	}
}

func TestScreenUploadEmptyFileInputIsNotAFile(t *testing.T) {
	// What a browser sends for a file input left empty.
	body, ct := multipartBody(t, map[string]string{"a": "1"}, [][2]string{{"", ""}})
	r := httptest.NewRequest(http.MethodPost, "/", body)
	r.Header.Set("Content-Type", ct)
	boundary, _ := multipartBoundary(r)
	if _, f := screenUpload(r.Body, boundary); f != nil {
		t.Fatalf("empty file input blocked as %+v", f)
	}
}

func TestScreenUploadStopsAtFilePart(t *testing.T) {
	body, ct := multipartBody(t, map[string]string{"a": "1"}, [][2]string{{`C:\Users\v\secret.pdf`, "%PDF"}})
	r := httptest.NewRequest(http.MethodPost, "/", body)
	r.Header.Set("Content-Type", ct)
	boundary, _ := multipartBoundary(r)
	fwd, f := screenUpload(r.Body, boundary)
	if f == nil || fwd != nil {
		t.Fatalf("file part not blocked: %+v", f)
	}
	if f.name != "secret.pdf" {
		t.Fatalf("name = %q, want the base name", f.name)
	}
}

func TestScreenUploadUnreadableOrHugeIsBlocked(t *testing.T) {
	if _, f := screenUpload(strings.NewReader("not a form at all"), "xyz"); f == nil {
		t.Fatal("unparseable multipart body must count as an upload")
	}
	big, ct := multipartBody(t, map[string]string{"blob": strings.Repeat("y", maxUploadInspectBytes+10)}, nil)
	r := httptest.NewRequest(http.MethodPost, "/", big)
	r.Header.Set("Content-Type", ct)
	boundary, _ := multipartBoundary(r)
	if _, f := screenUpload(r.Body, boundary); f == nil || f.name != "(form too large to inspect)" {
		t.Fatalf("oversized form = %+v, want blocked as too large", f)
	}
}

func TestObserveUploadsPassesBodyAndListsFiles(t *testing.T) {
	body, ct := multipartBody(t, map[string]string{"a": "1"}, [][2]string{{"a.txt", "hello"}, {"b.bin", strings.Repeat("z", 70_000)}, {"", ""}})
	want := body.String()
	r := httptest.NewRequest(http.MethodPost, "/", body)
	r.Header.Set("Content-Type", ct)
	boundary, _ := multipartBoundary(r)
	fwd, finish := observeUploads(r.Body, boundary)
	got, _ := io.ReadAll(fwd)
	files := finish()
	if string(got) != want {
		t.Fatal("observed body was changed")
	}
	if len(files) != 2 || files[0].name != "a.txt" || files[0].size != 5 || files[1].name != "b.bin" || files[1].size != 70_000 {
		t.Fatalf("files = %+v", files)
	}
}

func TestObserveUploadsAbandonedBodyDoesNotHang(t *testing.T) {
	body, ct := multipartBody(t, nil, [][2]string{{"a.txt", strings.Repeat("q", 200_000)}})
	r := httptest.NewRequest(http.MethodPost, "/", body)
	r.Header.Set("Content-Type", ct)
	boundary, _ := multipartBoundary(r)
	fwd, finish := observeUploads(r.Body, boundary)
	_, _ = fwd.Read(make([]byte, 1000)) // the app answered early; nothing more is read
	ch := make(chan []webFile, 1)
	go func() { ch <- finish() }()
	select {
	case <-ch:
	case <-time.After(2 * time.Second):
		t.Fatal("finish hung on an abandoned body")
	}
}

func TestAttachmentFile(t *testing.T) {
	cases := []struct {
		disp, path, want string
		ok               bool
	}{
		{`attachment; filename="report.xlsx"`, "/x", "report.xlsx", true},
		{`attachment; filename*=UTF-8''%C3%B6zet.pdf`, "/x", "özet.pdf", true},
		{`attachment`, "/files/data.csv", "data.csv", true},
		{`ATTACHMENT; filename="../../etc/passwd"`, "/", "passwd", true},
		{`attachment; filename="a`, "/dl/b.zip", "b.zip", true}, // malformed, still a download
		{`inline; filename="view.pdf"`, "/", "", false},
		{``, "/", "", false},
	}
	for _, c := range cases {
		f, ok := attachmentFile(map[string][]string{"content-disposition": {c.disp}, "Content-Type": {"application/pdf; x=1"}}, c.path)
		if ok != c.ok || (ok && (f.name != c.want || f.mime != "application/pdf")) {
			t.Errorf("%q: got %+v %v, want %q %v", c.disp, f, ok, c.want, c.ok)
		}
	}
}

func TestFileTransferScript(t *testing.T) {
	both := fileTransferScript(false, false)
	for _, want := range []string{`{"d":false,"u":false}`, "File uploads are turned off", "File downloads are turned off", "showOpenFilePicker", "HTMLAnchorElement"} {
		if !strings.Contains(both, want) {
			t.Errorf("script missing %q", want)
		}
	}
	if !strings.Contains(fileTransferScript(true, false), `{"d":false,"u":true}`) {
		t.Error("download-only script config wrong")
	}
	if !(injections{upload: true, download: false}).any() || (injections{upload: true, download: true}).any() {
		t.Error("injections.any must follow the file transfer flags")
	}
}

// webFileServer plays the connector for one proxied request: it reads the
// request (reporting whether one arrived and its body) and answers with the
// given response.
func webFileServer(t *testing.T, header map[string][]string, body string) (*BrowserProxy, *fakeControl, chan []byte) {
	t.Helper()
	srv, cli := newTunnelPair(t)
	got := make(chan []byte, 1)
	go func() {
		st, err := cli.Accept()
		if err != nil {
			return
		}
		defer st.Close()
		if _, err := tunnel.ReadFrame(st); err != nil {
			return
		}
		b, _ := io.ReadAll(tunnel.NewBodyReader(st))
		got <- b
		resp, _ := json.Marshal(tunnel.DialResponse{Status: http.StatusOK, Header: header})
		if err := tunnel.WriteFrame(st, resp); err != nil {
			return
		}
		_ = tunnel.WriteBody(st, strings.NewReader(body))
	}()
	reg := NewRegistry()
	reg.Set("c1", &Session{mux: srv})
	ctrl := &fakeControl{userID: "u1", email: "v@vendor.test", siteID: "s1", connID: "c1", upstream: "http://app.internal", allow: true}
	return &BrowserProxy{reg: reg, ctrl: ctrl, managerURL: "https://m.example", audit: NewAuditQueue(100), web: NewWebActivityTracker(), webIdle: time.Minute}, ctrl, got
}

func transferEvents(q *AuditQueue) []AuditEvent {
	var out []AuditEvent
	for _, e := range q.drain(100) {
		if e.Method == verbUpload || e.Method == verbDownload {
			out = append(out, e)
		}
	}
	return out
}

func uploadRequest(t *testing.T) *http.Request {
	body, ct := multipartBody(t, map[string]string{"a": "1"}, [][2]string{{"cert.pem", "-----BEGIN"}})
	r := httptest.NewRequest(http.MethodPost, "http://app.example.com/upload", body)
	r.Header.Set("Content-Type", ct)
	r.AddCookie(&http.Cookie{Name: "ca_session", Value: "tok"})
	return r
}

func TestBrowserProxyBlocksUploadBeforeTheApp(t *testing.T) {
	p, ctrl, got := webFileServer(t, map[string][]string{"Content-Type": {"text/plain"}}, "ok")
	ctrl.fileTransferMode = "no_upload"
	w := httptest.NewRecorder()
	p.ServeHTTP(w, uploadRequest(t))
	if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "uploads are turned off") {
		t.Fatalf("status = %d body = %s", w.Code, w.Body.String())
	}
	select {
	case <-got:
		t.Fatal("the upload reached the app")
	case <-time.After(200 * time.Millisecond):
	}
	ev := transferEvents(p.audit)
	if len(ev) != 1 || ev[0].Decision != "DENY" || ev[0].Path != "/cert.pem" || ev[0].Reason != "file-transfer-denied:upload" {
		t.Fatalf("audit = %+v", ev)
	}
}

func TestBrowserProxyAuditsAllowedUpload(t *testing.T) {
	p, _, got := webFileServer(t, map[string][]string{"Content-Type": {"text/plain"}}, "ok")
	r := uploadRequest(t)
	w := httptest.NewRecorder()
	p.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	if b := <-got; !bytes.Contains(b, []byte("-----BEGIN")) {
		t.Fatal("upload body did not reach the app intact")
	}
	ev := transferEvents(p.audit)
	if len(ev) != 1 || ev[0].Decision != "ALLOW" || ev[0].Path != "/cert.pem" || ev[0].BytesOut != int64(len("-----BEGIN")) {
		t.Fatalf("audit = %+v", ev)
	}
}

func downloadRequest() *http.Request {
	r := httptest.NewRequest(http.MethodGet, "http://app.example.com/export", nil)
	r.AddCookie(&http.Cookie{Name: "ca_session", Value: "tok"})
	return r
}

var attachmentHeader = map[string][]string{"Content-Type": {"text/csv"}, "Content-Disposition": {`attachment; filename="customers.csv"`}}

func TestBrowserProxyBlocksDownload(t *testing.T) {
	p, ctrl, _ := webFileServer(t, attachmentHeader, "id,name\n1,a\n")
	ctrl.fileTransferMode = "no_download"
	w := httptest.NewRecorder()
	p.ServeHTTP(w, downloadRequest())
	if w.Code != http.StatusForbidden || strings.Contains(w.Body.String(), "id,name") {
		t.Fatalf("status = %d body = %s", w.Code, w.Body.String())
	}
	if w.Header().Get("Content-Disposition") != "" {
		t.Fatal("the attachment header leaked onto the block page")
	}
	ev := transferEvents(p.audit)
	if len(ev) != 1 || ev[0].Decision != "DENY" || ev[0].Path != "/customers.csv" || ev[0].Reason != "file-transfer-denied:download" {
		t.Fatalf("audit = %+v", ev)
	}
}

func TestBrowserProxyAuditsAllowedDownload(t *testing.T) {
	const csv = "id,name\n1,a\n"
	p, _, _ := webFileServer(t, attachmentHeader, csv)
	w := httptest.NewRecorder()
	p.ServeHTTP(w, downloadRequest())
	if w.Code != http.StatusOK || w.Body.String() != csv {
		t.Fatalf("status = %d body = %q", w.Code, w.Body.String())
	}
	ev := transferEvents(p.audit)
	if len(ev) != 1 || ev[0].Decision != "ALLOW" || ev[0].Path != "/customers.csv" || ev[0].BytesOut != int64(len(csv)) || ev[0].Reason != "file:text/csv" {
		t.Fatalf("audit = %+v", ev)
	}
}

func TestBrowserProxyInjectsFileGuardAndAsksForPlainHTML(t *testing.T) {
	p, ctrl, _ := webFileServer(t, map[string][]string{"Content-Type": {"text/html"}}, "<html><head></head><body>x</body></html>")
	ctrl.fileTransferMode = "none"
	w := httptest.NewRecorder()
	p.ServeHTTP(w, downloadRequest())
	if !strings.Contains(w.Body.String(), "File downloads are turned off") {
		t.Fatalf("file guard not injected: %s", w.Body.String())
	}
}
