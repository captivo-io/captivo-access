package main

import (
	"bufio"
	"crypto/hmac"
	"crypto/md5" // #nosec G501 -- SCRAM-SHA-1's password digest, when the server only offers that
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha1" // #nosec G505 -- SCRAM-SHA-1, when the server only offers that
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// A MongoDB server for a database resource: the connector signs in with the
// saved account (SCRAM-SHA-256, or SCRAM-SHA-1 on a server that only has it)
// and hands the data plane a connection that is past authentication; OP_MSG
// follows, relayed raw. The resource's "database" is the account's
// authentication database (admin when empty). "disable" is a plain
// connection; "require" and "verify-full" speak TLS from the first byte.

// mongoError is a refusal by the server during the sign-in.
type mongoError struct {
	msg  string
	code string
}

func (e *mongoError) Error() string { return e.msg }

type mongoConn struct {
	conn net.Conn
	r    *bufio.Reader
	id   int32
}

// command sends one OP_MSG command and reads the server's one answer.
func (m *mongoConn) command(doc []byte) ([]byte, error) {
	m.id++
	if _, err := m.conn.Write(tunnel.MongoMsg(m.id, 0, 0, doc)); err != nil {
		return nil, errors.New("the database server closed the connection")
	}
	h, err := tunnel.ReadMongoHeader(m.r)
	if err != nil {
		return nil, errors.New("the database server did not answer as MongoDB: is this a MongoDB port?")
	}
	if h.OpCode != tunnel.MongoOpMsg || h.Len > 16<<20 {
		return nil, errors.New("the database server did not answer as MongoDB: is this a MongoDB port?")
	}
	b := make([]byte, int(h.Len)-16)
	if _, err := io.ReadFull(m.r, b); err != nil {
		return nil, errors.New("the database server closed the connection")
	}
	body, _, err := tunnel.MongoMsgBody(b)
	if err != nil {
		return nil, errors.New("the database server did not answer as MongoDB: is this a MongoDB port?")
	}
	if typ, v, ok := tunnel.BSONGet(body, "ok"); !ok {
		return nil, errors.New("the database server's answer has no ok field")
	} else if n, _ := tunnel.BSONInt(typ, v); n == 0 {
		msg := "the database server refused the command"
		if t, v, ok := tunnel.BSONGet(body, "errmsg"); ok && t == tunnel.BSONString {
			msg, _ = tunnel.BSONStringValue(v)
		}
		code := ""
		if t, v, ok := tunnel.BSONGet(body, "code"); ok {
			if n, ok := tunnel.BSONInt(t, v); ok {
				code = strconv.FormatInt(n, 10)
			}
		}
		return nil, &mongoError{msg: msg, code: code}
	}
	return body, nil
}

// mongoSCRAM runs the SASL conversation.
func (m *mongoConn) scram(mech, authDB, user, password string) error {
	var h func() hash.Hash
	keyLen := 32
	if mech == "SCRAM-SHA-1" {
		h, keyLen = sha1.New, 20
		sum := md5.Sum([]byte(user + ":mongo:" + password)) // #nosec G401 -- the mechanism's own construction
		password = hex.EncodeToString(sum[:])
	} else {
		h = sha256.New
	}
	nb := make([]byte, 18)
	_, _ = rand.Read(nb)
	nonce := base64.StdEncoding.EncodeToString(nb)
	escaped := strings.NewReplacer("=", "=3D", ",", "=2C").Replace(user)
	bare := "n=" + escaped + ",r=" + nonce
	start, err := m.command(tunnel.BSONDoc(
		tunnel.BSONInt32Elem("saslStart", 1), tunnel.BSONStr("mechanism", mech),
		tunnel.BSONBin("payload", []byte("n,,"+bare)), tunnel.BSONInt32Elem("autoAuthorize", 1),
		tunnel.BSONSub("options", tunnel.BSONBoolElem("skipEmptyExchange", true)), tunnel.BSONStr("$db", authDB)))
	if err != nil {
		return err
	}
	payload := func(doc []byte) (string, error) {
		t, v, ok := tunnel.BSONGet(doc, "payload")
		if !ok || t != tunnel.BSONBinary {
			return "", errors.New("the database server's SCRAM answer has no payload")
		}
		b, ok := tunnel.BSONBinaryValue(v)
		if !ok {
			return "", errors.New("the database server's SCRAM answer is not valid")
		}
		return string(b), nil
	}
	convID := func(doc []byte) int32 {
		t, v, _ := tunnel.BSONGet(doc, "conversationId")
		n, _ := tunnel.BSONInt(t, v)
		return int32(n)
	}
	serverFirst, err := payload(start)
	if err != nil {
		return err
	}
	var r, salt64, iters string
	for _, part := range strings.Split(serverFirst, ",") {
		if len(part) < 2 || part[1] != '=' {
			continue
		}
		switch part[0] {
		case 'r':
			r = part[2:]
		case 's':
			salt64 = part[2:]
		case 'i':
			iters = part[2:]
		}
	}
	salt, derr := base64.StdEncoding.DecodeString(salt64)
	n, nerr := strconv.Atoi(iters)
	if !strings.HasPrefix(r, nonce) || len(r) == len(nonce) || derr != nil || nerr != nil || n < 1 || n > scramMaxIter {
		return errors.New("the database server's SCRAM challenge is not valid")
	}
	salted, err := pbkdf2.Key(h, password, salt, n, keyLen)
	if err != nil {
		return err
	}
	mac := func(key []byte, msg string) []byte {
		x := hmac.New(h, key)
		x.Write([]byte(msg))
		return x.Sum(nil)
	}
	clientKey := mac(salted, "Client Key")
	hh := h()
	hh.Write(clientKey)
	stored := hh.Sum(nil)
	withoutProof := "c=biws,r=" + r
	authMessage := bare + "," + serverFirst + "," + withoutProof
	sig := mac(stored, authMessage)
	proof := make([]byte, len(clientKey))
	for i := range clientKey {
		proof[i] = clientKey[i] ^ sig[i]
	}
	final := withoutProof + ",p=" + base64.StdEncoding.EncodeToString(proof)
	cont, err := m.command(tunnel.BSONDoc(
		tunnel.BSONInt32Elem("saslContinue", 1), tunnel.BSONInt32Elem("conversationId", convID(start)),
		tunnel.BSONBin("payload", []byte(final)), tunnel.BSONStr("$db", authDB)))
	if err != nil {
		return err
	}
	serverFinal, err := payload(cont)
	if err != nil {
		return err
	}
	want := base64.StdEncoding.EncodeToString(mac(mac(salted, "Server Key"), authMessage))
	if !strings.HasPrefix(serverFinal, "v=") || !hmac.Equal([]byte(strings.TrimSpace(serverFinal[2:])), []byte(want)) {
		return errors.New("the database server's SCRAM signature does not match")
	}
	// Without skipEmptyExchange support the server wants one more, empty, round.
	for done := false; !done; {
		t, v, _ := tunnel.BSONGet(cont, "done")
		done = t == tunnel.BSONBool && len(v) == 1 && v[0] == 1
		if done {
			break
		}
		if cont, err = m.command(tunnel.BSONDoc(
			tunnel.BSONInt32Elem("saslContinue", 1), tunnel.BSONInt32Elem("conversationId", convID(start)),
			tunnel.BSONBin("payload", nil), tunnel.BSONStr("$db", authDB))); err != nil {
			return err
		}
	}
	return nil
}

func mongoSignIn(req tunnel.DbDialRequest, password string) (net.Conn, *bufio.Reader, tunnel.DbDialResponse, error) {
	var resp tunnel.DbDialResponse
	raw, err := net.DialTimeout("tcp", net.JoinHostPort(req.Host, req.Port), 10*time.Second)
	if err != nil {
		return nil, nil, resp, errors.New("the database server can't be reached from the connector")
	}
	fail := func(err error) (net.Conn, *bufio.Reader, tunnel.DbDialResponse, error) {
		raw.Close()
		return nil, nil, resp, err
	}
	_ = raw.SetDeadline(time.Now().Add(dbSignInLimit))
	var conn net.Conn = raw
	if req.TLS != "disable" && req.TLS != "" {
		cfg, err := mssqlTLSConfig(req)
		if err != nil {
			return fail(err)
		}
		tc := tls.Client(raw, cfg)
		if err := tc.Handshake(); err != nil {
			return fail(fmt.Errorf("TLS to the database server failed: %v (set the resource's TLS to Off if the server has no TLS)", err))
		}
		conn, resp.TLS = tc, true
	}
	m := &mongoConn{conn: conn, r: bufio.NewReaderSize(conn, 64<<10)}
	authDB := req.Database
	if authDB == "" {
		authDB = "admin"
	}
	hello, err := m.command(tunnel.BSONDoc(
		tunnel.BSONInt32Elem("hello", 1), tunnel.BSONBoolElem("helloOk", true),
		tunnel.BSONStr("saslSupportedMechs", authDB+"."+req.Username),
		tunnel.BSONSub("client", tunnel.BSONSub("driver", tunnel.BSONStr("name", "captivo-access"), tunnel.BSONStr("version", "1")), tunnel.BSONSub("os", tunnel.BSONStr("type", "Linux"))),
		tunnel.BSONStr("$db", "admin")))
	if err != nil {
		return fail(err)
	}
	mech := "SCRAM-SHA-256"
	if t, v, ok := tunnel.BSONGet(hello, "saslSupportedMechs"); ok && t == tunnel.BSONArray {
		has256, has1 := false, false
		_ = tunnel.BSONEach(v, func(t byte, _ string, v []byte) bool {
			if s, ok := tunnel.BSONStringValue(v); ok && t == tunnel.BSONString {
				has256 = has256 || s == "SCRAM-SHA-256"
				has1 = has1 || s == "SCRAM-SHA-1"
			}
			return true
		})
		if !has256 && has1 {
			mech = "SCRAM-SHA-1"
		}
	}
	if err := m.scram(mech, authDB, req.Username, password); err != nil {
		var me *mongoError
		if errors.As(err, &me) {
			if me.code == "18" {
				return fail(&mongoError{msg: "the saved account was not accepted by the database (authentication failed for " + req.Username + " in " + authDB + ")", code: "18"})
			}
			return fail(me)
		}
		return fail(err)
	}
	// The version is for the console's session note.
	if bi, err := m.command(tunnel.BSONDoc(tunnel.BSONInt32Elem("buildInfo", 1), tunnel.BSONStr("$db", "admin"))); err == nil {
		if t, v, ok := tunnel.BSONGet(bi, "version"); ok && t == tunnel.BSONString {
			resp.ServerVersion, _ = tunnel.BSONStringValue(v)
		}
	}
	_ = conn.SetDeadline(time.Time{})
	return conn, m.r, resp, nil
}
