package tunnel

// ControlHello is the data-plane's opening frame on a control stream (Kind
// "control"). The connector dispatches on it and then reports telemetry.
type ControlHello struct {
	Kind string `json:"kind"` // "control"
}

// Telemetry is a periodic connector -> data-plane report on the control stream.
type Telemetry struct {
	Version           string   `json:"version"`
	UptimeSec         int64    `json:"uptimeSec"`
	ActiveConnections int      `json:"activeConnections"` // in-flight relay streams (excludes control)
	TotalConnections  int64    `json:"totalConnections"`  // since process start
	DeniedCount       int64    `json:"deniedCount"`       // egress-boundary rejections since start
	BytesIn           int64    `json:"bytesIn"`           // upstream -> vendor bytes relayed since start
	BytesOut          int64    `json:"bytesOut"`          // vendor -> upstream bytes relayed since start
	RecentLogs        []string `json:"recentLogs"`        // tail of the connector's own log output
	GuacdLogs         []string `json:"guacdLogs"`         // tail of guacd's log (gateway-host connectors only)
	KasmLogs          []string `json:"kasmLogs"`          // tail of the isolated-browser (KasmVNC) broker log (gateway-host connectors only)
	// The host the connector runs on, as the install command hands it in
	// (--hostname, HOST_IP, /etc/os-release); empty when started without them.
	Hostname string `json:"hostname,omitempty"`
	OS       string `json:"os,omitempty"`
	LocalIP  string `json:"localIp,omitempty"`
	// The updater beside the connector (nil: none, or a connector before 2.41.0)
	// and the latest host action it ran.
	Updater    *UpdaterInfo      `json:"updater,omitempty"`
	HostAction *HostActionStatus `json:"hostAction,omitempty"`
}
