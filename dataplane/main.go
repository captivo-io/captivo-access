// Samba AD's own TLS certificate carries a negative serial number, which Go
// refuses to parse since 1.23; the directory connection (ldap.go) reaches Samba
// DCs over LDAPS. This only relaxes parsing, not verification.
//go:debug x509negativeserial=1

// Command dataplane is the captivo-access data-plane service: it accepts
// connector WSS tunnels (each backed by a yamux session), and exposes an
// internal /proxy API the control plane uses to round-trip HTTP requests
// through a connector.
package main

import (
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
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
	live := NewWebLiveHub()
	webIdle := time.Duration(envInt("WEB_SESSION_IDLE_SECS", 120)) * time.Second
	// Audit queue is created here (not just before the browser proxy) so the internal
	// mux handlers below — e.g. /kasm-files — can enqueue audit events too.
	audit := NewAuditQueue(envInt("AUDIT_QUEUE_CAP", 10000))
	// Live remote-desktop / isolated sessions: is access still granted? (recheck.go)
	go runPolicyRecheck(ctrl, hub, audit)
	go RunAuditFlush(audit, func(evs []AuditEvent) error {
		err := ctrl.SendAudit(evs)
		if err != nil {
			log.Printf("audit flush failed: %v (dropped total=%d)", err, audit.Dropped())
		}
		return err
	}, 5*time.Second, 200)
	// SSH jump host for a user's own SSH client (sshjump.go). SSH_ADDR=off turns it off.
	sshTickets := newSSHTickets()
	sshInfo, err := startSSHJump(env("SSH_ADDR", ":2222"), env("SSH_HOST_KEY_FILE", "/data/ssh_host_ed25519_key"), sshJumpDeps{
		ctrl: ctrl, hub: hub, audit: audit, tickets: sshTickets, now: time.Now,
		dial: func(connectorID, target string) (net.Conn, error) { return dialRdp(reg.Get(connectorID), target) },
		pick: func(c []routeCandidate) routeCandidate { p, _ := pickLeastLoaded(reg, hub, c); return p },
		rec:  sshRecDeps{session: reg.Get, recIndex: ctrl.SendRecording},
		noteHostKey: func(siteID, fp string) {
			if err := ctrl.NoteSshHostKey(siteID, fp); err != nil {
				log.Printf("ssh jump: site=%s keeping the server's host key failed: %v", siteID, err)
			}
		},
	})
	if err != nil {
		log.Printf("WARNING: ssh jump host not started: %v", err)
	}
	// PostgreSQL, MySQL and SQL Server clients for database resources (pgproxy.go,
	// mysqlproxy.go, mssqlproxy.go). DB_ADDR=off / MYSQL_ADDR=off / MSSQL_ADDR=off turns one off. Without DB_TLS_CERT/DB_TLS_KEY
	// it keeps a self-signed certificate in DB_TLS_DIR.
	edgeCert, err := newEdgeCert(os.Getenv("DB_TLS_CERT"), os.Getenv("DB_TLS_KEY"), env("DB_TLS_DIR", "/data"))
	if err != nil {
		log.Printf("WARNING: no certificate for the database proxies and recorded native RDP: %v", err)
	}
	dbOn, myOn, msOn, err := startDbProxy(env("DB_ADDR", ":15432"), env("MYSQL_ADDR", ":13306"), env("MSSQL_ADDR", ":11433"), edgeCert, pgProxyDeps{
		ctrl: ctrl, hub: hub, audit: audit, now: time.Now, recIndex: ctrl.SendRecording,
		session: reg.Get,
		pick:    func(c []routeCandidate) routeCandidate { p, _ := pickLeastLoaded(reg, hub, c); return p },
	})
	if err != nil {
		log.Printf("WARNING: database proxy not started: %v", err)
	}
	in := http.NewServeMux()
	in.HandleFunc("/db-info", func(w http.ResponseWriter, r *http.Request) {
		if !dpAuthorized(r, secret) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"enabled": dbOn, "mysql": myOn, "mssql": msOn})
	})
	in.HandleFunc("/ssh-ticket", serveSSHTicket(sshInfo, sshTickets, secret))
	in.HandleFunc("/ssh-info", serveSSHInfo(sshInfo, secret))
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
	in.HandleFunc("/vault-reseal", func(w http.ResponseWriter, r *http.Request) {
		if !dpAuthorized(r, secret) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		var body struct {
			ConnectorID string              `json:"connectorId"`
			Items       []tunnel.ResealItem `json:"items"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<20)).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_body"})
			return
		}
		res, err := Reseal(reg.Get(body.ConnectorID), tunnel.ResealRequest{Items: body.Items})
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, res)
	})
	in.HandleFunc("/vault-rotate", func(w http.ResponseWriter, r *http.Request) {
		if !dpAuthorized(r, secret) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		var body struct {
			ConnectorID string               `json:"connectorId"`
			Request     tunnel.RotateRequest `json:"request"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_body"})
			return
		}
		res, err := Rotate(reg.Get(body.ConnectorID), body.Request)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, res)
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
	in.HandleFunc("/ldap-groups", func(w http.ResponseWriter, r *http.Request) {
		if !dpAuthorized(r, secret) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		var body struct {
			ConnectorID string `json:"connectorId"`
			Query       string `json:"query"`
			LdapConfig
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_body"})
			return
		}
		writeJSON(w, http.StatusOK, SearchGroups(reg.Get(body.ConnectorID), body.LdapConfig, body.Query))
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
		out := map[string]any{"online": true, "ageMs": time.Since(at).Milliseconds(), "telemetry": t}
		if d, ok := sess.RTT(2 * time.Second); ok {
			out["edgeLatencyMs"] = float64(d.Microseconds()) / 1000
		}
		writeJSON(w, http.StatusOK, out)
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
	// An update or removal of a connector's host, asked from the console. The
	// answer says whether the connector handed it to its updater; how it went
	// comes later in the connector's telemetry (hostAction).
	in.HandleFunc("/connector-hostaction", func(w http.ResponseWriter, r *http.Request) {
		if !dpAuthorized(r, secret) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		var body struct {
			ConnectorID string `json:"connectorId"`
			tunnel.HostAction
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.ConnectorID == "" || body.ID == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "reason": "invalid_body"})
			return
		}
		sess := reg.Get(body.ConnectorID)
		if sess == nil {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "reason": "offline"})
			return
		}
		ack, err := sess.HostAction(body.HostAction, 10*time.Second)
		switch {
		case errors.Is(err, errHostActionOld):
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "reason": "no_updater"})
		case errors.Is(err, errHostActionTimeout):
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "reason": "no_answer"})
		case err != nil:
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "reason": "not_ready"})
		case ack.Error != "":
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "reason": ack.Error})
		default:
			writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		}
	})
	// Audit records for the SIEM on a connector's network, as syslog messages.
	in.HandleFunc("/connector-logforward", serveLogForward(reg, secret))
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
		list := web.List(webIdle)
		keys := live.LiveKeys()
		for i := range list {
			list[i].LiveKey = keys[list[i].UserID+webKeySep+list[i].SiteID]
			if list[i].LiveKey != "" {
				list[i].Viewers = live.Viewers(list[i].LiveKey)
			}
		}
		writeJSON(w, http.StatusOK, list)
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
			// A guest invited into the session (ownerUserId "guest:<invite>"),
			// named to the user; empty for an admin.
			GuestName string `json:"guestName"`
			// An admin's take: control a guest holds comes back to them.
			Force bool `json:"force"`
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
		who := adminWho
		if strings.HasPrefix(body.OwnerUserID, guestPrefix) {
			who = guestWho(body.GuestName)
		}
		if err := hub.SetControlAs(body.SessionID, body.OwnerUserID, who, body.Force); err != nil {
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
		uid, sid := r.URL.Query().Get("userId"), r.URL.Query().Get("siteId")
		watching, guests, controlBy := hub.WatchStatus(uid, sid)
		// "ended": why a recheck closed this vendor's session here, so the page can say so.
		// "message": an admin's recent message, which the page shows once.
		// "guests": invited guests watching; "controlBy": who holds control.
		writeJSON(w, http.StatusOK, map[string]any{"watching": watching, "controlHeld": controlBy != "", "guests": guests, "controlBy": controlBy, "ended": hub.EndedReason(uid, sid), "message": hub.PendingMessage(uid, sid, time.Now())})
	})
	// Close a viewer's views of a session: an admin removed an invited guest.
	in.HandleFunc("/sessions/kick-viewer", func(w http.ResponseWriter, r *http.Request) {
		if !dpAuthorized(r, secret) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		var body struct {
			SessionID string `json:"sessionId"`
			ViewerID  string `json:"viewerId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.SessionID == "" || body.ViewerID == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "reason": "invalid_body"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "found": hub.KickViewer(body.SessionID, body.ViewerID)})
	})
	// A live session's recent events, newest first, for the console's watch panel.
	in.HandleFunc("/sessions/feed", func(w http.ResponseWriter, r *http.Request) {
		if !dpAuthorized(r, secret) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		events, ok := hub.Feed(r.URL.Query().Get("sessionId"))
		if !ok {
			writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "reason": "not_found"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "events": events})
	})
	// An admin's message to the user of a live session.
	in.HandleFunc("/sessions/message", func(w http.ResponseWriter, r *http.Request) {
		if !dpAuthorized(r, secret) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		var body struct {
			SessionID string `json:"sessionId"`
			Text      string `json:"text"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.SessionID == "" || strings.TrimSpace(body.Text) == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "reason": "invalid_body"})
			return
		}
		text := strings.TrimSpace(body.Text)
		if len([]rune(text)) > 280 {
			text = string([]rune(text)[:280])
		}
		m, ok := hub.Message(body.SessionID, text)
		if !ok {
			writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "reason": "not_found"})
			return
		}
		res := map[string]any{"ok": true, "message": m}
		if d := hub.NoticeTerminal(body.SessionID, text); d != "" {
			res["delivery"] = d
		}
		writeJSON(w, http.StatusOK, res)
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

	proxy := &BrowserProxy{reg: reg, ctrl: ctrl, managerURL: managerURL, audit: audit, web: web, webIdle: webIdle, live: live}
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
	mux.HandleFunc("/web-view", rlGuard(func(w http.ResponseWriter, r *http.Request) { serveWebView(live, ctrl, w, r) }))
	// RD Gateway for native Remote Desktop clients (rdpgw.go); the front proxy
	// forwards /remoteDesktopGateway/ on the console host here.
	rdpgw := rdpgwDeps{
		secret: ctrl.Secret, ctrl: ctrl, hub: hub, audit: audit, now: time.Now,
		dial: func(connectorID, target string) (net.Conn, error) { return dialRdp(reg.Get(connectorID), target) },
		pick: func(c []routeCandidate) routeCandidate { p, _ := pickLeastLoaded(reg, hub, c); return p },
		dialRec: func(connectorID string, req tunnel.RdpRecRequest) (net.Conn, tunnel.RdpRecResponse, error) {
			return dialRdpRec(reg.Get(connectorID), req)
		},
		rec: sshRecDeps{session: reg.Get, recIndex: ctrl.SendRecording},
	}
	if edgeCert != nil {
		rdpgw.cert = edgeCert.get
	}
	rdpgwHandler := rlGuard(func(w http.ResponseWriter, r *http.Request) { serveRdpGateway(rdpgw, w, r) })
	mux.HandleFunc(rdpgwPath, rdpgwHandler)
	mux.HandleFunc(strings.TrimSuffix(rdpgwPath, "/"), rdpgwHandler)
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
