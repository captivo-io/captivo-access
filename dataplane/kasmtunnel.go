package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// openKasmSession asks the in-container broker to start an isolated KasmVNC
// session at url and returns the assigned per-session port. It writes an HTTP/1.0
// POST /session and reads the response over the same relay stream. status is the
// HTTP status (so the caller can surface 503 capacity); err is set only on
// transport/parse failure. This is deliberately self-contained (not shared with
// the former transport A, now removed).
func parseKasmDim(s string) int {
	if s == "" {
		return 0
	}
	n, err := strconv.Atoi(s)
	if err != nil || n < 0 {
		return 0
	}
	return n
}

func splitKasmSize(s string) (int, int, bool) {
	i := strings.IndexByte(s, 'x')
	if i <= 0 {
		return 0, 0, false
	}
	w, e1 := strconv.Atoi(s[:i])
	h, e2 := strconv.Atoi(s[i+1:])
	if e1 != nil || e2 != nil {
		return 0, 0, false
	}
	return w, h, true
}

func clampKasmDim(v, lo, hi, def int) int {
	if v <= 0 {
		return def
	}
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func openKasmSession(rw io.ReadWriter, host, auth, target string, copyOut, pasteIn bool, w, h int, watermarkText string, insecure, keys bool, proxy, proxyToken string) (id string, port, status int, vncAuth string, err error) {
	body := `{"url":` + jsonQuoteKasm(target) +
		`,"copyOut":` + strconv.FormatBool(copyOut) +
		`,"pasteIn":` + strconv.FormatBool(pasteIn) +
		`,"w":` + strconv.Itoa(w) +
		`,"h":` + strconv.Itoa(h) +
		`,"watermarkText":` + jsonQuoteKasm(watermarkText) +
		`,"insecure":` + strconv.FormatBool(insecure) +
		`,"keys":` + strconv.FormatBool(keys) +
		`,"proxy":` + jsonQuoteKasm(proxy) +
		`,"proxyToken":` + jsonQuoteKasm(proxyToken) + `}`
	req := "POST /session HTTP/1.0\r\n" +
		"Host: " + host + "\r\n" + auth +
		"Content-Type: application/json\r\n" +
		"Content-Length: " + strconv.Itoa(len(body)) + "\r\n" +
		"Connection: close\r\n\r\n" + body
	if _, err = io.WriteString(rw, req); err != nil {
		return "", 0, 0, "", err
	}
	resp, rerr := http.ReadResponse(bufio.NewReader(rw), nil)
	if rerr != nil {
		return "", 0, 0, "", rerr
	}
	defer resp.Body.Close()
	status = resp.StatusCode
	if status/100 != 2 {
		return "", 0, status, "", nil
	}
	var out struct {
		ID      string `json:"id"`
		Port    int    `json:"port"`
		VNCAuth string `json:"vncAuth"`
	}
	if derr := json.NewDecoder(resp.Body).Decode(&out); derr != nil {
		return "", 0, status, "", derr
	}
	return out.ID, out.Port, status, out.VNCAuth, nil
}

// pullKasmKeys reads the typed-input events the broker gathered for a session.
// Anything malformed yields nothing: the timeline is an extra, never a reason
// to fail the teardown.
func pullKasmKeys(rw io.ReadWriter, host, auth, id string) []keyEvent {
	if _, err := io.WriteString(rw, "GET /session/"+id+"/keys HTTP/1.0\r\nHost: "+host+"\r\n"+auth+"Connection: close\r\n\r\n"); err != nil {
		return nil
	}
	resp, err := http.ReadResponse(bufio.NewReader(rw), nil)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil
	}
	var events []keyEvent
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&events); err != nil {
		return nil
	}
	out := events[:0]
	for _, e := range events {
		if e.AtMs < 0 || len(e.Text) > 4096 {
			continue
		}
		e.Kind = "text"
		if e.Masked {
			e.Text = "••••"
		}
		out = append(out, e)
	}
	return out
}

