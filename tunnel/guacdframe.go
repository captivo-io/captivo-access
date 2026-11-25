package tunnel

// GuacdDialRequest is the first control frame on a guacd stream (Kind "guacd").
// Target is the guacd "host:port" the connector plain-TCP-dials; the Guacamole
// protocol then runs opaquely over the relay.
type GuacdDialRequest struct {
	Kind   string `json:"kind"`   // "guacd"
	Target string `json:"target"` // "host:port"
	// A resource secret sealed to the connector's vault key: the connector opens
	// it for the target in the "connect" instruction and puts it in place of
	// Placeholder, so the data-plane never holds the plaintext.
	Sealed      string `json:"sealed,omitempty"`
	Placeholder string `json:"placeholder,omitempty"`
	// Administrator rights for this session (connector/elevate.go): the account
	// the session signs in as gets them before guacd connects and loses them
	// when the stream ends.
	Elevate *ElevateRequest `json:"elevate,omitempty"`
}

// ElevateRequest names whose rights to raise and who raises them. Admin is the
// resource's reconcile seal, bound to Host and Port as for a rotation.
type ElevateRequest struct {
	Platform string          `json:"platform"` // "linux" | "windows"
	Host     string          `json:"host"`
	Port     string          `json:"port"`
	Account  string          `json:"account"`
	Admin    RotateReconcile `json:"admin"`
	// Linux: the server's SSH host key as pinned ("SHA256:...").
	SSHHostKey string `json:"sshHostKey,omitempty"`
}

// GuacdDialResponse reports whether the connector reached guacd. Empty Error = ok.
type GuacdDialResponse struct {
	Error string `json:"error,omitempty"`
}
