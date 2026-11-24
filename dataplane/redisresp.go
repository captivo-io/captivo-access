package main

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"unicode/utf8"
)

// RESP (the Redis protocol) pieces for the Redis proxy (redisproxy.go): a
// client's command read far enough to name it, a server's reply copied to the
// client frame by frame so the proxy knows where each answer ends, and the
// text a command is logged as (its name and first argument, never a value).

const (
	respLineMax  = 1 << 20 // a header or simple-string line
	respArgKeep  = 1 << 20 // a leading argument read whole to name the command
	respArgsMax  = 1 << 20 // the most arguments a command may have (Redis's own limit)
	respHeadArgs = 2       // arguments read before a command is let through: its name and what follows
	respDepthMax = 32      // nesting of an aggregate reply
	redisLogArg  = 100     // characters of the first argument in the log
)

var errResp = errors.New("not valid RESP")

// readRespLine reads one line ending in CRLF, CRLF included.
func readRespLine(r *bufio.Reader) ([]byte, error) {
	var out []byte
	for {
		chunk, err := r.ReadSlice('\n')
		out = append(out, chunk...)
		if err == nil {
			break
		}
		if err != bufio.ErrBufferFull {
			return nil, err
		}
		if len(out) > respLineMax {
			return nil, errResp
		}
	}
	if len(out) < 2 || out[len(out)-2] != '\r' {
		return nil, errResp
	}
	return out, nil
}

// respInt is the number after a RESP type byte.
func respInt(line []byte) (int64, error) {
	if len(line) < 3 {
		return 0, errResp
	}
	return strconv.ParseInt(string(line[1:len(line)-2]), 10, 64)
}

// redisCmd is the start of one client command: every byte read so far, and
// the leading arguments. The arguments after those are streamed.
type redisCmd struct {
	head []byte   // exactly as received
	args [][]byte // the leading arguments
	left int      // arguments still unread
}

func (c *redisCmd) name() string {
	if len(c.args) == 0 {
		return ""
	}
	return strings.ToUpper(string(c.args[0]))
}

// sub is the lowercase word after the name, for commands that take a sub-command.
func (c *redisCmd) sub() string {
	if len(c.args) < 2 {
		return ""
	}
	return strings.ToLower(string(c.args[1]))
}

// readRedisCmd reads a command's header and its first keep arguments. An inline
// command (a line of words, as a person types into telnet) is read whole.
func readRedisCmd(r *bufio.Reader, keep int) (*redisCmd, error) {
	line, err := readRespLine(r)
	if err != nil {
		return nil, err
	}
	c := &redisCmd{head: line}
	if line[0] != '*' {
		for _, f := range bytes.Fields(line) {
			c.args = append(c.args, f)
		}
		return c, nil
	}
	n, err := respInt(line)
	if err != nil || n > respArgsMax {
		return nil, errResp
	}
	if n <= 0 {
		return c, nil // an empty command: the server ignores it
	}
	c.left = int(n)
	for len(c.args) < keep && c.left > 0 {
		h, err := readRespLine(r)
		if err != nil {
			return nil, err
		}
		if h[0] != '$' {
			return nil, errResp
		}
		l, err := respInt(h)
		if err != nil || l < 0 || l > respArgKeep {
			return nil, errResp
		}
		b := make([]byte, l+2)
		if _, err := io.ReadFull(r, b); err != nil {
			return nil, err
		}
		if b[l] != '\r' || b[l+1] != '\n' {
			return nil, errResp
		}
		c.head = append(append(c.head, h...), b...)
		c.args = append(c.args, b[:l])
		c.left--
	}
	return c, nil
}

// rest copies the arguments after the leading ones to w, or drops them (w nil).
func (c *redisCmd) rest(r *bufio.Reader, w io.Writer) error {
	for ; c.left > 0; c.left-- {
		h, err := readRespLine(r)
		if err != nil {
			return err
		}
		if h[0] != '$' {
			return errResp
		}
		l, err := respInt(h)
		if err != nil || l < 0 {
			return errResp
		}
		dst := io.Discard
		if w != nil {
			dst = w
			if _, err := w.Write(h); err != nil {
				return err
			}
		}
		if _, err := io.CopyN(dst, r, l+2); err != nil {
			return err
		}
	}
	return nil
}

