package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"github.com/kurtserdar/captivo-access/tunnel"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

func refText(t *testing.T, r secretRef) string {
	t.Helper()
	b, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	return refPrefix + string(b)
}

func allowAll(t *testing.T) {
	t.Helper()
	m, _ := ParseAllowedTargets("")
	old := providerAllow
	providerAllow = m
	t.Cleanup(func() { providerAllow = old })
}

func TestOrdinarySecretsAreNotReferences(t *testing.T) {
	if _, isRef, _ := parseSecretRef("hunter2"); isRef {
		t.Fatal("a password was taken for a reference")
	}
	if _, isRef, err := parseSecretRef(refPrefix + "{not json"); !isRef || err == nil {
		t.Fatal("a broken reference must be an error, not a password")
	}
}

func TestReferencesAreChecked(t *testing.T) {
	good := secretRef{Provider: "hashicorp", Address: "https://vault.corp:8200", Path: "ssh/web", Auth: "token", Token: "s.x"}
	if err := good.validate(); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*secretRef){
		"no scheme":    func(r *secretRef) { r.Address = "vault.corp:8200" },
		"credentials":  func(r *secretRef) { r.Address = "https://u:p@vault.corp" },
		"file scheme":  func(r *secretRef) { r.Address = "file:///etc/passwd" },
		"no path":      func(r *secretRef) { r.Path = " / " },
		"no token":     func(r *secretRef) { r.Token = "" },
		"approle bare": func(r *secretRef) { r.Auth, r.RoleID = "approle", "r" },
		"unknown auth": func(r *secretRef) { r.Auth = "ldap" },
		"unknown kv":   func(r *secretRef) { r.KVVersion = 3 },
		"unknown prov": func(r *secretRef) { r.Provider = "lastpass" },
		"cyber no safe": func(r *secretRef) {
			*r = secretRef{Provider: "cyberark", Address: "https://pvwa", AppID: "a", Object: "o"}
		},
		"cyber cert": func(r *secretRef) {
			*r = secretRef{Provider: "cyberark", Address: "https://pvwa", AppID: "a", Safe: "s", Object: "o", ClientCert: "x"}
		},
	} {
		r := good
		mutate(&r)
		if r.validate() == nil {
			t.Errorf("%s was accepted", name)
		}
	}
}

// vaultServer imitates the parts of HashiCorp Vault the connector uses.
func vaultServer(t *testing.T, kv2 bool) (*httptest.Server, *[]string) {
	t.Helper()
	var seen []string
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Method+" "+r.URL.Path+" ns="+r.Header.Get("X-Vault-Namespace"))
		switch {
		case r.URL.Path == "/v1/auth/approle/login":
			var b map[string]string
			_ = json.NewDecoder(r.Body).Decode(&b)
			if b["role_id"] != "role" || b["secret_id"] != "sid" {
				w.WriteHeader(400)
				_, _ = w.Write([]byte(`{"errors":["invalid role or secret ID"]}`))
				return
			}
			_, _ = w.Write([]byte(`{"auth":{"client_token":"s.approle"}}`))
		case kv2 && r.URL.Path == "/v1/kv/data/servers/web01":
			if r.Header.Get("X-Vault-Token") != "s.good" && r.Header.Get("X-Vault-Token") != "s.approle" {
				w.WriteHeader(403)
				_, _ = w.Write([]byte(`{"errors":["permission denied"]}`))
				return
			}
			_, _ = w.Write([]byte(`{"data":{"data":{"password":"Vault-Pass-1","num":5},"metadata":{"version":3}}}`))
		case !kv2 && r.URL.Path == "/v1/kv/servers/web01":
			_, _ = w.Write([]byte(`{"data":{"password":"V1-Pass"}}`))
		case kv2 && r.URL.Path == "/v1/kv/data/servers/gone":
			_, _ = w.Write([]byte(`{"data":{"data":null,"metadata":{"deletion_time":"2026-01-01"}}}`))
		default:
			w.WriteHeader(404)
			_, _ = w.Write([]byte(`{"errors":[]}`))
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &seen
}

