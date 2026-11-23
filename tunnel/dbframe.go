package tunnel

// DbDialRequest is the first frame on a database stream (Kind "db"). The
// connector dials the resource's database server, signs in with the saved
// password (sealed to its own vault key for this target, like a gateway
// session's) and, once the server says the sign-in worked, answers with a
// DbDialResponse and relays the rest of the connection raw: the server's
// ParameterStatus, BackendKeyData and ReadyForQuery come next, then the
// queries. The password never leaves the connector.
type DbDialRequest struct {
	Kind     string `json:"kind"`   // "db"
	Engine   string `json:"engine"` // "postgres" | "mysql" | "mssql"
	Host     string `json:"host"`
	Port     string `json:"port"`
	Username string `json:"username"`
	Database string `json:"database"`
	Sealed   string `json:"sealed"` // the password, sealed for Host, Port, Username
	// TLS to the server: "disable", "require" (encrypted, any certificate) or
	// "verify-full" (the certificate must name Host and chain to CACertPEM, or
	// to the system roots when that is empty).
	TLS       string `json:"tls"`
	CACertPEM string `json:"caCertPem,omitempty"`
	// Startup parameters the user's client asked for (application_name,
	// client_encoding, DateStyle...). The connector drops the ones that would
	// change who signs in or where (user, database, replication, options).
	Params map[string]string `json:"params,omitempty"`
	// MySQL: the capability flags the user's client agreed with the data plane
	// and its character set. The connector signs in with the ones the server
	// also has, so what the server sends next reads the way the client expects.
	Capabilities uint32 `json:"capabilities,omitempty"`
	Collation    uint8  `json:"collation,omitempty"`
	// SQL Server: the user's client's LOGIN7 (its TDS version, packet size,
	// options, host and application names; never a password). The connector
	// signs in with these and the saved account.
	MSSQL *Login7 `json:"mssql,omitempty"`
}

// DbDialResponse reports the sign-in. An empty Error means the server accepted
// it and the raw relay has begun. Error is safe to show the user (a server's
// "password authentication failed" is reported as such, never the password).
type DbDialResponse struct {
	Error string `json:"error,omitempty"`
	// The server's SQLSTATE when it refused (28P01 wrong password, 3D000 no
	// such database...), for the client's error.
	Code string `json:"code,omitempty"`
	// Whether the connection to the server is encrypted.
	TLS bool `json:"tls,omitempty"`
	// MySQL: the server's connection id (KILL QUERY takes it), its version and
	// the capability flags the sign-in settled on.
	ConnID        uint32 `json:"connId,omitempty"`
	ServerVersion string `json:"serverVersion,omitempty"`
	Capabilities  uint32 `json:"capabilities,omitempty"`
	// SQL Server: the server's answer to the sign-in (its tokens: LOGINACK,
	// the database, collation and packet size it settled on), which the data
	// plane hands the user's client as the answer to its own LOGIN7.
	LoginReply []byte `json:"loginReply,omitempty"`
}

// DbCancelRequest (Kind "db-cancel") asks the connector to send PostgreSQL's
// cancel request for a running query: a separate connection to the server
// carrying the backend's process id and secret key. There is no answer frame.
type DbCancelRequest struct {
	Kind      string `json:"kind"` // "db-cancel"
	Host      string `json:"host"`
	Port      string `json:"port"`
	TLS       string `json:"tls"`
	CACertPEM string `json:"caCertPem,omitempty"`
	PID       uint32 `json:"pid"`
	Secret    uint32 `json:"secret"`
}
