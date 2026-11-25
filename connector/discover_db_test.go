package main

import (
	"crypto/ecdh"
	"crypto/rand"
	"net"
	"os"
	"strings"
	"testing"

	"github.com/kurtserdar/captivo-access/tunnel"
)

func TestParseDatabaseAccounts(t *testing.T) {
	pg := parseDatabaseAccounts("postgres", []string{"app|true|false", "postgres|true|true", "readonly|false|false", "bad name|true|false", "app|true|false", "junk"})
	by := map[string]tunnel.DiscoveredAccount{}
	for _, a := range pg {
		by[a.Name] = a
	}
	if len(pg) != 3 || !by["postgres"].Admin || !by["app"].Login || by["app"].Admin || !by["readonly"].Locked {
		t.Fatalf("postgres accounts %+v", pg)
	}
	if pg[len(pg)-1].Name != "readonly" {
		t.Fatalf("accounts that cannot sign in come last: %v", pg)
	}
	my := parseDatabaseAccounts("mysql", []string{"app|%|N|30|N", "root|localhost|N|400|Y", "multi|a|N|-1|N", "multi|b|N|-1|N", "off|%|Y|5|N"})
	m := map[string]tunnel.DiscoveredAccount{}
	for _, a := range my {
		m[a.Name] = a
	}
	if len(my) != 4 || m["app"].PassAgeDays != 30 || !m["root"].Admin || !m["off"].Locked || m["off"].Login {
		t.Fatalf("mysql accounts %+v", my)
	}
	if !strings.Contains(m["multi"].Blocked, "2 hosts") || m["app"].Blocked != "" {
		t.Fatalf("a user on several hosts cannot be taken over: %+v", m["multi"])
	}
}

// Real servers: DISC_DB_ENGINE, DISC_DB_ADDR, DISC_DB_ADMIN, DISC_DB_PASS, DISC_DB_NAME (PostgreSQL), DISC_DB_TLS, DISC_DB_WANT (an account that must show up).
func TestDiscoverDatabaseE2E(t *testing.T) {
	addr := os.Getenv("DISC_DB_ADDR")
	if addr == "" {
		t.Skip("DISC_DB_ADDR not set")
	}
	host, port, _ := net.SplitHostPort(addr)
	tg := &dbAccountTarget{engine: os.Getenv("DISC_DB_ENGINE"), host: host, port: port, username: os.Getenv("DISC_DB_ADMIN"), db: tunnel.RotateDB{Database: os.Getenv("DISC_DB_NAME"), TLS: os.Getenv("DISC_DB_TLS")}}
	r := discoverDatabase(tg, tg.username, os.Getenv("DISC_DB_PASS"))
	if r.Error != "" {
		t.Fatal(r.Error)
	}
	found := false
	for _, a := range r.Accounts {
		if a.Name == os.Getenv("DISC_DB_WANT") && a.Login {
			found = true
		}
	}
	if !found {
		t.Fatalf("%s is not listed: %+v", os.Getenv("DISC_DB_WANT"), r.Accounts)
	}
}

// Taking a database account over: the saved password is a placeholder, so the
// rotation resets it through the administrator account. Needs the same env,
// plus DISC_DB_TARGET (the account to take over) and the administrator able to reset it.
func TestTakeOverDatabaseE2E(t *testing.T) {
	addr, target := os.Getenv("DISC_DB_ADDR"), os.Getenv("DISC_DB_TARGET")
	if addr == "" || target == "" {
		t.Skip("DISC_DB_ADDR / DISC_DB_TARGET not set")
	}
	host, port, _ := net.SplitHostPort(addr)
	engine := os.Getenv("DISC_DB_ENGINE")
	k, _ := ecdh.X25519().GenerateKey(rand.Reader)
	pub := vaultPublicKeyB64(k)
	aad := vaultTargetAAD(host, port, target)
	db := &tunnel.RotateDB{Database: os.Getenv("DISC_DB_NAME"), TLS: os.Getenv("DISC_DB_TLS")}
	admin := os.Getenv("DISC_DB_ADMIN")
	base := tunnel.RotateRequest{Method: engine, Host: host, Port: port, Username: target, DB: db,
		Current:   sealForTest(t, k.PublicKey(), "placeholder-not-the-password", aad),
		Reconcile: &tunnel.RotateReconcile{Host: host, Port: port, Username: admin, Sealed: sealForTest(t, k.PublicKey(), os.Getenv("DISC_DB_PASS"), vaultReconcileAAD(host, port, admin))}}
	allow := &TargetMatcher{open: true}
	prep := base
	prep.Op, prep.To = "prepare", []string{pub}
	p := rotate(t.Context(), k, allow, prep)
	if p.Error != "" {
		t.Fatal(p.Error)
	}
	apply := base
	apply.Op, apply.Pending = "apply", p.Seals[pub]
	r := rotate(t.Context(), k, allow, apply)
	if r.Outcome != "rotated" || !r.Reconciled || !r.OutOfSync {
		t.Fatalf("take-over: %+v", r)
	}
	next, _ := openSealed(k, p.Seals[pub], aad)
	at := &dbAccountTarget{engine: engine, host: host, port: port, db: *db}
	c, err := at.signIn(target, next)
	if err != nil {
		t.Fatalf("the new password does not sign in: %v", err)
	}
	c.Close()
}

