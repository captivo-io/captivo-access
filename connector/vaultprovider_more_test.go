package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

// AWS's published signing example ("get-vanilla" of the Signature Version 4 test suite).
func TestSigV4MatchesAWSsTestVector(t *testing.T) {
	at := time.Date(2015, 8, 30, 12, 36, 0, 0, time.UTC)
	got := sigV4("GET", "/", "", map[string]string{"Host": "example.amazonaws.com", "X-Amz-Date": "20150830T123600Z"}, nil,
		"AKIDEXAMPLE", "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "us-east-1", "service", at)
	want := "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
	if got != want {
		t.Fatalf("\n got %s\nwant %s", got, want)
	}
}

func TestMoreReferencesAreChecked(t *testing.T) {
	for name, r := range map[string]secretRef{
		"pvwa no user":    {Provider: "cyberark", Mode: "pvwa", Address: "https://pvwa", Safe: "s", Object: "o"},
		"pvwa no account": {Provider: "cyberark", Mode: "pvwa", Address: "https://pvwa", User: "u", Password: "p"},
		"pvwa logon type": {Provider: "cyberark", Mode: "pvwa", Address: "https://pvwa", User: "u", Password: "p", Safe: "s", Object: "o", LogonType: "saml"},
		"azure no secret": {Provider: "azure", Address: "https://v.vault.azure.net", TenantID: "t", ClientID: "c", ClientSecret: "s"},
		"azure no tenant": {Provider: "azure", Address: "https://v.vault.azure.net", ClientID: "c", ClientSecret: "s", SecretName: "n"},
		"azure authority": {Provider: "azure", Address: "https://v.vault.azure.net", TenantID: "t", ClientID: "c", ClientSecret: "s", SecretName: "n", Authority: "ftp://x"},
		"aws no region":   {Provider: "aws", AWSSecretID: "x"},
		"aws bad region":  {Provider: "aws", Region: "eu/../x", AWSSecretID: "x"},
		"aws no secret":   {Provider: "aws", Region: "eu-west-1"},
		"aws half key":    {Provider: "aws", Region: "eu-west-1", AWSSecretID: "x", AccessKeyID: "a"},
	} {
		if r.validate() == nil {
			t.Errorf("%s was accepted", name)
		}
	}
	ok := []secretRef{
		{Provider: "cyberark", Mode: "pvwa", Address: "https://pvwa", User: "u", Password: "p", Safe: "s", Object: "o"},
		{Provider: "cyberark", Mode: "pvwa", Address: "https://pvwa", User: "u", Password: "p", AccountID: "12_3", LogonType: "ldap"},
		{Provider: "azure", Address: "https://v.vault.azure.net", TenantID: "t", ClientID: "c", ClientSecret: "s", SecretName: "n"},
		{Provider: "aws", Region: "eu-central-1", AWSSecretID: "prod/web01"},
	}
	for i, r := range ok {
		if err := r.validate(); err != nil {
			t.Errorf("ok[%d]: %v", i, err)
		}
	}
	a := ok[3]
	_ = a.validate()
	if a.Address != "https://secretsmanager.eu-central-1.amazonaws.com" {
		t.Errorf("default endpoint %q", a.Address)
	}
}

func TestCyberArkPasswordVaultWebAccess(t *testing.T) {
	allowAll(t)
	var calls []string
	var reason string
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path)
		auth := r.Header.Get("Authorization")
		switch {
		case r.URL.Path == "/PasswordVault/API/auth/LDAP/Logon":
			var b map[string]any
			_ = json.NewDecoder(r.Body).Decode(&b)
			if b["username"] != "svc-captivo" || b["password"] != "pw" {
				w.WriteHeader(401)
				_, _ = w.Write([]byte(`{"ErrorCode":"ITATS542I","ErrorMessage":"Authentication failure for user svc-captivo."}`))
				return
			}
			_, _ = w.Write([]byte(`"session-token-1"`))
		case r.URL.Path == "/PasswordVault/API/Accounts" && r.Method == "GET":
			if auth != "session-token-1" {
				w.WriteHeader(401)
				return
			}
			if r.URL.Query().Get("filter") != "safeName eq Servers" {
				t.Errorf("filter %q", r.URL.Query().Get("filter"))
			}
			_, _ = w.Write([]byte(`{"value":[{"id":"12_3","name":"web01-admin-old","safeName":"Servers"},{"id":"12_4","name":"web01-admin","safeName":"Servers"}],"count":2}`))
		case r.URL.Path == "/PasswordVault/API/Accounts/12_4/Password/Retrieve":
			var b map[string]string
			_ = json.NewDecoder(r.Body).Decode(&b)
			reason = b["reason"]
			_, _ = w.Write([]byte(`"PVWA-Pass-5"`))
		case r.URL.Path == "/PasswordVault/API/Accounts/12_9/Password/Retrieve":
			w.WriteHeader(403)
			_, _ = w.Write([]byte(`{"ErrorCode":"PASWS013E","ErrorMessage":"Dual control request is required"}`))
		case r.URL.Path == "/PasswordVault/API/Auth/Logoff":
			_, _ = io.Copy(io.Discard, r.Body)
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	r := secretRef{Provider: "cyberark", Mode: "pvwa", Address: srv.URL, Insecure: true, LogonType: "ldap", User: "svc-captivo", Password: "pw", Safe: "Servers", Object: "web01-admin", Reason: "Captivo: vendor session"}
	v, err := resolveSecretRef(t.Context(), &r)
	if err != nil || v != "PVWA-Pass-5" {
		t.Fatalf("%q %v", v, err)
	}
	if reason != "Captivo: vendor session" {
		t.Fatalf("reason %q", reason)
	}
	if !strings.HasSuffix(strings.Join(calls, "|"), "POST /PasswordVault/API/Auth/Logoff") {
		t.Fatalf("the session was not ended: %v", calls)
	}
	// By id, and the vault's own refusal (dual control) is shown.
	byID := secretRef{Provider: "cyberark", Mode: "pvwa", Address: srv.URL, Insecure: true, LogonType: "ldap", User: "svc-captivo", Password: "pw", AccountID: "12_9"}
	if _, err := resolveSecretRef(t.Context(), &byID); err == nil || !strings.Contains(err.Error(), "Dual control") {
		t.Fatalf("%v", err)
	}
	bad := r
	bad.Password = "wrong"
	if _, err := resolveSecretRef(t.Context(), &bad); err == nil || !strings.Contains(err.Error(), "ITATS542I") {
		t.Fatalf("%v", err)
	}
	none := r
	none.Object = "nope"
	if _, err := resolveSecretRef(t.Context(), &none); err == nil || !strings.Contains(err.Error(), "no account") {
		t.Fatalf("%v", err)
	}
}

func TestAzureKeyVault(t *testing.T) {
	allowAll(t)
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/tenant-1/oauth2/v2.0/token":
			b, _ := io.ReadAll(r.Body)
			f, _ := url.ParseQuery(string(b))
			if f.Get("client_id") != "app" || f.Get("client_secret") != "shh" || f.Get("scope") != "https://vault.azure.net/.default" || f.Get("grant_type") != "client_credentials" {
				w.WriteHeader(401)
				_, _ = w.Write([]byte("{\"error\":\"invalid_client\",\"error_description\":\"AADSTS7000215: Invalid client secret provided.\\r\\nTrace ID: x\"}"))
				return
			}
			_, _ = w.Write([]byte(`{"access_token":"az-token","expires_in":3600}`))
		case r.URL.Path == "/secrets/web01-admin" || r.URL.Path == "/secrets/web01-admin/v2":
			if r.Header.Get("Authorization") != "Bearer az-token" || r.URL.Query().Get("api-version") != "7.4" {
				w.WriteHeader(401)
				return
			}
			v := "Azure-Pass-1"
			if strings.HasSuffix(r.URL.Path, "/v2") {
				v = "Azure-Pass-v2"
			}
			_, _ = w.Write([]byte(`{"value":"` + v + `","id":"x"}`))
		case r.URL.Path == "/secrets/locked":
			w.WriteHeader(403)
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	r := secretRef{Provider: "azure", Address: srv.URL, Authority: srv.URL, Insecure: true, TenantID: "tenant-1", ClientID: "app", ClientSecret: "shh", SecretName: "web01-admin"}
	if v, err := resolveSecretRef(t.Context(), &r); err != nil || v != "Azure-Pass-1" {
		t.Fatalf("%q %v", v, err)
	}
	r.SecretVersion = "v2"
	if v, err := resolveSecretRef(t.Context(), &r); err != nil || v != "Azure-Pass-v2" {
		t.Fatalf("%q %v", v, err)
	}
	bad := r
	bad.ClientSecret = "no"
	if _, err := resolveSecretRef(t.Context(), &bad); err == nil || !strings.Contains(err.Error(), "AADSTS7000215") || strings.Contains(err.Error(), "Trace") {
		t.Fatalf("%v", err)
	}
	for name, want := range map[string]string{"locked": "access policy", "missing": "no such secret"} {
		x := r
		x.SecretName, x.SecretVersion = name, ""
		if _, err := resolveSecretRef(t.Context(), &x); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestAWSSecretsManagerRequestIsSignedAndPicksJSONFields(t *testing.T) {
	allowAll(t)
	var gotAuth, target, token string
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth, target, token = r.Header.Get("Authorization"), r.Header.Get("X-Amz-Target"), r.Header.Get("X-Amz-Security-Token")
		var b map[string]string
		_ = json.NewDecoder(r.Body).Decode(&b)
		switch b["SecretId"] {
		case "prod/web01":
			_, _ = w.Write([]byte(`{"SecretString":"{\"username\":\"root\",\"password\":\"Aws-Pass-1\",\"n\":3}"}`))
		case "plain":
			_, _ = w.Write([]byte(`{"SecretString":"just-text"}`))
		case "denied":
			w.WriteHeader(400)
			_, _ = w.Write([]byte(`{"__type":"AccessDeniedException","message":"User: arn:aws:iam::1:user/x is not authorized"}`))
		default:
			w.WriteHeader(400)
			_, _ = w.Write([]byte(`{"__type":"ResourceNotFoundException","message":"Secrets Manager can't find the specified secret."}`))
		}
	}))
	defer srv.Close()
	r := secretRef{Provider: "aws", Address: srv.URL, Insecure: true, Region: "eu-central-1", AccessKeyID: "AKIAEXAMPLE", SecretAccessKey: "sk", SessionToken: "sess", AWSSecretID: "prod/web01", JSONKey: "password"}
	if v, err := resolveSecretRef(t.Context(), &r); err != nil || v != "Aws-Pass-1" {
		t.Fatalf("%q %v", v, err)
	}
	if target != "secretsmanager.GetSecretValue" || token != "sess" || !strings.HasPrefix(gotAuth, "AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/") || !strings.Contains(gotAuth, "/eu-central-1/secretsmanager/aws4_request") || !strings.Contains(gotAuth, "x-amz-security-token") {
		t.Fatalf("auth=%q target=%q token=%q", gotAuth, target, token)
	}
	plain := r
	plain.AWSSecretID, plain.JSONKey = "plain", ""
	if v, err := resolveSecretRef(t.Context(), &plain); err != nil || v != "just-text" {
		t.Fatalf("%q %v", v, err)
	}
	for _, c := range []struct{ id, key, want string }{{"plain", "password", "not JSON"}, {"prod/web01", "n", `no text field "n"`}, {"denied", "", "may not read"}, {"missing", "", "no such secret"}} {
		x := r
		x.AWSSecretID, x.JSONKey = c.id, c.key
		if _, err := resolveSecretRef(t.Context(), &x); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v", c.id, err)
		}
	}
	// No key in the reference: the connector's own environment, else a clear error.
	env := r
	env.AccessKeyID, env.SecretAccessKey, env.SessionToken = "", "", ""
	t.Setenv("AWS_ACCESS_KEY_ID", "")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "")
	if _, err := resolveSecretRef(t.Context(), &env); err == nil || !strings.Contains(err.Error(), "no AWS access key") {
		t.Fatalf("%v", err)
	}
	t.Setenv("AWS_ACCESS_KEY_ID", "AKIAENV")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "envsk")
	if v, err := resolveSecretRef(t.Context(), &env); err != nil || v != "Aws-Pass-1" || !strings.Contains(gotAuth, "Credential=AKIAENV/") {
		t.Fatalf("%q %v %s", v, err, gotAuth)
	}
}

// Against moto (a Secrets Manager stand-in) when AWS_TEST_ENDPOINT is set; it does not check signatures,
// but it speaks the real wire format.
func TestAWSMotoReal(t *testing.T) {
	ep := os.Getenv("AWS_TEST_ENDPOINT")
	if ep == "" {
		t.Skip("AWS_TEST_ENDPOINT not set")
	}
	allowAll(t)
	r := secretRef{Provider: "aws", Address: ep, Region: "eu-central-1", AccessKeyID: "test", SecretAccessKey: "test", AWSSecretID: "prod/web01", JSONKey: "password"}
	if v, err := resolveSecretRef(t.Context(), &r); err != nil || v != "Moto-Pass" {
		t.Fatalf("%q %v", v, err)
	}
}
