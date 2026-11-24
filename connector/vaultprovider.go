package main

import (
	"context"
	"crypto/ecdh"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Credentials kept in a vault the customer already runs. Instead of a password,
// the sealed secret of a resource can be a reference: where to ask HashiCorp
// Vault or CyberArk (Central Credential Provider) for it, and how to sign in
// there. It is sealed to the connector exactly like a password (same key, same
// "only for this host, port and user" binding), so the control plane never sees
// the provider's address-and-token any more than it sees a password. The
// connector asks the vault at the moment a session needs the credential and
// keeps nothing: no cache, no log of the value.

const (
	refPrefix       = "captivo-ref1:"
	providerTimeout = 10 * time.Second
	providerMaxBody = 1 << 20
)

// providerAllow is the connector's egress boundary, applied to vault addresses
// too (set in runConnector).
var providerAllow *TargetMatcher

type secretRef struct {
	Provider string `json:"provider"` // "hashicorp" | "cyberark" | "azure" | "aws"
	Address  string `json:"address"`  // https://vault.corp:8200
	CAPem    string `json:"caPem,omitempty"`
	Insecure bool   `json:"insecure,omitempty"` // encrypted, certificate not checked

	// HashiCorp Vault
	Namespace string `json:"namespace,omitempty"`
	Mount     string `json:"mount,omitempty"` // KV mount, default "secret"
	Path      string `json:"path,omitempty"`
	Field     string `json:"field,omitempty"` // default "password"
	KVVersion int    `json:"kvVersion,omitempty"`
	Auth      string `json:"auth,omitempty"` // "token" | "approle"
	Token     string `json:"token,omitempty"`
	RoleID    string `json:"roleId,omitempty"`
	SecretID  string `json:"secretId,omitempty"`
	AuthMount string `json:"authMount,omitempty"` // approle mount, default "approle"

	// CyberArk Central Credential Provider
	AppID      string `json:"appId,omitempty"`
	Safe       string `json:"safe,omitempty"`
	Object     string `json:"object,omitempty"`
	Folder     string `json:"folder,omitempty"`
	ClientCert string `json:"clientCert,omitempty"` // PEM certificate chain
	ClientKey  string `json:"clientKey,omitempty"`  // PEM private key
	// CyberArk Password Vault Web Access (REST): sign in as a user, find the account, retrieve its password
	Mode      string `json:"mode,omitempty"`      // "ccp" (default) | "pvwa"
	LogonType string `json:"logonType,omitempty"` // "cyberark" (default) | "ldap" | "radius"
	User      string `json:"user,omitempty"`
	Password  string `json:"password,omitempty"`
	AccountID string `json:"accountId,omitempty"` // skips the search
	Reason    string `json:"reason,omitempty"`    // what the retrieval is logged as in CyberArk

	// Azure Key Vault (Address is the vault's URL, https://name.vault.azure.net)
	TenantID      string `json:"tenantId,omitempty"`
	ClientID      string `json:"clientId,omitempty"`
	ClientSecret  string `json:"clientSecret,omitempty"`
	SecretName    string `json:"secretName,omitempty"`
	SecretVersion string `json:"secretVersion,omitempty"`
	Authority     string `json:"authority,omitempty"` // default https://login.microsoftonline.com

	// AWS Secrets Manager (Address, when set, replaces the regional endpoint)
	Region          string `json:"region,omitempty"`
	AccessKeyID     string `json:"accessKeyId,omitempty"`
	SecretAccessKey string `json:"secretAccessKey,omitempty"`
	SessionToken    string `json:"sessionToken,omitempty"`
	AWSSecretID     string `json:"awsSecretId,omitempty"` // name or ARN
	JSONKey         string `json:"jsonKey,omitempty"`     // a field of a JSON secret
}

// parseSecretRef reads a sealed value's plaintext: a reference, or (ok=false) an ordinary secret.
func parseSecretRef(plain string) (*secretRef, bool, error) {
	body, ok := strings.CutPrefix(plain, refPrefix)
	if !ok {
		return nil, false, nil
	}
	var r secretRef
	if err := json.Unmarshal([]byte(body), &r); err != nil {
		return nil, true, errors.New("the saved vault reference is not valid; enter it again")
	}
	return &r, true, r.validate()
}

func (r *secretRef) validate() error {
	if r.Provider == "aws" && r.Address == "" {
		r.Address = awsEndpoint(r.Region)
	}
	u, err := url.Parse(r.Address)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("the vault's address must be http(s)://host[:port]")
	}
	switch r.Provider {
	case "azure":
		return r.validateAzure()
	case "aws":
		return r.validateAWS()
	case "hashicorp":
		if strings.Trim(r.Path, " /") == "" {
			return errors.New("the vault reference has no secret path")
		}
		switch r.Auth {
		case "token":
			if r.Token == "" {
				return errors.New("the vault reference has no token")
			}
		case "approle":
			if r.RoleID == "" || r.SecretID == "" {
				return errors.New("the vault reference needs a role id and a secret id")
			}
		default:
			return errors.New("the vault reference's sign-in is token or approle")
		}
		if r.KVVersion != 0 && r.KVVersion != 1 && r.KVVersion != 2 {
			return errors.New("the KV version is 1 or 2")
		}
	case "cyberark":
		if r.Mode == "pvwa" {
			return r.validatePVWA()
		}
		if r.AppID == "" || r.Safe == "" || r.Object == "" {
			return errors.New("a CyberArk reference needs the application id, the safe and the object")
		}
		if (r.ClientCert == "") != (r.ClientKey == "") {
			return errors.New("a CyberArk client certificate needs its key")
		}
	default:
		return errors.New("unknown vault provider")
	}
	return nil
}

