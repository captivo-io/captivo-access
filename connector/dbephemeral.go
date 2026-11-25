package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// A database user per connection (zero standing privilege). A PostgreSQL or
// MySQL / MariaDB resource can name a "session role": the saved account then
// only provisions. For each connection the user's client opens, this connector
//
//  1. signs in as the saved account and creates a user with a random password
//     that inherits the session role (PostgreSQL: VALID UNTIL a few minutes on,
//     so it can only be used right now),
//  2. signs in as that user and relays the session,
//  3. drops the user when the connection ends.
//
// A user a crash left behind is dropped by the next connection that provisions
// (it is named captivo_tmp_<unix time>_<random>, so its age is in its name).
// Nobody ever holds a password that outlives the connection, and the account
// the client works as has only what the session role has.

const (
	ephPrefix     = "captivo_tmp_"
	ephLoginGrace = 10 * time.Minute // PostgreSQL: the user can sign in only this long after it is made
	ephStaleAfter = 6 * time.Hour    // a user older than this is a leftover
	ephSweepMax   = 10
)

var ephRoleOK = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.$-]{0,62}$`)

// ephName is a new user's name; the time is when it was made.
func ephName(now time.Time) (string, error) {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return ephPrefix + strconv.FormatInt(now.Unix(), 10) + "_" + hex.EncodeToString(b[:]), nil
}

// ephAge reads the age of a user this connector made; false for any other name.
func ephAge(name string, now time.Time) (time.Duration, bool) {
	rest, ok := strings.CutPrefix(name, ephPrefix)
	if !ok {
		return 0, false
	}
	ts, _, ok := strings.Cut(rest, "_")
	if !ok {
		return 0, false
	}
	n, err := strconv.ParseInt(ts, 10, 64)
	if err != nil || n <= 0 {
		return 0, false
	}
	return now.Sub(time.Unix(n, 0)), true
}

type ephUser struct {
	t    *dbAccountTarget
	pw   string // the provisioner's password
	role string
	user string
	pass string
}

// createEphemeralUser makes the user and returns it; drop() removes it.
func createEphemeralUser(t *dbAccountTarget, provisionerPW, role string) (*ephUser, error) {
	if t.engine != "postgres" && t.engine != "mysql" {
		return nil, errors.New("a session user is made for PostgreSQL and MySQL only")
	}
	if !ephRoleOK.MatchString(role) {
		return nil, errors.New("the session role's name is not valid")
	}
	now := time.Now()
	name, err := ephName(now)
	if err != nil {
		return nil, err
	}
	pass, err := generatePassword(rotatedPassLen)
	if err != nil {
		return nil, err
	}
	s, err := t.signIn(t.username, provisionerPW)
	if err != nil {
		return nil, fmt.Errorf("the saved account can't sign in: %v", err)
	}
	defer s.Close()
	if t.engine == "postgres" {
		v, err := newVerifier(pass)
		if err != nil {
			return nil, err
		}
		until := now.Add(ephLoginGrace).UTC().Format("2006-01-02 15:04:05+00")
		err = s.exec("CREATE ROLE " + pgIdent(name) + " LOGIN PASSWORD '" + v + "' VALID UNTIL '" + until + "' IN ROLE " + pgIdent(role))
		if err != nil {
			return nil, fmt.Errorf("the saved account could not create a user in role %s (it needs CREATEROLE and ADMIN OPTION on the role): %v", role, err)
		}
	} else if err := createMySQLUser(s, name, pass, role); err != nil {
		return nil, err
	}
	u := &ephUser{t: t, pw: provisionerPW, role: role, user: name, pass: pass}
	sweepStale(s, t.engine, now)
	return u, nil
}

func createMySQLUser(s dbSession, name, pass, role string) error {
	acct := myString(name) + "@'%'"
	if err := s.exec("CREATE USER " + acct + " IDENTIFIED BY " + myString(pass)); err != nil {
		return fmt.Errorf("the saved account could not create a user (it needs CREATE USER): %v", err)
	}
	fail := func(err error) error {
		_ = s.exec("DROP USER IF EXISTS " + acct)
		return fmt.Errorf("the saved account could not give the user role %s (it needs the role granted WITH ADMIN OPTION): %v", role, err)
	}
	if err := s.exec("GRANT " + myString(role) + " TO " + acct); err != nil {
		return fail(err)
	}
	// MySQL 8: SET DEFAULT ROLE ... TO; MariaDB: SET DEFAULT ROLE ... FOR.
	if err := s.exec("SET DEFAULT ROLE " + myString(role) + " TO " + acct); err != nil {
		if err2 := s.exec("SET DEFAULT ROLE " + myString(role) + " FOR " + acct); err2 != nil {
			return fail(err2)
		}
	}
	return nil
}

// drop removes the user, after the connection that used it has closed.
func (u *ephUser) drop() {
	var last error
	for i := 0; i < 3; i++ {
		if i > 0 {
			time.Sleep(300 * time.Millisecond)
		}
		s, err := u.t.signIn(u.t.username, u.pw)
		if err != nil {
			last = err
			continue
		}
		last = dropEphemeral(s, u.t.engine, u.user, u.role)
		s.Close()
		if last == nil {
			return
		}
	}
	logWarn("could not drop the session database user %s: %v", u.user, last)
}

func dropEphemeral(s dbSession, engine, name, role string) error {
	if engine == "postgres" {
		// What it made goes to the role, so the user can be dropped; best effort.
		if role != "" {
			_ = s.exec("REASSIGN OWNED BY " + pgIdent(name) + " TO " + pgIdent(role))
		}
		_ = s.exec("DROP OWNED BY " + pgIdent(name))
		if err := s.exec("DROP ROLE IF EXISTS " + pgIdent(name)); err != nil {
			_ = s.exec("ALTER ROLE " + pgIdent(name) + " NOLOGIN")
			return err
		}
		return nil
	}
	return s.exec("DROP USER IF EXISTS " + myString(name) + "@'%'")
}

// sweepStale drops users this connector made that are too old to be in use.
func sweepStale(s dbSession, engine string, now time.Time) {
	q := "SELECT rolname FROM pg_roles WHERE rolname LIKE 'captivo\\_tmp\\_%'"
	if engine == "mysql" {
		q = "SELECT User FROM mysql.user WHERE User LIKE 'captivo\\_tmp\\_%'"
	}
	names, err := s.column(q)
	if err != nil {
		return // not allowed to look: the next provisioner that can will
	}
	n := 0
	for _, name := range names {
		if age, ok := ephAge(name, now); ok && age > ephStaleAfter && n < ephSweepMax {
			n++
			_ = dropEphemeral(s, engine, name, "")
		}
	}
}
