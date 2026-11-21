package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
)

// routeCandidate is one connector the manager says may carry a resource's
// session. A resource on a connector group gets every eligible member; one on
// a single connector gets just that one. sealedSecret is the resource's vault
// secret sealed to this member's key (gateway descriptors only).
type routeCandidate struct {
	ID           string `json:"id"`
	Standby      bool   `json:"standby,omitempty"`
	SealedSecret string `json:"sealedSecret,omitempty"`
}

// candidatesOr returns the manager's candidates, or the single connector an
// older manager names, so the dataplane runs against either.
func candidatesOr(cands []routeCandidate, connectorID string) []routeCandidate {
	if len(cands) > 0 {
		return cands
	}
	if connectorID == "" {
		return nil
	}
	return []routeCandidate{{ID: connectorID}}
}

func decodeCandidates(raw json.RawMessage) []routeCandidate {
	var c []routeCandidate
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &c)
	}
	return c
}

func connected(reg *Registry, id string) bool {
	s := reg.Get(id)
	return s != nil && s.mux != nil && !s.mux.IsClosed()
}

// pickLeastLoaded chooses the connector for a new interactive session: the
// online active member carrying the fewest live sessions, else the least
// loaded online standby. With none online it returns the first candidate, so
// the caller reports that connector offline as before. ok is false only when
// there are no candidates at all.
func pickLeastLoaded(reg *Registry, hub *SessionHub, cands []routeCandidate) (routeCandidate, bool) {
	if len(cands) == 0 {
		return routeCandidate{}, false
	}
	if len(cands) == 1 {
		return cands[0], true
	}
	for _, standby := range []bool{false, true} {
		best, bestLoad := -1, 0
		for i, c := range cands {
			if c.Standby != standby || !connected(reg, c.ID) {
				continue
			}
			load := 0
			if hub != nil {
				load = hub.CountByConnector(c.ID)
			}
			if best < 0 || load < bestLoad {
				best, bestLoad = i, load
			}
		}
		if best >= 0 {
			return cands[best], true
		}
	}
	return cands[0], true
}

// pickSticky chooses the connector for web app traffic, where every request is
// routed on its own: the same user stays on the same online member (a recorded
// page's chunks must all reach one connector), and when members come or go
// only the users of that member move (rendezvous hashing).
func pickSticky(reg *Registry, cands []routeCandidate, key string) (routeCandidate, bool) {
	if len(cands) == 0 {
		return routeCandidate{}, false
	}
	if len(cands) == 1 {
		return cands[0], true
	}
	for _, standby := range []bool{false, true} {
		best, bestScore := -1, uint64(0)
		for i, c := range cands {
			if c.Standby != standby || !connected(reg, c.ID) {
				continue
			}
			h := sha256.Sum256([]byte(key + "\x00" + c.ID))
			if score := binary.BigEndian.Uint64(h[:8]); best < 0 || score > bestScore {
				best, bestScore = i, score
			}
		}
		if best >= 0 {
			return cands[best], true
		}
	}
	return cands[0], true
}
