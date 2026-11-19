package tunnel

// RdpDialRequest is the first control frame on a native RDP stream (Kind "rdp").
// The connector raw-TCP-dials Target (a "host:port", the resource's RDP server)
// and, on success, relays bytes bidirectionally. Like the LDAP relay it parses
// nothing: the user's own Remote Desktop client negotiates TLS/CredSSP with the
// server end-to-end, through the data-plane's RD Gateway and this relay.
type RdpDialRequest struct {
	Kind   string `json:"kind"`   // "rdp"
	Target string `json:"target"` // host:port
}

// RdpDialResponse reports whether the connector reached Target. An empty Error
// means the connection succeeded and the raw byte relay has begun.
type RdpDialResponse struct {
	Error string `json:"error,omitempty"`
}
