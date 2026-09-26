package tunnel

// Recording frames. Chunk bytes belong to the customer's connector, never to the
// control plane: the dataplane writes them INTO the tunnel (recwrite), search runs
// where the bytes are (recsearch) and replay streams back on demand (recfetch).
// Each mirrors the ProbeRequest/ProbeResponse shape already used on this tunnel.

// RecWriteRequest carries one chunk to the connector's store. Data is the raw
// (already gzipped by the caller, not yet encrypted) chunk payload; the connector
// encrypts with its own key before it touches the disk.
type RecWriteRequest struct {
	Kind         string `json:"kind"` // "recwrite"
	TenantID     string `json:"tenantId"`
	RecordingKey string `json:"recordingKey"`
	Seq          int    `json:"seq"`
	Format       string `json:"format"`   // "guac" | "rrweb" | "video"
	Protocol     string `json:"protocol"` // "ssh" | "rdp" | "vnc" | "" for web
	Data         []byte `json:"data"`
}

// RecWriteResponse reports bytes committed so the caller can keep the central byte
// counter honest. Empty Error = ok.
type RecWriteResponse struct {
	Written int    `json:"written"`
	Error   string `json:"error,omitempty"`
}

// RecSearchRequest asks the connector to search its own store. RecordingKeys
// narrows the candidate set (the control plane already knows which recordings the
// caller may see). MaxDecrypt bounds how many chunks may be decrypted, so one
// search cannot scan an unbounded corpus.
type RecSearchRequest struct {
	Kind          string   `json:"kind"` // "recsearch"
	TenantID      string   `json:"tenantId"`
	Query         string   `json:"query"`
	RecordingKeys []string `json:"recordingKeys"`
	MaxDecrypt    int      `json:"maxDecrypt"`
}

// RecSearchMatch is one hit: which recording, which chunk, and the snippet the
// caller asked to see. Never the whole chunk.
type RecSearchMatch struct {
	RecordingKey string `json:"recordingKey"`
	Seq          int    `json:"seq"`
	Snippet      string `json:"snippet"`
}

// RecSearchResponse returns the hits. Truncated means the decrypt budget ran out
// before the candidate set was exhausted -- the caller must surface that, because
// an empty-looking answer would otherwise read as "it did not happen".
type RecSearchResponse struct {
	Matches   []RecSearchMatch `json:"matches"`
	Truncated bool             `json:"truncated"`
	Error     string           `json:"error,omitempty"`
}

// RecFetchRequest asks for a recording's chunks for replay, from FromSeq onward.
// The connector answers with a RecFetchResponse frame and then streams the
// plaintext chunks as frames until the stream closes.
type RecFetchRequest struct {
	Kind         string `json:"kind"` // "recfetch"
	TenantID     string `json:"tenantId"`
	RecordingKey string `json:"recordingKey"`
	FromSeq      int    `json:"fromSeq"`
}

// RecFetchResponse precedes the streamed chunks. Empty Error = the stream follows.
type RecFetchResponse struct {
	Error string `json:"error,omitempty"`
}