func TestHashiCorpTokenAppRoleAndKV1(t *testing.T) {
	allowAll(t)
	srv, seen := vaultServer(t, true)
	base := secretRef{Provider: "hashicorp", Address: srv.URL, Insecure: true, Mount: "kv", Path: "servers/web01", Namespace: "team-a"}
	tok := base
	tok.Auth, tok.Token = "token", "s.good"
	if v, err := resolveSecretRef(t.Context(), &tok); err != nil || v != "Vault-Pass-1" {
		t.Fatalf("token: %q %v", v, err)
	}
	if !strings.Contains(strings.Join(*seen, "|"), "GET /v1/kv/data/servers/web01 ns=team-a") {
		t.Fatalf("requests: %v", *seen)
	}
	ar := base
	ar.Auth, ar.RoleID, ar.SecretID = "approle", "role", "sid"
	if v, err := resolveSecretRef(t.Context(), &ar); err != nil || v != "Vault-Pass-1" {
		t.Fatalf("approle: %q %v", v, err)
	}
	bad := ar
	bad.SecretID = "wrong"
	if _, err := resolveSecretRef(t.Context(), &bad); err == nil || !strings.Contains(err.Error(), "invalid role or secret ID") {
		t.Fatalf("bad approle: %v", err)
	}
	denied := tok
	denied.Token = "s.other"
	if _, err := resolveSecretRef(t.Context(), &denied); err == nil || !strings.Contains(err.Error(), "policy") {
		t.Fatalf("denied: %v", err)
	}
	for field, want := range map[string]string{"num": `no text field "num"`, "missing": `no text field "missing"`} {
		r := tok
		r.Field = field
		if _, err := resolveSecretRef(t.Context(), &r); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("field %s: %v", field, err)
		}
	}
	gone := tok
	gone.Path = "servers/gone"
	if _, err := resolveSecretRef(t.Context(), &gone); err == nil || !strings.Contains(err.Error(), "no current version") {
		t.Fatalf("deleted: %v", err)
	}
	none := tok
	none.Path = "servers/none"
	if _, err := resolveSecretRef(t.Context(), &none); err == nil || !strings.Contains(err.Error(), "no secret") {
		t.Fatalf("missing: %v", err)
	}
	// KV version 1
	srv1, _ := vaultServer(t, false)
	v1 := secretRef{Provider: "hashicorp", Address: srv1.URL, Insecure: true, Mount: "kv", Path: "servers/web01", KVVersion: 1, Auth: "token", Token: "x"}
	if v, err := resolveSecretRef(t.Context(), &v1); err != nil || v != "V1-Pass" {
		t.Fatalf("kv1: %q %v", v, err)
	}
	// Certificate checking: without Insecure or the CA, a self-signed vault is refused.
	strict := tok
	strict.Insecure = false
	if _, err := resolveSecretRef(t.Context(), &strict); err == nil || !strings.Contains(err.Error(), "could not reach") {
		t.Fatalf("strict TLS: %v", err)
	}
}

func TestCyberArkCentralCredentialProvider(t *testing.T) {
	allowAll(t)
	var got url.Values
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/AIMWebService/api/Accounts" {
			w.WriteHeader(404)
			return
		}
		got = r.URL.Query()
		if got.Get("Object") == "locked" {
			w.WriteHeader(404)
			_, _ = w.Write([]byte(`{"ErrorCode":"APPAP004E","ErrorMsg":"Password object matching query was not found"}`))
			return
		}
		_, _ = w.Write([]byte(`{"Content":"Cyber-Pass-9","UserName":"svc","Address":"web01"}`))
	}))
	defer srv.Close()
	r := secretRef{Provider: "cyberark", Address: srv.URL, Insecure: true, AppID: "Captivo", Safe: "Servers", Object: "web01-admin", Folder: "Root"}
	if v, err := resolveSecretRef(t.Context(), &r); err != nil || v != "Cyber-Pass-9" {
		t.Fatalf("%q %v", v, err)
	}
	if got.Get("AppID") != "Captivo" || got.Get("Safe") != "Servers" || got.Get("Object") != "web01-admin" || got.Get("Folder") != "Root" {
		t.Fatalf("query %v", got)
	}
	r.Object = "locked"
	if _, err := resolveSecretRef(t.Context(), &r); err == nil || !strings.Contains(err.Error(), "APPAP004E") || strings.Contains(err.Error(), "web01") {
		t.Fatalf("%v", err)
	}
}

func TestVaultClientCertificateIsSent(t *testing.T) {
	allowAll(t)
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if len(r.TLS.PeerCertificates) == 0 {
			w.WriteHeader(401)
			return
		}
		_, _ = w.Write([]byte(`{"Content":"mtls-pass"}`))
	}))
	srv.TLS = &tls.Config{ClientAuth: tls.RequireAnyClientCert}
	srv.StartTLS()
	defer srv.Close()
	cert, key := selfSignedPair(t)
	r := secretRef{Provider: "cyberark", Address: srv.URL, Insecure: true, AppID: "a", Safe: "s", Object: "o", ClientCert: cert, ClientKey: key}
	if v, err := resolveSecretRef(t.Context(), &r); err != nil || v != "mtls-pass" {
		t.Fatalf("%q %v", v, err)
	}
	r.ClientCert, r.ClientKey = "", ""
	if _, err := resolveSecretRef(t.Context(), &r); err == nil {
		t.Fatal("answered without a client certificate")
	}
}

