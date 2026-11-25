package tunnel

// SshDialRequest is the first frame on a recorded-SSH stream (Kind "ssh"). The
// connector signs in to the resource's SSH server with the saved password or
// key (sealed to its own vault key for this target, like a gateway session's)
// and checks the server's host key against the one pinned for it. When that
// worked it answers with an SshDialResponse and then speaks SSH on the stream
// as a server: every channel and request the data plane opens is carried to
// the signed-in connection, and the answers back. The secret never leaves the
// connector; the data plane, which terminates the user's own SSH client, sees
// the session in the clear and records it.
type SshDialRequest struct {
	Kind     string `json:"kind"` // "ssh"
	Host     string `json:"host"`
	Port     string `json:"port"`
	Username string `json:"username"`
	// Exactly one of these: the secret sealed for Host, Port, Username, or (a
	// connector without a vault key yet) the secret itself.
	Sealed string `json:"sealed,omitempty"`
	Secret string `json:"secret,omitempty"`
	// "PASSWORD" or "KEY" (an OpenSSH or PEM private key without a passphrase).
	SecretKind string `json:"secretKind"`
	// The server's host key fingerprint ("SHA256:...") seen before; empty on
	// first contact, when whatever the server shows is taken and reported.
	PinnedHostKey string `json:"pinnedHostKey,omitempty"`
	// Who is signing in, for a certificate's key id ("captivo:ana@acme.com"),
	// which the server then writes in its log.
	KeyID string `json:"keyId,omitempty"`
	// Give the account administrator rights (sudo) for this session: the
	// administrator account signs in on Host and Port to add and later remove
	// a sudoers entry for Username (connector/elevate.go). Its seal is the
	// resource's reconcile seal.
	Elevate *RotateReconcile `json:"elevate,omitempty"`
}

// SshDialResponse reports the sign-in. An empty Error means the SSH server on
// the stream is ready. HostKey is the fingerprint the server showed, also on
// a refusal, so a changed key can be named.
type SshDialResponse struct {
	Error          string `json:"error,omitempty"`
	HostKey        string `json:"hostKey,omitempty"`
	HostKeyChanged bool   `json:"hostKeyChanged,omitempty"`
	// The account has administrator rights for this session.
	Elevated bool `json:"elevated,omitempty"`
}
