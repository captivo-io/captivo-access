package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/go-ldap/ldap/v3"
	"github.com/kurtserdar/captivo-access/tunnel"
)

// A directory (Active Directory or Samba AD) account over LDAP. AD takes a
// password change only on an encrypted connection: the account changes its
// own by deleting the old unicodePwd and adding the new one; the reconcile
// account (with the "Reset password" right) replaces it, which also bypasses
// the minimum password age and the history rule.

type adTarget struct {
	dir       tunnel.RotateDirectory
	bindName  string // what the account signs in as: DOMAIN\user or user@realm
	filter    string // finds its entry under the base DN
	reconcile *reconcileSecret
	tlsConfig *tls.Config
}

func newADTarget(dir tunnel.RotateDirectory, username string, rec *reconcileSecret) (*adTarget, error) {
	sec := strings.ToUpper(dir.Security)
	if sec != "LDAPS" && sec != "STARTTLS" {
		return nil, errors.New("the directory connection must use LDAPS or StartTLS: AD only changes passwords over an encrypted connection")
	}
	if strings.TrimSpace(dir.BaseDN) == "" {
		return nil, errors.New("the directory has no base DN")
	}
	bind, filter, err := adAccount(username, dir.Domain)
	if err != nil {
		return nil, err
	}
	cfg := &tls.Config{ServerName: dir.Host, InsecureSkipVerify: dir.InsecureSkipVerify, MinVersion: tls.VersionTLS12} // #nosec G402 -- the admin's explicit choice for this directory
	if strings.TrimSpace(dir.CACertPEM) != "" {
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM([]byte(dir.CACertPEM)) {
			return nil, errors.New("the directory's CA certificate does not parse")
		}
		cfg.RootCAs = pool
	}
	dir.Security = sec
	return &adTarget{dir: dir, bindName: bind, filter: filter, reconcile: rec, tlsConfig: cfg}, nil
}

