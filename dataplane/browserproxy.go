package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"html/template"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// sessionCookieName is the browser cookie set by the control plane's login
// flow (src/lib/auth/cookies.ts) after an authenticated user is redirected
// back from /login.
const sessionCookieName = "ca_session"

// reservedAuthCookies are the proxy's own identity cookies (set by the
// control plane: src/lib/auth/session.ts, challenge.ts, recover-token.ts).
// Because the session cookie is shared across *.access.<domain> subdomains
// (COOKIE_DOMAIN), an upstream app must never be allowed to set or overwrite
// one of these via its own Set-Cookie response headers — otherwise a
// compromised/malicious internal app could fixate or hijack the identity
// cookie proxy-wide. copyRespHeaders drops any Set-Cookie whose name matches
// one of these (case-insensitively).
var reservedAuthCookies = map[string]bool{
	"ca_session":   true,
	"ca_challenge": true,
	"ca_recover":   true,
}

// hopByHopHeaders are stripped in both directions across the proxy boundary,
// per RFC 7230 §6.1 — they describe the state of a single hop's connection
// and must never be blindly forwarded across it.
var hopByHopHeaders = map[string]bool{
	"connection":          true,
	"keep-alive":          true,
	"proxy-authenticate":  true,
	"proxy-authorization": true,
	"te":                  true,
	"trailer":             true,
	"transfer-encoding":   true,
	"upgrade":             true,
}

// denyReasonText maps a DecisionReason (control-plane's evaluateAccess) to a
// short, human-readable message shown on the 403 deny page.
var denyReasonText = map[string]string{
	"no_grant":         "You don't have access to this application.",
	"expired":          "Your access has expired.",
	"not_yet":          "Your access hasn't started yet.",
	"revoked":          "Your access was revoked.",
	"pending_approval": "Your access is awaiting approval.",
	"user_disabled":    "Your account is disabled.",
	"off_schedule":     "Your access isn't available at this time.",
	"denied":           "Your access request was declined.",
	"ip_not_allowed":   "Access from your network isn't allowed.",
}

