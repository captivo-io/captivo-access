package main

import (
	"net"
	"os"
	"strings"
	"testing"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// Against a real server when MONGO_TEST_ADDR (host:port) is set: auth is on
// and the account rooty / Mongo-Pass-1a lives in admin.
func TestMongoSignInReal(t *testing.T) {
	addr := os.Getenv("MONGO_TEST_ADDR")
	if addr == "" {
		t.Skip("MONGO_TEST_ADDR not set")
	}
	host, port, _ := net.SplitHostPort(addr)
	req := func(user, db string) tunnel.DbDialRequest {
		return tunnel.DbDialRequest{Engine: "mongodb", Host: host, Port: port, Username: user, Database: db, TLS: "disable"}
	}
	conn, br, resp, err := mongoSignIn(req("rooty", ""), "Mongo-Pass-1a")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if !strings.HasPrefix(resp.ServerVersion, "7.") {
		t.Fatalf("version %q", resp.ServerVersion)
	}
	// The connection is past authentication: a command only an account may run works.
	m := &mongoConn{conn: conn, r: br}
	doc, err := m.command(tunnel.BSONDoc(tunnel.BSONInt32Elem("listDatabases", 1), tunnel.BSONBoolElem("nameOnly", true), tunnel.BSONStr("$db", "admin")))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, ok := tunnel.BSONGet(doc, "databases"); !ok {
		t.Fatalf("no databases in the answer")
	}

	_, _, _, err = mongoSignIn(req("rooty", ""), "wrong")
	var me *mongoError
	if err == nil || !strings.Contains(err.Error(), "authentication failed") {
		t.Fatalf("wrong password: %v", err)
	}
	_ = me
	if _, _, _, err = mongoSignIn(req("nobody", ""), "x"); err == nil {
		t.Fatal("an unknown account")
	}
}

func TestMongoSignInSHA1AndAuthDatabase(t *testing.T) {
	addr := os.Getenv("MONGO_TEST_ADDR")
	if addr == "" {
		t.Skip("MONGO_TEST_ADDR not set")
	}
	host, port, _ := net.SplitHostPort(addr)
	// Accounts of the shop database: one with only SCRAM-SHA-1, one without.
	for user, pass := range map[string]string{"old1": "Old-Pass-1", "sha256": "Sha-Pass-1"} {
		conn, _, _, err := mongoSignIn(tunnel.DbDialRequest{Engine: "mongodb", Host: host, Port: port, Username: user, Database: "shop", TLS: "disable"}, pass)
		if err != nil {
			t.Fatalf("%s: %v", user, err)
		}
		conn.Close()
	}
	// The wrong authentication database is a failed sign-in.
	if _, _, _, err := mongoSignIn(tunnel.DbDialRequest{Engine: "mongodb", Host: host, Port: port, Username: "old1", TLS: "disable"}, "Old-Pass-1"); err == nil {
		t.Fatal("signed in to admin with a shop account")
	}
}
