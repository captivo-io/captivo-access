package main

import (
	"crypto/tls"
	"strings"
	"testing"
	"time"
)

func z(s ...string) []byte {
	var b []byte
	for _, x := range s {
		b = append(append(b, x...), 0)
	}
	return b
}

func TestTrackerSimpleQuery(t *testing.T) {
	t0 := time.Unix(1000, 0)
	q := newQueryTracker(t0, "crm")
	q.client('Q', z("select 1; update t set a = 1 where id = 2"), t0.Add(time.Second))
	if evs := q.server('C', z("SELECT 1"), t0.Add(1100*time.Millisecond)); len(evs) != 0 {
		t.Fatal("a simple query completes at ReadyForQuery, not at its first CommandComplete")
	}
	q.server('C', z("UPDATE 1"), t0.Add(1200*time.Millisecond))
	evs := q.server('Z', []byte{'I'}, t0.Add(1300*time.Millisecond))
	if len(evs) != 1 || evs[0].Rows == nil || *evs[0].Rows != 2 || evs[0].Ms != 300 || evs[0].AtMs != 1000 || evs[0].Db != "crm" {
		t.Fatalf("got %+v", evs)
	}
}

func TestTrackerExtendedPipelined(t *testing.T) {
	t0 := time.Unix(1000, 0)
	q := newQueryTracker(t0, "")
	// Two statements sent before any answer (pgjdbc batches, psycopg pipelines).
	q.client('P', z("s1", "select * from users where id = $1"), t0)
	q.client('B', z("", "s1"), t0)
	q.client('E', z(""), t0)
	q.client('P', z("", "delete from orders where id = $1"), t0)
	q.client('B', z("", ""), t0)
	q.client('E', z(""), t0)
	q.client('S', nil, t0)
	a := q.server('C', z("SELECT 1"), t0.Add(5*time.Millisecond))
	b := q.server('C', z("DELETE 3"), t0.Add(9*time.Millisecond))
	q.server('Z', []byte{'I'}, t0.Add(9*time.Millisecond))
	if len(a) != 1 || a[0].Text != "select * from users where id = $1" || *a[0].Rows != 1 {
		t.Fatalf("first: %+v", a)
	}
	if len(b) != 1 || b[0].Text != "delete from orders where id = $1" || *b[0].Rows != 3 || b[0].Ms != 9 {
		t.Fatalf("second: %+v", b)
	}
}

func TestTrackerErrorSkipsRestOfBatch(t *testing.T) {
	t0 := time.Unix(1000, 0)
	q := newQueryTracker(t0, "")
	q.client('P', z("", "select nope"), t0)
	q.client('B', z("", ""), t0)
	q.client('E', z(""), t0)
	q.client('P', z("", "select 2"), t0)
	q.client('B', z("", ""), t0)
	q.client('E', z(""), t0)
	evs := q.server('E', z("SERROR", "C42703", `Mcolumn "nope" does not exist`), t0)
	if len(evs) != 1 || evs[0].Code != "42703" || !strings.Contains(evs[0].Error, "nope") {
		t.Fatalf("got %+v", evs)
	}
	if evs := q.server('Z', []byte{'I'}, t0); len(evs) != 0 {
		t.Fatalf("the skipped statement was logged: %+v", evs)
	}
	// The next batch pairs up again.
	q.client('Q', z("select 3"), t0)
	q.server('C', z("SELECT 1"), t0)
	if evs := q.server('Z', []byte{'I'}, t0); len(evs) != 1 || evs[0].Text != "select 3" {
		t.Fatalf("got %+v", evs)
	}
}

func TestTrackerSuspendedPortalIsOneStatement(t *testing.T) {
	t0 := time.Unix(1000, 0)
	q := newQueryTracker(t0, "")
	q.client('P', z("", "select * from big"), t0)
	q.client('B', z("c1", ""), t0)
	q.client('E', z("c1"), t0)
	for range 100 {
		q.server('D', nil, t0)
	}
	first := q.server('s', nil, t0)
	q.client('E', z("c1"), t0)
	for range 50 {
		q.server('D', nil, t0)
	}
	more := q.server('C', z("SELECT 50"), t0.Add(time.Second))
	if len(first) != 0 || len(more) != 1 || *more[0].Rows != 150 || more[0].Ms != 1000 {
		t.Fatalf("a fetch in pieces logs once, with every row: %+v %+v", first, more)
	}
}

func TestMaskQuery(t *testing.T) {
	got := maskQuery("ALTER ROLE app PASSWORD 'hunter2' VALID UNTIL 'infinity'")
	if strings.Contains(got, "hunter2") || !strings.Contains(got, "VALID UNTIL 'infinity'") {
		t.Fatalf("got %q", got)
	}
	if got := maskQuery("create user x with encrypted password 'SCRAM-SHA-256$4096:abc'"); strings.Contains(got, "SCRAM") {
		t.Fatalf("got %q", got)
	}
	long := maskQuery(strings.Repeat("ş", queryTextMax))
	if len(long) > queryTextMax+4 || !strings.HasSuffix(long, " …") {
		t.Fatalf("not cut: %d", len(long))
	}
}

func TestTagRows(t *testing.T) {
	for tag, want := range map[string]int64{"SELECT 5": 5, "INSERT 0 7": 7, "UPDATE 0": 0, "COPY 10": 10} {
		if n, ok := tagRows(tag); !ok || n != want {
			t.Fatalf("%s: %d %v", tag, n, ok)
		}
	}
	if _, ok := tagRows("CREATE TABLE"); ok {
		t.Fatal("no row count in CREATE TABLE")
	}
}

func TestSelfSignedDbCertIsKept(t *testing.T) {
	dir := t.TempDir()
	c1, k1, err := selfSignedDbCert(dir)
	if err != nil {
		t.Fatal(err)
	}
	a, _ := tls.LoadX509KeyPair(c1, k1)
	c2, k2, err := selfSignedDbCert(dir)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := tls.LoadX509KeyPair(c2, k2)
	if len(a.Certificate) == 0 || string(a.Certificate[0]) != string(b.Certificate[0]) {
		t.Fatal("a restart must keep the same certificate")
	}
}