// buildKasmCloseRequest formats the broker POST /session/<id>/close call.
func buildKasmCloseRequest(host, auth, id string) string {
	return "POST /session/" + id + "/close HTTP/1.0\r\nHost: " + host + "\r\n" + auth +
		"Content-Length: 0\r\nConnection: close\r\n\r\n"
}

// kasmSessionAddr keeps the host of kasmAddr (host[:port]) and swaps in the
// per-session port, so the reverse-proxy dials the right per-session backend.
func kasmSessionAddr(kasmAddr string, port int) string {
	host := kasmAddr
	if i := strings.LastIndex(kasmAddr, ":"); i >= 0 {
		host = kasmAddr[:i]
	}
	return host + ":" + strconv.Itoa(port)
}

// jsonQuoteKasm JSON-quotes a string (safe against embedded quotes/backslashes).
func jsonQuoteKasm(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// clipboardToKasm maps the site clipboardMode (allow|no_copy|no_paste|none) to the
// KasmVNC DLP booleans: copyOut = server_to_client (isolated -> vendor), pasteIn =
// client_to_server (vendor -> isolated). Unknown/empty defaults to allow (no B1
// regression); the restrictive values are the ones that must be explicit.
func clipboardToKasm(mode string) (copyOut, pasteIn bool) {
	switch mode {
	case "no_copy":
		return false, true
	case "no_paste":
		return true, false
	case "none":
		return false, false
	default: // "allow" and any unknown value
		return true, true
	}
}

// kasmDesc is the ISOLATED-hi-fi connection descriptor from the control plane.
type kasmDesc struct {
	Transport          string `json:"transport"`
	NavigateUrl        string `json:"navigateUrl"`
	KasmAddr           string `json:"kasmAddr"`
	KasmControlAddr    string `json:"kasmControlAddr"`
	ConnectorID        string `json:"connectorId"`
	TenantID           string `json:"tenantId"`
	ClipboardMode      string `json:"clipboardMode"`
	Record             bool   `json:"record"`
	WatermarkText      string `json:"watermarkText"`
	FileTransferMode   string `json:"fileTransferMode"`
	InsecureSkipVerify bool   `json:"insecureSkipVerify"`
	// Typed input in the isolated browser (the broker loads its keys extension);
	// only ever acted on while Record is true.
	KeystrokeLogging bool `json:"keystrokeLogging"`
	// The session's network rule; nil from a manager that predates it.
	Egress *kasmEgress `json:"egress"`
}

// serveKasmTunnel reverse-proxies the vendor's HTTP/WebSocket request to a KasmVNC
// backend (web client + RFB-over-WS) THROUGH the connector. The web client
// (HTML/assets) is static and served by an always-on hub; each WebSocket upgrade
// opens a fresh per-session browser via the in-container broker and is proxied to
// that session's port, closed when the WebSocket ends. The credential/target never
// leaves the customer network — the data-plane only relays.
func serveKasmTunnel(ctrl *ControlClient, reg *Registry, hub *SessionHub, audit *AuditQueue, w http.ResponseWriter, r *http.Request) {
	ck, err := r.Cookie("ca_session")
	if err != nil || ck.Value == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	userID, _, err := ctrl.ResolveSession(ck.Value)
	if err != nil || userID == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	// Captured relay conn for the (WS) isolated session, so the terminate closer can
	// close it. Populated on the reverse proxy's first dial (below); read under the
	// mutex by the closer running on another goroutine.
	var connMu sync.Mutex
	var backendConn net.Conn

	siteID := r.URL.Query().Get("site")
	if siteID == "" {
		if c, e := r.Cookie("ca_kasm_site"); e == nil {
			siteID = c.Value
		}
	}
	var d kasmDesc
	if err := ctrl.post("/api/internal/gateway/descriptor", map[string]string{"userId": userID, "siteId": siteID}, &d); err != nil || d.Transport != "kasm" {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	// Pin the site for the follow-up asset/WS requests (the iframe loads /kasm-tunnel/
	// without ?site on its sub-requests).
	if r.URL.Query().Get("site") != "" {
		http.SetCookie(w, &http.Cookie{Name: "ca_kasm_site", Value: siteID, Path: "/kasm-tunnel", HttpOnly: true, Secure: true, SameSite: http.SameSiteLaxMode})
	}
	// Client-reported screen size for a full-screen desktop: query on the HTML load,
	// cookie for the query-less websockify upgrade (same pattern as ca_kasm_site).
	kasmW := parseKasmDim(r.URL.Query().Get("w"))
	kasmH := parseKasmDim(r.URL.Query().Get("h"))
	if kasmW == 0 || kasmH == 0 {
		if c, e := r.Cookie("ca_kasm_size"); e == nil {
			if cw, ch, ok := splitKasmSize(c.Value); ok {
				if kasmW == 0 {
					kasmW = cw
				}
				if kasmH == 0 {
					kasmH = ch
				}
			}
		}
	}
	if r.URL.Query().Get("w") != "" && r.URL.Query().Get("h") != "" {
		http.SetCookie(w, &http.Cookie{Name: "ca_kasm_size", Value: strconv.Itoa(kasmW) + "x" + strconv.Itoa(kasmH), Path: "/kasm-tunnel", HttpOnly: true, Secure: true, SameSite: http.SameSiteLaxMode})
	}
	sess := reg.Get(d.ConnectorID)
	if sess == nil {
		http.Error(w, "connector offline", http.StatusBadGateway)
		return
	}

	// Non-WebSocket requests (the KasmVNC web client HTML + assets) are static and
	// identical for every session, so they go to the always-on hub. Only the live
	// RFB-over-WebSocket needs a per-session Xvnc.
	backendAddr := d.KasmAddr
	var vncAuth string // this session's VNC websocket password (kasm-browser/control.py)
	if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		// A WebSocket upgrade IS the session boundary. Open a fresh per-session
		// browser via the broker and proxy this WS to its port; close it when the
		// WS ends. Concurrency is capped by the broker (503 capacity).
		// The vendor IP allowlist, as for web apps; the descriptor checked the grant.
		clientIP := trustedClientIP(r)
		if allow, why, err := ctrl.CheckAccess(userID, siteID, clientIP); err != nil || !allow {
			log.Printf("kasm-tunnel site=%s user=%s: access refused (%s) err=%v", siteID, userID, why, err)
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		var id string
		var port, status int
		// The session's network rule goes to the connector first; its browser
		// then reaches the network only through the connector's egress proxy.
		var egressTok, egressProxy string
		if d.Egress != nil {
			if er, e := egressCall(sess, tunnel.EgressRequest{Op: "register", Mode: d.Egress.Mode, Hosts: d.Egress.Hosts, ReportOnly: d.Egress.ReportOnly}); e == nil && er.Token != "" {
				egressTok, egressProxy = er.Token, er.Proxy
				defer func() {
					if rel, e := egressCall(sess, tunnel.EgressRequest{Op: "release", Token: egressTok}); e == nil {
						for _, ev := range egressAudit(rel.Events, userID, siteID, r) {
							audit.Enqueue(ev)
						}
					}
				}()
			} else {
				log.Printf("kasm-tunnel site=%s: no egress proxy on this connector (%v); the session runs unconfined", siteID, e)
			}
		}
		co, pi := clipboardToKasm(d.ClipboardMode)
		if st, e := dialGuacd(sess, d.KasmControlAddr); e == nil {
			cw := clampKasmDim(kasmW, 360, 2560, 1280)
			ch := clampKasmDim(kasmH, 480, 1600, 800)
			id, port, status, vncAuth, e = openKasmSession(st, d.KasmControlAddr, kasmAuth(sess), d.NavigateUrl, co, pi, cw, ch, d.WatermarkText, d.InsecureSkipVerify, d.Record && d.KeystrokeLogging, egressProxy, egressTok)
			st.Close()
			if e != nil {
				http.Error(w, "isolated browser unavailable", http.StatusBadGateway)
				return
			}
		} else {
			http.Error(w, "isolated browser unavailable", http.StatusBadGateway)
			return
		}
		if status == 503 {
			http.Error(w, "isolated browser at capacity", http.StatusServiceUnavailable)
			return
		}
		if status/100 != 2 || port == 0 {
			http.Error(w, "isolated browser unavailable", http.StatusBadGateway)
			return
		}
		backendAddr = kasmSessionAddr(d.KasmAddr, port)
		log.Printf("kasm-tunnel site=%s: hi-fi session %s started on port %d", siteID, id, port)
		var recCleanup func()
		if d.Record {
			// Live-stream the session video to the manager (the video analog of
			// transport A's recWriter): read the broker's ffmpeg WebM output through
			// the connector and forward it in chunks. Closing recConn (on WS end)
			// stops ffmpeg and flushes the tail. Best-effort — never blocks the session.
			if recConn, e := dialGuacd(sess, d.KasmControlAddr); e == nil {
				// Chunks go to the connector already carrying this session, so the
				// video never leaves the customer's network.
				recSend := func(req tunnel.RecWriteRequest) (int, error) { return writeRecChunk(sess, req) }
				kidx := &recIndexReporter{send: ctrl.SendRecording, userID: userID, siteID: siteID, host: d.NavigateUrl, format: "video"}
				rw := newKasmRecWriter(recSend, kidx, d.TenantID,
					newRecordingKey(siteID, userID), siteID, userID, d.NavigateUrl, recordingMaxBytes())
				_, _ = io.WriteString(recConn, "GET /session/"+id+"/rec HTTP/1.0\r\nHost: "+d.KasmControlAddr+"\r\n"+kasmAuth(sess)+"Connection: close\r\n\r\n")
				recDone := make(chan struct{})
				go func() {
					defer close(recDone)
					defer recConn.Close()
					resp, re := http.ReadResponse(bufio.NewReader(recConn), nil)
					if re != nil {
						return
					}
					defer resp.Body.Close()
					buf := make([]byte, 65536)
					for {
						n, er := resp.Body.Read(buf)
						if n > 0 {
							rw.Write(buf[:n])
						}
						if er != nil {
							break
						}
					}
					rw.Close()
				}()
				recCleanup = func() {
					// Stop the live relay -> broker SIGINTs ffmpeg -> /rec/<id>.webm is
					// finalized; wait for the interim chunks to fully drain, then pull
					// the seekable file and replace them.
					recConn.Close()
					<-recDone
					if fc, fe := dialGuacd(sess, d.KasmControlAddr); fe == nil {
						_, _ = io.WriteString(fc, "GET /session/"+id+"/recording HTTP/1.0\r\nHost: "+d.KasmControlAddr+"\r\n"+kasmAuth(sess)+"Connection: close\r\n\r\n")
						if fresp, fre := http.ReadResponse(bufio.NewReader(fc), nil); fre == nil && fresp.StatusCode == 200 {
							seq := 0
							fbuf := make([]byte, 262144)
							for {
								n, er := fresp.Body.Read(fbuf)
								if n > 0 {
									sendFinalizedVideo(recSend, d.TenantID, rw.key, seq, fbuf[:n])
									seq++
								}
								if er != nil {
									break
								}
							}
							fresp.Body.Close()
							// The interim chunks were smaller (64 KiB live relay) and
							// numbered from 0 too; the finalized file overwrote the
							// first `seq` of them. Any beyond that are stale bytes of
							// the live relay that would follow the finished file on
							// replay, so they are blanked (an empty chunk adds nothing
							// to the concatenation, on old connectors as on new).
							blankStaleVideoChunks(recSend, d.TenantID, rw.key, seq, rw.seq)
						}
						fc.Close()
					}
					// Typed input, gathered in the isolated browser by the broker's
					// keys extension (already masked for credential fields and timed
					// from the start of this capture), lands next to the video as the
					// same "keys" stream the gateway writes.
					if d.KeystrokeLogging {
						if kc, ke := dialGuacd(sess, d.KasmControlAddr); ke == nil {
							if events := pullKasmKeys(kc, d.KasmControlAddr, kasmAuth(sess), id); len(events) > 0 {
								newKeyWriter(recSend, d.TenantID, rw.key).post(events)
							}
							kc.Close()
						}
					}
				}
				log.Printf("kasm-tunnel site=%s: recording enabled key=%s", siteID, rw.key)
			} else {
				log.Printf("kasm-tunnel site=%s: recording dial failed err=%v", siteID, e)
			}
		}
		defer func() {
			// Finalize the seekable recording (drain live relay + pull file) BEFORE
			// tearing the session down, so the file still exists on the broker.
			if recCleanup != nil {
				recCleanup()
			}
			if st, e := dialGuacd(sess, d.KasmControlAddr); e == nil {
				_, _ = st.Write([]byte(buildKasmCloseRequest(d.KasmControlAddr, kasmAuth(sess), id)))
				_ = st.Close()
			}
			log.Printf("kasm-tunnel site=%s: hi-fi session %s closed", siteID, id)
		}()

		// Make this isolated session visible + terminable in the console. The closer
		// closes the captured relay conn, which ends proxy.ServeHTTP below and unwinds
		// the deferred broker close above (killing Xvnc/Chromium) — terminate reuses
		// the normal teardown path.
		sessionID := newSessionID()
		hub.RegisterIsolated(sessionID, siteID, userID, d.NavigateUrl, time.Now(), d.ConnectorID, d.KasmAddr, port, id, d.KasmControlAddr, d.FileTransferMode, vncAuth).SetAuth(ck.Value, clientIP)
		hub.clearEnded(userID, siteID)
		hub.SetCloser(sessionID, func() {
			connMu.Lock()
			c := backendConn
			connMu.Unlock()
			if c != nil {
				_ = c.Close()
			}
		})
		defer hub.Remove(sessionID)

		kStart := time.Now()
		audit.Enqueue(auditEvent("ALLOW", "session_open", userID, siteID, d.NavigateUrl, r, http.StatusSwitchingProtocols, 0))
		defer func() {
			audit.Enqueue(auditEvent("ALLOW", "session_close "+compactDur(time.Since(kStart)), userID, siteID, d.NavigateUrl, r, http.StatusSwitchingProtocols, 0))
		}()
	}

	target, _ := url.Parse("http://" + backendAddr)
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.Transport = &http.Transport{
		DialContext: func(_ context.Context, _, _ string) (net.Conn, error) {
			c, e := dialGuacd(sess, backendAddr) // relay to KasmVNC through the connector
			if e == nil {
				connMu.Lock()
				backendConn = c
				connMu.Unlock()
			}
			return c, e
		},
	}
	r.URL.Path = strings.TrimPrefix(r.URL.Path, "/kasm-tunnel")
	if r.URL.Path == "" {
		r.URL.Path = "/"
	}
	setKasmVNCAuth(r, backendAddr != d.KasmAddr, vncAuth)
	proxy.ServeHTTP(w, r)
}

// setKasmVNCAuth prepares a request for KasmVNC. Whatever Authorization the
// browser sent is dropped; a request for a session's own display (its RFB
// websocket) carries that session's password, which only the broker and this
// data-plane know -- neither the vendor nor a page in another isolated session
// can attach to it. The hub's static web client needs none.
func setKasmVNCAuth(r *http.Request, toSession bool, vncAuth string) {
	r.Header.Del("Authorization")
	if toSession && vncAuth != "" {
		r.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(vncAuth)))
	}
}
