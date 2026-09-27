package main

import (
	"bufio"
	"bytes"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"
)

// readRawInstruction reads one complete Guacamole instruction from br and returns
// its exact raw bytes (length prefixes, values, separators, terminating ';'). Used
// to relay guacd -> browser one whole instruction per WebSocket message, so a large
// instruction (e.g. an initial full-frame image) is never split across frames.
func readRawInstruction(br *bufio.Reader) ([]byte, error) {
	var raw []byte
	for {
		lenStr, err := br.ReadString('.')
		if err != nil {
			return nil, err
		}
		raw = append(raw, lenStr...)
		n, err := strconv.Atoi(strings.TrimSuffix(lenStr, "."))
		if err != nil || n < 0 {
			return nil, fmt.Errorf("bad length %q", lenStr)
		}
		for i := 0; i < n; i++ {
			ch, _, err := br.ReadRune()
			if err != nil {
				return nil, err
			}
			var b [4]byte
			raw = append(raw, b[:utf8.EncodeRune(b[:], ch)]...)
		}
		sep, _, err := br.ReadRune()
		if err != nil {
			return nil, err
		}
		raw = append(raw, byte(sep))
		if sep == ';' {
			return raw, nil
		}
		if sep != ',' {
			return nil, fmt.Errorf("bad separator %q", sep)
		}
	}
}

// encodeInstruction builds a Guacamole instruction: LENGTH.VALUE,…; where LENGTH
// is the rune count of VALUE (e.g. "6.select,3.rdp;").
func encodeInstruction(elems ...string) []byte {
	var b strings.Builder
	for i, e := range elems {
		if i > 0 {
			b.WriteByte(',')
		}
		fmt.Fprintf(&b, "%d.%s", len([]rune(e)), e)
	}
	b.WriteByte(';')
	return []byte(b.String())
}

// parseInstruction reads one instruction from r. The first element is the opcode,
// the rest are its arguments.
func parseInstruction(r *bufio.Reader) (string, []string, error) {
	var elems []string
	for {
		lenStr, err := r.ReadString('.')
		if err != nil {
			return "", nil, err
		}
		n, err := strconv.Atoi(strings.TrimSuffix(lenStr, "."))
		if err != nil || n < 0 {
			return "", nil, fmt.Errorf("bad length %q", lenStr)
		}
		val := make([]rune, n)
		for i := 0; i < n; i++ {
			ch, _, err := r.ReadRune()
			if err != nil {
				return "", nil, err
			}
			val[i] = ch
		}
		sep, _, err := r.ReadRune()
		if err != nil {
			return "", nil, err
		}
		elems = append(elems, string(val))
		if sep == ';' {
			break
		}
		if sep != ',' {
			return "", nil, fmt.Errorf("bad separator %q", sep)
		}
	}
	if len(elems) == 0 {
		return "", nil, fmt.Errorf("empty instruction")
	}
	return elems[0], elems[1:], nil
}

// GuacConn is the resolved connection descriptor injected into the guacd handshake.
type GuacConn struct {
	Protocol, Hostname, Port, Username, Secret, SecretKind string
	Width, Height, Dpi                                     int
	Params                                                 map[string]string // resolved guacd arg-name→value (server-layout, color-depth, enable-*, disable-copy/paste)
}

// injectDrivePath gives an RDP drive session-scoped isolation: a fresh
// /drive/<sessionID> that create-drive-path makes on connect. No-op unless the
// drive is enabled.
func injectDrivePath(params map[string]string, sessionID string) {
	if params != nil && params["enable-drive"] == "true" {
		params["drive-path"] = "/drive/" + sessionID
	}
}

// buildConnect echoes one value per arg name guacd listed, filling connection
// params from c. The leading VERSION arg is echoed back (spike-confirmed);
// names it doesn't recognise get an empty value (guacd default).
func buildConnect(argNames []string, c GuacConn) []byte {
	elems := []string{"connect"}
	for _, name := range argNames {
		switch {
		case strings.HasPrefix(name, "VERSION"):
			elems = append(elems, name)
		case name == "hostname":
			elems = append(elems, c.Hostname)
		case name == "port":
			elems = append(elems, c.Port)
		case name == "username":
			elems = append(elems, c.Username)
		case name == "password":
			if c.SecretKind == "PASSWORD" {
				elems = append(elems, c.Secret)
			} else {
				elems = append(elems, "")
			}
		case name == "private-key":
			if c.SecretKind == "KEY" {
				elems = append(elems, c.Secret)
			} else {
				elems = append(elems, "")
			}
		case name == "ignore-cert":
			elems = append(elems, "true") // RDP: accept the target's self-signed cert
		case name == "security":
			// Per-resource override (via guacParams) wins; default to negotiate.
			if v, ok := c.Params["security"]; ok && v != "" {
				elems = append(elems, v)
			} else {
				elems = append(elems, "any") // default: let guacd negotiate (NLA/TLS/RDP)
			}
		case name == "resize-method":
			elems = append(elems, "display-update") // smoother RDP resize when supported
		default:
			if v, ok := c.Params[name]; ok {
				elems = append(elems, v)
			} else {
				elems = append(elems, "")
			}
		}
	}
	return encodeInstruction(elems...)
}

// instructionOpcode returns the opcode of one raw Guacamole instruction, or "" when
// it cannot be read. The length prefix counts RUNES, not bytes.
func instructionOpcode(raw []byte) string {
	dot := bytes.IndexByte(raw, '.')
	if dot <= 0 {
		return ""
	}
	n, err := strconv.Atoi(string(raw[:dot]))
	if err != nil || n <= 0 {
		return ""
	}
	s := string(raw[dot+1:])
	runes := 0
	for idx := range s {
		if runes == n {
			// A well-formed element is followed by a separator. Without this check a
			// malformed instruction yields a bogus opcode -- and a bogus opcode that
			// happened to read as "sync" would pass the viewer gate.
			if s[idx] == ',' || s[idx] == ';' {
				return s[:idx]
			}
			return ""
		}
		runes++
	}
	return ""
}

// viewerUpstreamAlways are the instructions a WATCHING viewer must still be able to
// send even though it holds no control.
//
// guacd polls every connected user and disconnects one that sends nothing for
// GUACD_USEC_TIMEOUT (15 s by default). An idle read-only viewer's only traffic is
// its echo of guacd's own `sync`, so gating the whole upstream direction made a
// monitoring admin's view die seconds after it opened, reported to them as "The
// session ended or is no longer available." while the session was in fact live.
//
// Only protocol liveness is exempt. Everything else a browser sends -- key, mouse,
// size, clipboard, file transfer -- is either input or would mutate the session the
// vendor is sharing, and stays gated on actually holding control.
var viewerUpstreamAlways = map[string]bool{"sync": true, "nop": true}

// viewerMayForward decides whether one instruction from a viewer reaches guacd.
func viewerMayForward(op string, hasControl bool) bool {
	return viewerUpstreamAlways[op] || hasControl
}
