package main

import (
	"bufio"
	"errors"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// Account discovery in Redis and MongoDB. Neither has a reconcile account, so
// the resource's own saved account lists the others.

// discoverRedis lists a Redis server's ACL users (Redis 6 and later): who is
// on, who has no password, who may run every command. Never a password hash.
func discoverRedis(t *dbAccountTarget, adminUser, adminPW string) tunnel.RotateResponse {
	req := t.req(adminUser)
	conn, br, _, err := redisSignIn(req, adminPW)
	if err != nil {
		return tunnel.RotateResponse{Error: "the administrator account can't sign in: " + err.Error()}
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(dbSignInLimit))
	if _, err := conn.Write([]byte("*2\r\n$3\r\nACL\r\n$4\r\nLIST\r\n")); err != nil {
		return tunnel.RotateResponse{Error: "the database server closed the connection"}
	}
	lines, err := readRespStringArray(br)
	if err != nil {
		return tunnel.RotateResponse{Error: "the administrator account can't list the server's users: " + err.Error()}
	}
	return tunnel.RotateResponse{Outcome: "ok", Accounts: parseRedisACL(lines)}
}

// readRespStringArray reads one RESP2 reply that is an array of bulk strings,
// or turns an error reply into an error.
func readRespStringArray(br *bufio.Reader) ([]string, error) {
	line, err := br.ReadString('\n')
	if err != nil {
		return nil, errors.New("the database server closed the connection")
	}
	line = strings.TrimRight(line, "\r\n")
	if strings.HasPrefix(line, "-") {
		return nil, errors.New(redisSignInText(line[1:]))
	}
	if !strings.HasPrefix(line, "*") {
		return nil, errors.New("unexpected answer from the database server")
	}
	n, err := strconv.Atoi(line[1:])
	if err != nil || n < 0 || n > 10000 {
		return nil, errors.New("unexpected answer from the database server")
	}
	out := make([]string, 0, n)
	for i := 0; i < n; i++ {
		hdr, err := br.ReadString('\n')
		if err != nil || !strings.HasPrefix(hdr, "$") {
			return nil, errors.New("unexpected answer from the database server")
		}
		l, err := strconv.Atoi(strings.TrimRight(hdr[1:], "\r\n"))
		if err != nil || l < 0 || l > 1<<20 {
			return nil, errors.New("unexpected answer from the database server")
		}
		buf := make([]byte, l+2)
		if _, err := io.ReadFull(br, buf); err != nil {
			return nil, errors.New("the database server closed the connection")
		}
		out = append(out, string(buf[:l]))
	}
	return out, nil
}

// parseRedisACL reads "user NAME on|off nopass|#hash|>pw ... ~keys &channels +@all" lines.
func parseRedisACL(lines []string) []tunnel.DiscoveredAccount {
	var out []tunnel.DiscoveredAccount
	for _, l := range lines {
		f := strings.Fields(l)
		if len(f) < 3 || f[0] != "user" || !dbAccountNameRe.MatchString(f[1]) {
			continue
		}
		a := tunnel.DiscoveredAccount{Name: f[1], PassAgeDays: -1}
		for _, w := range f[2:] {
			switch {
			case w == "on":
				a.Login = true
			case w == "off":
				a.Locked = true
			case w == "nopass":
				a.NoPass = true
			case w == "+@all" || w == "allcommands" || w == "+@admin" || w == "+@dangerous":
				a.Admin = true
			}
		}
		out = append(out, a)
	}
	sortAccounts(out)
	return out
}

// discoverMongo lists the users of a MongoDB server (every database the
// administrator account can see): the user name, and whether any role is an
// administrative one. Never a credential.
func discoverMongo(t *dbAccountTarget, adminUser, adminPW string) tunnel.RotateResponse {
	req := t.req(adminUser)
	conn, br, _, err := mongoSignIn(req, adminPW)
	if err != nil {
		return tunnel.RotateResponse{Error: "the administrator account can't sign in: " + err.Error()}
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(dbSignInLimit))
	m := &mongoConn{conn: conn, r: br}
	body, err := m.command(tunnel.BSONDoc(
		tunnel.BSONSub("usersInfo", tunnel.BSONBoolElem("forAllDBs", true)),
		tunnel.BSONStr("$db", "admin"),
	))
	if err != nil {
		return tunnel.RotateResponse{Error: "the administrator account can't list the server's users: " + err.Error()}
	}
	return tunnel.RotateResponse{Outcome: "ok", Accounts: parseMongoUsers(body)}
}

var mongoAdminRoles = map[string]bool{"root": true, "dbOwner": true, "userAdminAnyDatabase": true, "userAdmin": true, "clusterAdmin": true, "readWriteAnyDatabase": true, "dbAdminAnyDatabase": true}

// parseMongoUsers reads the "users" array of a usersInfo answer.
func parseMongoUsers(body []byte) []tunnel.DiscoveredAccount {
	typ, v, ok := tunnel.BSONGet(body, "users")
	if !ok || typ != 0x04 {
		return nil
	}
	var out []tunnel.DiscoveredAccount
	seen := map[string]bool{}
	_ = tunnel.BSONEach(v, func(t byte, _ string, u []byte) bool {
		if t != 0x03 {
			return true
		}
		name, db := "", ""
		admin := false
		_ = tunnel.BSONEach(u, func(t byte, k string, val []byte) bool {
			switch {
			case k == "user" && t == tunnel.BSONString:
				name, _ = tunnel.BSONStringValue(val)
			case k == "db" && t == tunnel.BSONString:
				db, _ = tunnel.BSONStringValue(val)
			case k == "roles" && t == 0x04:
				_ = tunnel.BSONEach(val, func(rt byte, _ string, r []byte) bool {
					if rt != 0x03 {
						return true
					}
					if _, rv, ok := tunnel.BSONGet(r, "role"); ok {
						if role, ok := tunnel.BSONStringValue(rv); ok && mongoAdminRoles[role] {
							admin = true
						}
					}
					return true
				})
			}
			return true
		})
		label := name
		if db != "" && db != "admin" {
			label = name + "@" + db
		}
		if name == "" || !dbAccountNameRe.MatchString(label) || seen[label] {
			return true
		}
		seen[label] = true
		out = append(out, tunnel.DiscoveredAccount{Name: label, Login: true, Admin: admin, PassAgeDays: -1})
		return true
	})
	sortAccounts(out)
	if len(out) > discoverMax {
		out = out[:discoverMax]
	}
	return out
}