// errPageTmpl renders the browser-facing proxy error page: a neutral,
// self-contained "Captivo Access" card, light/dark aware, no external assets
// or JS. Dynamic fields are auto-HTML-escaped by html/template.
var errPageTmpl = template.Must(template.New("errpage").Parse(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{.Title}} · Captivo Access</title>
<style>
:root { --bg:#f6f7f9; --card:#fff; --fg:#1a1d21; --muted:#6b7280; --border:#e5e7eb; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#0f1115; --card:#171a1f; --fg:#e6e8eb; --muted:#9aa1ab; --border:#262a30; }
}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;align-items:center;justify-content:center;padding:1.5rem}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;max-width:30rem;width:100%;padding:2.25rem 2rem;box-shadow:0 1px 2px rgba(0,0,0,.04),0 8px 24px rgba(0,0,0,.06)}
.brand{font-size:.72rem;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);font-weight:600;margin:0 0 1.25rem}
.status{font-size:.8rem;color:var(--muted);font-weight:600;margin:0 0 .35rem}
h1{font-size:1.4rem;line-height:1.25;margin:0 0 .6rem;font-weight:650}
.detail{margin:0 0 1rem}
.hint{margin:0;color:var(--muted);font-size:.92rem}
</style>
</head>
<body>
<main class="card">
<p class="brand">Captivo Access</p>
<p class="status">{{.Status}}</p>
<h1>{{.Title}}</h1>
<p class="detail">{{.Detail}}</p>
<p class="hint">{{.Hint}}</p>
</main>
</body>
</html>
`))

type errPageData struct {
	Status int
	Title  string
	Detail string
	Hint   string
}

// errorPage writes a styled HTML error page. Used for all browser-facing proxy
// failures so a vendor never sees a bare plain-text error. Title, Detail, and
// Hint all go through html/template's default contextual auto-escaping (each
// is rendered into a text/RCDATA position: <title>, <h1>, <p>). The escaper
// rewrites &, <, >, and apostrophes as needed (an apostrophe becomes an HTML
// entity that browsers render back as a literal apostrophe) -- expected and
// safe, not a bug.
func errorPage(w http.ResponseWriter, status int, title, detail, hint string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	_ = errPageTmpl.Execute(w, errPageData{Status: status, Title: title, Detail: detail, Hint: hint})
}

// gatewayUserHeader carries the authenticated vendor's identity to a gateway
// Site's Guacamole (header-auth). It is TRUSTED by Guacamole, so it is stripped
// from all client input and set only from the server-resolved session, only for
// gateway Sites (see setGatewayIdentity). Guacamole must never be reachable
// except through this proxy.
const gatewayUserHeader = "X-Captivo-User"

// setGatewayIdentity injects the vendor's email as the trusted gateway header,
// only for gateway Sites with a resolved email.
func setGatewayIdentity(h map[string][]string, gateway bool, email string) {
	if gateway && email != "" {
		h[gatewayUserHeader] = []string{email}
	}
}

// --- Recording consent gate (opt-in) ---

const consentCookieName = "ca_rec_consent"
const consentPath = "/__captivo/consent"

// setConsentCookie marks that the vendor acknowledged recording. Session-scoped
// (no expiry -> cleared on browser close -> fresh consent each session) and
// host-only (-> per recorded Site).
func setConsentCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     consentCookieName,
		Value:    "1",
		Path:     "/",
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
	})
}

// consentReturnTo returns a safe same-site path to resume after consent: the
// ?returnTo query if it is a site-relative path, else "/". Guards open redirects.
func consentReturnTo(r *http.Request) string {
	rt := r.URL.Query().Get("returnTo")
	if strings.HasPrefix(rt, "/") && !strings.HasPrefix(rt, "//") {
		return rt
	}
	return "/"
}

type consentData struct {
	ContinueHref template.URL
	BackHref     template.URL
}

// consentTmpl is the self-contained recording-consent interstitial (inline CSS,
// light/dark, no JS). The hrefs are server-built and marked template.URL; there
// is no free dynamic text.
var consentTmpl = template.Must(template.New("consent").Parse(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>This session is recorded · Captivo Access</title>
<style>
:root { --bg:#f6f7f9; --card:#fff; --fg:#1a1d21; --muted:#6b7280; --border:#e5e7eb; --accent:#3358d4; }
@media (prefers-color-scheme: dark){ :root{ --bg:#0f1115; --card:#171a1f; --fg:#e6e8eb; --muted:#9aa1ab; --border:#262a30; --accent:#5b8cff; } }
*{box-sizing:border-box} html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;align-items:center;justify-content:center;padding:1.5rem}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;max-width:31rem;width:100%;padding:2.25rem 2rem;box-shadow:0 1px 2px rgba(0,0,0,.04),0 8px 24px rgba(0,0,0,.06)}
.brand{font-size:.72rem;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);font-weight:600;margin:0 0 1.1rem}
.rec{display:inline-flex;align-items:center;gap:.4rem;font-size:.75rem;font-weight:600;color:var(--muted);margin:0 0 .5rem}
.rec .dot{width:8px;height:8px;border-radius:50%;background:#ef4444}
h1{font-size:1.4rem;line-height:1.25;margin:0 0 .6rem;font-weight:650}
.detail{margin:0 0 1.4rem;color:var(--fg)}
.actions{display:flex;flex-wrap:wrap;gap:.6rem}
.btn{display:inline-flex;align-items:center;justify-content:center;padding:.6rem 1rem;border-radius:8px;border:1px solid var(--border);text-decoration:none;color:var(--fg);font-weight:600;font-size:.9rem}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
</style>
</head>
<body>
<main class="card">
<p class="brand">Captivo Access</p>
<p class="rec"><span class="dot"></span> Recording notice</p>
<h1>This session will be recorded</h1>
<p class="detail">Your activity in this application will be recorded for security and compliance for the duration of your session. Continue only if you agree.</p>
<div class="actions">
<a class="btn primary" href="{{.ContinueHref}}">I understand — continue</a>
<a class="btn" href="{{.BackHref}}">Not now</a>
</div>
</main>
</body>
</html>
`))

// consentPage serves the interstitial for the vendor's original request. The
// Continue link carries the original path so consent can resume it.
func (p *BrowserProxy) consentPage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_ = consentTmpl.Execute(w, consentData{
		ContinueHref: template.URL(consentPath + "?returnTo=" + url.QueryEscape(r.URL.RequestURI())),
		BackHref:     template.URL(p.managerURL + "/access"),
	})
}

// proxyControl is the subset of ControlClient that BrowserProxy depends on.
// Tests inject a fake implementation; *ControlClient satisfies it for
// production use.
type proxyControl interface {
	ResolveSession(token string) (userID, email string, err error)
	SiteByHost(host string) (siteID, connectorID, upstreamUrl, clipboardMode string, insecureSkipVerify, recordSessions, gateway, consentRequired, watermark bool, err error)
	CheckAccess(userID, siteID, clientIP string) (allow bool, reason string, err error)
	RecorderJS() ([]byte, error)
	SendRecording(userID, siteID, host string, body []byte) error
}

