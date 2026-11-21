package tunnel

// ResealRequest asks a connector to copy saved resource secrets to other
// connectors of its connector group: it opens each sealed secret with its own
// vault key and seals it again to every key in To, for the same target. The
// plaintext exists only in the connector's memory; the control plane gets the
// new sealed copies, which it cannot open either. Kind is "reseal".
type ResealRequest struct {
	Kind  string       `json:"kind"` // "reseal"
	Items []ResealItem `json:"items"`
}

// ResealItem is one saved secret: its seal for this connector, and the target
// it was entered for (the seal's additional data, kept on the new copies).
type ResealItem struct {
	ID       string   `json:"id"`
	Sealed   string   `json:"sealed"`
	Host     string   `json:"host"`
	Port     string   `json:"port"`
	Username string   `json:"username"`
	To       []string `json:"to"`
}

// ResealResponse carries the new seals by item and recipient key. An item the
// connector could not open comes back with Error and no seals.
type ResealResponse struct {
	Items []ResealResult `json:"items"`
	Error string         `json:"error,omitempty"`
}

type ResealResult struct {
	ID    string            `json:"id"`
	Seals map[string]string `json:"seals,omitempty"`
	Error string            `json:"error,omitempty"`
}