// adAccount turns the resource's user name into a bind name and a search
// filter: "CORP\alice", "alice@corp.example" or, with the resource's domain,
// "alice".
func adAccount(username, domain string) (bind, filter string, err error) {
	u := strings.TrimSpace(username)
	switch {
	case strings.Contains(u, `\`):
		i := strings.LastIndex(u, `\`)
		if u[i+1:] == "" || strings.HasPrefix(u, `.\`) {
			return "", "", errors.New("a local account (.\\name) is not in the directory")
		}
		return u, "(sAMAccountName=" + ldap.EscapeFilter(u[i+1:]) + ")", nil
	case strings.Contains(u, "@"):
		sam := u[:strings.Index(u, "@")]
		return u, "(|(userPrincipalName=" + ldap.EscapeFilter(u) + ")(sAMAccountName=" + ldap.EscapeFilter(sam) + "))", nil
	case u != "" && strings.TrimSpace(domain) != "":
		return strings.TrimSpace(domain) + `\` + u, "(sAMAccountName=" + ldap.EscapeFilter(u) + ")", nil
	}
	return "", "", errors.New("the user name has no domain: use DOMAIN\\name or name@domain, or set the resource's domain")
}

func (t *adTarget) canReset() bool { return t.reconcile != nil }

func (t *adTarget) connect(ctx context.Context) (*ldap.Conn, error) {
	addr := net.JoinHostPort(t.dir.Host, t.dir.Port)
	d := &net.Dialer{Timeout: 8 * time.Second}
	var c *ldap.Conn
	var err error
	if t.dir.Security == "LDAPS" {
		c, err = ldap.DialURL("ldaps://"+addr, ldap.DialWithDialer(d), ldap.DialWithTLSConfig(t.tlsConfig))
	} else {
		c, err = ldap.DialURL("ldap://"+addr, ldap.DialWithDialer(d))
		if err == nil {
			if err = c.StartTLS(t.tlsConfig); err != nil {
				c.Close()
			}
		}
	}
	if err != nil {
		return nil, fmt.Errorf("could not reach the directory: %v", err)
	}
	if dl, ok := ctx.Deadline(); ok {
		c.SetTimeout(time.Until(dl))
	}
	return c, nil
}

// adBindResult reads AD's sub-code from a failed bind ("data 52e" etc.).
func adBindResult(err error) authResult {
	var le *ldap.Error
	if !errors.As(err, &le) || le.ResultCode != ldap.LDAPResultInvalidCredentials {
		return authResult{kind: authOther, detail: "directory: " + err.Error()}
	}
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "data 532"), strings.Contains(msg, "data 773"):
		return authResult{kind: authExpired, detail: "the password has expired or must be changed at next sign-in"}
	case strings.Contains(msg, "data 775"):
		return authResult{kind: authOther, detail: "the account is locked out"}
	case strings.Contains(msg, "data 533"), strings.Contains(msg, "data 701"):
		return authResult{kind: authOther, detail: "the account is disabled or expired"}
	}
	return authResult{kind: authBad, detail: "the password was not accepted"}
}

func (t *adTarget) check(ctx context.Context, pw string) authResult {
	c, err := t.connect(ctx)
	if err != nil {
		return authResult{kind: authOther, detail: err.Error()}
	}
	defer c.Close()
	if err := c.Bind(t.bindName, pw); err != nil {
		return adBindResult(err)
	}
	return authResult{kind: authOK}
}

func (t *adTarget) findDN(c *ldap.Conn) (string, error) {
	res, err := c.Search(ldap.NewSearchRequest(t.dir.BaseDN, ldap.ScopeWholeSubtree, ldap.NeverDerefAliases, 2, 15, false,
		"(&(objectClass=user)"+t.filter+")", []string{"dn"}, nil))
	if err != nil {
		return "", fmt.Errorf("directory search failed: %v", err)
	}
	if len(res.Entries) != 1 {
		return "", fmt.Errorf("the account was found %d times under %s", len(res.Entries), t.dir.BaseDN)
	}
	return res.Entries[0].DN, nil
}

// adPassword is unicodePwd's value: the password in quotes, UTF-16LE.
func adPassword(pw string) string {
	u := utf16.Encode([]rune(`"` + pw + `"`))
	b := make([]byte, 2*len(u))
	for i, r := range u {
		binary.LittleEndian.PutUint16(b[2*i:], r)
	}
	return string(b)
}

func adChangeError(err error) error {
	msg := err.Error()
	if strings.Contains(msg, "0000052D") || strings.Contains(strings.ToLower(msg), "constraint") {
		return errors.New("the directory refused the new password (minimum password age, history or complexity rule)")
	}
	if strings.Contains(strings.ToLower(msg), "insufficient") {
		return errors.New("the account is not allowed to change this password")
	}
	return fmt.Errorf("the directory refused the change: %v", err)
}

func (t *adTarget) selfChange(ctx context.Context, cur, next string) error {
	c, err := t.connect(ctx)
	if err != nil {
		return err
	}
	defer c.Close()
	if err := c.Bind(t.bindName, cur); err != nil {
		return errors.New(adBindResult(err).detail)
	}
	dn, err := t.findDN(c)
	if err != nil {
		return err
	}
	m := ldap.NewModifyRequest(dn, nil)
	m.Delete("unicodePwd", []string{adPassword(cur)})
	m.Add("unicodePwd", []string{adPassword(next)})
	if err := c.Modify(m); err != nil {
		return adChangeError(err)
	}
	return nil
}

func (t *adTarget) reset(ctx context.Context, next string) error {
	if t.reconcile == nil {
		return errNoReconcile
	}
	c, err := t.connect(ctx)
	if err != nil {
		return err
	}
	defer c.Close()
	if err := c.Bind(t.reconcile.username, t.reconcile.secret); err != nil {
		return errors.New("the reconcile account could not sign in to the directory: " + adBindResult(err).detail)
	}
	dn, err := t.findDN(c)
	if err != nil {
		return err
	}
	m := ldap.NewModifyRequest(dn, nil)
	m.Replace("unicodePwd", []string{adPassword(next)})
	if err := c.Modify(m); err != nil {
		return adChangeError(err)
	}
	return nil
}