// BrowserProxy is the browser-facing identity-aware reverse proxy: it
// resolves the caller's session, the target site for the request's Host,
// and the access decision, then streams the request/response through the
// resolved connector's tunnel (see spec §3).
type BrowserProxy struct {
	reg        *Registry
	ctrl       proxyControl
	managerURL string
	audit      *AuditQueue
	web        *WebActivityTracker
	webIdle    time.Duration
}

func (p *BrowserProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	host := forwardedHost(r)

	// 1. Session.
	token := readCookie(r, sessionCookieName)
	userID, email, _ := p.ctrl.ResolveSession(token)
	if userID == "" {
		orig := absoluteURL(r, host)
		http.Redirect(w, r, p.managerURL+"/login?returnTo="+url.QueryEscape(orig), http.StatusFound)
		return
	}

	// 2. Site by host.
	siteID, connectorID, upstream, clipboardMode, insecureSkipVerify, recordSessions, gateway, consentRequired, watermark, err := p.ctrl.SiteByHost(host)
	if err != nil {
		if errors.Is(err, ErrNoSite) {
			errorPage(w, http.StatusNotFound, "No application here", "There's no application published at this address.", "Check the link, or contact your administrator.")
		} else {
			errorPage(w, http.StatusBadGateway, "Application unavailable", "The application didn't respond.", "Try again shortly.")
		}
		return
	}

	// 3. Access decision.
	allow, reason, err := p.ctrl.CheckAccess(userID, siteID, trustedClientIP(r))
	if err != nil {
		errorPage(w, http.StatusBadGateway, "Application unavailable", "The application didn't respond.", "Try again shortly.")
		return
	}
	if !allow {
		p.audit.Enqueue(auditEvent("DENY", reason, userID, siteID, host, r, http.StatusForbidden, 0))
		denyPage(w, reason)
		return
	}

	// Recording consent gate (opt-in via RECORDING_CONSENT_REQUIRED): on a
	// recorded Site, the vendor must acknowledge recording once per browser
	// session before any app content is served, and the acknowledgement is
	// audited. recordSessions is already false unless recording is active
	// (RECORDING_ENABLED + the per-Site toggle). Reserved /__captivo/* paths
	// are exempt (recorder infra).
	if recordSessions && consentRequired {
		if r.URL.Path == consentPath {
			setConsentCookie(w)
			p.audit.Enqueue(auditEvent("ALLOW", "recording_consent", userID, siteID, host, r, http.StatusFound, 0))
			http.Redirect(w, r, consentReturnTo(r), http.StatusFound)
			return
		}
		if !strings.HasPrefix(r.URL.Path, "/__captivo/") && readCookie(r, consentCookieName) == "" {
			p.consentPage(w, r)
			return
		}
	}

	// Reserved recording endpoints the recorder bundle talks to
	// (src/recorder/record-init.ts): never proxied upstream. Handled here,
	// after session/site/access are resolved, so recording is scoped to an
	// authenticated, allowed user on a recording-enabled site.
	if strings.HasPrefix(r.URL.Path, "/__captivo/") {
		p.serveRecording(w, r, userID, siteID, host, recordSessions)
		return
	}

	// WebSocket upgrades take a dedicated raw-relay path — they must branch
	// here, before sanitizeReqHeaders strips the Upgrade/Connection headers.
	if isWebSocketUpgrade(r) {
		p.serveWebSocket(w, r, connectorID, siteID, userID, host, upstream, insecureSkipVerify, gateway, email)
		return
	}

	// 4. Stream through the connector.
	sess := p.reg.Get(connectorID)
	if sess == nil || sess.mux == nil {
		errorPage(w, http.StatusBadGateway, "Application unavailable", "The connector for this application is offline.", "Try again shortly, or contact your administrator.")
		return
	}
	st, err := sess.mux.Open()
	if err != nil {
		errorPage(w, http.StatusBadGateway, "Application unavailable", "The connector for this application is offline.", "Try again shortly, or contact your administrator.")
		return
	}
	defer st.Close() // also unblocks a still-running WriteBody goroutine below

	reqHeaders := sanitizeReqHeaders(r, host)
	setGatewayIdentity(reqHeaders, gateway, email)
	if recordSessions {
		// Force uncompressed HTML from the upstream so the response-path
		// injection below (Step 3) can buffer, modify, and recompute
		// Content-Length without also having to decompress it.
		reqHeaders["Accept-Encoding"] = []string{"identity"}
	}
	dr := tunnel.DialRequest{
		UpstreamUrl:        upstream,
		Method:             r.Method,
		Path:               r.URL.RequestURI(),
		Header:             reqHeaders,
		InsecureSkipVerify: insecureSkipVerify,
	}
	reqBytes, err := json.Marshal(dr)
	if err != nil {
		errorPage(w, http.StatusInternalServerError, "Something went wrong", "An unexpected error occurred.", "Try again shortly.")
		return
	}
	if err := tunnel.WriteFrame(st, reqBytes); err != nil {
		errorPage(w, http.StatusBadGateway, "Application unavailable", "The application didn't respond.", "Try again shortly.")
		return
	}

	// The connector may reply (or error out) before it has read the whole
	// request body — e.g. a handler that redirects or rejects immediately
	// on a large upload. Writing the body to completion before reading the
	// response would deadlock/head-of-line-block on the yamux stream in
	// that case, so the body is streamed in its own goroutine while this
	// goroutine reads the response concurrently. The deferred st.Close()
	// above guarantees this goroutine unblocks (WriteBody returns an error
	// that's safe to ignore) once the handler returns.
	go func() {
		_ = tunnel.WriteBody(st, r.Body)
	}()

	respBytes, err := tunnel.ReadFrame(st)
	if err != nil {
		errorPage(w, http.StatusBadGateway, "Application unavailable", "The application didn't respond.", "Try again shortly.")
		return
	}
	var resp tunnel.DialResponse
	if err := json.Unmarshal(respBytes, &resp); err != nil {
		errorPage(w, http.StatusBadGateway, "Application unavailable", "The application didn't respond.", "Try again shortly.")
		return
	}
	if resp.Error != "" {
		errorPage(w, http.StatusBadGateway, "Application unavailable", "The application didn't respond.", "Try again shortly.")
		return
	}

	copyRespHeaders(w.Header(), resp.Header)
	body := tunnel.NewBodyReader(st)
	watermarkText := ""
	if watermark && !gateway {
		watermarkText = email
	}
	written := p.writeProxyResponse(w, resp, body, recordSessions, clipboardMode, watermarkText)
	accessLog(userID, siteID, host, r.Method, r.URL.Path, resp.Status, written)
	// Emit a single session_open when a new web span starts (so the activity feed
	// shows one "connected" like gateway/isolated), then the per-request ALLOW —
	// which stays in the audit log for compliance but is collapsed out of the feed.
	if p.web.Touch(userID, siteID, host, p.webIdle) {
		p.audit.Enqueue(auditEvent("ALLOW", "session_open", userID, siteID, host, r, resp.Status, 0))
	}
	p.audit.Enqueue(auditEvent("ALLOW", "", userID, siteID, host, r, resp.Status, written))
}

