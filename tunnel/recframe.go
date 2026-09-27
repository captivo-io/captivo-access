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
	// Format names the STREAM this chunk belongs to, and the connector stores it
	// under that name. One session writes several streams under one recording key
	// (a guac session records its instructions and its keystrokes at once), each
	// numbering its chunks from zero, so without this they overwrite one another.
	Format   string `json:"format"`   // "guac" | "rrweb" | "video" | "keys"
	Protocol string `json:"protocol"` // "ssh" | "rdp" | "vnc" | "" for web
	Data     []byte `json:"data"`
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

// RecFetchRequest asks for a recording's chunks for replay. The connector answers
// with a RecFetchResponse frame and then streams the plaintext as frames until the
// stream closes.
//
// FromByte/ToByte carry an HTTP Range through to the connector so a video player
// can still scrub. Without them replay would have to stream from the start, and the
// only way to answer a Range centrally would be buffering the whole recording in
// the control plane's memory -- up to the 500 MiB per-recording cap, for a copy this
// design exists to avoid keeping.
//
// Byte offsets are over the CONCATENATED plaintext, which is what the player sees;
// the connector maps them onto its chunks. ToByte is inclusive, matching HTTP.
// ToByte == 0 with FromByte == 0 means "the whole recording".
type RecFetchRequest struct {
	Kind         string `json:"kind"` // "recfetch"
	TenantID     string `json:"tenantId"`
	RecordingKey string `json:"recordingKey"`
	// Format selects which stream of the recording to replay -- a recording holds
	// more than one. Required: guessing a default would hand a player the wrong
	// stream, which is the bug this field exists to close.
	Format   string `json:"format"`
	FromSeq  int    `json:"fromSeq"`
	FromByte int64  `json:"fromByte"`
	ToByte   int64  `json:"toByte"`
}

// RecFetchResponse precedes the streamed chunks. Empty Error = the stream follows.
// TotalBytes is the recording's full plaintext length, which a Range response needs
// for its Content-Range header and which only the connector can know for certain.
type RecFetchResponse struct {
	Error      string `json:"error,omitempty"`
	TotalBytes int64  `json:"totalBytes,omitempty"`
}
