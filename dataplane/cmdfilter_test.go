package main

import "testing"

func allow(entries ...string) *CommandPolicy { return &CommandPolicy{Mode: "allow", Entries: entries} }
func deny(entries ...string) *CommandPolicy  { return &CommandPolicy{Mode: "deny", Entries: entries} }

func TestAllowListOnlyLetsListedCommandsRun(t *testing.T) {
	p := allow("ls", "systemctl status *", "cat /var/log/*", "uptime")
	cases := []struct {
		line string
		ok   bool
	}{
		{"ls", true},
		{"ls -la /etc", true},
		{"/bin/ls -la", true},           // path of a listed name
		{"systemctl status nginx", true},
		{"systemctl restart nginx", false}, // a pattern entry does not allow the rest of the command
		{"cat /var/log/syslog", true},
		{"cat /etc/shadow", false},
		{"rm -rf /", false},
		{"ls; uptime", true},
		{"ls && rm -rf /", false},          // every command in the line must be listed
		{"ls | tee /tmp/x", false},
		{"echo $(rm -rf /)", false},        // a substitution cannot be checked
		{"ls `id`", false},
		{"FOO=bar ls", true},              // an environment prefix is skipped
		{"sudo ls", true},                 // a wrapper is looked through
		{"sudo rm -rf /", false},
		{"LS", true},                      // names are not case sensitive here
		{"", true},                        // an empty line runs nothing
	}
	for _, c := range cases {
		if ok, why := p.Check(c.line); ok != c.ok {
			t.Errorf("allow %q: got %v (%s), want %v", c.line, ok, why, c.ok)
		}
	}
}

func TestEmptyAllowListRefusesEverything(t *testing.T) {
	p := allow()
	if ok, _ := p.Check("ls"); ok {
		t.Fatal("an allow list with no entries allowed a command")
	}
	if ok, _ := p.Check(""); !ok {
		t.Fatal("an empty line is not a command")
	}
}

func TestDenyListRefusesListedCommandsAnywhereInTheLine(t *testing.T) {
	p := deny("rm", "mkfs", "shutdown", "systemctl stop *", "dd if=*")
	cases := []struct {
		line string
		ok   bool
	}{
		{"ls -la", true},
		{"rm -rf /tmp/x", false},
		{"/bin/rm file", false},
		{"sudo rm file", false},
		{"bash -c 'rm -rf /'", false},     // inside a wrapper's argument
		{"ls; rm x", false},
		{"echo $(shutdown now)", false},
		{"xargs rm < list", false},
		{"systemctl stop nginx", false},   // a pattern
		{"systemctl status nginx", true},
		{"dd if=/dev/zero of=/dev/sda", false},
		{"dd of=/tmp/x", true},
		{"RM x", false},
		{"grep format file", true},        // a word that only contains a listed name is fine
		{"farm --help", true},
	}
	for _, c := range cases {
		if ok, why := p.Check(c.line); ok != c.ok {
			t.Errorf("deny %q: got %v (%s), want %v", c.line, ok, why, c.ok)
		}
	}
}

func TestInactivePoliciesAllowEverything(t *testing.T) {
	var nilPolicy *CommandPolicy
	for _, p := range []*CommandPolicy{nilPolicy, deny(), {Mode: ""}} {
		if ok, _ := p.Check("rm -rf /"); !ok {
			t.Fatalf("%+v refused a command", p)
		}
		if p.Active() {
			t.Fatalf("%+v reports itself active", p)
		}
	}
	if !allow().Active() || !deny("rm").Active() {
		t.Fatal("an allow list, even empty, and a deny list with entries are active")
	}
}

