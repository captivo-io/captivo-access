package main

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"

	"github.com/go-ldap/ldap/v3"
	"github.com/kurtserdar/captivo-access/tunnel"
)

// LdapConfig is the directory connection the manager asks the data-plane to
// reach through the connector. bindPassword arrives in cleartext over the
// secret-gated, internal-only channel and is never persisted here.
type LdapConfig struct {
	Host               string `json:"host"`
	Port               int    `json:"port"`
	Security           string `json:"security"` // PLAIN | STARTTLS | LDAPS
	InsecureSkipVerify bool   `json:"insecureSkipVerify"`
	BaseDN             string `json:"baseDN"`
	BindDN             string `json:"bindDN"`
	BindPassword       string `json:"bindPassword"`
	CACertPem          string `json:"caCertPem"` // PEM CA(s) to verify LDAPS/StartTLS against; "" = system roots
}

type LdapTestResult struct {
	Ok          bool   `json:"ok"`
	Error       string `json:"error,omitempty"`
	BaseDnFound bool   `json:"baseDnFound"`
}

// dialLdap opens a raw relay stream to the directory host through the connector
// and returns it as a net.Conn. The LDAP protocol (and any TLS) run end-to-end
// over this — the connector is an opaque byte pipe.
func dialLdap(s *Session, target string) (net.Conn, error) {
	if s == nil || s.mux == nil {
		return nil, errors.New("connector offline")
	}
	st, err := s.mux.Open()
	if err != nil {
		return nil, err
	}
	reqBytes, err := json.Marshal(tunnel.LdapDialRequest{Kind: "ldap", Target: target})
	if err != nil {
		st.Close()
		return nil, err
	}
	if err := tunnel.WriteFrame(st, reqBytes); err != nil {
		st.Close()
		return nil, err
	}
	respBytes, err := tunnel.ReadFrame(st)
	if err != nil {
		st.Close()
		return nil, err
	}
	var resp tunnel.LdapDialResponse
	if err := json.Unmarshal(respBytes, &resp); err != nil {
		st.Close()
		return nil, err
	}
	if resp.Error != "" {
		st.Close()
		return nil, errors.New(resp.Error)
	}
	return st, nil // yamux.Stream satisfies net.Conn
}

// explainTLSFailure turns a low-level TLS/StartTLS failure into an operator-
// friendly hint. The commonest cause on Active Directory is that LDAPS/StartTLS
// simply is not enabled on the domain controller (no server certificate
// installed): the DC resets the TLS handshake (EOF / connection reset) or
// answers StartTLS with LDAP result 52 (unavailable). Certificate-trust
// failures get a different, equally actionable hint pointing at the CA field.
func explainTLSFailure(err error, mode string) string {
	msg := err.Error()
	low := strings.ToLower(msg)
	switch {
	case strings.Contains(low, "x509") || strings.Contains(low, "certificate"):
		return "TLS certificate could not be verified — paste the CA that signed the directory's certificate (or the server certificate itself) into the CA certificate field. (" + msg + ")"
	case ldap.IsErrorWithCode(err, ldap.LDAPResultUnavailable),
		strings.Contains(low, "eof"),
		strings.Contains(low, "reset"),
		strings.Contains(low, "broken pipe"),
		strings.Contains(low, "forcibly closed"),
		strings.Contains(low, "unavailable"):
		return "the directory did not complete a TLS handshake — " + mode + " is not enabled on it. This is a common default on Active Directory, which needs a server certificate installed before LDAPS works. Enable LDAPS/StartTLS on the domain controller, or use Plain (lab only) to test. (" + msg + ")"
	default:
		return mode + " failed: " + msg
	}
}