// writeProxyResponse writes the upstream response (status, already-copied
// headers, and body) to w, returning the number of body bytes written. For
// recorded Sites whose response Content-Type starts with text/html, it
// buffers the body (capped at maxInjectableBodyBytes), injects the recorder
// script tag, strips the response's CSP headers (which would otherwise
// block the injected script and the recorder's own outbound requests), and
// recomputes Content-Length. Every other response — non-recorded Sites,
// non-HTML content types, and oversized HTML bodies — is streamed exactly
// as it arrives, unmodified.
func (p *BrowserProxy) writeProxyResponse(w http.ResponseWriter, resp tunnel.DialResponse, body io.Reader, recordSessions bool, clipboardMode, watermarkText string) int64 {
	// Two independent reasons to buffer + rewrite an HTML body: session
	// recording (inject the rrweb recorder) and clipboard restriction
	// (inject the clipboard guard). Either one needs the same treatment —
	// buffer, inject before </body>, strip CSP so the injected inline
	// script runs. When neither applies, stream the body through untouched.
	inject := recordSessions || clipboardRestricted(clipboardMode) || watermarkText != ""
	// isCompressed: an upstream that ignored the Accept-Encoding: identity
	// sent toward it (Step 2) and returned compressed HTML anyway must not
	// have its bytes mangled by injectRecorder, which only understands raw
	// HTML — stream it through unchanged instead, same as the non-HTML path.
	if !inject || !isHTMLContentType(resp.Header) || isCompressed(resp.Header) {
		w.WriteHeader(resp.Status)
		written, _ := io.Copy(w, body)
		return written
	}

	// Read up to maxInjectableBodyBytes+1 bytes: if that many are present,
	// the body exceeds the cap and must be streamed unchanged instead of
	// buffered/injected. buf below holds at most that many bytes read so
	// far either way — for the oversize case it's simply written back out
	// verbatim followed by the rest of the stream, so the response the
	// browser receives is identical to the un-injected path.
	buf, _ := io.ReadAll(io.LimitReader(body, maxInjectableBodyBytes+1))
	if int64(len(buf)) > maxInjectableBodyBytes {
		w.WriteHeader(resp.Status)
		n1, _ := w.Write(buf)
		n2, _ := io.Copy(w, body)
		return int64(n1) + n2
	}

	injected := buf
	if recordSessions {
		injected = injectRecorder(injected)
	}
	if clipboardRestricted(clipboardMode) {
		injected = injectBeforeBody(injected, []byte(clipboardScript(clipboardMode)))
	}
	if watermarkText != "" {
		injected = injectBeforeBody(injected, []byte(watermarkScript(watermarkText)))
	}
	w.Header().Del("Content-Security-Policy")
	w.Header().Del("Content-Security-Policy-Report-Only")
	w.Header().Set("Content-Length", strconv.Itoa(len(injected)))
	w.WriteHeader(resp.Status)
	n, _ := w.Write(injected)
	return int64(n)
}

