package main

import (
	"net/url"
	"slices"
	"strings"
)

// What a Kubernetes API request asks for, read off its path the way the API
// server's own request-info does, and the resource's rules for it. The proxy
// (kubeproxy.go) refuses before the request leaves, so a rule holds whatever
// the cluster's RBAC would allow the service account.

type kubeReq struct {
	Verb        string // get, list, watch, create, update, patch, delete, deletecollection
	Group       string // "" for the core group
	Resource    string // pods, deployments, ...
	Sub         string // exec, attach, portforward, proxy, log, status, ...
	Namespace   string
	Name        string
	NonResource bool // discovery, /version, /openapi, /healthz
}

// namespaceSubresources are the subresources of a Namespace object itself
// (/api/v1/namespaces/{name}/status), not a namespace's resources.
var namespaceSubresources = map[string]bool{"status": true, "finalize": true}

func parseKubeReq(method, path string, q url.Values) kubeReq {
	parts := strings.Split(strings.Trim(path, "/"), "/")
	var k kubeReq
	switch {
	case len(parts) >= 3 && parts[0] == "api":
		parts = parts[2:]
	case len(parts) >= 4 && parts[0] == "apis":
		k.Group = parts[1]
		parts = parts[3:]
	default:
		k.NonResource = true
		k.Verb = strings.ToLower(method)
		return k
	}
	watchPrefix := false
	if len(parts) > 0 && parts[0] == "watch" {
		watchPrefix = true
		parts = parts[1:]
	}
	if len(parts) >= 2 && parts[0] == "namespaces" {
		if len(parts) >= 3 && !namespaceSubresources[parts[2]] {
			k.Namespace = parts[1]
			parts = parts[2:]
		}
	}
	if len(parts) > 0 {
		k.Resource = parts[0]
	}
	if len(parts) > 1 {
		k.Name = parts[1]
	}
	if len(parts) > 2 {
		k.Sub = parts[2]
	}
	watch := q.Get("watch") == "true" || q.Get("watch") == "1"
	switch strings.ToUpper(method) {
	case "GET", "HEAD":
		switch {
		case watchPrefix || watch:
			k.Verb = "watch"
		case k.Name == "":
			k.Verb = "list"
		default:
			k.Verb = "get"
		}
	case "POST":
		k.Verb = "create"
	case "PUT":
		k.Verb = "update"
	case "PATCH":
		k.Verb = "patch"
	case "DELETE":
		if k.Name == "" {
			k.Verb = "deletecollection"
		} else {
			k.Verb = "delete"
		}
	default:
		k.Verb = strings.ToLower(method)
	}
	return k
}

// interactive: a request that opens a stream into a container.
func (k kubeReq) interactive() bool {
	return k.Resource == "pods" && k.Group == "" && (k.Sub == "exec" || k.Sub == "attach")
}

// forwarding: a request that reaches a port inside the cluster (port-forward,
// or the API server's proxy to a pod, service or node).
func (k kubeReq) forwarding() bool {
	return (k.Resource == "pods" && k.Sub == "portforward") || k.Sub == "proxy"
}

func (k kubeReq) reads() bool { return k.Verb == "get" || k.Verb == "list" || k.Verb == "watch" }

// The reviews kubectl auth can-i and tools ask; they change nothing.
var selfReviews = map[string]bool{"selfsubjectaccessreviews": true, "selfsubjectrulesreviews": true, "selfsubjectreviews": true}

// clusterReadable are cluster-wide kinds a user limited to some namespaces may
// still read (tools look at them to draw the cluster); anything else without
// a namespace is refused, since a request like /api/v1/pods would list every
// namespace's.
var clusterReadable = map[string]bool{
	"nodes": true, "namespaces": true, "persistentvolumes": true, "storageclasses": true, "customresourcedefinitions": true,
	"apiservices": true, "priorityclasses": true, "ingressclasses": true, "runtimeclasses": true, "csidrivers": true, "csinodes": true,
}

type kubeRules struct {
	ReadOnly    bool
	Namespaces  []string // empty: every namespace
	PortForward bool
}

// check says whether the resource's rules let this request through, and why
// not in words kubectl shows.
func (r kubeRules) check(k kubeReq) (bool, string) {
	if k.NonResource {
		if r.ReadOnly && k.Verb != "get" && k.Verb != "head" {
			return false, "this resource is read-only"
		}
		return true, ""
	}
	if selfReviews[k.Resource] && k.Verb == "create" {
		return true, ""
	}
	if k.forwarding() && (!r.PortForward || r.ReadOnly) {
		return false, "port forwarding is off on this resource"
	}
	if r.ReadOnly {
		if k.interactive() {
			return false, "this resource is read-only: kubectl exec and attach are off"
		}
		if k.Resource == "secrets" && k.Group == "" {
			return false, "this resource is read-only: secrets can't be read"
		}
		if !k.reads() {
			return false, "this resource is read-only"
		}
	}
	if len(r.Namespaces) > 0 {
		if k.Namespace != "" {
			if !slices.Contains(r.Namespaces, k.Namespace) {
				return false, "this resource reaches only the namespaces " + strings.Join(r.Namespaces, ", ")
			}
			return true, ""
		}
		if k.Resource == "namespaces" && k.Name != "" {
			if !slices.Contains(r.Namespaces, k.Name) {
				return false, "this resource reaches only the namespaces " + strings.Join(r.Namespaces, ", ")
			}
			if !k.reads() {
				return false, "namespaces themselves can't be changed through this resource"
			}
			return true, ""
		}
		if !clusterReadable[k.Resource] {
			return false, "this resource reaches only the namespaces " + strings.Join(r.Namespaces, ", ") + "; name one with -n"
		}
		if !k.reads() {
			return false, "cluster-wide objects can't be changed through this resource"
		}
	}
	return true, ""
}

// text is the request as the log shows it: "list pods", "get deployments.apps/api",
// "exec pods/web-1".
func (k kubeReq) text(path string) string {
	if k.NonResource {
		return strings.ToUpper(k.Verb) + " " + path
	}
	res := k.Resource
	if k.Group != "" {
		res += "." + k.Group
	}
	if k.Name != "" {
		res += "/" + k.Name
	}
	verb := k.Verb
	switch {
	case k.Sub == "exec" || k.Sub == "attach" || k.Sub == "portforward" || k.Sub == "proxy":
		verb = k.Sub
	case k.Sub != "":
		res += "/" + k.Sub
	}
	return verb + " " + res
}

// discovery requests (what the cluster serves) are many and say nothing about
// what the user did: they are counted, not logged.
func (k kubeReq) discovery() bool { return k.NonResource }
