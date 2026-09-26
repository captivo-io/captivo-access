package main

import (
	"strings"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// snippetRadius is how much context accompanies a hit. Small on purpose: the answer
// is "which recording", not "here is the content".
const snippetRadius = 40

// searchStore runs the command search where the bytes are. Semantics mirror
// src/lib/recording/command-search.ts exactly -- case-insensitive substring, an
// empty query never matches, an undecryptable chunk is skipped -- because the
// control plane keeps that function's contract and only changes where it runs.
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
		chunks, err := s.Read(req.TenantID, key, 0)
		if err != nil {
			continue
		}
		for _, c := range chunks {
			if budget <= 0 {
				out.Truncated = true
				break
			}
			budget--
			hay := strings.ToLower(string(c.Data))
			at := strings.Index(hay, needle)
			if at < 0 {
				continue
			}
			out.Matches = append(out.Matches, tunnel.RecSearchMatch{
				RecordingKey: key, Seq: c.Seq, Snippet: snippetAround(string(c.Data), at, len(req.Query)),
			})
			break // one hit per recording is enough to surface it
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
