package main

import (
	"net/url"
	"strings"
	"testing"
)

func TestParseKubeReq(t *testing.T) {
	cases := []struct {
		method, path, query string
		want                kubeReq
	}{
		{"GET", "/api/v1/namespaces/web/pods", "", kubeReq{Verb: "list", Resource: "pods", Namespace: "web"}},
		{"GET", "/api/v1/namespaces/web/pods", "watch=true", kubeReq{Verb: "watch", Resource: "pods", Namespace: "web"}},
		{"GET", "/api/v1/watch/namespaces/web/pods", "", kubeReq{Verb: "watch", Resource: "pods", Namespace: "web"}},
		{"GET", "/api/v1/namespaces/web/pods/api-1/log", "", kubeReq{Verb: "get", Resource: "pods", Namespace: "web", Name: "api-1", Sub: "log"}},
		{"POST", "/api/v1/namespaces/web/pods/api-1/exec", "command=sh", kubeReq{Verb: "create", Resource: "pods", Namespace: "web", Name: "api-1", Sub: "exec"}},
		{"GET", "/api/v1/namespaces/web/pods/api-1/exec", "command=sh", kubeReq{Verb: "get", Resource: "pods", Namespace: "web", Name: "api-1", Sub: "exec"}},
		{"PATCH", "/apis/apps/v1/namespaces/web/deployments/api", "", kubeReq{Verb: "patch", Group: "apps", Resource: "deployments", Namespace: "web", Name: "api"}},
		{"DELETE", "/apis/apps/v1/namespaces/web/deployments", "", kubeReq{Verb: "deletecollection", Group: "apps", Resource: "deployments", Namespace: "web"}},
		{"GET", "/api/v1/pods", "", kubeReq{Verb: "list", Resource: "pods"}},
		{"GET", "/api/v1/nodes/n1", "", kubeReq{Verb: "get", Resource: "nodes", Name: "n1"}},
		{"GET", "/api/v1/namespaces/web", "", kubeReq{Verb: "get", Resource: "namespaces", Name: "web"}},
		{"PUT", "/api/v1/namespaces/web/finalize", "", kubeReq{Verb: "update", Resource: "namespaces", Name: "web", Sub: "finalize"}},
		{"GET", "/apis/apps/v1", "", kubeReq{Verb: "get", NonResource: true}},
		{"GET", "/version", "", kubeReq{Verb: "get", NonResource: true}},
	}
	for _, c := range cases {
		q, _ := url.ParseQuery(c.query)
		if got := parseKubeReq(c.method, c.path, q); got != c.want {
			t.Errorf("%s %s?%s: got %+v want %+v", c.method, c.path, c.query, got, c.want)
		}
	}
}

func TestKubeRules(t *testing.T) {
	req := func(method, path string) kubeReq { return parseKubeReq(method, path, url.Values{}) }
	ro := kubeRules{ReadOnly: true}
	for _, c := range []struct {
		r    kubeRules
		k    kubeReq
		ok   bool
		why  string
		name string
	}{
		{ro, req("GET", "/api/v1/namespaces/web/pods"), true, "", "read-only lists"},
		{ro, req("DELETE", "/api/v1/namespaces/web/pods/a"), false, "read-only", "read-only deletes"},
		{ro, req("POST", "/api/v1/namespaces/web/pods/a/exec"), false, "exec and attach", "read-only exec"},
		{ro, req("GET", "/api/v1/namespaces/web/pods/a/attach"), false, "exec and attach", "read-only attach by GET"},
		{ro, req("GET", "/api/v1/namespaces/web/secrets/db"), false, "secrets", "read-only secrets"},
		{ro, req("POST", "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews"), true, "", "can-i"},
		{kubeRules{}, req("POST", "/api/v1/namespaces/web/pods/a/portforward"), false, "port forwarding", "forwarding off"},
		{kubeRules{PortForward: true}, req("POST", "/api/v1/namespaces/web/pods/a/portforward"), true, "", "forwarding on"},
		{kubeRules{}, req("GET", "/api/v1/namespaces/web/services/s/proxy"), false, "port forwarding", "service proxy off"},
		{kubeRules{}, req("POST", "/api/v1/namespaces/web/pods/a/exec"), true, "", "exec allowed"},
	} {
		ok, why := c.r.check(c.k)
		if ok != c.ok || (why == "") != (c.why == "") || !strings.Contains(why, c.why) {
			t.Errorf("%s: got %v %q", c.name, ok, why)
		}
	}
	ns := kubeRules{Namespaces: []string{"web", "jobs"}}
	for _, c := range []struct {
		method, path string
		ok           bool
	}{
		{"GET", "/api/v1/namespaces/web/pods", true},
		{"POST", "/apis/apps/v1/namespaces/jobs/deployments", true},
		{"GET", "/api/v1/namespaces/kube-system/secrets", false},
		{"GET", "/api/v1/pods", false},          // every namespace's pods
		{"GET", "/api/v1/nodes", true},          // cluster-wide, read
		{"DELETE", "/api/v1/nodes/n1", false},   // cluster-wide, change
		{"GET", "/api/v1/namespaces/web", true}, // the Namespace object
		{"GET", "/api/v1/namespaces/other", false},
		{"DELETE", "/api/v1/namespaces/web", false},
		{"POST", "/apis/rbac.authorization.k8s.io/v1/clusterrolebindings", false},
		{"GET", "/apis", true},
	} {
		if ok, why := ns.check(req(c.method, c.path)); ok != c.ok {
			t.Errorf("namespaces %s %s: got %v %q", c.method, c.path, ok, why)
		}
	}
}

func TestKubeReqText(t *testing.T) {
	for path, want := range map[string]string{
		"/api/v1/namespaces/web/pods":                  "list pods",
		"/apis/apps/v1/namespaces/web/deployments/api": "get deployments.apps/api",
		"/api/v1/namespaces/web/pods/a/log":            "get pods/a/log",
		"/api/v1/namespaces/web/pods/a/exec":           "exec pods/a",
	} {
		if got := parseKubeReq("GET", path, url.Values{}).text(path); got != want {
			t.Errorf("%s: %q want %q", path, got, want)
		}
	}
}
