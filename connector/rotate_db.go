package main

import (
	"bufio"
	"context"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"strings"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// Rotating a database account's password (rotate.go): PostgreSQL and MySQL /
// MariaDB, signed in the way the database proxy's sessions are (dbproxy.go,
// mysql.go), with the resource's TLS setting.
//
// PostgreSQL gets a SCRAM-SHA-256 verifier made here, never the password in
// clear, so a server that logs its statements logs no password. MySQL takes
// the password in ALTER USER (it masks it in its own logs), inside the
// connection's TLS when the resource has TLS on.
//
// The reconcile account is a database account that may change others'
// passwords: CREATEROLE (or superuser) in PostgreSQL, CREATE USER in MySQL,
// ALTER ANY LOGIN in SQL Server.

const scramIterations = 4096

// scramVerifier is what PostgreSQL stores for a SCRAM-SHA-256 password
// ("SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>").
func scramVerifier(password string, salt []byte) (string, error) {
	salted, err := pbkdf2.Key(sha256.New, password, salt, scramIterations, 32)
	if err != nil {
		return "", err
	}
	clientKey := hmacSHA256(salted, "Client Key")
	stored := sha256.Sum256(clientKey)
	serverKey := hmacSHA256(salted, "Server Key")
	enc := base64.StdEncoding.EncodeToString
	return fmt.Sprintf("SCRAM-SHA-256$%d:%s$%s:%s", scramIterations, enc(salt), enc(stored[:]), enc(serverKey)), nil
}

func pgIdent(s string) string { return `"` + strings.ReplaceAll(s, `"`, `""`) + `"` }

// myString quotes a MySQL string literal (backslashes escaped, as the default
// sql_mode reads them; quotes doubled, as every mode does).
func myString(s string) string {
	return "'" + strings.ReplaceAll(strings.ReplaceAll(s, `\`, `\\`), "'", "''") + "'"
}

type dbAccountTarget struct {
	engine    string // "postgres" | "mysql" | "mssql"
	host      string
	port      string
	username  string
	db        tunnel.RotateDB
	reconcile *reconcileSecret
}

// req is the sign-in. MySQL needs no database for a password change (and the
// account's rights on one shouldn't decide whether it can rotate); PostgreSQL
// needs one to connect to: the resource's default.
func (t *dbAccountTarget) req(user string) tunnel.DbDialRequest {
	database := t.db.Database
	if t.engine == "mysql" {
		database = ""
	}
	// A MongoDB administrator signs in where it was made, not in the account's database.
	if t.engine == "mongodb" && user != t.username {
		database = "admin"
	}
	return tunnel.DbDialRequest{Engine: t.engine, Host: t.host, Port: t.port, Username: user, Database: database, TLS: t.db.TLS, CACertPEM: t.db.CACertPEM}
}

func (t *dbAccountTarget) canReset() bool { return t.reconcile != nil }

func (t *dbAccountTarget) check(ctx context.Context, pw string) authResult {
	c, err := t.signIn(t.username, pw)
	if err == nil {
		c.Close()
		return authResult{kind: authOK}
	}
	return t.classify(err)
}

func (t *dbAccountTarget) classify(err error) authResult {
	var pe *pgError
	var me *myError
	var te *tunnel.TDSServerError
	var re *redisError
	var mo *mongoError
	switch {
	case errors.As(err, &pe) && pe.Code == "28P01":
		return authResult{kind: authBad, detail: pe.Message}
	case errors.As(err, &me) && me.Number == 1045:
		return authResult{kind: authBad, detail: me.Message}
	case errors.As(err, &me) && (me.Number == 1862 || me.Number == 1820):
		return authResult{kind: authExpired, detail: "the account's password has expired"}
	case errors.As(err, &re) && strings.Contains(re.msg, "WRONGPASS"):
		return authResult{kind: authBad, detail: re.msg}
	case errors.As(err, &mo) && mo.code == "18":
		return authResult{kind: authBad, detail: mo.msg}
	case errors.As(err, &te) && te.Number == 18456:
		return authResult{kind: authBad, detail: te.Msg}
	case errors.As(err, &te) && (te.Number == 18487 || te.Number == 18488):
		return authResult{kind: authExpired, detail: "the account's password has expired"}
	}
	return authResult{kind: authOther, detail: err.Error()}
}

func (t *dbAccountTarget) selfChange(ctx context.Context, cur, next string) error {
	c, err := t.signIn(t.username, cur)
	if err != nil {
		return err
	}
	defer c.Close()
	if err, ok := t.setNoSQL(c, t.username, next); ok {
		return err
	}
	if t.engine == "postgres" {
		v, err := newVerifier(next)
		if err != nil {
			return err
		}
		return c.exec("ALTER ROLE CURRENT_USER PASSWORD '" + v + "'")
	}
	if t.engine == "mssql" {
		// A login changes its own password when it gives the current one.
		return c.exec("ALTER LOGIN " + msIdent(t.username) + " WITH PASSWORD = " + msString(next) + " OLD_PASSWORD = " + msString(cur))
	}
	err = c.exec("ALTER USER CURRENT_USER() IDENTIFIED BY " + myString(next))
	var me *myError
	if errors.As(err, &me) && (me.Number == 3892 || me.Number == 3893) {
		// password_require_current: the server wants the current one too.
		err = c.exec("ALTER USER CURRENT_USER() IDENTIFIED BY " + myString(next) + " REPLACE " + myString(cur))
	}
	if errors.As(err, &me) && me.Number == 1227 {
		// MariaDB lets ALTER USER only with CREATE USER; an account changes
		// its own password with SET PASSWORD.
		err = c.exec("SET PASSWORD = PASSWORD(" + myString(next) + ")")
	}
	return err
}

func (t *dbAccountTarget) reset(ctx context.Context, next string) error {
	if t.reconcile == nil {
		return errNoReconcile
	}
	c, err := t.signIn(t.reconcile.username, t.reconcile.secret)
	if err != nil {
		return fmt.Errorf("the reconcile account can't sign in: %v", err)
	}
	defer c.Close()
	if err, ok := t.setNoSQL(c, t.username, next); ok {
		return err
	}
	if t.engine == "postgres" {
		v, err := newVerifier(next)
		if err != nil {
			return err
		}
		return c.exec("ALTER ROLE " + pgIdent(t.username) + " PASSWORD '" + v + "'")
	}
	if t.engine == "mssql" { // ALTER ANY LOGIN
		return c.exec("ALTER LOGIN " + msIdent(t.username) + " WITH PASSWORD = " + msString(next))
	}
	// A MySQL account is user@host: find which, and don't guess between several.
	hosts, err := c.column("SELECT Host FROM mysql.user WHERE User = " + myString(t.username))
	if err != nil {
		return fmt.Errorf("the reconcile account can't read mysql.user: %v", err)
	}
	switch len(hosts) {
	case 0:
		return fmt.Errorf("there is no account named %s", t.username)
	case 1:
	default:
		return fmt.Errorf("there are %d accounts named %s (hosts %s); a reconcile account can't tell which", len(hosts), t.username, strings.Join(hosts, ", "))
	}
	return c.exec("ALTER USER " + myString(t.username) + "@" + myString(hosts[0]) + " IDENTIFIED BY " + myString(next))
}

func newVerifier(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	return scramVerifier(password, salt)
}

// setNoSQL changes a Redis or MongoDB account's password on a signed-in
// session; ok is false for the engines that run SQL.
func (t *dbAccountTarget) setNoSQL(c dbSession, user, next string) (err error, ok bool) {
	switch s := c.(type) {
	case *redisSession:
		return s.setPassword(user, next), true
	case *mongoSession:
		return s.setPassword(t.db.Database, user, next), true
	}
	return nil, false
}

// dbSession is a signed-in connection that runs a statement or two.
type dbSession interface {
	exec(sql string) error
	column(sql string) ([]string, error)
	Close() error
}

func (t *dbAccountTarget) signIn(user, pw string) (dbSession, error) {
	if t.engine == "postgres" {
		conn, br, _, err := pgSignIn(t.req(user), pw)
		if err != nil {
			return nil, err
		}
		s := &pgSession{conn: conn, br: br}
		if err := s.ready(); err != nil {
			conn.Close()
			return nil, err
		}
		return s, nil
	}
	if t.engine == "redis" {
		conn, br, _, err := redisSignIn(t.req(user), pw)
		if err != nil {
			return nil, err
		}
		return &redisSession{conn: conn, br: br}, nil
	}
	if t.engine == "mongodb" {
		conn, br, _, err := mongoSignIn(t.req(user), pw)
		if err != nil {
			return nil, err
		}
		return &mongoSession{m: &mongoConn{conn: conn, r: br}}, nil
	}
	if t.engine == "mssql" {
		conn, br, _, err := mssqlSignIn(t.req(user), pw)
		if err != nil {
			return nil, err
		}
		return &mssqlSession{out: conn, in: br, packetSize: tunnel.TDSDefaultPkt}, nil
	}
	conn, br, _, err := mySignIn(t.req(user), pw)
	if err != nil {
		return nil, err
	}
	return &mySession{c: &myConn{conn: conn, br: br}}, nil
}

type pgSession struct {
	conn net.Conn
	br   *bufio.Reader
}

func (s *pgSession) Close() error { return s.conn.Close() }

// ready reads up to ReadyForQuery, returning the first error the server sent.
func (s *pgSession) ready() error {
	var first error
	for {
		t, body, err := pgRead(s.br)
		if err != nil {
			return errors.New("the database server closed the connection")
		}
		switch t {
		case 'E':
			if first == nil {
				first = parsePgError(body)
			}
		case 'Z':
			return first
		}
	}
}

func (s *pgSession) exec(sql string) error {
	if err := pgSend(s.conn, 'Q', append([]byte(sql), 0)); err != nil {
		return err
	}
	return s.ready()
}

// column runs a query and returns its first column.
func (s *pgSession) column(sql string) ([]string, error) {
	if err := pgSend(s.conn, 'Q', append([]byte(sql), 0)); err != nil {
		return nil, err
	}
	var out []string
	var first error
	for {
		t, body, err := pgRead(s.br)
		if err != nil {
			return nil, errors.New("the database server closed the connection")
		}
		switch t {
		case 'E':
			if first == nil {
				first = parsePgError(body)
			}
		case 'D':
			if len(body) >= 6 {
				n := int(int32(binary.BigEndian.Uint32(body[2:6])))
				if n >= 0 && 6+n <= len(body) {
					out = append(out, string(body[6:6+n]))
				}
			}
		case 'Z':
			return out, first
		}
	}
}

type mySession struct{ c *myConn }

func (s *mySession) Close() error { return s.c.conn.Close() }

func (s *mySession) query(sql string) error {
	s.c.seq = 0
	return s.c.write(append([]byte{0x03}, sql...))
}

func (s *mySession) exec(sql string) error {
	if err := s.query(sql); err != nil {
		return err
	}
	p, err := s.c.read()
	if err != nil {
		return errors.New("the database server closed the connection")
	}
	if len(p) > 0 && p[0] == 0xff {
		return parseMyError(p)
	}
	if len(p) > 0 && p[0] == 0x00 {
		return nil
	}
	return errors.New("unexpected answer from the database server")
}

// column runs a query and returns its first column (text protocol).
func (s *mySession) column(sql string) ([]string, error) {
	if err := s.query(sql); err != nil {
		return nil, err
	}
	p, err := s.c.read()
	if err != nil {
		return nil, errors.New("the database server closed the connection")
	}
	if len(p) > 0 && p[0] == 0xff {
		return nil, parseMyError(p)
	}
	cols := int(p[0])
	for range cols { // column definitions
		if _, err := s.c.read(); err != nil {
			return nil, err
		}
	}
	if _, err := s.c.read(); err != nil { // EOF after them
		return nil, err
	}
	var out []string
	for {
		row, err := s.c.read()
		if err != nil {
			return nil, err
		}
		if len(row) > 0 && row[0] == 0xff {
			return nil, parseMyError(row)
		}
		if len(row) < 9 && len(row) > 0 && row[0] == 0xfe {
			return out, nil
		}
		if len(row) > 0 && row[0] == 0xfb { // NULL
			out = append(out, "")
			continue
		}
		n := int(row[0])
		if 1+n > len(row) {
			return nil, errors.New("unexpected answer from the database server")
		}
		out = append(out, string(row[1:1+n]))
	}
}
