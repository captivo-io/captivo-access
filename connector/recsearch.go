package main

import (
	"encoding/json"
	"strings"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// snippetRadius is how much context accompanies a hit. Small on purpose: the answer
// is "which recording", not "here is the content".
const snippetRadius = 40

// keyEventPayload is one reconstructed keystroke event as the dataplane sends it in
// a "keys" chunk. It mirrors what the control plane used to store as a
// SessionKeyEvent row, minus the row id.
type keyEventPayload struct {
	AtMs   int    `json:"atMs"`
	Kind   string `json:"kind"` // "command" | "text"
	Text   string `json:"text"`
	Masked bool   `json:"masked"`
}

// searchStore runs the command search where the bytes are.
//
// Semantics mirror the control plane's former src/lib/recording/command-search.ts
// exactly, and the two that are easy to lose are the ones that matter:
//
//   - Only KEYSTROKE recordings are searched. A guac or video chunk is a protocol
//     or media stream, and substring-matching it yields meaningless hits; the
//     central search never touched them because it only read keystroke rows.
//   - MASKED entries are skipped. A line is masked because it is a password
//     prompt; matching it would leak precisely what masking exists to hide.
//     Centrally this was `where: { masked: false }`.
//
// Also unchanged: case-insensitive substring, an empty query never matches, and a
// chunk that fails to decrypt or parse is skipped rather than failing the search.
func searchStore(s *recStore, req tunnel.RecSearchRequest) tunnel.RecSearchResponse {
	needle := strings.ToLower(strings.TrimSpace(req.Query))
	if needle == "" {
		return tunnel.RecSearchResponse{}
	}
	budget := req.MaxDecrypt
	if budget <= 0 {
		budget = 500
	}
	var out tunnel.RecSearchResponse
	for _, key := range req.RecordingKeys {
		if budget <= 0 {
			out.Truncated = true
			break
		}
		if s.Format(req.TenantID, key) != "keys" {
			continue
		}
		chunks, err := s.Read(req.TenantID, key, 0)
		if err != nil {
			continue
		}
		matched := false
		for _, c := range chunks {
			if budget <= 0 {
				out.Truncated = true
				break
			}
			budget--
			var evs []keyEventPayload
			if json.Unmarshal(c.Data, &evs) != nil {
				continue
			}
			for _, e := range evs {
				if e.Masked {
					continue
				}
				at := strings.Index(strings.ToLower(e.Text), needle)
				if at < 0 {
					continue
				}
				out.Matches = append(out.Matches, tunnel.RecSearchMatch{
					RecordingKey: key, Seq: c.Seq, Snippet: snippetAround(e.Text, at, len(req.Query)),
				})
				matched = true
				break
			}
			if matched {
				break // one hit per recording is enough to surface it
			}
		}
	}
	return out
}

func snippetAround(s string, at, matchLen int) string {
	start := at - snippetRadius
	if start < 0 {
		start = 0
	}
	end := at + matchLen + snippetRadius
	if end > len(s) {
		end = len(s)
	}
	return strings.ToValidUTF8(s[start:end], "")
}
