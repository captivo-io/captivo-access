package main

import (
	"fmt"
	"testing"
	"time"
)

func liveReg(t *testing.T, ids ...string) *Registry {
	t.Helper()
	reg := NewRegistry()
	for _, id := range ids {
		srv, _ := newTunnelPair(t)
		reg.Set(id, &Session{mux: srv})
	}
	return reg
}

func TestPickLeastLoadedSpreadsOverOnlineActives(t *testing.T) {
	reg := liveReg(t, "a", "b", "s")
	hub := NewSessionHub()
	cands := []routeCandidate{{ID: "a"}, {ID: "b"}, {ID: "s", Standby: true}, {ID: "gone"}}
	var got []string
	for i := 0; i < 4; i++ {
		c, ok := pickLeastLoaded(reg, hub, cands)
		if !ok {
			t.Fatal("no pick")
		}
		got = append(got, c.ID)
		hub.RegisterNative(fmt.Sprint("s", i), "ssh", "site", "u", "h", time.Now(), c.ID, "")
	}
	if fmt.Sprint(got) != "[a b a b]" {
		t.Fatalf("picks %v", got)
	}
}

func TestPickLeastLoadedFallsBackToStandbyThenFirst(t *testing.T) {
	hub := NewSessionHub()
	cands := []routeCandidate{{ID: "a"}, {ID: "s", Standby: true}}
	if c, _ := pickLeastLoaded(liveReg(t, "s"), hub, cands); c.ID != "s" {
		t.Fatalf("with the active down got %q, want the standby", c.ID)
	}
	// Nothing online: the first candidate, so the caller says it is offline.
	if c, _ := pickLeastLoaded(liveReg(t), hub, cands); c.ID != "a" {
		t.Fatalf("nothing online got %q", c.ID)
	}
	if _, ok := pickLeastLoaded(liveReg(t), hub, nil); ok {
		t.Fatal("picked from no candidates")
	}
}

func TestPickLeastLoadedSkipsClosedTunnel(t *testing.T) {
	reg := liveReg(t, "a", "b")
	reg.Get("a").mux.Close()
	hub := NewSessionHub()
	hub.RegisterNative("x", "ssh", "site", "u", "h", time.Now(), "b", "")
	if c, _ := pickLeastLoaded(reg, hub, []routeCandidate{{ID: "a"}, {ID: "b"}}); c.ID != "b" {
		t.Fatalf("got %q, want b (a's tunnel is closed)", c.ID)
	}
}

func TestPickStickyKeepsAUserOnOneMember(t *testing.T) {
	reg := liveReg(t, "a", "b", "c")
	cands := []routeCandidate{{ID: "a"}, {ID: "b"}, {ID: "c"}}
	seen := map[string]int{}
	moved := 0
	for i := 0; i < 300; i++ {
		key := fmt.Sprint("user", i)
		first, _ := pickSticky(reg, cands, key)
		again, _ := pickSticky(reg, cands, key)
		if first.ID != again.ID {
			t.Fatalf("user %d moved between calls", i)
		}
		seen[first.ID]++
		// Dropping b moves only b's users.
		without, _ := pickSticky(reg, []routeCandidate{{ID: "a"}, {ID: "c"}}, key)
		if first.ID != "b" && without.ID != first.ID {
			moved++
		}
	}
	if moved != 0 {
		t.Fatalf("%d users not on b moved when b left", moved)
	}
	for _, id := range []string{"a", "b", "c"} {
		if seen[id] < 60 {
			t.Fatalf("uneven spread %v", seen)
		}
	}
}

func TestCandidatesOrFallsBackToTheSingleConnector(t *testing.T) {
	if got := candidatesOr(nil, "c1"); len(got) != 1 || got[0].ID != "c1" {
		t.Fatalf("got %+v", got)
	}
	if got := candidatesOr(nil, ""); got != nil {
		t.Fatalf("got %+v", got)
	}
}
