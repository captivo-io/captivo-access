package main

import (
	"bufio"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/json"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

func TestEphemeralNamesCarryTheirAge(t *testing.T) {
	now := time.Now()
	n, err := ephName(now.Add(-7 * time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(n, ephPrefix) || len(n) > 32 {
		t.Fatalf("name %q (MySQL allows 32 characters on older servers)", n)
	}
	if age, ok := ephAge(n, now); !ok || age < 7*time.Hour-2*time.Second || age > 7*time.Hour+2*time.Second {
		t.Fatalf("age %v %v", age, ok)
	}
	for _, other := range []string{"app", "captivo_tmp_", "captivo_tmp_x_1", "captivo_tmpx_1_2", "captivo_tmp_-5_ab"} {
		if _, ok := ephAge(other, now); ok {
			t.Errorf("%q is not one of ours", other)
		}
	}
	if !ephRoleOK.MatchString("app_readonly") || ephRoleOK.MatchString(`ro"; DROP`) || ephRoleOK.MatchString("") {
		t.Fatal("role name check")
	}
}

func TestEphemeralRefusesOtherEnginesAndOddRoles(t *testing.T) {
	if _, err := createEphemeralUser(&dbAccountTarget{engine: "mssql"}, "x", "r"); err == nil {
		t.Fatal("SQL Server is not supported")
	}
	if _, err := createEphemeralUser(&dbAccountTarget{engine: "postgres"}, "x", `a"b`); err == nil {
		t.Fatal("a role name with a quote must be refused before anything runs")
	}
}

// A real server: the saved account provisions a user that inherits a role, the
// session works as that user, and the user is gone afterwards. Set
// EPH_ADDR, EPH_ENGINE (postgres|mysql), EPH_USER, EPH_PASS, EPH_ROLE, EPH_DB
// (the database to connect to) and EPH_PROBE (a table the role can read).
func TestEphemeralE2E(t *testing.T) {
	addr := os.Getenv("EPH_ADDR")
	if addr == "" {
		t.Skip("EPH_ADDR not set")
	}
	host, port, _ := net.SplitHostPort(addr)
	engine, role := os.Getenv("EPH_ENGINE"), os.Getenv("EPH_ROLE")
	prov := &dbAccountTarget{engine: engine, host: host, port: port, username: os.Getenv("EPH_USER"), db: tunnel.RotateDB{Database: os.Getenv("EPH_DB"), TLS: os.Getenv("EPH_TLS")}}
	pw := os.Getenv("EPH_PASS")

	u, err := createEphemeralUser(prov, pw, role)
	if err != nil {
		t.Fatal(err)
	}
	// It signs in, with the role's rights and not the provisioner's.
	as := &dbAccountTarget{engine: engine, host: host, port: port, db: prov.db}
	s, err := as.signIn(u.user, u.pass)
	if err != nil {
		u.drop()
		t.Fatalf("the made user can't sign in: %v", err)
	}
	if probe := os.Getenv("EPH_PROBE"); probe != "" {
		if _, err := s.column("SELECT * FROM " + probe); err != nil && engine == "postgres" {
			t.Errorf("the role's table is not readable: %v", err)
		}
	}
	if err := s.exec("CREATE DATABASE captivo_must_fail"); err == nil {
		t.Error("a session user must not have the provisioner's rights")
		_ = s.exec("DROP DATABASE captivo_must_fail")
	}
	s.Close()
	u.drop()
	if _, err := as.signIn(u.user, u.pass); err == nil {
		t.Fatal("the user must be gone after the session")
	}
	// A leftover from a crash is swept by the next provisioning.
	old, _ := ephName(time.Now().Add(-8 * time.Hour))
	ps, err := prov.signIn(prov.username, pw)
	if err != nil {
		t.Fatal(err)
	}
	if engine == "postgres" {
		_ = ps.exec("CREATE ROLE " + pgIdent(old) + " NOLOGIN")
	} else {
		_ = ps.exec("CREATE USER " + myString(old) + "@'%' IDENTIFIED BY 'x'")
	}
	ps.Close()
	u2, err := createEphemeralUser(prov, pw, role)
	if err != nil {
		t.Fatal(err)
	}
	defer u2.drop()
	ps, _ = prov.signIn(prov.username, pw)
	defer ps.Close()
	q := "SELECT rolname FROM pg_roles WHERE rolname = '" + old + "'"
	if engine == "mysql" {
		q = "SELECT User FROM mysql.user WHERE User = '" + old + "'"
	}
	if left, _ := ps.column(q); len(left) != 0 {
		t.Errorf("the stale user %s was not swept", old)
	}
}

// Through the connector's db stream: the client works as a made-up user, and
// the user is gone once the stream closes.
func TestEphemeralThroughHandleDb(t *testing.T) {
	addr := os.Getenv("EPH_ADDR")
	if addr == "" || os.Getenv("EPH_ENGINE") != "postgres" {
		t.Skip("EPH_ADDR / EPH_ENGINE=postgres not set")
	}
	host, port, _ := net.SplitHostPort(addr)
	k, _ := ecdh.X25519().GenerateKey(rand.Reader)
	old := vaultKey
	vaultKey = k
	defer func() { vaultKey = old }()
	user := os.Getenv("EPH_USER")
	sealed := sealForTest(t, k.PublicKey(), os.Getenv("EPH_PASS"), vaultTargetAAD(host, port, user))
	dp, cn := tcpPair(t)
	req := tunnel.DbDialRequest{Kind: "db", Engine: "postgres", Host: host, Port: port, Username: user, Database: os.Getenv("EPH_DB"), Sealed: sealed, SessionRole: os.Getenv("EPH_ROLE")}
	b, _ := json.Marshal(req)
	done := make(chan struct{})
	go func() { handleDb(cn, &TargetMatcher{open: true}, b); close(done) }()
	_ = dp.SetDeadline(time.Now().Add(10 * time.Second))
	rb, err := tunnel.ReadFrame(dp)
	if err != nil {
		t.Fatal(err)
	}
	var resp tunnel.DbDialResponse
	_ = json.Unmarshal(rb, &resp)
	if resp.Error != "" {
		t.Fatalf("sign-in: %s", resp.Error)
	}
	// What the server reports as the current user.
	br := bufio.NewReader(dp)
	for { // the sign-in's own answers, up to ReadyForQuery
		typ, _, err := pgRead(br)
		if err != nil {
			t.Fatal(err)
		}
		if typ == 'Z' {
			break
		}
	}
	_ = pgSend(dp, 'Q', append([]byte("select current_user"), 0))
	var who string
	for {
		typ, body, err := pgRead(br)
		if err != nil {
			t.Fatal(err)
		}
		if typ == 'D' {
			who = string(body[6:])
		}
		if typ == 'Z' {
			break
		}
	}
	if !strings.HasPrefix(who, ephPrefix) {
		t.Fatalf("the session works as %q, want a captivo_tmp_ user", who)
	}
	dp.Close()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("handleDb did not return after the client closed")
	}
	prov := &dbAccountTarget{engine: "postgres", host: host, port: port, username: user, db: tunnel.RotateDB{Database: os.Getenv("EPH_DB")}}
	ps, err := prov.signIn(user, os.Getenv("EPH_PASS"))
	if err != nil {
		t.Fatal(err)
	}
	defer ps.Close()
	if left, _ := ps.column("SELECT rolname FROM pg_roles WHERE rolname = '" + who + "'"); len(left) != 0 {
		t.Fatalf("%s is still there after the session", who)
	}
}
