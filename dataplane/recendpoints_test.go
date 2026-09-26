package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The recording endpoints reach into a customer's own store, so an unauthenticated
// caller must not be able to search or fetch. dpAuthorized is the gate; this pins
// that it is actually applied to both.
func TestRecEndpointsRequireTheDataplaneSecret(t *testing.T) {
	mux := http.NewServeMux()
	registerRecEndpoints(mux, "s3cret", NewRegistry())

	for _, path := range []string{"/rec-search", "/rec-fetch"} {
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{}`))
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("%s without a secret = %d, want 403", path, rec.Code)
		}
	}
}

func TestRecSearchEndpointReportsOfflineRatherThanEmpty(t *testing.T) {
	mux := http.NewServeMux()
	registerRecEndpoints(mux, "s3cret", NewRegistry()) // empty registry = every connector offline

	req := httptest.NewRequest(http.MethodPost, "/rec-search",
		strings.NewReader(`{"connectorId":"c-missing","tenantId":"acme","query":"rm"}`))
	req.Header.Set("x-dataplane-secret", "s3cret")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	// An empty 200 would read to the caller as "searched, found nothing" -- the
	// exact confusion this design has to avoid.
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("offline connector = %d, want 502", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "offline") {
		t.Fatalf("want the reason named, got %s", rec.Body.String())
	}
}
