package main

import (
	"bufio"
	"crypto/hmac"
	"crypto/md5" // #nosec G501 -- PostgreSQL's md5 password method, when the server asks for it
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// Database access (Kind "db"): the connector signs in to the resource's
// PostgreSQL server with the saved password and hands the data plane a
// connection that is already past authentication. The user's client never
// sees the password, and neither does the control plane: it opens here only,
// for the target it was sealed for.
//
// Everything after AuthenticationOk is relayed raw. The data plane reads the
// messages to log the queries (dataplane/pgproxy.go); this side parses only the
// startup and the sign-in.

const (
	pgProtocol30     = 196608 // 3.0
	pgSSLRequestCode = 80877103
	pgCancelCode     = 80877102
	dbSignInLimit    = 20 * time.Second
	pgMaxMessage     = 1 << 20 // a sign-in message is small; anything bigger is not PostgreSQL
	scramMaxIter     = 1 << 20
)

// Startup parameters a client may pass through. Anything else (user, database,
// replication, options, protocol extensions) is decided here, not by the client.
var pgClientParams = map[string]bool{
	"application_name": true, "client_encoding": true, "DateStyle": true, "TimeZone": true,
	"extra_float_digits": true, "IntervalStyle": true, "search_path": true, "statement_timeout": true,
	"lock_timeout": true, "idle_in_transaction_session_timeout": true, "default_transaction_read_only": true,
	"standard_conforming_strings": true, "datestyle": true, "timezone": true, "intervalstyle": true,
}

func handleDb(st io.ReadWriteCloser, allow *TargetMatcher, reqBytes []byte) {
	var req tunnel.DbDialRequest
	if json.Unmarshal(reqBytes, &req) != nil {
		writeDbErr(st, "bad request", "")
		return
	}
	addr := net.JoinHostPort(req.Host, req.Port)
	if req.Engine != "postgres" {
		writeDbErr(st, "this connector does not support the "+req.Engine+" engine", "")
		return
	}
	if !egressAllowed(allow, addr) {
		denied()
		logDenied("db", addr)
		writeDbErr(st, "target not allowed", "")
		return
	}
	password, err := openSealed(vaultKey, req.Sealed, vaultTargetAAD(req.Host, req.Port, req.Username))
	if err != nil {
		writeDbErr(st, "the saved password does not open on this connector; enter it again", "")
		return
	}
	conn, br, encrypted, perr := pgSignIn(req, password)
	if perr != nil {
		var pe *pgError
		if errors.As(perr, &pe) {
			writeDbErr(st, pe.Message, pe.Code)
		} else {
			logUpstreamErr("db", addr, perr.Error())
			writeDbErr(st, perr.Error(), "")
		}
		return
	}
	defer conn.Close()
	b, _ := json.Marshal(tunnel.DbDialResponse{TLS: encrypted})
	if tunnel.WriteFrame(st, b) != nil {
		return
	}
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(st, br); done <- struct{}{} }()   // server -> tunnel (buffered bytes first)
	go func() { _, _ = io.Copy(conn, st); done <- struct{}{} }() // tunnel -> server
	<-done
}

// handleDbCancel sends a cancel request for a running query. PostgreSQL takes
// it on a new connection and answers nothing.
func handleDbCancel(st io.ReadWriteCloser, allow *TargetMatcher, reqBytes []byte) {
	var req tunnel.DbCancelRequest
	if json.Unmarshal(reqBytes, &req) != nil {
		return
	}
	addr := net.JoinHostPort(req.Host, req.Port)
	if !egressAllowed(allow, addr) {
		denied()
		logDenied("db-cancel", addr)
		return
	}
	conn, _, err := pgDial(req.Host, req.Port, req.TLS, req.CACertPEM)
	if err != nil {
		logUpstreamErr("db-cancel", addr, err.Error())
		return
	}
	defer conn.Close()
	msg := make([]byte, 16)
	binary.BigEndian.PutUint32(msg[0:], 16)
	binary.BigEndian.PutUint32(msg[4:], pgCancelCode)
	binary.BigEndian.PutUint32(msg[8:], req.PID)
	binary.BigEndian.PutUint32(msg[12:], req.Secret)
	_, _ = conn.Write(msg)
	// The server closes the connection once it has read the request.
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, _ = io.Copy(io.Discard, conn)
}

func writeDbErr(st io.Writer, msg, code string) {
	b, _ := json.Marshal(tunnel.DbDialResponse{Error: msg, Code: code})
	_ = tunnel.WriteFrame(st, b)
}

// pgError is the server's ErrorResponse during the sign-in.
type pgError struct {
	Code, Message string
}

func (e *pgError) Error() string { return e.Message }

