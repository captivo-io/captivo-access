package tunnel

// EgressRequest registers or releases the network rule of one isolated-browser
// session (Kind "egress"). The isolated browser reaches the network only
// through the connector's egress proxy, which applies the rule of the session
// whose token it presents.
type EgressRequest struct {
	Kind string `json:"kind"` // "egress"
	Op   string `json:"op"`   // "register" | "release"
	// register: Mode is "internet" (public internet + Hosts; the internal
	// network only for Hosts), "strict" (Hosts only) or "open" (anything).
	// Hosts are the resource's own host and any the admin listed ("*.x.com" ok).
	// ReportOnly records what the rule would block but blocks nothing.
	Mode       string   `json:"mode,omitempty"`
	Hosts      []string `json:"hosts,omitempty"`
	ReportOnly bool     `json:"reportOnly,omitempty"`
	// release
	Token string `json:"token,omitempty"`
}

// EgressEvent is one destination the rule blocked (or, report-only, would have).
type EgressEvent struct {
	Dest    string `json:"dest"` // host:port
	Reason  string `json:"reason"`
	Count   int    `json:"count"`
	Blocked bool   `json:"blocked"`
}

type EgressResponse struct {
	Token  string        `json:"token,omitempty"`
	Proxy  string        `json:"proxy,omitempty"` // host:port the isolated browser uses
	Events []EgressEvent `json:"events,omitempty"`
	Error  string        `json:"error,omitempty"`
}