// connectAndBind reaches the directory through the connector, negotiates TLS
// per the security mode, and binds. On success the caller must close BOTH the
// returned *ldap.Conn and the raw net.Conn. Every failure returns a
// human-readable error (never panics).
func connectAndBind(s *Session, cfg LdapConfig) (*ldap.Conn, net.Conn, error) {
	port := cfg.Port
	if port == 0 {
		port = 389
	}
	raw, err := dialLdap(s, net.JoinHostPort(cfg.Host, fmt.Sprintf("%d", port)))
	if err != nil {
		return nil, nil, err
	}
	tlsCfg := &tls.Config{ServerName: cfg.Host, InsecureSkipVerify: cfg.InsecureSkipVerify}
	// A pasted CA (internal CA or the server's self-signed cert) lets LDAPS be
	// verified securely without turning verification off. InsecureSkipVerify, if
	// also set, still wins in crypto/tls — the CA is the secure alternative to it.
	if cfg.CACertPem != "" {
		pool := x509.NewCertPool()
		if pool.AppendCertsFromPEM([]byte(cfg.CACertPem)) {
			tlsCfg.RootCAs = pool
		}
	}

	var conn *ldap.Conn
	if cfg.Security == "LDAPS" {
		_ = raw.SetDeadline(time.Now().Add(12 * time.Second))
		tconn := tls.Client(raw, tlsCfg)
		if err := tconn.Handshake(); err != nil {
			raw.Close()
			return nil, nil, errors.New(explainTLSFailure(err, "LDAPS"))
		}
		_ = raw.SetDeadline(time.Time{})
		conn = ldap.NewConn(tconn, true)
	} else {
		conn = ldap.NewConn(raw, false)
	}
	conn.Start()
	conn.SetTimeout(12 * time.Second)

	if cfg.Security == "STARTTLS" {
		if err := conn.StartTLS(tlsCfg); err != nil {
			conn.Close()
			raw.Close()
			return nil, nil, errors.New(explainTLSFailure(err, "STARTTLS"))
		}
	}
	if err := conn.Bind(cfg.BindDN, cfg.BindPassword); err != nil {
		conn.Close()
		raw.Close()
		return nil, nil, errors.New("bind failed: " + err.Error())
	}
	return conn, raw, nil
}

// TestLdap reaches the directory through the connector, binds, and runs a
// bounded base-scope search of baseDN to confirm reachability + credentials.
// It never throws — every failure is a human-readable message in the result.
func TestLdap(s *Session, cfg LdapConfig) LdapTestResult {
	conn, raw, err := connectAndBind(s, cfg)
	if err != nil {
		return LdapTestResult{Error: err.Error()}
	}
	defer conn.Close()
	defer raw.Close()

	req := ldap.NewSearchRequest(
		cfg.BaseDN, ldap.ScopeBaseObject, ldap.NeverDerefAliases, 1, 10, false,
		"(objectClass=*)", []string{"dn"}, nil,
	)
	res, err := conn.Search(req)
	if err != nil {
		return LdapTestResult{Ok: true, Error: "bound OK, but the base DN search failed: " + err.Error()}
	}
	return LdapTestResult{Ok: true, BaseDnFound: len(res.Entries) > 0}
}

// LdapResolveResult reports a directory lookup by email. A non-empty Error means
// the lookup could not be completed (transport/bind/query) — the caller MUST
// treat that as "unknown" and fail open, never as "user absent".
type LdapResolveResult struct {
	Found       bool     `json:"found"`
	DN          string   `json:"dn,omitempty"`
	MemberOf    []string `json:"memberOf,omitempty"`
	DisplayName string   `json:"displayName,omitempty"`
	Error       string   `json:"error,omitempty"`
}

func entryToResolve(e *ldap.Entry) LdapResolveResult {
	return LdapResolveResult{
		Found:       true,
		DN:          e.DN,
		MemberOf:    e.GetAttributeValues("memberOf"),
		DisplayName: e.GetAttributeValue("displayName"),
	}
}

