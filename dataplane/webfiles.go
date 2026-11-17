package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"path"
	"strings"
	"time"
)

// File transfer control for web apps (TRANSPARENT sites). The vendor's own
// browser talks to the app through this proxy, so what can be enforced is
// file-shaped HTTP: a response marked Content-Disposition: attachment is a
// download, a multipart/form-data request with a file part is an upload. Data
// the app shows on screen, files the page builds itself, raw-body or WebSocket
// uploads are not files to this proxy; the injected fileTransferScript closes
// the common browser-side paths, and the isolated browser is the strict option.

// maxUploadInspectBytes caps how much of a multipart body is held back while
// looking for a file part on a site whose uploads are off. Form fields alone
// never come near it; a body that does is treated as an upload.
const maxUploadInspectBytes = 16 << 20

// webFile is one file seen crossing the proxy, for the audit log.
type webFile struct {
	name string
	mime string
	size int64
}

// multipartBoundary returns the boundary of a multipart/form-data request.
func multipartBoundary(r *http.Request) (string, bool) {
	mt, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mt != "multipart/form-data" || params["boundary"] == "" {
		return "", false
	}
	return params["boundary"], true
}

// filePart reports whether a multipart part carries a file: a filename
// parameter that is not empty, or an empty one with content (a browser sends
// filename="" with no content for a file input left empty).
func filePart(p *multipart.Part) (name string, hasFilename bool) {
	_, params, err := mime.ParseMediaType(p.Header.Get("Content-Disposition"))
	if err != nil {
		return "", false
	}
	name, hasFilename = params["filename"]
	return cleanFileName(name), hasFilename
}

// screenUpload reads a multipart body held back from the upstream until it
// either ends with no file in it, and returns a reader that replays it in
// full, or reaches a file part, and returns that file. Nothing reaches the
// app before the decision. A body that cannot be parsed, has no parts or is
// too large to inspect counts as an upload: the app's parser may read it
// differently.
func screenUpload(body io.Reader, boundary string) (io.Reader, *webFile) {
	var held bytes.Buffer
	mr := multipart.NewReader(io.TeeReader(io.LimitReader(body, maxUploadInspectBytes+1), &held), boundary)
	for parts := 0; ; parts++ {
		p, err := mr.NextRawPart()
		if errors.Is(err, io.EOF) {
			// No part at all in a body that is not empty: not a form this
			// parser understands, so not one to vouch for.
			if parts == 0 && held.Len() > 0 {
				return nil, &webFile{name: "(unreadable form data)"}
			}
			return io.MultiReader(&held, body), nil
		}
		if err != nil {
			return nil, uninspectable(&held)
		}
		name, hasFilename := filePart(p)
		if hasFilename && name != "" {
			return nil, &webFile{name: name, mime: p.Header.Get("Content-Type")}
		}
		n, err := io.Copy(io.Discard, p)
		if err != nil {
			return nil, uninspectable(&held)
		}
		if hasFilename && n > 0 {
			return nil, &webFile{name: "(unnamed file)", mime: p.Header.Get("Content-Type"), size: n}
		}
	}
}

func uninspectable(held *bytes.Buffer) *webFile {
	if held.Len() > maxUploadInspectBytes {
		return &webFile{name: "(form too large to inspect)"}
	}
	return &webFile{name: "(unreadable form data)"}
}

// observeUploads passes a multipart body through unchanged while a parser
// beside it notes the files in it. finish returns them once the body is done
// (or abandoned); a file cut off midway is listed with the bytes that passed.
func observeUploads(body io.Reader, boundary string) (io.Reader, func() []webFile) {
	pr, pw := io.Pipe()
	done := make(chan []webFile, 1)
	go func() {
		var files []webFile
		mr := multipart.NewReader(pr, boundary)
		for {
			p, err := mr.NextRawPart()
			if err != nil {
				break
			}
			name, hasFilename := filePart(p)
			n, _ := io.Copy(io.Discard, p)
			if hasFilename && (name != "" || n > 0) {
				if name == "" {
					name = "(unnamed file)"
				}
				files = append(files, webFile{name: name, mime: p.Header.Get("Content-Type"), size: n})
			}
		}
		_, _ = io.Copy(io.Discard, pr) // the tee below must never block on us
		done <- files
	}()
	tee := &teeCloser{r: io.TeeReader(body, pw), w: pw}
	return tee, func() []webFile {
		pw.Close()
		return <-done
	}
}

// teeCloser closes the parser's pipe as soon as the body ends.
type teeCloser struct {
	r io.Reader
	w *io.PipeWriter
}

func (t *teeCloser) Read(b []byte) (int, error) {
	n, err := t.r.Read(b)
	if err != nil {
		t.w.Close()
	}
	return n, err
}

// attachmentFile reports whether a response is a download: Content-Disposition
// attachment. The name is the header's filename, else the last path segment.
func attachmentFile(header map[string][]string, reqPath string) (*webFile, bool) {
	var disp, ctype string
	for k, vs := range header {
		if len(vs) == 0 {
			continue
		}
		switch {
		case strings.EqualFold(k, "Content-Disposition"):
			disp = vs[0]
		case strings.EqualFold(k, "Content-Type"):
			ctype = vs[0]
		}
	}
	dt, params, err := mime.ParseMediaType(disp)
	if err != nil {
		// A malformed header still downloads in a browser if it starts so.
		if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(disp)), "attachment") {
			return nil, false
		}
		dt, params = "attachment", nil
	}
	if dt != "attachment" {
		return nil, false
	}
	name := cleanFileName(params["filename"])
	if name == "" {
		name = cleanFileName(path.Base(reqPath))
	}
	if name == "" {
		name = "(unnamed file)"
	}
	if mt, _, err := mime.ParseMediaType(ctype); err == nil {
		ctype = mt
	}
	return &webFile{name: name, mime: ctype}, true
}

