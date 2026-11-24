package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"
)

// More places a credential can live: CyberArk's REST API (PVWA), Azure Key
// Vault and AWS Secrets Manager. Same rules as vaultprovider.go: the reference
// is sealed to the connector, the value is fetched per sign-in and kept nowhere.

// --- CyberArk Password Vault Web Access ---

func (r *secretRef) validatePVWA() error {
	switch r.LogonType {
	case "", "cyberark", "ldap", "radius":
	default:
		return errors.New("CyberArk's sign-in type is cyberark, ldap or radius")
	}
	if r.User == "" || r.Password == "" {
		return errors.New("a CyberArk REST reference needs the user and its password")
	}
	if r.AccountID == "" && (r.Safe == "" || r.Object == "") {
		return errors.New("a CyberArk REST reference needs the account id, or the safe and the account's name")
	}
	if (r.ClientCert == "") != (r.ClientKey == "") {
		return errors.New("a CyberArk client certificate needs its key")
	}
	return nil
}

func (r *secretRef) fromPVWA(ctx context.Context, c *http.Client) (string, error) {
	base := strings.TrimRight(r.Address, "/") + "/PasswordVault/API"
	logon := r.LogonType
	if logon == "" {
		logon = "CyberArk"
	}
	switch strings.ToLower(logon) {
	case "cyberark":
		logon = "CyberArk"
	case "ldap":
		logon = "LDAP"
	case "radius":
		logon = "RADIUS"
	}
	body, _ := json.Marshal(map[string]any{"username": r.User, "password": r.Password, "concurrentSession": true})
	out, code, err := r.do(ctx, c, http.MethodPost, base+"/auth/"+logon+"/Logon", strings.NewReader(string(body)), map[string]string{"Content-Type": "application/json"})
	if err != nil {
		return "", err
	}
	if code != http.StatusOK {
		return "", fmt.Errorf("CyberArk refused the sign-in (%d)%s", code, pvwaError(out))
	}
	var token string
	if json.Unmarshal(out, &token) != nil || token == "" {
		return "", errors.New("CyberArk's sign-in answer has no session token")
	}
	hdr := map[string]string{"Authorization": token, "Content-Type": "application/json"}
	// The session ends with the retrieval, whatever happens in between.
	defer func() {
		lctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _, _ = r.do(lctx, c, http.MethodPost, base+"/Auth/Logoff", nil, hdr)
	}()

	id := r.AccountID
	if id == "" {
		q := url.Values{"search": {r.Object}, "filter": {"safeName eq " + r.Safe}}
		out, code, err = r.do(ctx, c, http.MethodGet, base+"/Accounts?"+q.Encode(), nil, hdr)
		if err != nil {
			return "", err
		}
		if code != http.StatusOK {
			return "", fmt.Errorf("CyberArk's account search failed (%d)%s", code, pvwaError(out))
		}
		var list struct {
			Value []struct {
				ID       string `json:"id"`
				Name     string `json:"name"`
				SafeName string `json:"safeName"`
			} `json:"value"`
		}
		if json.Unmarshal(out, &list) != nil {
			return "", errors.New("CyberArk's account list is not JSON")
		}
		var hit []string
		for _, a := range list.Value {
			if a.Name == r.Object && (a.SafeName == "" || strings.EqualFold(a.SafeName, r.Safe)) {
				hit = append(hit, a.ID)
			}
		}
		switch len(hit) {
		case 0:
			return "", errors.New("CyberArk has no account with that name in that safe, or the user may not see it")
		case 1:
			id = hit[0]
		default:
			return "", errors.New("several CyberArk accounts have that name; give the account id")
		}
	}
	reason := r.Reason
	if reason == "" {
		reason = "Captivo Access session"
	}
	rb, _ := json.Marshal(map[string]string{"reason": reason})
	out, code, err = r.do(ctx, c, http.MethodPost, base+"/Accounts/"+url.PathEscape(id)+"/Password/Retrieve", strings.NewReader(string(rb)), hdr)
	if err != nil {
		return "", err
	}
	if code != http.StatusOK {
		return "", fmt.Errorf("CyberArk would not hand out the password (%d)%s", code, pvwaError(out))
	}
	var pw string
	if json.Unmarshal(out, &pw) != nil || pw == "" {
		return "", errors.New("CyberArk's answer has no password")
	}
	return pw, nil
}

