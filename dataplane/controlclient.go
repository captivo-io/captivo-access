package main

import (
	"github.com/kurtserdar/captivo-access/tunnel"

	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// ErrNoSite is returned by SiteByHost when the control plane has no site
// registered for the given host (404).
var ErrNoSite = errors.New("no site for host")

// ControlClient talks to the control-plane's internal connector APIs
// (Task 4: POST /api/internal/connector/auth and /status), authenticated
// via the shared x-dataplane-secret header.
type ControlClient struct {
	BaseURL, Secret string
	HTTP            *http.Client

	recorderMu sync.Mutex
	recorderJS []byte
}

func NewControlClient(base, secret string) *ControlClient {
	return &ControlClient{BaseURL: base, Secret: secret, HTTP: &http.Client{Timeout: 10 * time.Second}}
}

// AuthConnector validates a connector's bearer token against the control
// plane and returns the resolved connectorId, or an error if invalid.
func (c *ControlClient) AuthConnector(token string) (string, error) {
	var out struct {
		ConnectorID string `json:"connectorId"`
	}
	if err := c.post("/api/internal/connector/auth", map[string]string{"token": token}, &out); err != nil {
		return "", err
	}
	return out.ConnectorID, nil
}

// ReportStatus tells the control plane a connector went ONLINE/OFFLINE.
// Best-effort: errors are swallowed since this must never block tunnel
// teardown/setup.
func (c *ControlClient) ReportStatus(connectorID, status, remoteAddr, version, vaultPublicKey string) (egressPolicy, logLevel string, rec RecordingPolicy) {
	var out struct {
		EgressPolicy           string   `json:"egressPolicy"`
		LogLevel               string   `json:"logLevel"`
		TenantID               string   `json:"tenantId"`
		RecordingRetentionDays int      `json:"recordingRetentionDays"`
		PurgeRecordingKeys     []string `json:"purgeRecordingKeys"`
	}
	_ = c.post("/api/internal/connector/status",
		map[string]string{"connectorId": connectorID, "status": status, "remoteAddr": remoteAddr, "version": version, "vaultPublicKey": vaultPublicKey}, &out)
	return out.EgressPolicy, out.LogLevel, RecordingPolicy{TenantID: out.TenantID, RetentionDays: out.RecordingRetentionDays, PurgeKeys: out.PurgeRecordingKeys}
}

// RecordingPolicy is the recording half of a connector's policy, returned on
// connect so the on-connect push resumes retention + carries pending erasures.
type RecordingPolicy struct {
	TenantID      string
	RetentionDays int
	PurgeKeys     []string
}

// ReportErasureAck relays a connector's PolicyAck (what a pushed recording policy
// actually erased/swept) to the control plane, which then drops the matching index
// rows. Best-effort — the connector will re-report on the next push if this fails.
func (c *ControlClient) ReportErasureAck(connectorID string, retentionRemoved int, purgedKeys []string) {
	_ = c.post("/api/internal/recording/erasure-ack",
		map[string]any{"connectorId": connectorID, "retentionRemoved": retentionRemoved, "purgedKeys": purgedKeys}, nil)
}

// ReportRecordings relays a connector's recording report (tunnel.RecReport) to
// the control plane. An error means it was not recorded: the connector keeps
// the items and sends them again.
func (c *ControlClient) ReportRecordings(connectorID string, items []tunnel.RecReportItem) error {
	return c.post("/api/internal/recording/report",
		map[string]any{"connectorId": connectorID, "items": items}, nil)
}

// ResolveSession exchanges a browser session token for the userId/email it
// belongs to. A non-200 response (no such session, or an expired/invalid
// token) is not treated as an error: it simply means "no session", and the
// caller should treat the request as unauthenticated.
func (c *ControlClient) ResolveSession(token string) (userID, email string, err error) {
	var out struct {
		UserID string `json:"userId"`
		Email  string `json:"email"`
	}
	if err := c.post("/api/internal/session/resolve", map[string]string{"token": token}, &out); err != nil {
		if isHTTPStatus(err) {
			return "", "", nil
		}
		return "", "", err
	}
	return out.UserID, out.Email, nil
}

// ViewAuthz asks the manager whether a user may watch the live session on siteID:
// read_console, and the site must belong to the viewer's own tenant. The hub holds
// every tenant's sessions, so the role alone would let one workspace's admin watch
// another's.
func (c *ControlClient) ViewAuthz(userID, siteID string) (bool, error) {
	var out struct {
		Allow bool `json:"allow"`
	}
	if err := c.post("/api/internal/gateway/view-authz", map[string]string{"userId": userID, "siteId": siteID}, &out); err != nil {
		if isHTTPStatus(err) {
			return false, nil
		}
		return false, err
	}
	return out.Allow, nil
}

// GatewayDescriptor authorizes (userID, siteID) and returns the guacd connection
// descriptor with the decrypted credential + the guacd address to reach. On a
// denied grant / missing credential the control plane returns an HTTP status,
// surfaced here as an error so the tunnel closes.
//
// connectors lists every connector that may carry the session, each with the
// secret sealed to its own key; the caller picks one (connpick.go).
func (c *ControlClient) GatewayDescriptor(userID, siteID string) (conn GuacConn, guacdAddress string, connectors []routeCandidate, tenantID string, record, keystrokeLogging bool, mod moderationRef, err error) {
	var out struct {
		Protocol         string            `json:"protocol"`
		TargetHost       string            `json:"targetHost"`
		TargetPort       int               `json:"targetPort"`
		Username         string            `json:"username"`
		Secret           string            `json:"secret"`
		SealedSecret     string            `json:"sealedSecret"`
		SecretKind       string            `json:"secretKind"`
		GuacdAddress     string            `json:"guacdAddress"`
		ConnectorID      string            `json:"connectorId"`
		Connectors       []routeCandidate  `json:"connectors"`
		TenantID         string            `json:"tenantId"`
		Record           bool              `json:"record"`
		KeystrokeLogging bool              `json:"keystrokeLogging"`
		Params           map[string]string `json:"params"`
		Moderation       moderationRef     `json:"moderation"`
	}
	if err := c.post("/api/internal/gateway/descriptor", map[string]string{"userId": userID, "siteId": siteID}, &out); err != nil {
		return GuacConn{}, "", nil, "", false, false, moderationRef{}, err
	}
	return GuacConn{
		Protocol:     out.Protocol,
		Hostname:     out.TargetHost,
		Port:         strconv.Itoa(out.TargetPort),
		Username:     out.Username,
		Secret:       out.Secret,
		SealedSecret: out.SealedSecret,
		SecretKind:   out.SecretKind,
		Params:       out.Params,
	}, out.GuacdAddress, candidatesOr(out.Connectors, out.ConnectorID), out.TenantID, out.Record, out.KeystrokeLogging, out.Moderation, nil
}

// rdpTarget is where a native RDP tunnel goes, and the device redirection the
// gateway tells the user's client to switch off (MS-TSGU redirection flags).
type rdpTarget struct {
	Host, Port, ConnectorID, TenantID, SiteName string
	RedirectFlags                               uint32
	// A recorded resource: Captivo signs in with the saved account (Secret
	// only for a connector without a vault key; else each candidate's seal),
	// and the static channels the resource keeps off are not opened.
	Recorded      bool
	Keystrokes    bool
	Username      string
	Secret        string
	BlockChannels []string
	// Every connector that may carry the tunnel; ConnectorID is set to the one
	// picked from them when the tunnel is dialled.
	Candidates []routeCandidate
}

// NativeRdpTarget authorizes (userID, siteID) for a native RDP client and
// returns the resource's RDP server. The manager refuses (an HTTP status,
// surfaced here as an error) when the grant does not hold, the resource does
// not allow native clients, or its sessions must be recorded.
func (c *ControlClient) NativeRdpTarget(userID, siteID string) (rdpTarget, error) {
	var out struct {
		TargetHost    string           `json:"targetHost"`
		TargetPort    int              `json:"targetPort"`
		ConnectorID   string           `json:"connectorId"`
		Connectors    []routeCandidate `json:"connectors"`
		TenantID      string           `json:"tenantId"`
		SiteName      string           `json:"siteName"`
		RedirectFlags uint32           `json:"redirectFlags"`
		Mode          string           `json:"mode"`
		Username      string           `json:"username"`
		Secret        string           `json:"secret"`
		BlockChannels []string         `json:"blockChannels"`
		Keystrokes    bool             `json:"keystrokes"`
	}
	if err := c.post("/api/internal/gateway/native-rdp", map[string]string{"userId": userID, "siteId": siteID}, &out); err != nil {
		return rdpTarget{}, err
	}
	return rdpTarget{
		Host: out.TargetHost, Port: strconv.Itoa(out.TargetPort), ConnectorID: out.ConnectorID, TenantID: out.TenantID, SiteName: out.SiteName,
		RedirectFlags: out.RedirectFlags, Candidates: candidatesOr(out.Connectors, out.ConnectorID),
		Recorded: out.Mode == "recorded", Keystrokes: out.Keystrokes, Username: out.Username, Secret: out.Secret, BlockChannels: out.BlockChannels,
	}, nil
}

// sshTarget is a resource's SSH server for the jump host. A recorded one
// also carries what the connector needs to sign in (sshrec.go): the account,
// its secret (sealed per candidate, or plain for a connector without a vault
// key), the pinned host key, and what the session may do.
type sshTarget struct {
	rdpTarget
	Record        bool
	Keystrokes    bool
	FileTransfer  string // allow | no_upload | no_download | none
	Username      string
	SecretKind    string
	Secret        string // legacy, unsealed
	PinnedHostKey string
	// A TCP tunnel resource (sshtunnel.go): the user's ssh -L carries their
	// own app's connections to Host:Port, never recorded.
	Tunnel bool
	// A moderated session (moderation.go): only ever a recorded one.
	Moderation moderationRef
}

// NativeSshTarget is NativeRdpTarget for the SSH jump host (sshjump.go): the
// resource's SSH server, when the grant holds and the resource allows a
// user's own SSH client.
func (c *ControlClient) NativeSshTarget(userID, siteID string) (sshTarget, error) {
	var out struct {
		TargetHost    string           `json:"targetHost"`
		TargetPort    int              `json:"targetPort"`
		ConnectorID   string           `json:"connectorId"`
		Connectors    []routeCandidate `json:"connectors"`
		TenantID      string           `json:"tenantId"`
		SiteName      string           `json:"siteName"`
		Record        bool             `json:"record"`
		Keystrokes    bool             `json:"keystrokeLogging"`
		FileTransfer  string           `json:"fileTransfer"`
		Username      string           `json:"username"`
		SecretKind    string           `json:"secretKind"`
		Secret        string           `json:"secret"`
		PinnedHostKey string           `json:"sshHostKey"`
		Tunnel        bool             `json:"tunnel"`
		Moderation    moderationRef    `json:"moderation"`
	}
	if err := c.post("/api/internal/gateway/native-ssh", map[string]string{"userId": userID, "siteId": siteID}, &out); err != nil {
		return sshTarget{}, err
	}
	return sshTarget{
		rdpTarget: rdpTarget{Host: out.TargetHost, Port: strconv.Itoa(out.TargetPort), ConnectorID: out.ConnectorID, TenantID: out.TenantID, SiteName: out.SiteName, Candidates: candidatesOr(out.Connectors, out.ConnectorID)},
		Record:    out.Record, Keystrokes: out.Keystrokes, FileTransfer: out.FileTransfer,
		Username: out.Username, SecretKind: out.SecretKind, Secret: out.Secret, PinnedHostKey: out.PinnedHostKey,
		Tunnel: out.Tunnel, Moderation: out.Moderation,
	}, nil
}

// NoteSshHostKey keeps the host key a recorded session's server showed on
// first contact, so a later different one is refused (connector/sshproxy.go).
func (c *ControlClient) NoteSshHostKey(siteID, fingerprint string) error {
	return c.post("/api/internal/gateway/native-ssh/host-key", map[string]string{"siteId": siteID, "fingerprint": fingerprint}, nil)
}

// SiteByHost resolves a browser-facing hostname to the site/connector it's
// routed to. If the control plane has no site for host, it returns
// ErrNoSite. recordSessions reports whether session recording is enabled for
// this site (see Site.recordSessions). gateway reports whether the site's
// accessMode is GATEWAY (see setGatewayIdentity in browserproxy.go). keystrokes
// reports whether typed input is logged too (the tenant keystroke mode applied
// to this site; only ever true while recordSessions is).
func (c *ControlClient) SiteByHost(host string) (siteRoute, error) {
	var out struct {
		SiteID             string           `json:"siteId"`
		ConnectorID        string           `json:"connectorId"`
		Connectors         []routeCandidate `json:"connectors"`
		TenantID           string           `json:"tenantId"`
		UpstreamUrl        string           `json:"upstreamUrl"`
		InsecureSkipVerify bool             `json:"insecureSkipVerify"`
		RecordSessions     bool             `json:"recordSessions"`
		ClipboardMode      string           `json:"clipboardMode"`
		FileTransferMode   string           `json:"fileTransferMode"`
		AccessMode         string           `json:"accessMode"`
		ConsentRequired    bool             `json:"recordingConsentRequired"`
		Watermark          bool             `json:"watermark"`
		KeystrokeLogging   bool             `json:"keystrokeLogging"`
	}
	if err := c.post("/api/internal/site/by-host", map[string]string{"host": host}, &out); err != nil {
		if he, ok := err.(*httpError); ok && he.code == http.StatusNotFound {
			return siteRoute{}, ErrNoSite
		}
		return siteRoute{}, err
	}
	// A manager that predates web app file control sends no mode: nothing
	// was controlled then, so nothing is now.
	if out.FileTransferMode == "" {
		out.FileTransferMode = "allow"
	}
	return siteRoute{
		SiteID:             out.SiteID,
		ConnectorID:        out.ConnectorID,
		Candidates:         candidatesOr(out.Connectors, out.ConnectorID),
		TenantID:           out.TenantID,
		Upstream:           out.UpstreamUrl,
		ClipboardMode:      out.ClipboardMode,
		FileTransferMode:   out.FileTransferMode,
		InsecureSkipVerify: out.InsecureSkipVerify,
		RecordSessions:     out.RecordSessions,
		Gateway:            out.AccessMode == "GATEWAY",
		ConsentRequired:    out.ConsentRequired,
		Watermark:          out.Watermark,
		Keystrokes:         out.RecordSessions && out.KeystrokeLogging,
	}, nil
}

// RecorderJS returns the rrweb recorder bundle served by the control plane
// at GET /api/internal/recorder. A successful fetch is cached in memory for
// the lifetime of the process (the bundle never changes at runtime), but a
// failed fetch is never cached — the next call retries against the control
// plane. This matters because recording is fail-silent (browserproxy replies
// 404 on error): caching a transient failure would otherwise disable
// recording for the whole process until a restart. recorder.js is fetched
// rarely, so holding the mutex across the network call is fine.
func (c *ControlClient) RecorderJS() ([]byte, error) {
	c.recorderMu.Lock()
	defer c.recorderMu.Unlock()
	if c.recorderJS != nil {
		return c.recorderJS, nil
	}
	req, err := http.NewRequest(http.MethodGet, c.BaseURL+"/api/internal/recorder", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("x-dataplane-secret", c.Secret)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, &httpError{resp.StatusCode}
	}
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	c.recorderJS = b
	return b, nil
}

// SendRecording reports one recording chunk's INDEX to the control plane:
// {recordingKey, seq, bytes} plus the userId/siteId/host the proxy resolved.
//
// It no longer carries the event payload. The bytes go to the connector's own
// store (see recrrweb.go), and this call exists so an admin can still see that a
// recording exists and how large it is. Do not reintroduce a data field here --
// that is the central copy connector-local recordings removed.
//
// Best-effort: the caller ignores the error, since recording must never affect
// the proxied response.
func (c *ControlClient) SendRecording(userID, siteID, host string, body []byte) error {
	var batch map[string]any
	if err := json.Unmarshal(body, &batch); err != nil {
		return err
	}
	if batch == nil {
		batch = map[string]any{}
	}
	batch["userId"] = userID
	batch["siteId"] = siteID
	batch["host"] = host
	return c.post("/api/internal/recording/ingest", batch, nil)
}

// CheckAccess evaluates whether userId is allowed to reach siteId right
// now, returning a human-mappable deny reason when allow is false.
func (c *ControlClient) CheckAccess(userID, siteID, clientIP string) (allow bool, reason string, err error) {
	var out struct {
		Allow  bool   `json:"allow"`
		Reason string `json:"reason"`
	}
	if err := c.post("/api/internal/access/check", map[string]string{"userId": userID, "siteId": siteID, "clientIp": clientIP}, &out); err != nil {
		return false, "", err
	}
	return out.Allow, out.Reason, nil
}

// SendAudit ships a batch of audit events to the control plane for durable
// storage. Called by RunAuditFlush; best-effort (see AuditQueue).
func (c *ControlClient) SendAudit(events []AuditEvent) error {
	return c.post("/api/internal/audit/log", map[string]any{"events": events}, nil)
}

func isHTTPStatus(err error) bool {
	_, ok := err.(*httpError)
	return ok
}

func (c *ControlClient) post(path string, body any, out any) error {
	b, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, c.BaseURL+path, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-dataplane-secret", c.Secret)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	// Accept any 2xx as success: most internal routes reply 200, but
	// /api/internal/recording/ingest replies 204 (no body) on success.
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &httpError{resp.StatusCode}
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}

type httpError struct{ code int }

func (e *httpError) Error() string { return "control-plane returned non-200" }

// dbTarget is a database resource as the proxy needs it (pgproxy.go): who
// the ticket is for, where the server is, and each connector that may carry
// the connection with the password sealed to its own key.
type dbTarget struct {
	TenantID   string           `json:"tenantId"`
	SiteID     string           `json:"siteId"`
	UserID     string           `json:"userId"`
	SiteName   string           `json:"siteName"`
	Engine     string           `json:"engine"`
	Host       string           `json:"targetHost"`
	Port       int              `json:"targetPort"`
	Username   string           `json:"username"`
	Database   string           `json:"database"`
	Databases  []string         `json:"databases"`
	TLS        string           `json:"tls"`
	CACertPEM  string           `json:"caCertPem"`
	Connectors []routeCandidate `json:"connectors"`
	Record     bool             `json:"record"`
}

// engine is the resource's database engine; a control plane older than
// MySQL support sends none.
func (t dbTarget) engine() string {
	if t.Engine == "" {
		return "postgres"
	}
	return t.Engine
}

// DatabaseTarget resolves a connection ticket (the user name a database
// client signs in with). The manager refuses with a status: 404 an unknown or
// expired ticket (or its browser session ended), 403 no active grant, 409 a
// resource that can't be reached as a database now.
func (c *ControlClient) DatabaseTarget(ticket, clientIP string) (dbTarget, error) {
	var out dbTarget
	err := c.post("/api/internal/gateway/database", map[string]string{"ticket": ticket, "clientIp": clientIP}, &out)
	return out, err
}

// httpStatus is the control plane's answer code in err, or 0 when it did not answer.
func httpStatus(err error) int {
	if e, ok := err.(*httpError); ok {
		return e.code
	}
	return 0
}