// pgDial connects and, unless tlsMode is "disable", asks for TLS first.
func pgDial(host, port, tlsMode, caPEM string) (net.Conn, bool, error) {
	addr := net.JoinHostPort(host, port)
	raw, err := net.DialTimeout("tcp", addr, 10*time.Second)
	if err != nil {
		return nil, false, errors.New("the database server can't be reached from the connector")
	}
	if tlsMode == "disable" || tlsMode == "" {
		return raw, false, nil
	}
	_ = raw.SetDeadline(time.Now().Add(dbSignInLimit))
	req := make([]byte, 8)
	binary.BigEndian.PutUint32(req[0:], 8)
	binary.BigEndian.PutUint32(req[4:], pgSSLRequestCode)
	if _, err := raw.Write(req); err != nil {
		raw.Close()
		return nil, false, errors.New("the database server closed the connection")
	}
	var ans [1]byte
	if _, err := io.ReadFull(raw, ans[:]); err != nil {
		raw.Close()
		return nil, false, errors.New("the database server closed the connection")
	}
	if ans[0] != 'S' {
		raw.Close()
		return nil, false, errors.New("the database server does not accept TLS; set the resource's TLS to Off, or turn on ssl on the server")
	}
	cfg := &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12}
	if tlsMode == "verify-full" {
		if strings.TrimSpace(caPEM) != "" {
			pool := x509.NewCertPool()
			if !pool.AppendCertsFromPEM([]byte(caPEM)) {
				raw.Close()
				return nil, false, errors.New("the resource's CA certificate does not parse")
			}
			cfg.RootCAs = pool
		}
	} else {
		cfg.InsecureSkipVerify = true // #nosec G402 -- "require": encrypted, the admin chose not to verify the certificate
	}
	tc := tls.Client(raw, cfg)
	if err := tc.Handshake(); err != nil {
		raw.Close()
		return nil, false, fmt.Errorf("TLS to the database server failed: %v", err)
	}
	_ = raw.SetDeadline(time.Time{})
	return tc, true, nil
}

// pgSignIn opens the connection and signs in. On success the reader holds
// whatever the server sent after AuthenticationOk.
func pgSignIn(req tunnel.DbDialRequest, password string) (net.Conn, *bufio.Reader, bool, error) {
	conn, encrypted, err := pgDial(req.Host, req.Port, req.TLS, req.CACertPEM)
	if err != nil {
		return nil, nil, false, err
	}
	_ = conn.SetDeadline(time.Now().Add(dbSignInLimit))
	br := bufio.NewReader(conn)
	if _, err := conn.Write(pgStartup(req)); err != nil {
		conn.Close()
		return nil, nil, false, errors.New("the database server closed the connection")
	}
	if err := pgAuthenticate(conn, br, req.Username, password); err != nil {
		conn.Close()
		return nil, nil, false, err
	}
	_ = conn.SetDeadline(time.Time{})
	return conn, br, encrypted, nil
}

func pgStartup(req tunnel.DbDialRequest) []byte {
	var body []byte
	body = binary.BigEndian.AppendUint32(body, pgProtocol30)
	add := func(k, v string) {
		body = append(body, k...)
		body = append(body, 0)
		body = append(body, v...)
		body = append(body, 0)
	}
	add("user", req.Username)
	if req.Database != "" {
		add("database", req.Database)
	}
	for k, v := range req.Params {
		if pgClientParams[k] && !strings.ContainsRune(v, 0) {
			add(k, v)
		}
	}
	body = append(body, 0)
	out := binary.BigEndian.AppendUint32(nil, uint32(len(body)+4))
	return append(out, body...)
}

// pgRead reads one backend message.
func pgRead(br *bufio.Reader) (byte, []byte, error) {
	t, err := br.ReadByte()
	if err != nil {
		return 0, nil, err
	}
	var l [4]byte
	if _, err := io.ReadFull(br, l[:]); err != nil {
		return 0, nil, err
	}
	n := int(binary.BigEndian.Uint32(l[:]))
	if n < 4 || n > pgMaxMessage {
		return 0, nil, errors.New("not a PostgreSQL server")
	}
	body := make([]byte, n-4)
	if _, err := io.ReadFull(br, body); err != nil {
		return 0, nil, err
	}
	return t, body, nil
}

func pgSend(w io.Writer, t byte, body []byte) error {
	msg := append([]byte{t}, binary.BigEndian.AppendUint32(nil, uint32(len(body)+4))...)
	_, err := w.Write(append(msg, body...))
	return err
}

// parsePgError reads an ErrorResponse's code and message.
func parsePgError(body []byte) *pgError {
	e := &pgError{Message: "the database server refused the sign-in"}
	for len(body) > 1 {
		f := body[0]
		i := 1
		for i < len(body) && body[i] != 0 {
			i++
		}
		v := string(body[1:i])
		switch f {
		case 'C':
			e.Code = v
		case 'M':
			e.Message = v
		}
		if i >= len(body) {
			break
		}
		body = body[i+1:]
	}
	return e
}