func pvwaError(b []byte) string {
	var e struct{ ErrorCode, ErrorMessage string }
	if json.Unmarshal(b, &e) == nil && (e.ErrorMessage != "" || e.ErrorCode != "") {
		out := ""
		if e.ErrorMessage != "" {
			out = ": " + clip(e.ErrorMessage, 200)
		}
		if e.ErrorCode != "" {
			out += " [" + clip(e.ErrorCode, 40) + "]"
		}
		return out
	}
	return ""
}

// --- Azure Key Vault ---

func (r *secretRef) validateAzure() error {
	if r.TenantID == "" || r.ClientID == "" || r.ClientSecret == "" {
		return errors.New("an Azure reference needs the tenant id, the client id and its secret")
	}
	if r.SecretName == "" {
		return errors.New("an Azure reference needs the secret's name")
	}
	if r.Authority != "" {
		if u, err := url.Parse(r.Authority); err != nil || u.Scheme != "https" && u.Scheme != "http" || u.Host == "" {
			return errors.New("the Azure authority must be an https address")
		}
	}
	return nil
}

func (r *secretRef) fromAzure(ctx context.Context, c *http.Client) (string, error) {
	authority := strings.TrimRight(r.Authority, "/")
	if authority == "" {
		authority = "https://login.microsoftonline.com"
	}
	if au, err := url.Parse(authority); err == nil {
		h := au.Host
		if au.Port() == "" {
			h += ":443"
		}
		if !egressAllowed(providerAllow, h) {
			denied()
			logDenied("vault", h)
			return "", errors.New("Azure's sign-in address is not allowed by this connector")
		}
	}
	form := url.Values{"grant_type": {"client_credentials"}, "client_id": {r.ClientID}, "client_secret": {r.ClientSecret}, "scope": {"https://vault.azure.net/.default"}}
	out, code, err := r.do(ctx, c, http.MethodPost, authority+"/"+url.PathEscape(r.TenantID)+"/oauth2/v2.0/token", strings.NewReader(form.Encode()), map[string]string{"Content-Type": "application/x-www-form-urlencoded"})
	if err != nil {
		return "", err
	}
	var tok struct {
		AccessToken      string `json:"access_token"`
		ErrorDescription string `json:"error_description"`
	}
	_ = json.Unmarshal(out, &tok)
	if code != http.StatusOK || tok.AccessToken == "" {
		msg := ""
		if tok.ErrorDescription != "" {
			msg = ": " + clip(firstLine(tok.ErrorDescription), 200)
		}
		return "", fmt.Errorf("Azure refused the sign-in (%d)%s", code, msg)
	}
	u := strings.TrimRight(r.Address, "/") + "/secrets/" + url.PathEscape(r.SecretName)
	if r.SecretVersion != "" {
		u += "/" + url.PathEscape(r.SecretVersion)
	}
	u += "?api-version=7.4"
	out, code, err = r.do(ctx, c, http.MethodGet, u, nil, map[string]string{"Authorization": "Bearer " + tok.AccessToken})
	if err != nil {
		return "", err
	}
	switch code {
	case http.StatusOK:
	case http.StatusNotFound:
		return "", errors.New("the Key Vault has no such secret")
	case http.StatusForbidden, http.StatusUnauthorized:
		return "", errors.New("the Key Vault's access policy does not let this application read secrets")
	default:
		return "", fmt.Errorf("the Key Vault answered %d", code)
	}
	var sec struct {
		Value string `json:"value"`
	}
	if json.Unmarshal(out, &sec) != nil || sec.Value == "" {
		return "", errors.New("the secret has no value")
	}
	return sec.Value, nil
}

func firstLine(s string) string {
	if i := strings.IndexAny(s, "\r\n"); i >= 0 {
		return s[:i]
	}
	return s
}

// --- AWS Secrets Manager ---

func awsEndpoint(region string) string {
	return "https://secretsmanager." + region + ".amazonaws.com"
}

func (r *secretRef) validateAWS() error {
	if r.Region == "" || strings.ContainsAny(r.Region, "/ :") {
		return errors.New("an AWS reference needs the region (eu-central-1)")
	}
	if r.AWSSecretID == "" {
		return errors.New("an AWS reference needs the secret's name or ARN")
	}
	if (r.AccessKeyID == "") != (r.SecretAccessKey == "") {
		return errors.New("an AWS access key id needs its secret key")
	}
	return nil
}