func TestCheckExecLooksThroughWrappers(t *testing.T) {
	d := deny("rm", "shutdown")
	for _, c := range []struct {
		argv []string
		ok   bool
	}{
		{[]string{"ls", "-la"}, true},
		{[]string{"rm", "-rf", "/data"}, false},
		{[]string{"sh", "-c", "rm -rf /data"}, false},       // a shell's script
		{[]string{"bash", "-lc", "echo hi; rm x"}, false},
		{[]string{"env", "rm", "x"}, false},                  // a wrapper
		{[]string{"xargs", "rm"}, false},
		{[]string{"sh", "-c", "ls /data"}, true},
	} {
		if ok, why := d.CheckExec(c.argv); ok != c.ok {
			t.Errorf("deny %v: got %v (%s)", c.argv, ok, why)
		}
	}
	a := allow("ls", "cat /var/log/*")
	for _, c := range []struct {
		argv []string
		ok   bool
	}{
		{[]string{"ls", "/tmp"}, true},
		{[]string{"cat", "/var/log/app.log"}, true},
		{[]string{"cat", "/etc/shadow"}, false},
		{[]string{"sh"}, false},                              // an interactive shell is not listed
		{[]string{"sh", "-c", "ls"}, false},                  // nor is the shell that would run it
	} {
		if ok, why := a.CheckExec(c.argv); ok != c.ok {
			t.Errorf("allow %v: got %v (%s)", c.argv, ok, why)
		}
	}
	// A shell that IS allowed still has its script checked.
	sh := allow("sh", "ls")
	if ok, _ := sh.CheckExec([]string{"sh", "-c", "ls"}); !ok {
		t.Error("an allowed shell running an allowed command was refused")
	}
	if ok, _ := sh.CheckExec([]string{"sh", "-c", "rm -rf /"}); ok {
		t.Error("an allowed shell ran a command that is not listed")
	}
}

func TestATrailingStarAlsoNamesTheCommandAlone(t *testing.T) {
	a := allow("systemctl status *")
	if ok, _ := a.Check("systemctl status"); !ok {
		t.Error("the command with no argument was refused")
	}
	if ok, _ := a.Check("systemctl restart nginx"); ok {
		t.Error("another subcommand was allowed")
	}
}

func TestRedisAndMongoCommandLists(t *testing.T) {
	cmd := func(args ...string) *redisCmd {
		c := &redisCmd{}
		for _, a := range args {
			c.args = append(c.args, []byte(a))
		}
		return c
	}
	d := deny("FLUSHALL", "FLUSHDB", "KEYS", "CONFIG SET *")
	for _, c := range []struct {
		args []string
		why  bool
	}{{[]string{"get", "a"}, false}, {[]string{"flushall"}, true}, {[]string{"KEYS", "*"}, true}, {[]string{"eval", "return redis.call('flushall')", "0"}, true}, {[]string{"ping"}, false}} {
		if got := redisListRefusal(d, cmd(c.args...)); (got != "") != c.why {
			t.Errorf("redis deny %v: %q", c.args, got)
		}
	}
	a := allow("GET", "SET", "EXISTS")
	for _, c := range []struct {
		args []string
		why  bool
	}{{[]string{"get", "a"}, false}, {[]string{"del", "a"}, true}, {[]string{"eval", "return 1", "0"}, true}, {[]string{"ping"}, false}, {[]string{"select", "2"}, false}} {
		if got := redisListRefusal(a, cmd(c.args...)); (got != "") != c.why {
			t.Errorf("redis allow %v: %q", c.args, got)
		}
	}
	if redisListRefusal(nil, cmd("flushall")) != "" {
		t.Error("no list, yet a command was refused")
	}
	md := deny("dropDatabase", "drop", "delete")
	for _, c := range []struct {
		name string
		why  bool
	}{{"find", false}, {"dropDatabase", true}, {"DROP", true}, {"delete", true}, {"hello", false}, {"getMore", false}} {
		if got := mongoListRefusal(md, c.name); (got != "") != c.why {
			t.Errorf("mongo deny %s: %q", c.name, got)
		}
	}
	ma := allow("find", "count")
	for _, c := range []struct {
		name string
		why  bool
	}{{"find", false}, {"insert", true}, {"ping", false}, {"saslStart", false}, {"endSessions", false}} {
		if got := mongoListRefusal(ma, c.name); (got != "") != c.why {
			t.Errorf("mongo allow %s: %q", c.name, got)
		}
	}
}