func (r *secretRef) host() string {
	u, _ := url.Parse(r.Address)
	h := u.Host
	if u.Port() == "" {
		p := "443"
		if u.Scheme == "http" {
			p = "80"
		}
		h = net.JoinHostPort(u.Hostname(), p)
	}
	return h
}

func (r *secretRef) client() (*http.Client, error) {
	cfg := &tls.Config{MinVersion: tls.VersionTLS12}
	if r.Insecure {
		cfg.InsecureSkipVerify = true // #nosec G402 -- the admin's explicit choice for this vault
	} else if strings.TrimSpace(r.CAPem) != "" {
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM([]byte(r.CAPem)) {
			return nil, errors.New("the vault's CA certificate does not parse")
		}
		cfg.RootCAs = pool
	}
	if r.ClientCert != "" {
		c, err := tls.X509KeyPair([]byte(r.ClientCert), []byte(r.ClientKey))
		if err != nil {
			return nil, errors.New("the client certificate and key do not match or do not parse")
		}
		cfg.Certificates = []tls.Certificate{c}
	}
	return &http.Client{
		Timeout:       providerTimeout,
		Transport:     &http.Transport{TLSClientConfig: cfg, Proxy: nil, DisableKeepAlives: true},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}, nil
}

// do sends a request and reads at most providerMaxBody of the answer.
func (r *secretRef) do(ctx context.Context, c *http.Client, method, u string, body io.Reader, header map[string]string) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, method, u, body)
	if err != nil {
		return nil, 0, err
	}
	for k, v := range header {
		req.Header.Set(k, v)
	}
	resp, err := c.Do(req)
	if err != nil {
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err // the URL can carry the object's name; the reason is enough
		}
		return nil, 0, fmt.Errorf("could not reach the vault: %v", err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, providerMaxBody))
	return b, resp.StatusCode, err
}

// resolveSecretRef asks the vault for the credential.
func resolveSecretRef(ctx context.Context, r *secretRef) (string, error) {
	if !egressAllowed(providerAllow, r.host()) {
		denied()
		logDenied("vault", r.host())
		return "", errors.New("the vault's address is not allowed by this connector")
	}
	c, err := r.client()
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, providerTimeout)
	defer cancel()
	switch r.Provider {
	case "cyberark":
		if r.Mode == "pvwa" {
			return r.fromPVWA(ctx, c)
		}
		return r.fromCyberArk(ctx, c)
	case "azure":
		return r.fromAzure(ctx, c)
	case "aws":
		return r.fromAWS(ctx, c)
	}
	return r.fromHashiCorp(ctx, c)
}