func TestParseMSSQLRedisMongoAccounts(t *testing.T) {
	ms := parseMSSQLAccounts([]string{"sa|false|true|-1", "app|false|false|12", "dormant1|true|false|3", "bad name|false|false|1", "junk"})
	by := map[string]tunnel.DiscoveredAccount{}
	for _, a := range ms {
		by[a.Name] = a
	}
	if len(ms) != 3 || !by["sa"].Admin || by["app"].PassAgeDays != 12 || by["dormant1"].Login || !by["dormant1"].Locked || ms[len(ms)-1].Name != "dormant1" {
		t.Fatalf("mssql %+v", ms)
	}
	rd := parseRedisACL([]string{"user default on #hash ~* &* +@all", "user reader on #h ~* -@all +@read", "user open on nopass ~* +@all", "user dormant off #h", "garbage"})
	r := map[string]tunnel.DiscoveredAccount{}
	for _, a := range rd {
		r[a.Name] = a
	}
	if len(rd) != 4 || !r["default"].Admin || r["reader"].Admin || !r["open"].NoPass || r["dormant"].Login || r["reader"].Blocked == "" {
		t.Fatalf("redis %+v", rd)
	}
	for _, a := range rd {
		if strings.Contains(a.Name+a.Blocked, "hash") {
			t.Fatal("a hash got through")
		}
	}
}

// Real SQL Server, Redis and MongoDB: DISC_X_ADDR, DISC_X_ADMIN, DISC_X_PASS, DISC_X_WANT for X in MSSQL, REDIS, MONGO.
func TestDiscoverOtherEnginesE2E(t *testing.T) {
	for _, c := range []struct{ env, engine string }{{"MSSQL", "mssql"}, {"REDIS", "redis"}, {"MONGO", "mongodb"}} {
		addr := os.Getenv("DISC_" + c.env + "_ADDR")
		if addr == "" {
			continue
		}
		host, port, _ := net.SplitHostPort(addr)
		admin, pass := os.Getenv("DISC_"+c.env+"_ADMIN"), os.Getenv("DISC_"+c.env+"_PASS")
		tg := &dbAccountTarget{engine: c.engine, host: host, port: port, username: admin, db: tunnel.RotateDB{TLS: os.Getenv("DISC_" + c.env + "_TLS")}}
		var r tunnel.RotateResponse
		switch c.engine {
		case "redis":
			r = discoverRedis(tg, admin, pass)
		case "mongodb":
			r = discoverMongo(tg, admin, pass)
		default:
			r = discoverDatabase(tg, admin, pass)
		}
		if r.Error != "" {
			t.Fatalf("%s: %s", c.engine, r.Error)
		}
		found := false
		for _, a := range r.Accounts {
			if a.Name == os.Getenv("DISC_"+c.env+"_WANT") {
				found = true
			}
		}
		if !found {
			t.Fatalf("%s: %s is not listed: %+v", c.engine, os.Getenv("DISC_"+c.env+"_WANT"), r.Accounts)
		}
		t.Logf("%s: %d accounts: %+v", c.engine, len(r.Accounts), r.Accounts)
	}
}

// Redis and MongoDB have no reconcile account: the discover op signs in with the
// resource's own saved credential (the "current" seal), which may be a vault reference.
func TestDiscoverUsesTheSavedAccountWhereThereIsNoReconcile(t *testing.T) {
	for _, c := range []struct{ env, method string }{{"REDIS", "redis"}, {"MONGO", "mongodb"}} {
		addr := os.Getenv("DISC_" + c.env + "_ADDR")
		if addr == "" {
			continue
		}
		host, port, _ := net.SplitHostPort(addr)
		k, _ := ecdh.X25519().GenerateKey(rand.Reader)
		user := os.Getenv("DISC_" + c.env + "_ADMIN")
		cur := sealForTest(t, k.PublicKey(), os.Getenv("DISC_"+c.env+"_PASS"), vaultTargetAAD(host, port, user))
		r := discoverAccounts(t.Context(), k, &TargetMatcher{open: true}, tunnel.RotateRequest{Op: "discover", Method: c.method, Host: host, Port: port, Username: user, Current: cur, DB: &tunnel.RotateDB{TLS: ""}})
		if r.Error != "" || len(r.Accounts) == 0 {
			t.Fatalf("%s: %+v", c.method, r)
		}
		bad := discoverAccounts(t.Context(), k, &TargetMatcher{open: true}, tunnel.RotateRequest{Op: "discover", Method: c.method, Host: host, Port: port, Username: user, Current: "cv1:nonsense", DB: &tunnel.RotateDB{}})
		if bad.Error == "" {
			t.Fatalf("%s: a credential that does not open must be refused", c.method)
		}
	}
}