// isHTMLContentType reports whether header's Content-Type value(s) start
// with "text/html" (case-insensitively, ignoring leading whitespace — e.g.
// "text/html; charset=utf-8" matches). Header keys are matched
// case-insensitively since they originate from the connector's JSON-encoded
// response, not necessarily Go's canonical form.
func isHTMLContentType(header map[string][]string) bool {
	for k, vs := range header {
		if !strings.EqualFold(k, "Content-Type") {
			continue
		}
		for _, v := range vs {
			if strings.HasPrefix(strings.ToLower(strings.TrimSpace(v)), "text/html") {
				return true
			}
		}
	}
	return false
}

// isCompressed reports whether header carries a non-empty Content-Encoding
// value other than "identity" — i.e. the body is compressed and must not be
// treated as raw HTML by injectRecorder. Matched case-insensitively on both
// the header name and its value, for the same reason as isHTMLContentType.
func isCompressed(header map[string][]string) bool {
	for k, vs := range header {
		if !strings.EqualFold(k, "Content-Encoding") {
			continue
		}
		for _, v := range vs {
			v = strings.TrimSpace(v)
			if v != "" && !strings.EqualFold(v, "identity") {
				return true
			}
		}
	}
	return false
}

// recorderScriptTag is injected into recorded-Site HTML responses. It loads
// the recorder bundle from the reserved /__captivo/rec.js endpoint (served
// by serveRecording, never proxied upstream) with `defer` so it never blocks
// page rendering.
const recorderScriptTag = `<script src="/__captivo/rec.js" defer></script>`

// clipboardRestricted reports whether a site's clipboardMode calls for
// injecting the clipboard guard. "allow" (and any unknown value) means no
// restriction; gateway sites always resolve to "allow" before reaching here.
func clipboardRestricted(mode string) bool {
	return mode == "no_copy" || mode == "no_paste" || mode == "none"
}

// clipboardScript builds an inline <script> that suppresses clipboard copy
// (cut/copy) and/or paste inside the vendor's browser for a restricted site.
// It's a deterrent, not a hard control — a determined vendor can disable
// JavaScript; the hard controls live at the gateway (Guacamole). The
// capture-phase (useCapture=true) listeners on document fire before the
// page's own handlers, so the app can't re-enable the blocked action.
func clipboardScript(mode string) string {
	s := `<script>(function(){function b(e){e.preventDefault();e.stopImmediatePropagation();}`
	if mode == "no_copy" || mode == "none" {
		s += `document.addEventListener('copy',b,true);document.addEventListener('cut',b,true);`
	}
	if mode == "no_paste" || mode == "none" {
		s += `document.addEventListener('paste',b,true);`
	}
	return s + `})();</script>`
}

