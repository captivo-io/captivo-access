package main

import (
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

func TestRedisCommandEncoding(t *testing.T) {
	if got := string(redisCommand("AUTH", "u", "p w")); got != "*3\r\n$4\r\nAUTH\r\n$1\r\nu\r\n$3\r\np w\r\n" {
		t.Fatalf("%q", got)
	}
	if v := redisServerVersion("# Server\r\nredis_version:7.4.1\r\nredis_mode:standalone\r\n"); v != "7.4.1" {
		t.Fatalf("version %q", v)
	}
	if got := redisSignInText("WRONGPASS invalid username-password pair or user is disabled."); strings.Contains(got, "invalid username") || !strings.Contains(got, "WRONGPASS") {
		t.Fatalf("%q", got)
	}
}

// Against a real server when REDIS_TEST_ADDR (host:port) is set: the server
// runs with requirepass Known-Pass-1a and an ACL user ops with ops-pass-2b.
func TestRedisSignInReal(t *testing.T) {
	addr := os.Getenv("REDIS_TEST_ADDR")
	if addr == "" {
		t.Skip("REDIS_TEST_ADDR not set")
	}
	host, port, _ := net.SplitHostPort(addr)
	req := func(user, db string) tunnel.DbDialRequest {
		return tunnel.DbDialRequest{Engine: "redis", Host: host, Port: port, Username: user, Database: db, TLS: "disable"}
	}
	ask := func(c net.Conn, args ...string) string {
		_ = c.SetDeadline(time.Now().Add(5 * time.Second))
		_, _ = c.Write(redisCommand(args...))
		buf := make([]byte, 256)
		n, _ := c.Read(buf)
		return string(buf[:n])
	}

	conn, br, resp, err := redisSignIn(req("default", "2"), "Known-Pass-1a")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(resp.ServerVersion, "7.") {
		t.Fatalf("version %q", resp.ServerVersion)
	}
	if br.Buffered() != 0 {
		t.Fatalf("%d bytes left over after the sign-in", br.Buffered())
	}
	if got := ask(conn, "ACL", "WHOAMI"); !strings.Contains(got, "default") {
		t.Fatalf("whoami %q", got)
	}
	_ = conn.Close()

	conn, _, _, err = redisSignIn(req("ops", ""), "ops-pass-2b")
	if err != nil {
		t.Fatal(err)
	}
	if got := ask(conn, "ACL", "WHOAMI"); !strings.Contains(got, "ops") {
		t.Fatalf("whoami %q", got)
	}
	_ = conn.Close()

	if _, _, _, err = redisSignIn(req("ops", ""), "wrong"); err == nil || !strings.Contains(err.Error(), "WRONGPASS") {
		t.Fatalf("wrong password: %v", err)
	}
	if _, _, _, err = redisSignIn(req("default", "99"), "Known-Pass-1a"); err == nil || !strings.Contains(err.Error(), "SELECT 99") {
		t.Fatalf("bad database: %v", err)
	}
	if _, _, _, err = redisSignIn(req("default", "abc"), "Known-Pass-1a"); err == nil {
		t.Fatal("a non-numeric database")
	}
}
