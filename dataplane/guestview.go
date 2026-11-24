package main

import (
	"net/http"
	"time"
)

// guestCookie holds an invited guest's pass to the one live session their
// invite is for (src/lib/live/invite-token.ts). The console issues it after
// the guest signs in with Captivo ID; it is never a console sign-in.
const guestCookie = "ca_guest"

// GuestPass is the manager's answer about a guest's cookie for one session.
type GuestPass struct {
	Allow    bool      `json:"allow"`
	ViewerID string    `json:"viewerId"` // "guest:<invite id>"
	Name     string    `json:"name"`
	Until    time.Time `json:"until"`
}

// GuestAuthz asks the manager whether this guest cookie lets its holder watch
// the live session sessionID on siteID. Any refusal is "no".
func (c *ControlClient) GuestAuthz(token, sessionID, siteID string) (GuestPass, error) {
	var out GuestPass
	if err := c.post("/api/internal/gateway/guest-authz", map[string]string{"token": token, "sessionId": sessionID, "siteId": siteID}, &out); err != nil {
		if isHTTPStatus(err) {
			return GuestPass{}, nil
		}
		return GuestPass{}, err
	}
	return out, nil
}

type viewerAuthorizer interface {
	ResolveSession(token string) (userID, email string, err error)
	ViewAuthz(userID, siteID string) (bool, error)
	GuestAuthz(token, sessionID, siteID string) (GuestPass, error)
}

// viewerOf says who asks to watch ls: an admin signed in to the console who
// may watch its site, or a guest whose invite is for exactly this session. The
// status is non-zero when neither: 401 with no credential at all, 403 else.
func viewerOf(ctrl viewerAuthorizer, r *http.Request, ls *liveSession) (watcher, int) {
	status := http.StatusUnauthorized
	if ck, err := r.Cookie("ca_session"); err == nil && ck.Value != "" {
		status = http.StatusForbidden
		if uid, _, err := ctrl.ResolveSession(ck.Value); err == nil && uid != "" {
			if ok, err := ctrl.ViewAuthz(uid, ls.siteID); err == nil && ok {
				return watcher{id: uid}, 0
			}
		}
	}
	if ck, err := r.Cookie(guestCookie); err == nil && ck.Value != "" {
		status = http.StatusForbidden
		g, err := ctrl.GuestAuthz(ck.Value, ls.id, ls.siteID)
		if err == nil && g.Allow && len(g.ViewerID) > len(guestPrefix) && g.ViewerID[:len(guestPrefix)] == guestPrefix && g.Until.After(time.Now()) {
			return watcher{id: g.ViewerID, name: g.Name, guest: true, until: g.Until}, 0
		}
	}
	return watcher{}, status
}