// watermarkScript builds an inline <script> that overlays a tiled, translucent
// DLP watermark (the vendor's identity + a live UTC clock) on the page — the
// transparent-mode counterpart of KasmVNC's -DLP_WatermarkText. pointer-events:
// none, so it never blocks the app; refreshed every minute so screenshots carry
// the time. Deterrent + attribution, like the clipboard guard (a vendor who
// disables JavaScript loses the overlay, but also the app's own scripts).
func watermarkScript(text string) string {
	quoted, _ := json.Marshal(text)
	return `<script>(function(){try{var t=` + string(quoted) + `;var d=document.createElement('div');d.id='__captivo_wm';d.setAttribute('style','position:fixed;inset:0;z-index:2147483646;pointer-events:none;opacity:.14;');` +
		`function svg(s){return "url(\"data:image/svg+xml;utf8,"+encodeURIComponent('<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'420\' height=\'220\'><text x=\'20\' y=\'120\' transform=\'rotate(-24 210 110)\' font-family=\'system-ui,sans-serif\' font-size=\'18\' font-weight=\'600\' fill=\'#000\'>'+s.replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</text></svg>')+"\")";}` +
		`function paint(){var n=new Date();var hh=('0'+n.getUTCHours()).slice(-2),mm=('0'+n.getUTCMinutes()).slice(-2);d.style.backgroundImage=svg(t+'  \u00b7  '+n.toISOString().slice(0,10)+' '+hh+':'+mm+' UTC');}` +
		`paint();setInterval(paint,60000);var m=function(){if(document.body)document.body.appendChild(d);};if(document.body)m();else addEventListener('DOMContentLoaded',m);}catch(e){}})();</script>`
}

// maxInjectableBodyBytes caps how large a recorded-Site HTML response body
// may be for injectRecorder to run against a fully-buffered copy. Above
// this, the response is streamed unchanged (no injection) rather than
// buffering an unbounded body in memory.
const maxInjectableBodyBytes = 8 << 20 // 8 MiB

// injectRecorder inserts recorderScriptTag into an HTML document: before the
// first case-insensitive `</head>` if present, else before the first
// case-insensitive `</body>` if present, else prepended to the whole body.
// The tag is inserted exactly once. Pure function — no I/O.
//
// The search is done directly over the original bytes with an ASCII-only
// case fold (via indexFold/bytes.EqualFold), never through
// strings.ToLower(string(body)): ToLower can change a multi-byte UTF-8
// rune's byte length (e.g. Turkish İ, U+0130, is 2 bytes but lowercases to
// i̇, 3 bytes), which would desync any byte offset found in the lowered
// copy from the original body — corrupting the splice or, for
// length-growing runes before the match, panicking with a
// slice-bounds-out-of-range on body[:i]/body[i:]. `</head>` and `</body>`
// are themselves pure ASCII, so matching case-insensitively per byte against
// the untouched original is both correct and simpler.
func injectRecorder(body []byte) []byte {
	return injectBeforeBody(body, []byte(recorderScriptTag))
}

// injectBeforeBody inserts tag into an HTML document at the same anchor as
// injectRecorder (before </head>, else </body>, else prepended), exactly
// once. Shared by the recorder and clipboard-guard injections. Pure — no I/O.
func injectBeforeBody(body, tag []byte) []byte {
	if i := indexFold(body, []byte("</head>")); i >= 0 {
		return insertAt(body, tag, i)
	}
	if i := indexFold(body, []byte("</body>")); i >= 0 {
		return insertAt(body, tag, i)
	}
	out := make([]byte, 0, len(body)+len(tag))
	out = append(out, tag...)
	out = append(out, body...)
	return out
}

// indexFold returns the index of sub's first ASCII-case-insensitive match
// in b, or -1 if none. Byte-for-byte (not rune-aware) by design: sub is
// always a pure-ASCII marker (`</head>`/`</body>`), so this never needs to
// reason about multi-byte runes in b, unlike strings.ToLower on arbitrary
// UTF-8 content.
func indexFold(b, sub []byte) int {
	for i := 0; i+len(sub) <= len(b); i++ {
		if bytes.EqualFold(b[i:i+len(sub)], sub) {
			return i
		}
	}
	return -1
}

// insertAt splices tag into body immediately before byte offset i.
func insertAt(body, tag []byte, i int) []byte {
	out := make([]byte, 0, len(body)+len(tag))
	out = append(out, body[:i]...)
	out = append(out, tag...)
	out = append(out, body[i:]...)
	return out
}

