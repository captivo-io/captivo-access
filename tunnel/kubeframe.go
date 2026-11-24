package tunnel

// KubeDialRequest is the first frame on a Kubernetes stream (Kind "k8s"). The
// connector opens a TLS connection to the cluster's API server, checking its
// certificate against CACertPEM, and answers with a KubeDialResponse. On
// success the rest of the stream is plain HTTP/1.1 from the data plane: the
// connector serves it, signing every request in with the service account
// token (sealed to its own vault key for this target, like a database
// password) and, for Impersonate, naming the Captivo user and groups the
// request acts as. Whatever Authorization or Impersonate-* headers the stream
// carries are dropped first: only this frame says who acts.
type KubeDialRequest struct {
	Kind     string `json:"kind"` // "k8s"
	Host     string `json:"host"`
	Port     string `json:"port"`
	Username string `json:"username"` // the service account's name, part of the seal's target
	Sealed   string `json:"sealed"`   // the token, sealed for Host, Port, Username
	// The cluster's CA (PEM). Empty: the system roots (a managed cluster
	// behind a public certificate).
	CACertPEM string `json:"caCertPem,omitempty"`
	// The name the API server's certificate must carry, when Host is an
	// address the certificate doesn't name.
	ServerName string `json:"serverName,omitempty"`
	// Each request acts as this user and these groups (Kubernetes
	// impersonation). Empty: as the service account itself.
	ImpersonateUser   string   `json:"impersonateUser,omitempty"`
	ImpersonateGroups []string `json:"impersonateGroups,omitempty"`
}

// KubeDialResponse reports the connection to the API server. An empty Error
// means the connector reached it and serves the stream as HTTP from now on.
type KubeDialResponse struct {
	Error string `json:"error,omitempty"`
}
