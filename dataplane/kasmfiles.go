package main

import (
	"bufio"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// fileTransferAllows maps a site's fileTransferMode to per-direction booleans.
// up = vendor -> isolated (upload); down = isolated -> vendor (download).
// Unknown/empty defaults to denied both ways (isolation-first).
func fileTransferAllows(mode string) (up, down bool) {
	switch mode {
	case "allow":
		return true, true
	case "no_upload":
		return false, true
	case "no_download":
		return true, false
	default: // "none", "", unknown
		return false, false
	}
}

// _safeSeg reduces a query-supplied filename to one safe path segment (defense in
// depth; the broker sanitizes again). It strips path separators and rejects any
// control character (CR/LF etc.) so a crafted name cannot inject headers into the
// broker request (X-Filename) or the download response (Content-Disposition).
func _safeSeg(name string) string {
	name = strings.TrimSpace(name)
	if i := strings.LastIndexAny(name, "/\\"); i >= 0 {
		name = name[i+1:]
	}
	if strings.IndexFunc(name, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0 {
		return ""
	}
	if name == "." || name == ".." {
		return ""
	}
	return name
}

// serveKasmFiles relays isolated-session file transfer between the manager and the
// in-container broker, enforcing the per-site DLP mode stored in the session hub.
// Internal endpoint (secret-guarded by the caller). Query: userId, siteId, op
// (upload|list|download), name (download/upload filename).
func serveKasmFiles(hub *SessionHub, reg *Registry, audit *AuditQueue, w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	userID, siteID, op := q.Get("userId"), q.Get("siteId"), q.Get("op")
	connectorID, ctrlAddr, brokerSID, mode, host, ok := hub.IsolatedFileTarget(userID, siteID)
	if !ok {
		http.Error(w, "no active session", http.StatusConflict)
		return
	}
	up, down := fileTransferAllows(mode)
	isUpload := op == "upload"
	if (isUpload && !up) || (!isUpload && !down) {
		reason := "file-transfer-denied:" + op
		audit.Enqueue(auditEvent("DENY", reason, userID, siteID, host, r, http.StatusForbidden, 0))
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	sess := reg.Get(connectorID)
	if sess == nil {
		http.Error(w, "connector offline", http.StatusBadGateway)
		return
	}
	conn, err := dialGuacd(sess, ctrlAddr)
	if err != nil {
		http.Error(w, "isolated browser unavailable", http.StatusBadGateway)
		return
	}
	defer conn.Close()

	name := _safeSeg(q.Get("name"))
	var uploaded int64
	switch op {
	case "upload":
		if name == "" {
			http.Error(w, "bad name", http.StatusBadRequest)
			return
		}
		req := "POST /session/" + brokerSID + "/upload HTTP/1.0\r\n" +
			"Host: " + ctrlAddr + "\r\n" + kasmAuth(sess) +
			"X-Filename: " + name + "\r\n" +
			"Content-Type: application/octet-stream\r\n" +
			"Content-Length: " + r.Header.Get("Content-Length") + "\r\n" +
			"Connection: close\r\n\r\n"
		if _, err := io.WriteString(conn, req); err != nil {
			http.Error(w, "relay failed", http.StatusBadGateway)
			return
		}
		un, cerr := io.Copy(conn, r.Body)
		if cerr != nil {
			http.Error(w, "relay failed", http.StatusBadGateway)
			return
		}
		uploaded = un
	case "download":
		if name == "" {
			http.Error(w, "bad name", http.StatusBadRequest)
			return
		}
		req := "GET /session/" + brokerSID + "/downloads/" + url.PathEscape(name) + " HTTP/1.0\r\n" +
			"Host: " + ctrlAddr + "\r\n" + kasmAuth(sess) + "Connection: close\r\n\r\n"
		_, _ = io.WriteString(conn, req)
	default: // list
		req := "GET /session/" + brokerSID + "/downloads HTTP/1.0\r\n" +
			"Host: " + ctrlAddr + "\r\n" + kasmAuth(sess) + "Connection: close\r\n\r\n"
		_, _ = io.WriteString(conn, req)
	}

	resp, rerr := http.ReadResponse(bufio.NewReader(conn), nil)
	if rerr != nil {
		http.Error(w, "relay failed", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	if op == "download" {
		w.Header().Set("Content-Disposition", "attachment; filename=\""+name+"\"")
	}
	w.WriteHeader(resp.StatusCode)
	n, _ := io.Copy(w, resp.Body)

	verb := "DOWNLOAD"
	bytesAudited := n // download: bytes streamed out
	if isUpload {
		verb = "UPLOAD"
		bytesAudited = uploaded // upload: bytes received from the vendor, not the broker's ack
	}
	if resp.StatusCode/100 == 2 && op != "list" {
		audit.Enqueue(auditEvent("ALLOW", verb+" file:"+name, userID, siteID, host, r, resp.StatusCode, bytesAudited))
	}
}
