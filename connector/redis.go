package main

import (
	"bufio"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// A Redis server for a database resource: the connector signs in with the
// saved account and hands the data plane a connection that is past AUTH (and
// SELECT, when the resource names a database); RESP2 follows, relayed raw.
// "disable" is a plain connection; "require" and "verify-full" speak TLS from
// the first byte, as Redis does (tls-port).

const redisMaxReply = 1 << 20

// redisError is an error reply to the sign-in.
type redisError struct{ msg string }

func (e *redisError) Error() string { return e.msg }

// redisCommand encodes a command as a RESP array of bulk strings.
func redisCommand(args ...string) []byte {
	b := []byte("*" + strconv.Itoa(len(args)) + "\r\n")
	for _, a := range args {
		b = append(b, "$"+strconv.Itoa(len(a))+"\r\n"...)
		b = append(b, a...)
		b = append(b, "\r\n"...)
	}
	return b
}

// redisReadReply reads one reply of the shapes the sign-in gets: a line
// ("+OK", "-ERR ...", ":1") or a bulk string. The text is the line without
// its type byte, or the bulk's content.
func redisReadReply(r *bufio.Reader) (kind byte, text string, err error) {
	line, err := r.ReadString('\n')
	if err != nil {
		return 0, "", errors.New("the database server closed the connection")
	}
	line = strings.TrimRight(line, "\r\n")
	if line == "" {
		return 0, "", errors.New("the database server did not answer in RESP: is this a Redis port?")
	}
	if line[0] != '$' {
		return line[0], line[1:], nil
	}
	n, err := strconv.Atoi(line[1:])
	if err != nil || n > redisMaxReply {
		return 0, "", errors.New("the database server did not answer in RESP: is this a Redis port?")
	}
	if n < 0 {
		return '$', "", nil
	}
	b := make([]byte, n+2)
	if _, err := io.ReadFull(r, b); err != nil {
		return 0, "", errors.New("the database server closed the connection")
	}
	return '$', string(b[:n]), nil
}

// redisServerVersion finds redis_version in INFO server's text.
func redisServerVersion(info string) string {
	for _, l := range strings.Split(info, "\n") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(l), "redis_version:"); ok {
			return v
		}
	}
	return ""
}

func redisSignIn(req tunnel.DbDialRequest, password string) (net.Conn, *bufio.Reader, tunnel.DbDialResponse, error) {
	var resp tunnel.DbDialResponse
	raw, err := net.DialTimeout("tcp", net.JoinHostPort(req.Host, req.Port), 10*time.Second)
	if err != nil {
		return nil, nil, resp, errors.New("the database server can't be reached from the connector")
	}
	fail := func(err error) (net.Conn, *bufio.Reader, tunnel.DbDialResponse, error) {
		raw.Close()
		return nil, nil, resp, err
	}
	_ = raw.SetDeadline(time.Now().Add(dbSignInLimit))
	var conn net.Conn = raw
	if req.TLS != "disable" && req.TLS != "" {
		cfg, err := mssqlTLSConfig(req)
		if err != nil {
			return fail(err)
		}
		tc := tls.Client(raw, cfg)
		if err := tc.Handshake(); err != nil {
			return fail(fmt.Errorf("TLS to the database server failed: %v (set the resource's TLS to Off if the server has no TLS port)", err))
		}
		conn, resp.TLS = tc, true
	}
	br := bufio.NewReaderSize(conn, 64<<10)

	// The default account signs in with the password alone, which every Redis
	// version takes; another account needs Redis 6's ACL form.
	auth := []string{"AUTH", password}
	if u := req.Username; u != "" && u != "default" {
		auth = []string{"AUTH", u, password}
	}
	if _, err := conn.Write(redisCommand(auth...)); err != nil {
		return fail(errors.New("the database server closed the connection"))
	}
	kind, text, err := redisReadReply(br)
	if err != nil {
		return fail(err)
	}
	switch {
	case kind == '-' && strings.Contains(text, "without any password configured"):
		// A server with no password: nothing to sign in to.
	case kind == '-':
		return fail(&redisError{msg: redisSignInText(text)})
	case kind != '+':
		return fail(errors.New("the database server did not answer in RESP: is this a Redis port?"))
	}
	if req.Database != "" {
		if _, err := strconv.Atoi(req.Database); err != nil {
			return fail(errors.New("the resource's database must be a number (0-15 by default)"))
		}
		if _, err := conn.Write(redisCommand("SELECT", req.Database)); err != nil {
			return fail(errors.New("the database server closed the connection"))
		}
		if kind, text, err = redisReadReply(br); err != nil {
			return fail(err)
		}
		if kind != '+' {
			return fail(&redisError{msg: "SELECT " + req.Database + ": " + redisSignInText(text)})
		}
	}
	// The version is for the console's session note; an account without INFO still works.
	if _, err := conn.Write(redisCommand("INFO", "server")); err == nil {
		if kind, text, err = redisReadReply(br); err == nil && kind == '$' {
			resp.ServerVersion = redisServerVersion(text)
		}
	}
	_ = conn.SetDeadline(time.Time{})
	return conn, br, resp, nil
}

// redisSignInText is an error reply without the saved password's room to
// leak: Redis never echoes it, but a proxy in between might.
func redisSignInText(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "WRONGPASS") {
		return "the saved password was not accepted by the database (WRONGPASS)"
	}
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}
