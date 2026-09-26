package main

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// registerRecEndpoints wires the two recording endpoints. Extracted from main so
// the dataplane-secret gate can be tested for real: these reach into a customer's
// own recording store, and "the source says dpAuthorized is called" is not the
// same as proving an unauthenticated request is refused.
func registerRecEndpoints(mux *http.ServeMux, secret string, reg *Registry) {
	// Recording search and replay. The manager holds no tunnel sessions, so these
	// two are how the control plane reaches recordings that live on connectors.
	mux.HandleFunc("/rec-search", func(w http.ResponseWriter, r *http.Request) {
		if !dpAuthorized(r, secret) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		var body struct {
			ConnectorID   string   `json:"connectorId"`
			TenantID      string   `json:"tenantId"`
			Query         string   `json:"query"`
			RecordingKeys []string `json:"recordingKeys"`
			MaxDecrypt    int      `json:"maxDecrypt"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_body"})
			return
		}
		res, err := RecSearch(reg.Get(body.ConnectorID), tunnel.RecSearchRequest{
			TenantID: body.TenantID, Query: body.Query,
			RecordingKeys: body.RecordingKeys, MaxDecrypt: body.MaxDecrypt,
		})
		if err != nil {
			// 502 and a named error, never an empty 200: the caller must be able to
			// report this connector as unreachable rather than as "no matches".
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"matches": res.Matches, "truncated": res.Truncated})
	})
	mux.HandleFunc("/rec-fetch", func(w http.ResponseWriter, r *http.Request) {
		if !dpAuthorized(r, secret) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		var body struct {
			ConnectorID  string `json:"connectorId"`
			TenantID     string `json:"tenantId"`
			RecordingKey string `json:"recordingKey"`
			FromSeq      int    `json:"fromSeq"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_body"})
			return
		}
		sess := reg.Get(body.ConnectorID)
		if sess == nil {
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": "connector offline"})
			return
		}
		// Header before the body: once bytes start flowing the status is fixed, so a
		// mid-stream failure can only truncate. The caller detects that from the
		// recording's expected byte count in the index.
		w.Header().Set("Content-Type", "application/octet-stream")
		w.WriteHeader(http.StatusOK)
		if err := RecFetch(sess, tunnel.RecFetchRequest{
			TenantID: body.TenantID, RecordingKey: body.RecordingKey, FromSeq: body.FromSeq,
		}, w); err != nil {
			log.Printf("rec-fetch key=%s: stream failed err=%v", body.RecordingKey, err)
		}
	})
}
