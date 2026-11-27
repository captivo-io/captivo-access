package tunnel

// HostAction is a data-plane -> connector frame on the control stream: a change
// to the connector's own host that only the updater beside it can make, because
// the connector has no Docker access. The connector hands it over through the
// shared hostctl volume and answers with a HostActionAck.
//
// The frame names an action and a version, never a command or an image: the
// updater builds both from what is baked into its own image, so even a
// compromised control plane can only ask for a release we published.
//
// An older connector reads every control frame it does not know as a Policy, and
// a Policy with no egress narrowing would widen what it may reach. Send this only
// to a connector whose telemetry reports an updater (Telemetry.Updater).
type HostAction struct {
	Kind     string `json:"kind"`   // "hostaction"
	ID       string `json:"id"`     // chosen by the control plane; echoed in the ack and in the status
	Action   string `json:"action"` // update | uninstall | cancel
	Version  string `json:"version,omitempty"`
	KeepData bool   `json:"keepData,omitempty"` // uninstall: leave the recordings and keys volume on the host
	WaitIdle bool   `json:"waitIdle,omitempty"` // update: hold until no tunnel has been open for a while
}

// HostActionAck is the connector's answer: whether the request was handed to the
// updater (not whether the update worked; that comes later in HostActionStatus).
type HostActionAck struct {
	Kind  string `json:"kind"` // "hostactionack"
	ID    string `json:"id"`
	Error string `json:"error,omitempty"` // no_hostctl | no_updater | busy | invalid | not_pending | write_failed
}

// UpdaterInfo is the updater's heartbeat as the connector last read it.
type UpdaterInfo struct {
	Version  string `json:"version"`
	DockerOK bool   `json:"dockerOk"` // the updater can reach the host's Docker
	HostIP   string `json:"-"`        // from the beat; the connector reports it as LocalIP, not here
}

// HostActionStatus is the latest host action as the updater (or, while it waits
// for idle, the connector) reports it.
type HostActionStatus struct {
	ID      string `json:"id"`
	Action  string `json:"action"`
	State   string `json:"state"` // waiting_idle | preparing | applying | rolling_back | done | rolled_back | failed | removing
	Version string `json:"version,omitempty"`
	From    string `json:"from,omitempty"`
	Detail  string `json:"detail,omitempty"`
	At      string `json:"at,omitempty"` // RFC 3339
}

// The files the connector and the updater share in the hostctl volume. The
// updater never takes input from the network: these files are all it reads.
const (
	HostRequestFile   = "request.json"   // connector -> updater: the action to run
	HostStatusFile    = "status.json"    // updater -> connector: HostActionStatus
	UpdaterBeatFile   = "updater.json"   // updater -> connector: UpdaterBeat, every 30 seconds
	ConnectorMarkFile = "connector.json" // connector -> updater: ConnectorMark, on every accepted tunnel
)

// HostRequest is a HostAction as it waits for the updater. Ready is false while
// an update waits for the connector to be idle; the updater ignores it until then.
type HostRequest struct {
	ID       string `json:"id"`
	Action   string `json:"action"` // update | uninstall
	Version  string `json:"version,omitempty"`
	KeepData bool   `json:"keepData,omitempty"`
	Ready    bool   `json:"ready"`
	At       string `json:"at"`
}

// UpdaterBeat says the updater is running and can reach Docker.
type UpdaterBeat struct {
	Version  string `json:"version"`
	DockerOK bool   `json:"dockerOk"`
	// HostIP is the address the machine itself reaches the network with, read
	// from the host's network (a connector in a container cannot see it). Empty
	// until the updater has read it once.
	HostIP string `json:"hostIp,omitempty"`
	At     string `json:"at"`
}

// ConnectorMark is written each time the data-plane accepts the connector's
// tunnel: the updater's proof that a new version came up and connected.
type ConnectorMark struct {
	Version string `json:"version"`
	At      string `json:"at"`
}
