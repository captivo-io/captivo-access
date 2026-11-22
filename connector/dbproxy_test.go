package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"strings"
	"testing"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// RFC 7677's SCRAM-SHA-256 example (user "user", password "pencil").
func TestScramRFC7677(t *testing.T) {
	s := &scramClient{password: "pencil", nonce: "rOprNGfwEbeRWgbNEkqO", clientFirstBare: "n=user,r=rOprNGfwEbeRWgbNEkqO"}
	final, err := s.clientFinal("r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096")
	if err != nil {
		t.Fatal(err)
	}
	want := "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ="
	if final != want {
		t.Fatalf("client final\n got %s\nwant %s", final, want)
	}
	if err := s.verify("v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4="); err != nil || !s.verified {
		t.Fatalf("server signature not accepted: %v", err)
	}
	if err := (&scramClient{serverKey: s.serverKey, authMessage: s.authMessage}).verify("v=AAAA"); err == nil {
		t.Fatal("a wrong server signature was accepted")
	}
}

func TestScramRejectsForeignNonce(t *testing.T) {
	s := newScramClient("pw")
	s.clientFirst()
	if _, err := s.clientFinal("r=someoneelse,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096"); err == nil {
		t.Fatal("a server nonce not extending ours was accepted")
	}
	if _, err := s.clientFinal("r=" + s.nonce + "x,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=99999999"); err == nil {
		t.Fatal("an absurd iteration count was accepted")
	}
}

func TestPgMD5(t *testing.T) {
	if got := pgMD5("postgres", "secret", []byte{1, 2, 3, 4}); got != "md5bb41a296aab6baccb36ff243a562abff" {
		t.Fatalf("got %s", got)
	}
}

func TestStartupKeepsOnlySafeParams(t *testing.T) {
	b := pgStartup(tunnel.DbDialRequest{Username: "app", Database: "crm", Params: map[string]string{
		"application_name": "DBeaver", "user": "postgres", "options": "-c role=admin", "replication": "database", "_pq_.x": "1",
	}})
	s := string(b)
	for _, bad := range []string{"postgres", "role=admin", "replication", "_pq_"} {
		if strings.Contains(s, bad) {
			t.Fatalf("startup carries %q: %q", bad, s)
		}
	}
	for _, good := range []string{"user\x00app\x00", "database\x00crm\x00", "application_name\x00DBeaver\x00"} {
		if !strings.Contains(s, good) {
			t.Fatalf("startup lacks %q", good)
		}
	}
	if int(binary.BigEndian.Uint32(b)) != len(b) {
		t.Fatal("length field wrong")
	}
}

// A server that asks for a cleartext password, accepts it, and errors otherwise.
func TestAuthenticateCleartextAndError(t *testing.T) {
	msg := func(t byte, body []byte) []byte {
		return append(append([]byte{t}, binary.BigEndian.AppendUint32(nil, uint32(len(body)+4))...), body...)
	}
	var server bytes.Buffer
	server.Write(msg('R', binary.BigEndian.AppendUint32(nil, 3)))
	server.Write(msg('R', binary.BigEndian.AppendUint32(nil, 0)))
	server.Write(msg('S', []byte("server_version\x0016\x00")))
	var sent bytes.Buffer
	br := bufio.NewReader(&server)
	if err := pgAuthenticate(&sent, br, "app", "pw"); err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(sent.Bytes(), []byte("pw\x00")) {
		t.Fatal("password not sent")
	}
	if br.Buffered() == 0 {
		t.Fatal("what followed AuthenticationOk was not left for the relay")
	}

	server.Reset()
	server.Write(msg('E', []byte("SFATAL\x00C28P01\x00Mpassword authentication failed for user \"app\"\x00\x00")))
	err := pgAuthenticate(&sent, bufio.NewReader(&server), "app", "pw")
	pe, ok := err.(*pgError)
	if !ok || pe.Code != "28P01" || !strings.Contains(pe.Message, "password authentication failed") {
		t.Fatalf("got %v", err)
	}
}

func TestAuthenticateRefusesUnknownMethod(t *testing.T) {
	var server bytes.Buffer
	body := binary.BigEndian.AppendUint32(nil, 7) // GSSAPI
	server.Write(append([]byte{'R'}, binary.BigEndian.AppendUint32(nil, uint32(len(body)+4))...))
	server.Write(body)
	if err := pgAuthenticate(&bytes.Buffer{}, bufio.NewReader(&server), "u", "p"); err == nil || !strings.Contains(err.Error(), "does not support") {
		t.Fatalf("got %v", err)
	}
}