func TestVaultAddressIsHeldToTheEgressBoundary(t *testing.T) {
	m, _ := ParseAllowedTargets("10.9.0.0/16")
	old := providerAllow
	providerAllow = m
	defer func() { providerAllow = old }()
	r := secretRef{Provider: "hashicorp", Address: "https://vault.elsewhere:8200", Path: "a", Auth: "token", Token: "t"}
	if _, err := resolveSecretRef(t.Context(), &r); err == nil || !strings.Contains(err.Error(), "not allowed") {
		t.Fatalf("%v", err)
	}
}

func TestOpenSecretResolvesAReferenceAndLeavesPasswordsAlone(t *testing.T) {
	allowAll(t)
	srv, _ := vaultServer(t, true)
	k := newVaultTestKey(t)
	aad := vaultTargetAAD("10.0.0.5", "22", "root")
	plain, _ := sealToKey(vaultPublicKeyB64(k), "plain-pass", aad)
	if v, err := openSecret(k, plain, aad); err != nil || v != "plain-pass" {
		t.Fatalf("%q %v", v, err)
	}
	ref, _ := sealToKey(vaultPublicKeyB64(k), refText(t, secretRef{Provider: "hashicorp", Address: srv.URL, Insecure: true, Mount: "kv", Path: "servers/web01", Auth: "token", Token: "s.good"}), aad)
	if v, err := openSecret(k, ref, aad); err != nil || v != "Vault-Pass-1" {
		t.Fatalf("%q %v", v, err)
	}
	// A reference sealed for one host does not open for another.
	if _, err := openSecret(k, ref, vaultTargetAAD("10.0.0.6", "22", "root")); err == nil {
		t.Fatal("opened for another host")
	}
}

func TestRotationNeverTouchesAnExternalVaultCredential(t *testing.T) {
	allowAll(t)
	srv, _ := vaultServer(t, true)
	k := newVaultTestKey(t)
	me := vaultPublicKeyB64(k)
	aad := vaultTargetAAD("10.0.0.5", "22", "root")
	cur, _ := sealToKey(me, refText(t, secretRef{Provider: "hashicorp", Address: srv.URL, Insecure: true, Mount: "kv", Path: "servers/web01", Auth: "token", Token: "s.good"}), aad)
	req := tunnelRotate("verify", cur)
	if r := rotate(t.Context(), k, nil, req); r.Outcome != "ok" {
		t.Fatalf("verify: %+v", r)
	}
	for _, op := range []string{"prepare", "apply", "reveal"} {
		req := tunnelRotate(op, cur)
		req.To = []string{me}
		if r := rotate(t.Context(), k, nil, req); !strings.Contains(r.Error, "external vault") {
			t.Errorf("%s: %+v", op, r)
		}
	}
	bad, _ := sealToKey(me, refText(t, secretRef{Provider: "hashicorp", Address: srv.URL, Insecure: true, Mount: "kv", Path: "servers/web01", Auth: "token", Token: "s.nope"}), aad)
	if r := rotate(t.Context(), k, nil, tunnelRotate("verify", bad)); r.Outcome != "mismatch" || !strings.Contains(r.Detail, "policy") {
		t.Fatalf("a vault that refuses: %+v", r)
	}
}

// Against a real HashiCorp Vault when VAULT_TEST_ADDR is set (dev mode, root token VAULT_TEST_TOKEN,
// kv v2 at secret/ with servers/web01 {password: Real-Vault-Pass}).
func TestHashiCorpReal(t *testing.T) {
	addr := os.Getenv("VAULT_TEST_ADDR")
	if addr == "" {
		t.Skip("VAULT_TEST_ADDR not set")
	}
	allowAll(t)
	r := secretRef{Provider: "hashicorp", Address: addr, Path: "servers/web01", Auth: "token", Token: os.Getenv("VAULT_TEST_TOKEN")}
	if v, err := resolveSecretRef(t.Context(), &r); err != nil || v != "Real-Vault-Pass" {
		t.Fatalf("%q %v", v, err)
	}
	r.Path = "servers/none"
	if _, err := resolveSecretRef(t.Context(), &r); err == nil {
		t.Fatal("a missing secret")
	}
}

func tunnelRotate(op, current string) tunnel.RotateRequest {
	return tunnel.RotateRequest{Op: op, Method: "linux", Host: "10.0.0.5", Port: "22", Username: "root", Current: current}
}

func selfSignedPair(t *testing.T) (certPEM, keyPEM string) {
	t.Helper()
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "captivo"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &k.PublicKey, k)
	if err != nil {
		t.Fatal(err)
	}
	kb, _ := x509.MarshalECPrivateKey(k)
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kb}))
}
