package main

import (
	"bufio"
	"errors"
	"net"
	"strings"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// Changing a Redis or MongoDB account's password (rotate_db.go signs in and
// calls these). Redis: ACL SETUSER <user> resetpass ><new>, which leaves the
// new password as the only one; the default user of a server without ACLs
// (before Redis 6) is changed with CONFIG SET requirepass. MongoDB: the
// updateUser command in the account's own database.
//
// An ACL change lives in memory: a server that keeps its users in an ACL file
// is told to ACL SAVE (done when it can), and one whose users are written in
// redis.conf starts again with those. The resource's rotation panel says so.

type redisSession struct {
	conn net.Conn
	br   *bufio.Reader
}

func (s *redisSession) Close() error { return s.conn.Close() }

// exec and column exist for the shared interface; a Redis session is driven by cmd.
func (s *redisSession) exec(string) error               { return errors.New("not used") }
func (s *redisSession) column(string) ([]string, error) { return nil, errors.New("not used") }

// cmd sends one command and returns the server's error reply as an error.
func (s *redisSession) cmd(args ...string) error {
	_ = s.conn.SetDeadline(time.Now().Add(dbSignInLimit))
	defer func() { _ = s.conn.SetDeadline(time.Time{}) }()
	if _, err := s.conn.Write(redisCommand(args...)); err != nil {
		return errors.New("the database server closed the connection")
	}
	kind, text, err := redisReadReply(s.br)
	if err != nil {
		return err
	}
	if kind == '-' {
		return &redisError{msg: text}
	}
	return nil
}

// setPassword makes pw the account's only password.
func (s *redisSession) setPassword(user, pw string) error {
	if user == "" {
		user = "default"
	}
	err := s.cmd("ACL", "SETUSER", user, "resetpass", ">"+pw)
	if err != nil {
		var re *redisError
		// Before Redis 6 there is no ACL: the default user's password is requirepass.
		if user == "default" && errors.As(err, &re) && strings.Contains(strings.ToLower(re.msg), "unknown command") {
			return s.cmd("CONFIG", "SET", "requirepass", pw)
		}
		return err
	}
	// A server with an ACL file keeps users there; saving is not offered everywhere, so a refusal is not an error.
	_ = s.cmd("ACL", "SAVE")
	return nil
}

type mongoSession struct{ m *mongoConn }

func (s *mongoSession) Close() error                    { return s.m.conn.Close() }
func (s *mongoSession) exec(string) error               { return errors.New("not used") }
func (s *mongoSession) column(string) ([]string, error) { return nil, errors.New("not used") }

// setPassword changes the account's password in the database it was made in.
func (s *mongoSession) setPassword(authDB, user, pw string) error {
	if authDB == "" {
		authDB = "admin"
	}
	_ = s.m.conn.SetDeadline(time.Now().Add(dbSignInLimit))
	defer func() { _ = s.m.conn.SetDeadline(time.Time{}) }()
	_, err := s.m.command(tunnel.BSONDoc(
		tunnel.BSONStr("updateUser", user),
		tunnel.BSONStr("pwd", pw),
		tunnel.BSONStr("$db", authDB),
	))
	return err
}