// maxRecordingBatchBytes caps a single POST /__captivo/rec body. The
// recorder flushes the FullSnapshot as its own batch via a plain (uncapped)
// fetch, so a single batch can be large; 8 MiB is a generous backstop
// against a runaway/malicious client. An oversize body is dropped whole
// (below) rather than forwarded truncated, which would poison the chunk
// with corrupt JSON.
const maxRecordingBatchBytes = 8 << 20 // 8 MiB

// serveRecording intercepts the two reserved /__captivo/* paths the
// recorder bundle talks to. It never reaches the upstream app. Recording is
// fail-silent throughout: any error is swallowed rather than surfaced to the
// page (a site not recording-enabled yields 404; an oversized batch is dropped
// with 204), since a recording hiccup must never be visible to the user or
// break the app being proxied.
func (p *BrowserProxy) serveRecording(w http.ResponseWriter, r *http.Request, userID, siteID, host string, recordSessions bool) {
	if !recordSessions {
		http.NotFound(w, r)
		return
	}
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/__captivo/rec.js":
		js, err := p.ctrl.RecorderJS()
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		_, _ = w.Write(js)
	case r.Method == http.MethodPost && r.URL.Path == "/__captivo/rec":
		body, err := io.ReadAll(io.LimitReader(r.Body, maxRecordingBatchBytes+1))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		if len(body) > maxRecordingBatchBytes {
			// Oversize: drop cleanly rather than forward a truncated,
			// corrupt body. Fail-silent — recording must never surface to
			// the page.
			w.WriteHeader(http.StatusNoContent)
			return
		}
		_ = p.ctrl.SendRecording(userID, siteID, host, body) // best-effort
		w.WriteHeader(http.StatusNoContent)
	default:
		http.NotFound(w, r)
	}
}

// forwardedHost returns the browser-facing hostname for this request: the
// first hop of X-Forwarded-Host if a front proxy set one, otherwise
// r.Host. The result is always lowercased with any port stripped.
func forwardedHost(r *http.Request) string {
	h := r.Header.Get("X-Forwarded-Host")
	if h == "" {
		h = r.Host
	} else if i := strings.IndexByte(h, ','); i >= 0 {
		h = strings.TrimSpace(h[:i])
	}
	if host, _, err := net.SplitHostPort(h); err == nil {
		h = host
	}
	return strings.ToLower(h)
}

// readCookie returns the named cookie's value, or "" if absent.
func readCookie(r *http.Request, name string) string {
	c, err := r.Cookie(name)
	if err != nil {
		return ""
	}
	return c.Value
}

// absoluteURL reconstructs the full URL the browser requested, using
// X-Forwarded-Proto (set by the front TLS proxy) for the scheme, defaulting
// to https since browser-facing sites are never served plaintext.
func absoluteURL(r *http.Request, host string) string {
	scheme := r.Header.Get("X-Forwarded-Proto")
	if scheme == "" {
		scheme = "https"
	}
	return scheme + "://" + host + r.URL.RequestURI()
}

// sanitizeReqHeaders builds the header set forwarded to the connector: the
// inbound request's headers minus hop-by-hop ones, the session cookie
// stripped out of Cookie (other cookies pass through to the app), any
// client-supplied gatewayUserHeader dropped (anti-spoofing — see
// setGatewayIdentity), and X-Forwarded-For/X-Forwarded-Host added toward the
// app.
func sanitizeReqHeaders(r *http.Request, host string) map[string][]string {
	out := map[string][]string{}
	for k, vs := range r.Header {
		if hopByHopHeaders[strings.ToLower(k)] || strings.EqualFold(k, "Cookie") || strings.EqualFold(k, gatewayUserHeader) {
			continue
		}
		cp := make([]string, len(vs))
		copy(cp, vs)
		out[k] = cp
	}
	if ck := filteredCookieHeader(r); ck != "" {
		out["Cookie"] = []string{ck}
	}
	ip := remoteIP(r)
	if ip != "" {
		if existing := r.Header.Get("X-Forwarded-For"); existing != "" {
			ip = existing + ", " + ip
		}
		out["X-Forwarded-For"] = []string{ip}
	}
	out["X-Forwarded-Host"] = []string{host}
	return out
}

// filteredCookieHeader rebuilds a Cookie header value from the request's
// parsed cookies, dropping any of the proxy's own reserved auth cookies
// (ca_session, ca_challenge, ca_recover — case-insensitively) so the app
// never sees them. This mirrors the response-side filtering in
// copyRespHeaders: even if ca_challenge/ca_recover become domain-scoped in
// the future, they must not leak upstream either.
func filteredCookieHeader(r *http.Request) string {
	cookies := r.Cookies()
	parts := make([]string, 0, len(cookies))
	for _, c := range cookies {
		if reservedAuthCookies[strings.ToLower(c.Name)] {
			continue
		}
		parts = append(parts, c.Name+"="+c.Value)
	}
	return strings.Join(parts, "; ")
}