func (r *secretRef) fromHashiCorp(ctx context.Context, c *http.Client) (string, error) {
	base := strings.TrimRight(r.Address, "/")
	hdr := map[string]string{}
	if r.Namespace != "" {
		hdr["X-Vault-Namespace"] = r.Namespace
	}
	token := r.Token
	if r.Auth == "approle" {
		mount := strings.Trim(r.AuthMount, "/")
		if mount == "" {
			mount = "approle"
		}
		b, _ := json.Marshal(map[string]string{"role_id": r.RoleID, "secret_id": r.SecretID})
		out, code, err := r.do(ctx, c, http.MethodPost, base+"/v1/auth/"+escapePath(mount)+"/login", strings.NewReader(string(b)), hdr)
		if err != nil {
			return "", err
		}
		if code != http.StatusOK {
			return "", fmt.Errorf("the vault refused the AppRole sign-in (%d)%s", code, vaultErrors(out))
		}
		var a struct {
			Auth struct {
				ClientToken string `json:"client_token"`
			} `json:"auth"`
		}
		if json.Unmarshal(out, &a) != nil || a.Auth.ClientToken == "" {
			return "", errors.New("the vault's AppRole answer has no token")
		}
		token = a.Auth.ClientToken
	}
	hdr["X-Vault-Token"] = token
	mount := strings.Trim(r.Mount, "/")
	if mount == "" {
		mount = "secret"
	}
	path := strings.Trim(r.Path, " /")
	v2 := r.KVVersion != 1
	u := base + "/v1/" + escapePath(mount) + "/"
	if v2 {
		u += "data/"
	}
	u += escapePath(path)
	out, code, err := r.do(ctx, c, http.MethodGet, u, nil, hdr)
	if err != nil {
		return "", err
	}
	switch code {
	case http.StatusOK:
	case http.StatusNotFound:
		return "", errors.New("the vault has no secret at that mount and path")
	case http.StatusForbidden:
		return "", errors.New("the vault's policy does not allow reading that secret")
	default:
		return "", fmt.Errorf("the vault answered %d%s", code, vaultErrors(out))
	}
	var body struct {
		Data map[string]any `json:"data"`
	}
	if json.Unmarshal(out, &body) != nil {
		return "", errors.New("the vault's answer is not JSON")
	}
	data := body.Data
	if v2 {
		inner, ok := data["data"].(map[string]any)
		if !ok {
			return "", errors.New("the secret has no current version (deleted or destroyed?)")
		}
		data = inner
	}
	field := r.Field
	if field == "" {
		field = "password"
	}
	v, ok := data[field].(string)
	if !ok || v == "" {
		return "", fmt.Errorf("the secret has no text field %q", field)
	}
	return v, nil
}

func (r *secretRef) fromCyberArk(ctx context.Context, c *http.Client) (string, error) {
	q := url.Values{"AppID": {r.AppID}, "Safe": {r.Safe}, "Object": {r.Object}}
	if r.Folder != "" {
		q.Set("Folder", r.Folder)
	}
	u := strings.TrimRight(r.Address, "/") + "/AIMWebService/api/Accounts?" + q.Encode()
	out, code, err := r.do(ctx, c, http.MethodGet, u, nil, map[string]string{"Accept": "application/json"})
	if err != nil {
		return "", err
	}
	if code != http.StatusOK {
		var e struct{ ErrorCode, ErrorMsg string }
		_ = json.Unmarshal(out, &e)
		msg := ""
		if e.ErrorMsg != "" {
			msg = ": " + clip(e.ErrorMsg, 200)
		}
		if e.ErrorCode != "" {
			msg += " [" + clip(e.ErrorCode, 40) + "]"
		}
		return "", fmt.Errorf("CyberArk answered %d%s", code, msg)
	}
	var a struct{ Content string }
	if json.Unmarshal(out, &a) != nil || a.Content == "" {
		return "", errors.New("CyberArk's answer has no content")
	}
	return a.Content, nil
}

func vaultErrors(b []byte) string {
	var e struct {
		Errors []string `json:"errors"`
	}
	if json.Unmarshal(b, &e) == nil && len(e.Errors) > 0 {
		return ": " + clip(strings.Join(e.Errors, "; "), 200)
	}
	return ""
}

func escapePath(p string) string {
	parts := strings.Split(p, "/")
	for i := range parts {
		parts[i] = url.PathEscape(parts[i])
	}
	return strings.Join(parts, "/")
}

// openSecret opens a sealed secret and, when it is a vault reference, fetches
// the credential it points to. Everything that signs in with a saved
// credential calls it instead of openSealed.
func openSecret(k *ecdh.PrivateKey, sealed string, aad []byte) (string, error) {
	plain, err := openSealed(k, sealed, aad)
	if err != nil {
		return "", err
	}
	ref, isRef, err := parseSecretRef(plain)
	if !isRef {
		return plain, nil
	}
	if err != nil {
		return "", err
	}
	return resolveSecretRef(context.Background(), ref)
}