func pgAuthenticate(w io.Writer, br *bufio.Reader, user, password string) error {
	var scram *scramClient
	for {
		t, body, err := pgRead(br)
		if err != nil {
			return errors.New("the database server closed the connection during the sign-in")
		}
		switch t {
		case 'E':
			return parsePgError(body)
		case 'N':
			continue // a notice
		case 'R':
		default:
			return fmt.Errorf("unexpected message %q from the database server during the sign-in", t)
		}
		if len(body) < 4 {
			return errors.New("not a PostgreSQL server")
		}
		code, rest := binary.BigEndian.Uint32(body), body[4:]
		switch code {
		case 0: // AuthenticationOk
			if scram != nil && !scram.verified {
				return errors.New("the database server did not prove it knows the password")
			}
			return nil
		case 3: // cleartext
			if err := pgSend(w, 'p', append([]byte(password), 0)); err != nil {
				return err
			}
		case 5: // MD5
			if len(rest) < 4 {
				return errors.New("not a PostgreSQL server")
			}
			if err := pgSend(w, 'p', append([]byte(pgMD5(user, password, rest[:4])), 0)); err != nil {
				return err
			}
		case 10: // SASL
			if !hasMechanism(rest, "SCRAM-SHA-256") {
				return errors.New("the database server offers no sign-in method the connector supports (SCRAM-SHA-256, md5 or password)")
			}
			scram = newScramClient(password)
			first := scram.clientFirst()
			msg := append([]byte("SCRAM-SHA-256"), 0)
			msg = binary.BigEndian.AppendUint32(msg, uint32(len(first)))
			if err := pgSend(w, 'p', append(msg, first...)); err != nil {
				return err
			}
		case 11: // SASLContinue
			if scram == nil {
				return errors.New("not a PostgreSQL server")
			}
			final, err := scram.clientFinal(string(rest))
			if err != nil {
				return err
			}
			if err := pgSend(w, 'p', []byte(final)); err != nil {
				return err
			}
		case 12: // SASLFinal
			if scram == nil || scram.verify(string(rest)) != nil {
				return errors.New("the database server did not prove it knows the password")
			}
		default:
			return fmt.Errorf("the database server asks for a sign-in method the connector does not support (%d); use scram-sha-256 or md5 in pg_hba.conf", code)
		}
	}
}

func hasMechanism(list []byte, want string) bool {
	for _, m := range strings.Split(string(list), "\x00") {
		if m == want {
			return true
		}
	}
	return false
}

func pgMD5(user, password string, salt []byte) string {
	inner := md5.Sum([]byte(password + user)) // #nosec G401 -- the protocol's own construction
	h := md5.New()                             // #nosec G401
	h.Write([]byte(hex.EncodeToString(inner[:])))
	h.Write(salt)
	return "md5" + hex.EncodeToString(h.Sum(nil))
}

// scramClient is the client side of SCRAM-SHA-256 (RFC 5802/7677) as
// PostgreSQL uses it: no channel binding, and an empty user name (the server
// takes the one from the startup message).
type scramClient struct {
	password, nonce, clientFirstBare, authMessage string
	serverKey                                     []byte
	verified                                      bool
}

func newScramClient(password string) *scramClient {
	b := make([]byte, 18)
	_, _ = rand.Read(b)
	return &scramClient{password: password, nonce: base64.StdEncoding.EncodeToString(b)}
}

func (s *scramClient) clientFirst() string {
	s.clientFirstBare = "n=,r=" + s.nonce
	return "n,," + s.clientFirstBare
}

func (s *scramClient) clientFinal(serverFirst string) (string, error) {
	var nonce, salt64, iters string
	for _, part := range strings.Split(serverFirst, ",") {
		if len(part) < 2 || part[1] != '=' {
			continue
		}
		switch part[0] {
		case 'r':
			nonce = part[2:]
		case 's':
			salt64 = part[2:]
		case 'i':
			iters = part[2:]
		}
	}
	salt, err := base64.StdEncoding.DecodeString(salt64)
	n, nerr := strconv.Atoi(iters)
	if !strings.HasPrefix(nonce, s.nonce) || len(nonce) == len(s.nonce) || err != nil || nerr != nil || n < 1 || n > scramMaxIter {
		return "", errors.New("the database server's SCRAM challenge is not valid")
	}
	salted, err := pbkdf2.Key(sha256.New, s.password, salt, n, 32)
	if err != nil {
		return "", err
	}
	clientKey := hmacSHA256(salted, "Client Key")
	stored := sha256.Sum256(clientKey)
	withoutProof := "c=biws,r=" + nonce
	s.authMessage = s.clientFirstBare + "," + serverFirst + "," + withoutProof
	sig := hmacSHA256(stored[:], s.authMessage)
	proof := make([]byte, len(clientKey))
	for i := range clientKey {
		proof[i] = clientKey[i] ^ sig[i]
	}
	s.serverKey = hmacSHA256(salted, "Server Key")
	return withoutProof + ",p=" + base64.StdEncoding.EncodeToString(proof), nil
}

func (s *scramClient) verify(serverFinal string) error {
	if !strings.HasPrefix(serverFinal, "v=") {
		return errors.New("no server signature")
	}
	got, err := base64.StdEncoding.DecodeString(strings.TrimSpace(serverFinal[2:]))
	if err != nil {
		return err
	}
	if !hmac.Equal(got, hmacSHA256(s.serverKey, s.authMessage)) {
		return errors.New("server signature mismatch")
	}
	s.verified = true
	return nil
}

func hmacSHA256(key []byte, msg string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(msg))
	return m.Sum(nil)
}