// cleanFileName keeps the last path element of a client- or app-supplied name.
func cleanFileName(name string) string {
	name = strings.TrimSpace(name)
	if i := strings.LastIndexAny(name, `/\`); i >= 0 {
		name = name[i+1:]
	}
	if name == "." || name == ".." {
		return ""
	}
	if len(name) > maxFilenameLen {
		name = name[:maxFilenameLen]
	}
	return name
}

// webTransferEvent is the audit row for a web app file, in the shape gateway
// transfers use (method DOWNLOAD/UPLOAD, path "/name", reason "file:<mime>"),
// so the audit views badge it the same way. A blocked one is a DENY with the
// isolated browser's "file-transfer-denied:<op>" reason.
func webTransferEvent(upload, allowed bool, f webFile, userID, siteID, host string, r *http.Request) AuditEvent {
	method, op := verbDownload, "download"
	if upload {
		method, op = verbUpload, "upload"
	}
	decision, status, reason := "ALLOW", http.StatusOK, "file:"+f.mime
	if !allowed {
		decision, status, reason = "DENY", http.StatusForbidden, "file-transfer-denied:"+op
	}
	return AuditEvent{
		Timestamp: time.Now(),
		UserID:    userID,
		SiteID:    siteID,
		Host:      host,
		Method:    method,
		Path:      "/" + f.name,
		Status:    status,
		BytesOut:  f.size,
		Decision:  decision,
		Reason:    reason,
		ClientIP:  firstHop(r.Header.Get("X-Forwarded-For")),
		UserAgent: r.UserAgent(),
	}
}

// fileTransferScript builds the inline <script> for a web app whose uploads
// and/or downloads are off: file pickers, file drops and pasted files are
// refused, and download links (download attribute, blob:/data: URLs, a save
// dialog) do nothing, with a short notice either way. Like the clipboard guard
// it is a deterrent a vendor can disable; the proxy's own checks are the
// control, this keeps the app from failing halfway and covers files the page
// builds itself.
func fileTransferScript(up, down bool) string {
	cfg, _ := json.Marshal(map[string]bool{"u": up, "d": down})
	return `<script>(function(){try{var c=` + string(cfg) + `;` +
		`var UM='File uploads are turned off for this application.',DM='File downloads are turned off for this application.';` +
		`function note(m){try{var n=document.getElementById('__captivo_ft');if(!n){n=document.createElement('div');n.id='__captivo_ft';n.setAttribute('style','position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;max-width:90vw;background:#1f2328;color:#fff;font:14px/1.4 system-ui,sans-serif;padding:10px 16px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.25);pointer-events:none');(document.body||document.documentElement).appendChild(n);}n.textContent=m;n.style.display='block';clearTimeout(n._t);n._t=setTimeout(function(){n.style.display='none';},4000);}catch(e){}}` +
		`function stop(e,m){e.preventDefault();e.stopImmediatePropagation();note(m);}` +
		`function refuse(m){return function(){note(m);return Promise.reject(new DOMException(m,'AbortError'));};}` +
		`function isFile(el){return el&&el.tagName==='INPUT'&&String(el.type).toLowerCase()==='file';}` +
		`if(!c.u){` +
		`addEventListener('click',function(e){if(isFile(e.target))stop(e,UM);},true);` +
		`function files(d){if(!d)return false;if(d.files&&d.files.length)return true;var t=d.types;if(t)for(var i=0;i<t.length;i++)if(t[i]==='Files')return true;return false;}` +
		`['dragenter','dragover'].forEach(function(n){addEventListener(n,function(e){if(files(e.dataTransfer)){e.preventDefault();e.stopImmediatePropagation();e.dataTransfer.dropEffect='none';}},true);});` +
		`addEventListener('drop',function(e){if(files(e.dataTransfer))stop(e,UM);},true);` +
		`addEventListener('paste',function(e){if(e.clipboardData&&e.clipboardData.files&&e.clipboardData.files.length)stop(e,UM);},true);` +
		`var P=HTMLInputElement.prototype,ic=P.click,sp=P.showPicker;P.click=function(){if(isFile(this)){note(UM);return;}return ic.apply(this,arguments);};` +
		`if(sp)P.showPicker=function(){if(isFile(this)){note(UM);return;}return sp.apply(this,arguments);};` +
		`if(window.showOpenFilePicker)window.showOpenFilePicker=refuse(UM);if(window.showDirectoryPicker)window.showDirectoryPicker=refuse(UM);}` +
		`if(!c.d){` +
		`function bad(a){try{return a.hasAttribute('download')||/^\s*(blob|data):/i.test(String(a.getAttribute('href')||''));}catch(e){return false;}}` +
		`['click','auxclick'].forEach(function(n){addEventListener(n,function(e){var a=e.target&&e.target.closest?e.target.closest('a[href],area[href]'):null;if(a&&bad(a))stop(e,DM);},true);});` +
		`var A=HTMLAnchorElement.prototype,ac=A.click;A.click=function(){if(bad(this)){note(DM);return;}return ac.apply(this,arguments);};` +
		`var wo=window.open;window.open=function(u){if(/^\s*(blob|data):/i.test(String(u||''))){note(DM);return null;}return wo.apply(window,arguments);};` +
		`if(window.showSaveFilePicker)window.showSaveFilePicker=refuse(DM);}` +
		`}catch(e){}})();</script>`
}