// remoteIP returns the host part of r.RemoteAddr (falling back to the raw
// value if it has no port to split).
func remoteIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// trustedClientIP returns the real client IP as recorded by the trusted front
// proxy: the RIGHTMOST entry of X-Forwarded-For — the hop the immediate proxy
// appended (nginx proxy_add_x_forwarded_for / Caddy) — which a client cannot
// forge by sending its own X-Forwarded-For (any client-supplied value stays to
// the left). Falls back to the socket peer when no XFF is present (no front
// proxy). This assumes a single trusted reverse proxy in front of the
// data-plane, which the shipped deploy provides; it is the value the source-IP
// allowlist is evaluated against, so it must be the un-spoofable one.
func trustedClientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.LastIndexByte(xff, ','); i >= 0 {
			return strings.TrimSpace(xff[i+1:])
		}
		return strings.TrimSpace(xff)
	}
	return remoteIP(r)
}

// copyRespHeaders copies the upstream response headers into dst, stripping
// hop-by-hop ones. Set-Cookie is handled specially: it may appear multiple
// times, and any value naming one of our reserved auth cookies (ca_session,
// ca_challenge, ca_recover) is dropped so an upstream app can never set or
// overwrite the proxy's own identity cookies (session fixation guard). All
// other Set-Cookie values — the app's own cookies — are forwarded unchanged.
func copyRespHeaders(dst http.Header, src map[string][]string) {
	for k, vs := range src {
		if hopByHopHeaders[strings.ToLower(k)] {
			continue
		}
		if strings.EqualFold(k, "Set-Cookie") {
			for _, v := range vs {
				if reservedAuthCookies[strings.ToLower(setCookieName(v))] {
					continue
				}
				dst.Add(k, v)
			}
			continue
		}
		for _, v := range vs {
			dst.Add(k, v)
		}
	}
}

// setCookieName extracts the cookie name from a Set-Cookie header value —
// the substring before the first '=', trimmed of surrounding whitespace.
func setCookieName(setCookie string) string {
	name := setCookie
	if i := strings.IndexByte(setCookie, '='); i >= 0 {
		name = setCookie[:i]
	}
	return strings.TrimSpace(name)
}

// denyPage writes a 403 response with a short, human-readable message for
// the given access-decision reason.
func denyPage(w http.ResponseWriter, reason string) {
	msg, ok := denyReasonText[reason]
	if !ok {
		msg = "You don't have access to this application."
	}
	errorPage(w, http.StatusForbidden, "Access denied", msg,
		"Contact your administrator if you think this is a mistake.")
}

// auditEvent builds the AuditEvent for one access decision (allow or
// authenticated deny). bytes is the response body size on ALLOW (0 on
// DENY, since the deny page is written after this is constructed).
func auditEvent(decision, reason, userID, siteID, host string, r *http.Request, status int, bytes int64) AuditEvent {
	return AuditEvent{
		Timestamp: time.Now(),
		UserID:    userID,
		SiteID:    siteID,
		Host:      host,
		Method:    r.Method,
		Path:      r.URL.Path,
		Status:    status,
		BytesOut:  bytes,
		Decision:  decision,
		Reason:    reason,
		ClientIP:  firstHop(r.Header.Get("X-Forwarded-For")),
		UserAgent: r.UserAgent(),
	}
}

// firstHop returns the first (left-most, i.e. original client) address in a
// comma-separated X-Forwarded-For header value, trimmed of whitespace.
func firstHop(xff string) string {
	if i := strings.IndexByte(xff, ','); i >= 0 {
		xff = xff[:i]
	}
	return strings.TrimSpace(xff)
}

// accessLog emits one structured line per proxied request. log's default
// flags prefix it with a date/time, giving lines of the shape:
// "2026/01/02 15:04:05 user=<id> site=<id> host=<h> method=<m> path=<p> status=<s> bytes=<n>".
func accessLog(userID, siteID, host, method, path string, status int, bytes int64) {
	log.Printf("user=%s site=%s host=%s method=%s path=%s status=%d bytes=%d",
		userID, siteID, host, method, path, status, bytes)
}
