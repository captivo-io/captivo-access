// Command dataplane is the captivo-access data-plane service: it accepts
// connector WSS tunnels (each backed by a yamux session), and exposes an
// internal /proxy API the control plane uses to round-trip HTTP requests
// through a connector.
package main

import (
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// dpAuthorized gates the internal API: the caller must present the
// x-dataplane-secret header, compared in constant time. An unset secret denies
// (fail-closed) so a misconfigured deployment never exposes the internal plane.
func dpAuthorized(r *http.Request, secret string) bool {
	if secret == "" {
		return false
	}
	got := r.Header.Get("x-dataplane-secret")
	return subtle.ConstantTimeCompare([]byte(got), []byte(secret)) == 1
}

func main() {
	secret := os.Getenv("DATAPLANE_SECRET")
	ctrl := NewControlClient(env("CONTROL_PLANE_URL", "http://access-manager:3100"), secret)
	reg := NewRegistry()
	srv := &Server{reg: reg, ctrl: ctrl, rl: newRateLimiter()}

	// WSS listener (exposed to connectors).
	wss := http.NewServeMux()
	wss.HandleFunc("/tunnel", srv.HandleTunnel)
	wss.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })
	go func() { log.Fatal(http.ListenAndServe(env("WSS_ADDR", ":3101"), wss)) }()

	// Internal API (compose-internal only; guarded by x-dataplane-secret).
	hub := NewSessionHub()
	web := NewWebActivityTracker()
	webIdle := time.Duration(envInt("WEB_SESSION_IDLE_SECS", 120)) * time.Second
	// Audit queue is created here (not just before the browser proxy) so the internal
	// mux handlers below — e.g. /kasm-files — can enqueue audit events too.
	audit := NewAuditQueue(envInt("AUDIT_QUEUE_CAP", 10000))
	go RunAuditFlush(audit, func(evs []AuditEvent) error {
		err := ctrl.SendAudit(evs)
		if err != nil {
			log.Printf("audit flush failed: %v (dropped total=%d)", err, audit.Dropped())
		}
		return err
	}, 5*time.Second, 200)
	in := http.NewServeMux()
	in.HandleFunc("/proxy", func(w http.ResponseWriter, r *http.Request) {
		if !dpAuthorized(r, secret) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		var body struct {
			ConnectorID        string              `json:"connectorId"`
			UpstreamUrl        string              `json:"upstreamUrl"`
			Method             string              `json:"method"`
			Path               string              `json:"path"`
			Header             map[string][]string `json:"header"`
			InsecureSkipVerify bool                `json:"insecureSkipVerify"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_body"})
			return
		}
		res, err := Proxy(reg.Get(body.ConnectorID), tunnel.DialRequest{
			UpstreamUrl: body.UpstreamUrl, Method: body.Method, Path: body.Path, Header: body.Header,
			InsecureSkipVerify: body.InsecureSkipVerify,
		})
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"status":      res.Status,
			"header":      res.Header,
			"bodyPreview": base64.StdEncoding.EncodeToString(res.Body),
			"truncated":   res.Truncated,
		})
	})
	in.HandleFunc("/probe", func(w http.ResponseWriter, r *http.Request) {
		if !dpAuthorized(r, secret) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		var body struct {
			ConnectorID string `json:"connectorId"`
			UpstreamUrl string `json:"upstreamUrl"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_body"})
			return
		}
		res, err := Probe(reg.Get(body.ConnectorID), tunnel.ProbeRequest{UpstreamUrl: body.UpstreamUrl})
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": res.Ok, "latencyMs": res.LatencyMs, "error": res.Error})
	})
	registerRecEndpoints(in, secret, reg)
	in.HandleFunc("/kick", func(w http.ResponseWriter, r *http.Request) {
		if !dpAuthorized(r, secret) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		var body struct {
			ConnectorID string `json:"connectorId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.ConnectorID == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_body"})
			return
		}
		if s := reg.Get(body.ConnectorID); s != nil && s.mux != nil {
			s.mux.Close()
		}
		reg.Remove(body.ConnectorID)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	in.HandleFunc("/sessions/terminate", func(w http.ResponseWriter, r *http.Request) {
		if !dpAuthorized(r, secret) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		var body struct {
			SessionID string `json:"sessionId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.SessionID == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_body"})
			return
		}
		found := hub.Terminate(body.SessionID)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "found": found})
	})
	in.HandleFunc("/ldap-test", func(w http.ResponseWriter, r *http.Request) {
		if !dpAuthorized(r, secret) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		var body struct {
			ConnectorID string `json:"connectorId"`
			LdapConfig
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_body"})
			return
		}
		writeJSON(w, http.StatusOK, TestLdap(reg.Get(body.ConnectorID), body.LdapConfig))
	})
	in.HandleFunc("/ldap-resolve", func(w http.ResponseWriter, r *http.Request) {
		if !dpAuthorized(r, secret) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		var body struct {
			ConnectorID string `json:"connectorId"`
			Email       string `json:"email"`
			LdapConfig
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_body"})
			return
		}
		writeJSON(w, http.StatusOK, ResolveUser(reg.Get(body.ConnectorID), body.LdapConfig, body.Email))
	})
	in.HandleFunc("/connector-telemetry", func(w http.ResponseWriter, r *http.Request) {
		if !dpAuthorized(r, secret) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		var body struct {
			ConnectorID string `json:"connectorId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_body"})
			return
		}
		sess := reg.Get(body.ConnectorID)
		if sess == nil {
			writeJSON(w, http.StatusOK, map[string]any{"online": false})
			return
		}
		t, at := sess.Telemetry()
		if t == nil {
			writeJSON(w, http.StatusOK, map[string]any{"online": true, "telemetry": nil})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"online": true, "ageMs": time.Since(at).Milliseconds(), "telemetry": t})
	})
	in.HandleFunc("/connector-policy", func(w http.ResponseWriter, r *http.Request) {
		if !dpAuthorized(r, secret) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		var body struct {
			ConnectorID            string   `json:"connectorId"`
			EgressAllowedTargets   string   `json:"egressAllowedTargets"`
			LogLevel               string   `json:"logLevel"`
			TenantID               string   `json:"tenantId"`
			RecordingRetentionDays int      `json:"recordingRetentionDays"`
			PurgeRecordingKeys     []string `json:"purgeRecordingKeys"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_body"})
			return
		}
		sess := reg.Get(body.ConnectorID)
		if sess == nil {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "reason": "offline"})
			return
		}
		if err := sess.PushPolicy(tunnel.Policy{
			EgressAllowedTargets:   body.EgressAllowedTargets,
			LogLevel:               body.LogLevel,
			TenantID:               body.TenantID,
			RecordingRetentionDays: body.RecordingRetentionDays,
			PurgeRecordingKeys:     body.PurgeRecordingKeys,
		}); err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "reason": "not_ready"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	in.HandleFunc("/sessions", func(w http.ResponseWriter, r *http.Request) {
		if !dpAuthorized(r, secret) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		writeJSON(w, http.StatusOK, hub.List())
	})
	in.HandleFunc("/web-sessions", func(w http.ResponseWriter, r *http.Request) {
		if !dpAuthorized(r, secret) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		writeJSON(w, http.StatusOK, web.List(webIdle))
	})
	in.HandleFunc("/sessions/control", func(w http.ResponseWriter, r *http.Request) {
		if !dpAuthorized(r, secret) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		var body struct {
			SessionID   string `json:"sessionId"`
			OwnerUserID string `json:"ownerUserId"`
			Action      string `json:"action"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.SessionID == "" || body.OwnerUserID == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "reason": "invalid_body"})
			return
		}
		if body.Action == "release" {
			hub.ReleaseControl(body.SessionID, body.OwnerUserID)
			writeJSON(w, http.StatusOK, map[string]any{"ok": true})
			return
		}
		if err := hub.SetControl(body.SessionID, body.OwnerUserID); err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "reason": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	in.HandleFunc("/sessions/watch-status", func(w http.ResponseWriter, r *http.Request) {
		if !dpAuthorized(r, secret) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		watching, controlHeld := hub.WatchStatus(r.URL.Query().Get("userId"), r.URL.Query().Get("siteId"))
		writeJSON(w, http.StatusOK, map[string]any{"watching": watching, "controlHeld": controlHeld})
	})
	in.HandleFunc("/kasm-files", func(w http.ResponseWriter, r *http.Request) {
		if !dpAuthorized(r, secret) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		serveKasmFiles(hub, reg, audit, w, r)
	})
	in.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })
	go func() { log.Fatal(http.ListenAndServe(env("INTERNAL_ADDR", ":3102"), in)) }()

	// Browser-facing identity-aware proxy. A front TLS proxy sits in front
	// of this listener in production; it terminates TLS and forwards here.
	managerURL := env("MANAGER_PUBLIC_URL", "")
	if managerURL == "" {
		log.Printf("WARNING: MANAGER_PUBLIC_URL is empty; unauthenticated proxy requests will redirect to a relative /login on the site host and may loop")
	}

	proxy := &BrowserProxy{reg: reg, ctrl: ctrl, managerURL: managerURL, audit: audit, web: web, webIdle: webIdle}
	// Native gateway WebSocket tunnel (guacamole-common-js <-> guacd). The front
	// nginx forwards /guac-tunnel here; everything else is the browser proxy.
	// The gateway/view session-establishment endpoints each make a manager
	// round-trip (ResolveSession) on every hit, before auth succeeds. Rate-limit
	// them per un-spoofable client IP so an unauthenticated caller can't amplify
	// junk requests into manager load. (The browser proxy is intentionally NOT
	// wrapped — it serves many assets per legitimate page and already redirects
	// unauthenticated requests to /login.)
	gatewayRL := newRateLimiter()
	rlGuard := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if !gatewayRL.allow(trustedClientIP(r), 60, time.Minute) {
				http.Error(w, "rate limited", http.StatusTooManyRequests)
				return
			}
			next(w, r)
		}
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/guac-tunnel", rlGuard(func(w http.ResponseWriter, r *http.Request) { serveGuacTunnel(ctrl, reg, hub, audit, w, r) }))
	mux.HandleFunc("/kasm-tunnel", rlGuard(func(w http.ResponseWriter, r *http.Request) { serveKasmTunnel(ctrl, reg, hub, audit, w, r) }))
	mux.HandleFunc("/kasm-tunnel/", rlGuard(func(w http.ResponseWriter, r *http.Request) { serveKasmTunnel(ctrl, reg, hub, audit, w, r) }))
	mux.HandleFunc("/guac-view", rlGuard(func(w http.ResponseWriter, r *http.Request) { serveGuacView(hub, ctrl, reg, w, r) }))
	mux.HandleFunc("/kasm-view", rlGuard(func(w http.ResponseWriter, r *http.Request) { serveKasmView(hub, ctrl, reg, w, r) }))
	mux.HandleFunc("/kasm-view/", rlGuard(func(w http.ResponseWriter, r *http.Request) { serveKasmView(hub, ctrl, reg, w, r) }))
	mux.Handle("/", proxy)
	log.Fatal(http.ListenAndServe(env("PROXY_ADDR", ":3103"), mux))
}

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func envInt(k string, d int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return d
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}
