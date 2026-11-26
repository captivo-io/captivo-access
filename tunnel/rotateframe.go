package tunnel

// RotateRequest asks a connector to work on a resource's saved password
// (connector/rotate.go). The connector opens every seal with its own vault key
// for the target named here, so the control plane can only ever point it at
// the host, port and user the password was entered for, and it gets back only
// sealed values. Kind is "rotate".
//
// Ops:
//
//	prepare  generate the next password and seal it to every key in To
//	apply    make the target use Pending (the connector's own seal of the
//	         prepared password) instead of Current, then check it signs in
//	verify   check Current still signs in
//	reveal   seal Current to the one key in To (an admin's browser)
//	retarget re-seal Current, opened for Host/Port/Username, for the target named in
//	         NewHost/NewPort/NewUsername, to every key in To (the holders of the
//	         resource): the password moves with the resource and is never shown
//	discover list the accounts on a Linux server, through the reconcile
//	         account (Current is not used)
type RotateRequest struct {
	Kind     string   `json:"kind"` // "rotate"
	Op       string   `json:"op"`
	Method   string   `json:"method"` // "linux" (SSH) | "windows" (local account, SMB) | "ad" (directory account) | "postgres" | "mysql" | "mssql"
	Host     string   `json:"host"`
	Port     string   `json:"port"`
	Username string   `json:"username"`
	Current  string   `json:"current"`
	Pending  string   `json:"pending,omitempty"`
	// retarget: the address and account the saved password moves to.
	NewHost     string `json:"newHost,omitempty"`
	NewPort     string `json:"newPort,omitempty"`
	NewUsername string `json:"newUsername,omitempty"`
	To       []string `json:"to,omitempty"`
	// Linux: the target's SSH host key as first seen ("SHA256:..."); empty
	// trusts and reports the key on this first contact.
	SSHHostKey string `json:"sshHostKey,omitempty"`
	// The privileged account that resets the password when the account cannot
	// change its own (it no longer matches, or the target refuses the change).
	Reconcile *RotateReconcile `json:"reconcile,omitempty"`
	// AD: the domain controller the account lives in.
	Directory *RotateDirectory `json:"directory,omitempty"`
	// A database account: how to connect, as the resource's sessions do.
	DB *RotateDB `json:"db,omitempty"`
	// Shown in the connector's own record of rotated passwords (show-password).
	Label string `json:"label,omitempty"`
}

// RotateReconcile is sealed for "reconcile,<host>,<port>,<username>": the
// gateway never opens it, so it can sign in only through a rotation.
type RotateReconcile struct {
	Host      string `json:"host"`
	Port      string `json:"port"`
	Username  string `json:"username"`
	Sealed    string `json:"sealed"`
	SecretKey bool   `json:"secretKey,omitempty"` // a private key, not a password
}

type RotateDirectory struct {
	Host               string `json:"host"`
	Port               string `json:"port"`
	Security           string `json:"security"` // LDAPS | STARTTLS (PLAIN is refused)
	CACertPEM          string `json:"caCertPem,omitempty"`
	InsecureSkipVerify bool   `json:"insecureSkipVerify,omitempty"`
	BaseDN             string `json:"baseDn"`
	// The resource's domain, for a user name without one ("alice").
	Domain string `json:"domain,omitempty"`
}

// RotateResponse. Outcome for apply: "rotated" (the target now uses the new
// password), "already" (it already did: an earlier apply got through),
// "failed" (it still uses the current one), "unknown" (it may use either; the
// next apply finds out). For verify: "ok", "pending" (the prepared one works,
// not the current one) or "mismatch" (neither).
type RotateResponse struct {
	Seals      map[string]string `json:"seals,omitempty"`
	Outcome    string            `json:"outcome,omitempty"`
	Reconciled bool              `json:"reconciled,omitempty"` // the reconcile account set it
	OutOfSync  bool              `json:"outOfSync,omitempty"`  // the saved password no longer signed in
	SSHHostKey string            `json:"sshHostKey,omitempty"`
	Detail     string            `json:"detail,omitempty"`
	Error      string            `json:"error,omitempty"`
	// discover: the server's accounts. Never a hash.
	Accounts []DiscoveredAccount `json:"accounts,omitempty"`
}

// DiscoveredAccount is one account of a Linux server (connector/discover.go).
type DiscoveredAccount struct {
	Name   string `json:"name"`
	UID    int    `json:"uid"`
	Shell  string `json:"shell"`
	Home   string `json:"home"`
	Admin  bool   `json:"admin,omitempty"`  // uid 0, or in sudo, wheel or admin
	Login  bool   `json:"login,omitempty"`  // has a shell that signs in
	Locked bool   `json:"locked,omitempty"` // no password can sign in (a "!" or "*" hash)
	NoPass bool   `json:"noPass,omitempty"` // an empty password
	// Days since the password was last changed; -1 when unknown.
	PassAgeDays int `json:"passAgeDays"`
	// Why this account cannot be taken over, when the server says so (a MySQL
	// user that exists for several hosts, for one).
	Blocked string `json:"blocked,omitempty"`
}

// RotateDB is how the connector signs in to a database resource's server for a
// rotation: the database to connect to (PostgreSQL needs one) and TLS as the
// resource sets it ("disable", "require", "verify-full").
type RotateDB struct {
	Database  string `json:"database,omitempty"`
	TLS       string `json:"tls"`
	CACertPEM string `json:"caCertPem,omitempty"`
}
