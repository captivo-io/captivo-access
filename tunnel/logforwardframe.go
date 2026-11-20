package tunnel

// LogForwardRequest is the first (and only) frame on a "logforward" stream: a
// batch of audit records, already rendered as syslog messages by the control
// plane, for the connector to deliver to a SIEM on its own network. The
// connector answers with one LogForwardResponse once the batch is written.
//
// The control plane keeps the queue (a cursor per destination) and resends a
// batch the connector could not deliver, so the connector holds nothing.
//
// An older connector reads this as a dial request with no upstream and answers
// a DialResponse with "bad upstream url": nothing is sent anywhere.
type LogForwardRequest struct {
	Kind       string   `json:"kind"`      // "logforward"
	Transport  string   `json:"transport"` // udp | tcp | tls
	Target     string   `json:"target"`    // host:port
	Framing    string   `json:"framing,omitempty"`
	ServerName string   `json:"serverName,omitempty"` // tls: the name to verify; default the target's host
	CAPEM      string   `json:"caPem,omitempty"`      // tls: trust these instead of the system roots
	Messages   []string `json:"messages"`
}

// Framing of messages on a TCP or TLS stream (RFC 6587).
const (
	LogFramingNewline = "newline" // each message ends with LF (non-transparent framing)
	LogFramingOctet   = "octet"   // "<length> <message>" (octet counting)
)

// LogForwardResponse says how much of the batch reached the SIEM's socket.
// Error is empty when all of it did.
type LogForwardResponse struct {
	Sent      int    `json:"sent"`
	Error     string `json:"error,omitempty"`
	LatencyMs int    `json:"latencyMs"`
}