// replyInfo is what the proxy keeps from a server reply.
type replyInfo struct {
	err string // the text of a top-level error reply
}

// copyRedisReply copies one reply, nested replies included, from the server to
// the client, and reports an error reply's text.
func copyRedisReply(r *bufio.Reader, out *myClientOut, info *replyInfo, depth int) error {
	if depth > respDepthMax {
		return errResp
	}
	line, err := readRespLine(r)
	if err != nil {
		return err
	}
	if err := out.write(line, false); err != nil {
		return err
	}
	switch line[0] {
	case '+', ':', '_', '#', ',', '(':
	case '-':
		if depth == 0 && info != nil {
			info.err = strings.TrimRight(string(line[1:]), "\r\n")
		}
	case '$', '=', '!':
		n, err := respInt(line)
		if err != nil {
			return errResp
		}
		if n >= 0 {
			if err := out.copyN(r, n+2); err != nil {
				return err
			}
		}
	case '*', '~', '>', '%', '|':
		n, err := respInt(line)
		if err != nil {
			return errResp
		}
		if line[0] == '%' || line[0] == '|' {
			n *= 2
		}
		for i := int64(0); i < n; i++ {
			if err := copyRedisReply(r, out, nil, depth+1); err != nil {
				return err
			}
		}
		if line[0] == '|' { // an attribute is followed by the reply it describes
			return copyRedisReply(r, out, info, depth)
		}
	default:
		return fmt.Errorf("%w: type byte %q", errResp, line[0])
	}
	return nil
}

// redisBlocked says why a command is refused, or "" when it goes through.
// Refused: anything that signs in as someone else or changes the protocol the
// proxy follows, replication and server administration (which can also read
// the saved password: CONFIG GET requirepass), and file or network exits.
func redisBlocked(c *redisCmd) string {
	switch c.name() {
	case "AUTH":
		return "changing the user on a connection is not allowed; connect again instead"
	case "RESET":
		return "RESET would sign the connection out; connect again instead"
	case "MONITOR":
		return "MONITOR is not available through Captivo Access"
	case "SYNC", "PSYNC", "REPLICAOF", "SLAVEOF", "FAILOVER":
		return "replication commands are not available through Captivo Access"
	case "CONFIG", "DEBUG", "SHUTDOWN", "MODULE", "MIGRATE":
		return c.name() + " is not available through Captivo Access"
	case "ACL":
		if s := c.sub(); s != "whoami" && s != "cat" {
			return "ACL " + strings.ToUpper(s) + " is not available through Captivo Access"
		}
	case "CLIENT":
		if c.sub() == "reply" {
			return "CLIENT REPLY is not available through Captivo Access"
		}
	}
	return ""
}

// redisUnpaired is true for commands after which the server's replies no
// longer match the commands one for one (a subscription pushes messages).
func redisUnpaired(c *redisCmd) bool {
	switch c.name() {
	case "SUBSCRIBE", "PSUBSCRIBE", "SSUBSCRIBE":
		return true
	}
	return false
}

// redisLogText is what the query log says about a command: its name and first
// argument. Values, scripts and everything after the first argument stay out.
func redisLogText(c *redisCmd) string {
	name := c.name()
	if name == "" {
		return ""
	}
	switch name {
	case "EVAL", "EVALSHA", "EVAL_RO", "EVALSHA_RO", "FCALL", "FCALL_RO", "FUNCTION", "SCRIPT":
		return name
	}
	if len(c.args) < 2 {
		return name
	}
	a := string(c.args[1])
	if !utf8.ValidString(a) || strings.ContainsAny(a, "\r\n\x00") {
		a = strconv.Quote(a)
	}
	if len(a) > redisLogArg {
		a = a[:redisLogArg] + "…"
	}
	return name + " " + a
}

// redisErrCode is the first word of an error reply ("WRONGTYPE", "NOPERM").
func redisErrCode(e string) string {
	code, _, _ := strings.Cut(e, " ")
	return code
}