// ResolveUser binds, then subtree-searches baseDN for (mail=<email>) and returns
// the entry's DN + memberOf group DNs. Zero matches → {Found:false}. Any
// transport/bind/query failure → {Error:...} (caller fails open).
func ResolveUser(s *Session, cfg LdapConfig, email string) LdapResolveResult {
	conn, raw, err := connectAndBind(s, cfg)
	if err != nil {
		return LdapResolveResult{Error: err.Error()}
	}
	defer conn.Close()
	defer raw.Close()

	filter := fmt.Sprintf("(&(objectClass=user)(mail=%s))", ldap.EscapeFilter(email))
	req := ldap.NewSearchRequest(
		cfg.BaseDN, ldap.ScopeWholeSubtree, ldap.NeverDerefAliases, 2, 12, false,
		filter, []string{"memberOf", "displayName", "distinguishedName"}, nil,
	)
	res, err := conn.Search(req)
	if err != nil {
		return LdapResolveResult{Error: "search failed: " + err.Error()}
	}
	if len(res.Entries) == 0 {
		return LdapResolveResult{Found: false}
	}
	return entryToResolve(res.Entries[0])
}

// Directory groups the console offers when an admin types into "Group name or
// DN" (Directory → Group mappings), so nobody has to copy a DN out of ADUC.
const groupSearchLimit = 25

type LdapGroup struct {
	Name        string `json:"name"`
	DN          string `json:"dn"`
	Description string `json:"description,omitempty"`
}

type LdapGroupSearchResult struct {
	Groups    []LdapGroup `json:"groups"`
	Truncated bool        `json:"truncated,omitempty"` // more matched than groupSearchLimit
	Error     string      `json:"error,omitempty"`
}

// groupSearchFilter matches AD groups and the common OpenLDAP group classes
// whose cn (or AD sAMAccountName) contains q. q is escaped, never raw.
func groupSearchFilter(q string) string {
	e := ldap.EscapeFilter(q)
	return fmt.Sprintf("(&(|(objectClass=group)(objectClass=groupOfNames)(objectClass=groupOfUniqueNames)(objectClass=posixGroup))(|(cn=*%s*)(sAMAccountName=*%s*)))", e, e)
}

func entriesToGroups(entries []*ldap.Entry) []LdapGroup {
	out := make([]LdapGroup, 0, len(entries))
	for _, e := range entries {
		name := e.GetAttributeValue("cn")
		if name == "" {
			name = e.GetAttributeValue("sAMAccountName")
		}
		if name == "" || e.DN == "" {
			continue
		}
		out = append(out, LdapGroup{Name: name, DN: e.DN, Description: e.GetAttributeValue("description")})
	}
	return out
}

// SearchGroups binds and subtree-searches baseDN for groups whose name contains
// q, at most groupSearchLimit of them. A directory that stops at the size limit
// still returns what it found, marked truncated.
func SearchGroups(s *Session, cfg LdapConfig, q string) LdapGroupSearchResult {
	q = strings.TrimSpace(q)
	if len(q) < 2 {
		return LdapGroupSearchResult{Groups: []LdapGroup{}}
	}
	conn, raw, err := connectAndBind(s, cfg)
	if err != nil {
		return LdapGroupSearchResult{Error: err.Error()}
	}
	defer conn.Close()
	defer raw.Close()

	req := ldap.NewSearchRequest(
		cfg.BaseDN, ldap.ScopeWholeSubtree, ldap.NeverDerefAliases, groupSearchLimit+1, 12, false,
		groupSearchFilter(q), []string{"cn", "sAMAccountName", "description"}, nil,
	)
	res, err := conn.Search(req)
	truncated := false
	if err != nil {
		if !ldap.IsErrorWithCode(err, ldap.LDAPResultSizeLimitExceeded) || res == nil {
			return LdapGroupSearchResult{Error: "search failed: " + err.Error()}
		}
		truncated = true
	}
	groups := entriesToGroups(res.Entries)
	if len(groups) > groupSearchLimit {
		groups, truncated = groups[:groupSearchLimit], true
	}
	return LdapGroupSearchResult{Groups: groups, Truncated: truncated}
}