// sigV4 signs a request (AWS Signature Version 4). headers must include host
// and x-amz-date; the signed set is every header given.
func sigV4(method, path, query string, headers map[string]string, body []byte, accessKey, secretKey, region, service string, at time.Time) string {
	date := at.UTC().Format("20060102")
	names := make([]string, 0, len(headers))
	lower := map[string]string{}
	for k, v := range headers {
		lower[strings.ToLower(k)] = strings.TrimSpace(v)
		names = append(names, strings.ToLower(k))
	}
	sort.Strings(names)
	var canonHeaders strings.Builder
	for _, n := range names {
		canonHeaders.WriteString(n + ":" + lower[n] + "\n")
	}
	signed := strings.Join(names, ";")
	bodyHash := sha256.Sum256(body)
	canonical := strings.Join([]string{method, path, query, canonHeaders.String(), signed, hex.EncodeToString(bodyHash[:])}, "\n")
	scope := date + "/" + region + "/" + service + "/aws4_request"
	ch := sha256.Sum256([]byte(canonical))
	toSign := "AWS4-HMAC-SHA256\n" + at.UTC().Format("20060102T150405Z") + "\n" + scope + "\n" + hex.EncodeToString(ch[:])
	mac := func(k []byte, m string) []byte {
		h := hmac.New(sha256.New, k)
		h.Write([]byte(m))
		return h.Sum(nil)
	}
	key := mac(mac(mac(mac([]byte("AWS4"+secretKey), date), region), service), "aws4_request")
	sig := hex.EncodeToString(mac(key, toSign))
	return "AWS4-HMAC-SHA256 Credential=" + accessKey + "/" + scope + ", SignedHeaders=" + signed + ", Signature=" + sig
}

func (r *secretRef) fromAWS(ctx context.Context, c *http.Client) (string, error) {
	key, secret, token := r.AccessKeyID, r.SecretAccessKey, r.SessionToken
	if key == "" { // the connector's own environment: a service account on its host
		key, secret, token = os.Getenv("AWS_ACCESS_KEY_ID"), os.Getenv("AWS_SECRET_ACCESS_KEY"), os.Getenv("AWS_SESSION_TOKEN")
	}
	if key == "" || secret == "" {
		return "", errors.New("no AWS access key: put one in the reference, or in the connector's AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY")
	}
	endpoint := r.Address
	if endpoint == "" {
		endpoint = awsEndpoint(r.Region)
	}
	eu, err := url.Parse(endpoint)
	if err != nil {
		return "", errors.New("the AWS endpoint is not an address")
	}
	body, _ := json.Marshal(map[string]string{"SecretId": r.AWSSecretID})
	now := time.Now().UTC()
	h := map[string]string{
		"Content-Type": "application/x-amz-json-1.1",
		"Host":         eu.Host,
		"X-Amz-Date":   now.Format("20060102T150405Z"),
		"X-Amz-Target": "secretsmanager.GetSecretValue",
	}
	if token != "" {
		h["X-Amz-Security-Token"] = token
	}
	path := eu.EscapedPath()
	if path == "" {
		path = "/"
	}
	auth := sigV4(http.MethodPost, path, "", h, body, key, secret, r.Region, "secretsmanager", now)
	delete(h, "Host") // the client sets it from the URL
	h["Authorization"] = auth
	out, code, err := r.do(ctx, c, http.MethodPost, strings.TrimRight(endpoint, "/")+path[len("/"):], strings.NewReader(string(body)), h)
	if err != nil {
		return "", err
	}
	if code != http.StatusOK {
		var e struct {
			Type    string `json:"__type"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(out, &e)
		kind := e.Type
		if i := strings.LastIndex(kind, "#"); i >= 0 {
			kind = kind[i+1:]
		}
		switch kind {
		case "ResourceNotFoundException":
			return "", errors.New("AWS has no such secret in that region")
		case "AccessDeniedException":
			return "", errors.New("the AWS key may not read that secret (secretsmanager:GetSecretValue)")
		}
		msg := ""
		if kind != "" {
			msg = " " + clip(kind, 60)
		}
		return "", fmt.Errorf("AWS Secrets Manager answered %d%s", code, msg)
	}
	var sv struct {
		SecretString string `json:"SecretString"`
	}
	if json.Unmarshal(out, &sv) != nil || sv.SecretString == "" {
		return "", errors.New("the secret has no text value (a binary secret is not supported)")
	}
	if r.JSONKey == "" {
		return sv.SecretString, nil
	}
	var obj map[string]any
	if json.Unmarshal([]byte(sv.SecretString), &obj) != nil {
		return "", errors.New("the secret is not JSON, so it has no field to pick")
	}
	v, ok := obj[r.JSONKey].(string)
	if !ok || v == "" {
		return "", fmt.Errorf("the secret has no text field %q", r.JSONKey)
	}
	return v, nil
}
