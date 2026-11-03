package main

import (
	"context"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
)

// serveKasmView attaches an admin viewer to an active ISOLATED (KasmVNC) session by
// opening a SECOND shared client to the same per-session Xvnc (the vendor stays
// connected thanks to Xvnc -AlwaysShared). Read-only vs control is the client-side
// view_only setting on the KasmVNC web client — this relay is identical either way.
// It mirrors the vendor tunnel's reverse-proxy shape but attaches to an existing hub
// session instead of opening a new one.
func serveKasmView(hub *SessionHub, ctrl *ControlClient, reg *Registry, w http.ResponseWriter, r *http.Request) {
	ck, err := r.Cookie("ca_session")
	if err != nil || ck.Value == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	viewerUserID, _, err := ctrl.ResolveSession(ck.Value)
	if err != nil || viewerUserID == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	// The KasmVNC client's follow-up asset/WS requests carry no ?session, so pin it
	// in a cookie the way the vendor tunnel pins ca_kasm_site.
	sessionID := r.URL.Query().Get("session")
	if sessionID == "" {
		if c, e := r.Cookie("ca_kasm_view"); e == nil {
			sessionID = c.Value
		}
	}
	if r.URL.Query().Get("session") != "" {
		http.SetCookie(w, &http.Cookie{Name: "ca_kasm_view", Value: sessionID, Path: "/kasm-view", HttpOnly: true, Secure: true, SameSite: http.SameSiteLaxMode})
	}

	ls := hub.Get(sessionID)
	if ls == nil {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}
	if allow, e := ctrl.ViewAuthz(viewerUserID, ls.siteID); e != nil || !allow {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	connectorID, kasmAddr, kasmPort := ls.kasmAttach()
	if kasmAddr == "" {
		http.Error(w, "not an isolated session", http.StatusConflict)
		return
	}
	sess := reg.Get(connectorID)
	if sess == nil {
		http.Error(w, "connector offline", http.StatusBadGateway)
		return
	}

	backendAddr := kasmAddr // static web client from the always-on hub
	if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		backendAddr = kasmSessionAddr(kasmAddr, kasmPort) // live RFB on the vendor's display
		ls.addViewer()
		defer ls.removeViewer()
	}
	target, _ := url.Parse("http://" + backendAddr)
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.Transport = &http.Transport{
		DialContext: func(_ context.Context, _, _ string) (net.Conn, error) {
			return dialGuacd(sess, backendAddr) // relay through the connector
		},
	}
	r.URL.Path = strings.TrimPrefix(r.URL.Path, "/kasm-view")
	if r.URL.Path == "" {
		r.URL.Path = "/"
	}
	proxy.ServeHTTP(w, r)
}
