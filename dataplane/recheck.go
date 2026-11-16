package main

import (
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Remote-desktop and isolated-browser sessions are one long WebSocket: the
// sign-in, the grant (its expiry, schedule window, revocation), the user's
// status and the vendor IP allowlist were checked once, when it opened, and
// then never again. A web app is checked on every request; these sessions
// now are too, every recheckInterval: when access no longer holds, the
// session is closed, the reason audited, and the vendor's page told why
// (watch-status "ended").

const recheckInterval = 60 * time.Second

// A recent policy end, so the vendor's page can say why it was disconnected.
type policyEnd struct {
	reason string
	at     time.Time
}

const policyEndMemory = 10 * time.Minute

func endKey(userID, siteID string) string { return userID + "\x00" + siteID }

// EndedReason is why this user's session on this site was last closed by
// policy, if that happened in the last few minutes.
func (h *SessionHub) EndedReason(userID, siteID string) string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	e, ok := h.ended[endKey(userID, siteID)]
	if !ok || time.Since(e.at) > policyEndMemory {
		return ""
	}
	return e.reason
}

func (h *SessionHub) noteEnded(userID, siteID, reason string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for k, e := range h.ended {
		if time.Since(e.at) > policyEndMemory {
			delete(h.ended, k)
		}
	}
	h.ended[endKey(userID, siteID)] = policyEnd{reason: reason, at: time.Now()}
}

// clearEnded forgets an earlier end once the user is back in a session there.
func (h *SessionHub) clearEnded(userID, siteID string) {
	h.mu.Lock()
	delete(h.ended, endKey(userID, siteID))
	h.mu.Unlock()
}

// SetAuth keeps what a recheck needs: the vendor's sign-in token and the
// trusted client address the session was opened from.
func (ls *liveSession) SetAuth(token, clientIP string) {
	ls.mu.Lock()
	ls.authToken, ls.clientIP = token, clientIP
	ls.mu.Unlock()
}

type recheckTarget struct {
	id, userID, siteID, token, clientIP string
}

func (h *SessionHub) recheckTargets() []recheckTarget {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]recheckTarget, 0, len(h.m))
	for _, ls := range h.m {
		ls.mu.Lock()
		if ls.authToken != "" {
			out = append(out, recheckTarget{ls.id, ls.userID, ls.siteID, ls.authToken, ls.clientIP})
		}
		ls.mu.Unlock()
	}
	return out
}

// accessChecker is the part of ControlClient a recheck uses.
type accessChecker interface {
	ResolveSession(token string) (userID, email string, err error)
	CheckAccess(userID, siteID, clientIP string) (allow bool, reason string, err error)
}

// A web app's own long-lived WebSockets (a VM console in a hypervisor panel)
// are relayed raw and so, like a remote-desktop session, were checked only
// when they opened. They are not live sessions in the console, so they are
// kept here rather than in the hub.
var webSockets = struct {
	sync.Mutex
	n uint64
	m map[uint64]*watchedWS
}{m: map[uint64]*watchedWS{}}

type watchedWS struct {
	userID, siteID, token, clientIP string
	close                           func()
}

func watchWebSocket(w *watchedWS) (forget func()) {
	webSockets.Lock()
	webSockets.n++
	id := webSockets.n
	webSockets.m[id] = w
	webSockets.Unlock()
	return func() {
		webSockets.Lock()
		delete(webSockets.m, id)
		webSockets.Unlock()
	}
}

// accessReason is "" while access holds, else why not; ok=false when the
// control plane could not answer (nothing is ended on an outage).
func accessReason(ctrl accessChecker, userID, siteID, token, clientIP string) (reason string, ok bool) {
	uid, _, err := ctrl.ResolveSession(token)
	if err != nil {
		return "", false
	}
	if uid == "" || uid != userID {
		return "signed_out", true
	}
	allow, why, err := ctrl.CheckAccess(userID, siteID, clientIP)
	if err != nil {
		return "", false
	}
	if allow {
		return "", true
	}
	if why == "" {
		why = "denied"
	}
	return why, true
}

// recheckOnce ends every session whose access no longer holds. A control
// plane that cannot be reached ends nothing: an outage must not cut sessions.
func recheckOnce(ctrl accessChecker, hub *SessionHub, audit *AuditQueue) {
	for _, t := range hub.recheckTargets() {
		reason, ok := accessReason(ctrl, t.userID, t.siteID, t.token, t.clientIP)
		if !ok || reason == "" {
			continue
		}
		hub.noteEnded(t.userID, t.siteID, reason)
		if hub.Terminate(t.id) {
			log.Printf("policy-recheck: session %s site=%s user=%s ended: %s", t.id, t.siteID, t.userID, reason)
			if audit != nil {
				r, _ := http.NewRequest(http.MethodGet, "http://dataplane/policy-recheck", nil)
				audit.Enqueue(auditEvent("DENY", "session_end_policy "+strings.ReplaceAll(reason, " ", "_"), t.userID, t.siteID, "", r, http.StatusForbidden, 0))
			}
		}
	}
}

func recheckWebSockets(ctrl accessChecker, audit *AuditQueue) {
	webSockets.Lock()
	list := make([]*watchedWS, 0, len(webSockets.m))
	for _, w := range webSockets.m {
		list = append(list, w)
	}
	webSockets.Unlock()
	for _, w := range list {
		reason, ok := accessReason(ctrl, w.userID, w.siteID, w.token, w.clientIP)
		if !ok || reason == "" {
			continue
		}
		w.close()
		log.Printf("policy-recheck: web socket site=%s user=%s ended: %s", w.siteID, w.userID, reason)
		if audit != nil {
			r, _ := http.NewRequest(http.MethodGet, "http://dataplane/policy-recheck", nil)
			audit.Enqueue(auditEvent("DENY", "session_end_policy "+strings.ReplaceAll(reason, " ", "_"), w.userID, w.siteID, "", r, http.StatusForbidden, 0))
		}
	}
}

func runPolicyRecheck(ctrl accessChecker, hub *SessionHub, audit *AuditQueue) {
	t := time.NewTicker(recheckInterval)
	defer t.Stop()
	for range t.C {
		recheckOnce(ctrl, hub, audit)
		recheckWebSockets(ctrl, audit)
	}
}
