package main

import (
	"bufio"
	"bytes"
	"strings"
	"testing"
)

func TestInjectDrivePath(t *testing.T) {
	p := map[string]string{"enable-drive": "true"}
	injectDrivePath(p, "sess123")
	if p["drive-path"] != "/drive/sess123" {
		t.Fatalf("drive-path not injected: %v", p)
	}
	q := map[string]string{}
	injectDrivePath(q, "sess123")
	if _, ok := q["drive-path"]; ok {
		t.Fatalf("drive-path set without enable-drive: %v", q)
	}
}

func TestBuildConnectEmitsParamForListedArg(t *testing.T) {
	names := []string{"VERSION_1_5_0", "hostname", "server-layout", "enable-wallpaper"}
	c := GuacConn{Hostname: "h", Params: map[string]string{"server-layout": "tr-tr-qwerty", "enable-wallpaper": "true"}}
	got := string(buildConnect(names, c))
	if !strings.Contains(got, "12.tr-tr-qwerty") || !strings.Contains(got, "4.true") {
		t.Fatalf("params not emitted: %s", got)
	}
}

func TestEncodeInstruction(t *testing.T) {
	if got := string(encodeInstruction("select", "rdp")); got != "6.select,3.rdp;" {
		t.Fatalf("got %q", got)
	}
}

func TestParseInstruction(t *testing.T) {
	r := bufio.NewReader(bytes.NewReader([]byte("4.args,8.hostname,4.port;")))
	op, args, err := parseInstruction(r)
	if err != nil || op != "args" || len(args) != 2 || args[0] != "hostname" || args[1] != "port" {
		t.Fatalf("op=%q args=%v err=%v", op, args, err)
	}
}

func TestParseInstructionUnicodeLength(t *testing.T) {
	// LENGTH is rune count, not byte count.
	r := bufio.NewReader(bytes.NewReader([]byte("4.args,1.é;")))
	op, args, err := parseInstruction(r)
	if err != nil || op != "args" || len(args) != 1 || args[0] != "é" {
		t.Fatalf("op=%q args=%v err=%v", op, args, err)
	}
}

func TestBuildConnectFillsCredsAndEchoesVersion(t *testing.T) {
	names := []string{"VERSION_1_5_0", "hostname", "port", "username", "password"}
	c := GuacConn{Hostname: "10.0.0.5", Port: "3389", Username: "adm", Secret: "pw", SecretKind: "PASSWORD"}
	got := string(buildConnect(names, c))
	if want := "7.connect,13.VERSION_1_5_0,8.10.0.0.5,4.3389,3.adm,2.pw;"; got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestBuildConnectPrivateKeyKind(t *testing.T) {
	names := []string{"username", "password", "private-key"}
	c := GuacConn{Username: "root", Secret: "KEYDATA", SecretKind: "KEY"}
	got := string(buildConnect(names, c))
	// password blank (kind KEY), private-key filled.
	if want := "7.connect,4.root,0.,7.KEYDATA;"; got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestTheUsersInputIsHeldButTheirConnectionLives(t *testing.T) {
	for _, op := range []string{"key", "mouse", "touch", "clipboard", "file", "blob", "end", "put"} {
		if vendorMayForward(op, false) {
			t.Errorf("%s passed while input is held", op)
		}
		if !vendorMayForward(op, true) {
			t.Errorf("%s held while input is allowed", op)
		}
	}
	for _, op := range []string{"sync", "nop", "size", "ack", "disconnect", ""} {
		if !vendorMayForward(op, false) {
			t.Errorf("%s held: guacd would drop the user", op)
		}
	}
}
