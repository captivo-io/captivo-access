package main

import (
	"strconv"
	"strings"
	"testing"
)

func keyMsg(keysym int, down bool) []byte {
	d := "0"
	if down {
		d = "1"
	}
	return encodeInstruction("key", strconv.Itoa(keysym), d)
}

// typeText sends each character as a key press and returns what reaches guacd and the notices.
func typeText(k *guacCmdGate, s string) (string, []string) {
	var fwd strings.Builder
	var notes []string
	for _, c := range s {
		sym := int(c)
		if c == '\r' {
			sym = ksReturn
		}
		for _, down := range []bool{true, false} {
			out, n := k.process(keyMsg(sym, down))
			fwd.Write(out)
			notes = append(notes, n...)
		}
	}
	return fwd.String(), notes
}

func TestBrowserSSHGateSwallowsARefusedEnterAndSendsCtrlC(t *testing.T) {
	k := newGuacCmdGate(deny("rm"))
	fwd, notes := typeText(k, "ls\r")
	if strings.Count(fwd, string(keyMsg(ksReturn, true))) != 1 || len(notes) != 0 {
		t.Fatalf("an allowed line: %q %v", fwd, notes)
	}
	fwd, notes = typeText(k, "rm -rf /\r")
	if strings.Contains(fwd, string(keyMsg(ksReturn, true))) || strings.Contains(fwd, string(keyMsg(ksReturn, false))) {
		t.Fatalf("the Enter of a refused line reached guacd: %q", fwd)
	}
	if !strings.Contains(fwd, string(keyMsg(ksControlL, true))+string(keyMsg('c', true))) || len(notes) != 1 || !strings.Contains(notes[0], "Command refused") {
		t.Fatalf("Ctrl-C or the notice is missing: %q %v", fwd, notes)
	}
	// The next line is clean again.
	if fwd, notes = typeText(k, "pwd\r"); !strings.Contains(fwd, string(keyMsg(ksReturn, true))) || len(notes) != 0 {
		t.Fatalf("after a refusal: %q %v", fwd, notes)
	}
}

func TestBrowserSSHGateFollowsBackspaceAndControlKeys(t *testing.T) {
	k := newGuacCmdGate(deny("rm"))
	// "rmx" then BackSpace is "rm".
	for _, m := range [][]byte{keyMsg('r', true), keyMsg('m', true), keyMsg('x', true), keyMsg(ksBackspace, true), keyMsg(ksBackspace, false)} {
		k.process(m)
	}
	if _, notes := k.process(keyMsg(ksReturn, true)); len(notes) != 1 {
		t.Fatalf("the backspace was not followed: %v", notes)
	}
	// Ctrl-U clears the line: "rm", Ctrl-U, "ls" is "ls".
	k = newGuacCmdGate(deny("rm"))
	for _, m := range [][]byte{keyMsg('r', true), keyMsg('m', true), keyMsg(ksControlL, true), keyMsg('u', true), keyMsg('u', false), keyMsg(ksControlL, false), keyMsg('l', true), keyMsg('s', true)} {
		k.process(m)
	}
	if _, notes := k.process(keyMsg(ksReturn, true)); len(notes) != 0 {
		t.Fatalf("Ctrl-U was not followed: %v", notes)
	}
}

func TestBrowserSSHGateDropsPastesWhileAListIsActive(t *testing.T) {
	k := newGuacCmdGate(deny("rm"))
	out, notes := k.process(encodeInstruction("clipboard", "5", "text/plain"))
	if len(out) != 0 || len(notes) != 1 {
		t.Fatalf("clipboard: %q %v", out, notes)
	}
	if out, _ = k.process(encodeInstruction("blob", "5", "cm0gLXJmIC8K")); len(out) != 0 {
		t.Fatalf("the pasted data got through: %q", out)
	}
	if out, _ = k.process(encodeInstruction("end", "5")); len(out) != 0 {
		t.Fatalf("the end of the pasted stream got through: %q", out)
	}
	// A different stream (a file upload) is not touched.
	if out, _ = k.process(encodeInstruction("blob", "9", "AAAA")); string(out) != string(encodeInstruction("blob", "9", "AAAA")) {
		t.Fatalf("another stream was dropped: %q", out)
	}
	// And after the paste's end the stream id is free again.
	if out, _ = k.process(encodeInstruction("blob", "5", "AAAA")); len(out) == 0 {
		t.Fatal("a later stream with the same id was dropped")
	}
}

func TestBrowserSSHGateLeavesFullScreenProgramsAlone(t *testing.T) {
	k := newGuacCmdGate(deny("rm"))
	k.setAlt(true)
	if fwd, notes := typeText(k, "rm\r"); len(notes) != 0 || !strings.Contains(fwd, string(keyMsg(ksReturn, true))) {
		t.Fatalf("typing in a full-screen program: %q %v", fwd, notes)
	}
	k.setAlt(false)
	if _, notes := typeText(k, "rm\r"); len(notes) != 1 {
		t.Fatalf("the shell is back: %v", notes)
	}
}

func TestBrowserSSHGatePassesOtherInstructionsUntouched(t *testing.T) {
	k := newGuacCmdGate(allow("ls"))
	for _, m := range [][]byte{encodeInstruction("mouse", "10", "20", "0", "0"), encodeInstruction("size", "800", "600"), encodeInstruction("sync", "123")} {
		if out, notes := k.process(m); string(out) != string(m) || len(notes) != 0 {
			t.Fatalf("%q was changed: %q %v", m, out, notes)
		}
	}
}
