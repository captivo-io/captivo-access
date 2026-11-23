package tunnel

// RdpRecRequest is the first frame on a recorded native RDP stream (Kind
// "rdp-rec"). The data plane has ended the user's TLS (dataplane/rdprec.go);
// the connector connects to the server, negotiates TLS and NLA, and signs in
// with the saved account (sealed for Host, Port, Username), then answers with
// an RdpRecResponse, takes an RdpRecStart, and carries the RDP sequence from
// the client's MCS Connect Initial on, rewriting the few fields that must agree with what each side
// negotiated, and the client's logon info.
type RdpRecRequest struct {
	Kind     string `json:"kind"` // "rdp-rec"
	Host     string `json:"host"`
	Port     string `json:"port"`
	Username string `json:"username"`
	// Exactly one of these: the password sealed for Host, Port, Username, or (a
	// connector without a vault key yet) the password itself.
	Sealed string `json:"sealed,omitempty"`
	Secret string `json:"secret,omitempty"`
	// Static channels the resource keeps off (cliprdr, rdpdr, rdpsnd...): the
	// server is asked for none of them, whatever the client requests.
	BlockChannels []string `json:"blockChannels,omitempty"`
}

// RdpRecResponse reports the sign-in. An empty Error means the connector is
// signed in and waits for an RdpRecStart. CertSHA256 is the server
// certificate's fingerprint; NegFlags the flags of the server's negotiation
// response (graphics pipeline support among them), which the data plane passes
// on to the client.
type RdpRecResponse struct {
	Error      string `json:"error,omitempty"`
	CertSHA256 string `json:"certSha256,omitempty"`
	NegFlags   uint8  `json:"negFlags,omitempty"`
}

// RdpRecStart follows once the user's client has negotiated TLS with the data
// plane: what it asked for, then the RDP sequence.
type RdpRecStart struct {
	ClientProtocols uint32 `json:"clientProtocols"`
}
