package main

import (
	"strings"
	"testing"
)

// type feeds the keys to the gate and returns what is forwarded and what was refused.
func typeKeys(g *cmdGate, parts ...string) (string, []string) {
	var fwd strings.Builder
	var refused []string
	for _, p := range parts {
		out, why := g.filter([]byte(p))
		fwd.Write(out)
		refused = append(refused, why...)
	}
	return fwd.String(), refused
}

func TestGateLetsAnAllowedLineRunAndHoldsBackARefusedOne(t *testing.T) {
	g := newCmdGate(allow("ls", "systemctl status *"))
	fwd, refused := typeKeys(g, "ls -la\r")
	if fwd != "ls -la\r" || len(refused) != 0 {
		t.Fatalf("allowed line: forwarded %q refused %v", fwd, refused)
	}
	fwd, refused = typeKeys(g, "rm -rf /\r")
	if fwd != "rm -rf /\x03" || len(refused) != 1 {
		t.Fatalf("refused line: forwarded %q refused %v (the Enter must become Ctrl-C)", fwd, refused)
	}
	// The next line starts clean.
	if fwd, refused = typeKeys(g, "systemctl status nginx\r"); fwd != "systemctl status nginx\r" || len(refused) != 0 {
		t.Fatalf("after a refusal: %q %v", fwd, refused)
	}
}

func TestGateFollowsEditingKeys(t *testing.T) {
	g := newCmdGate(deny("rm"))
	// Backspace: typed "rmx", deleted x, so the line is rm.
	if _, refused := typeKeys(g, "rmx\x7f\r"); len(refused) != 1 {
		t.Fatalf("backspace was not followed: %v", refused)
	}
	// Ctrl-U clears, so what was typed before it is not the line.
	if fwd, refused := typeKeys(g, "rm\x15ls\r"); len(refused) != 0 || !strings.HasSuffix(fwd, "ls\r") {
		t.Fatalf("Ctrl-U: %q %v", fwd, refused)
	}
	// Ctrl-W removes the last word.
	if _, refused := typeKeys(g, "ls rm\x17\r"); len(refused) != 0 {
		t.Fatalf("Ctrl-W: %v", refused)
	}
	// Ctrl-C discards the line.
	if _, refused := typeKeys(g, "rm\x03ls\r"); len(refused) != 0 {
		t.Fatalf("Ctrl-C: %v", refused)
	}
}

func TestGateUncertainLinesAreRefusedByAnAllowListNotADenyList(t *testing.T) {
	up := "\x1b[A" // history recall
	a := newCmdGate(allow("ls"))
	if _, refused := typeKeys(a, "ls"+up+"\r"); len(refused) != 1 {
		t.Fatalf("an allow list let an unverifiable line run: %v", refused)
	}
	d := newCmdGate(deny("rm"))
	if _, refused := typeKeys(d, "ls"+up+"\r"); len(refused) != 0 {
		t.Fatalf("a deny list refused a history recall: %v", refused)
	}
	// Completing the command word is uncertain; completing an argument is not.
	a = newCmdGate(allow("ls *"))
	if _, refused := typeKeys(a, "l\t\r"); len(refused) != 1 {
		t.Fatalf("a completed command word: %v", refused)
	}
	a = newCmdGate(allow("ls *"))
	if _, refused := typeKeys(a, "ls /va\t\r"); len(refused) != 0 {
		t.Fatalf("a completed argument was refused: %v", refused)
	}
	// The next line is certain again.
	a = newCmdGate(allow("ls"))
	if _, refused := typeKeys(a, "ls"+up+"\r", "ls\r"); len(refused) != 1 {
		t.Fatalf("uncertainty leaked into the next line: %v", refused)
	}
}

func TestGatePassesKeysToFullScreenProgramsAndPastedText(t *testing.T) {
	g := newCmdGate(deny("rm"))
	g.shown([]byte("\x1b[?1049h")) // vim opens
	if fwd, refused := typeKeys(g, "rm everything\r"); fwd != "rm everything\r" || len(refused) != 0 {
		t.Fatalf("typing inside a full-screen program: %q %v", fwd, refused)
	}
	g.shown([]byte("\x1b[?1049l$ "))
	if _, refused := typeKeys(g, "rm x\r"); len(refused) != 1 {
		t.Fatal("the shell is back, the gate must be too")
	}
	// A bracketed paste holds the newline until the paste ends; the line is then checked once.
	g = newCmdGate(deny("rm"))
	if _, refused := typeKeys(g, "\x1b[200~rm -rf x\r\x1b[201~\r"); len(refused) != 1 {
		t.Fatalf("a pasted refused line: %v", refused)
	}
}

func TestGateHandlesSeveralLinesInOneRead(t *testing.T) {
	g := newCmdGate(deny("rm"))
	fwd, refused := typeKeys(g, "ls\rrm x\rpwd\r")
	if fwd != "ls\rrm x\x03pwd\r" || len(refused) != 1 {
		t.Fatalf("pasted lines: %q %v", fwd, refused)
	}
}

func TestGateCountsMultiByteCharactersOnce(t *testing.T) {
	g := newCmdGate(deny("rm"))
	if _, refused := typeKeys(g, "ö\x7frm\r"); len(refused) != 1 {
		t.Fatalf("a multi-byte backspace: %v", refused)
	}
}

func TestCheckArgvMatchesWordsAsTheyAre(t *testing.T) {
	d := deny("FLUSHALL", "CONFIG SET *")
	for _, c := range []struct {
		argv []string
		ok   bool
	}{
		{[]string{"GET", "k"}, true},
		{[]string{"flushall"}, false},
		{[]string{"CONFIG", "SET", "maxmemory", "1"}, false},
		{[]string{"CONFIG", "GET", "maxmemory"}, true},
		{[]string{"SET", "k", "a;rm|b"}, true}, // ; and | are data in a Redis value
	} {
		if ok, why := d.CheckArgv(c.argv); ok != c.ok {
			t.Errorf("deny %v: got %v (%s)", c.argv, ok, why)
		}
	}
	a := allow("GET", "SET", "KEYS *")
	for _, c := range []struct {
		argv []string
		ok   bool
	}{{[]string{"get", "k"}, true}, {[]string{"DEL", "k"}, false}, {[]string{"KEYS", "user:*"}, true}, {nil, true}} {
		if ok, why := a.CheckArgv(c.argv); ok != c.ok {
			t.Errorf("allow %v: got %v (%s)", c.argv, ok, why)
		}
	}
}
