package main

import (
	"bufio"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// The connector's vault key. Resource passwords and private keys are sealed in
// the admin's browser to this key's public half; the control plane stores and
// forwards only the sealed form and cannot open it. The private half never
// leaves this host. Losing it (the /data volume) means re-entering those
// secrets -- by design there is no copy anywhere else.
//
// Sealed format (src/lib/vault/seal.ts writes it):
//
//	"cv1:" + base64(ephemeral X25519 public (32) | nonce (12) | AES-256-GCM ciphertext+tag)
//
// key = HKDF-SHA256(X25519(eph, recipient), salt = eph pub | recipient pub,
// info = "captivo-access vault v1"); the additional data is the target the
// secret was entered for, as the Guacamole instruction
// "target,<hostname>,<port>,<username>;" -- and the connector takes those
// values from the connect instruction actually going to guacd. So a secret
// only ever opens for the host, port and user it was entered for: whoever runs
// the cloud cannot point it at another machine.
const (
	vaultSealPrefix = "cv1:"
	vaultHKDFInfo   = "captivo-access vault v1"
)

var vaultKey *ecdh.PrivateKey // set in main; nil = sealed secrets are refused

// loadOrCreateVaultKey returns the connector's X25519 vault key, generating it
// on first use. Like the recording key, a malformed file is an error rather than
// something to replace: replacing it would silently orphan every sealed secret.
func loadOrCreateVaultKey(path string) (*ecdh.PrivateKey, error) {
	b, err := os.ReadFile(path)
	if err == nil {
		k, kerr := ecdh.X25519().NewPrivateKey(b)
		if kerr != nil {
			return nil, fmt.Errorf("vault key %s is malformed (%v): refusing to replace it (sealed secrets would become unreadable)", path, kerr)
		}
		return k, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	k, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, k.Bytes(), 0o600); err != nil {
		return nil, err
	}
	return k, nil
}

func vaultPublicKeyB64(k *ecdh.PrivateKey) string {
	if k == nil {
		return ""
	}
	return base64.StdEncoding.EncodeToString(k.PublicKey().Bytes())
}

// hkdfSHA256 is RFC 5869 for one 32-byte output block (Go 1.23 has no crypto/hkdf).
func hkdfSHA256(secret, salt, info []byte) []byte {
	ext := hmac.New(sha256.New, salt)
	ext.Write(secret)
	prk := ext.Sum(nil)
	exp := hmac.New(sha256.New, prk)
	exp.Write(info)
	exp.Write([]byte{1})
	return exp.Sum(nil)
}

func vaultTargetAAD(host, port, username string) []byte {
	return encodeGuacInstruction([]string{"target", host, port, username})
}

// vaultReconcileAAD binds a reconcile account's secret: a different first
// element than vaultTargetAAD, so the gateway (which opens only "target")
// can never sign a session in with it.
func vaultReconcileAAD(host, port, username string) []byte {
	return encodeGuacInstruction([]string{"reconcile", host, port, username})
}

// openSealed opens a sealed secret addressed to k for the given target.
func openSealed(k *ecdh.PrivateKey, sealed string, aad []byte) (string, error) {
	if k == nil {
		return "", errors.New("no vault key")
	}
	if !strings.HasPrefix(sealed, vaultSealPrefix) {
		return "", errors.New("not a sealed secret")
	}
	raw, err := base64.StdEncoding.DecodeString(sealed[len(vaultSealPrefix):])
	if err != nil || len(raw) < 32+12+16 {
		return "", errors.New("malformed sealed secret")
	}
	ephPub, nonce, ct := raw[:32], raw[32:44], raw[44:]
	eph, err := ecdh.X25519().NewPublicKey(ephPub)
	if err != nil {
		return "", err
	}
	shared, err := k.ECDH(eph)
	if err != nil {
		return "", err
	}
	salt := append(append([]byte{}, ephPub...), k.PublicKey().Bytes()...)
	block, err := aes.NewCipher(hkdfSHA256(shared, salt, []byte(vaultHKDFInfo)))
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	pt, err := gcm.Open(nil, nonce, ct, aad)
	if err != nil {
		return "", errors.New("sealed secret does not open with this connector's key for this target")
	}
	return string(pt), nil
}

// Guacamole instruction elements are "<length>.<value>" with the length in
// Unicode code points, separated by ',' and ended by ';'.
const maxGuacElement = 1 << 20

func readGuacInstruction(r *bufio.Reader) ([]string, error) {
	var elems []string
	for {
		var num strings.Builder
		for {
			c, err := r.ReadByte()
			if err != nil {
				return nil, err
			}
			if c == '.' {
				break
			}
			if c < '0' || c > '9' || num.Len() > 7 {
				return nil, errors.New("bad guacamole length")
			}
			num.WriteByte(c)
		}
		n, err := strconv.Atoi(num.String())
		if err != nil || n > maxGuacElement {
			return nil, errors.New("bad guacamole length")
		}
		var v strings.Builder
		for i := 0; i < n; i++ {
			ch, _, err := r.ReadRune()
			if err != nil {
				return nil, err
			}
			v.WriteRune(ch)
		}
		elems = append(elems, v.String())
		end, err := r.ReadByte()
		if err != nil {
			return nil, err
		}
		if end == ';' {
			return elems, nil
		}
		if end != ',' {
			return nil, errors.New("bad guacamole separator")
		}
	}
}

func encodeGuacInstruction(elems []string) []byte {
	var b strings.Builder
	for i, e := range elems {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(strconv.Itoa(utf8.RuneCountInString(e)))
		b.WriteByte('.')
		b.WriteString(e)
	}
	b.WriteByte(';')
	return []byte(b.String())
}

// sealedRelay carries one guacd handshake whose secret is sealed. guacd's
// first instruction ("args") names the connect values in order; the connect
// instruction from the data-plane is checked against it: the secret opens only
// for the hostname, port and username in that instruction, and replaces the
// placeholder only in the password / private-key value.
type sealedRelay struct {
	key         *ecdh.PrivateKey
	sealed      string
	placeholder string
	args        chan []string
}

func newSealedRelay(key *ecdh.PrivateKey, sealed, placeholder string) *sealedRelay {
	return &sealedRelay{key: key, sealed: sealed, placeholder: placeholder, args: make(chan []string, 1)}
}

// fromGuacd relays guacd -> data-plane, noting the args list on the way.
func (s *sealedRelay) fromGuacd(dst io.Writer, src io.Reader) error {
	br := bufio.NewReader(src)
	elems, err := readGuacInstruction(br)
	if err != nil {
		close(s.args)
		return err
	}
	if len(elems) > 0 && elems[0] == "args" {
		s.args <- elems[1:]
	}
	close(s.args)
	if _, err := dst.Write(encodeGuacInstruction(elems)); err != nil {
		return err
	}
	_, err = io.Copy(dst, br)
	return err
}

// toGuacd relays data-plane -> guacd, opening the secret into "connect".
func (s *sealedRelay) toGuacd(dst io.Writer, src io.Reader) error {
	br := bufio.NewReader(src)
	for {
		elems, err := readGuacInstruction(br)
		if err != nil {
			return err
		}
		if len(elems) > 0 && elems[0] == "connect" {
			out, err := s.fillConnect(elems)
			if err != nil {
				return err // nothing reaches guacd; the handshake fails closed
			}
			if _, err := dst.Write(encodeGuacInstruction(out)); err != nil {
				return err
			}
			break
		}
		if _, err := dst.Write(encodeGuacInstruction(elems)); err != nil {
			return err
		}
	}
	_, err := io.Copy(dst, br) // includes whatever the reader already buffered
	return err
}

func (s *sealedRelay) fillConnect(elems []string) ([]string, error) {
	var names []string
	select {
	case names = <-s.args:
	case <-time.After(30 * time.Second):
	}
	vals := elems[1:]
	if names == nil || len(names) != len(vals) {
		return nil, errors.New("vault: connect does not match guacd's args")
	}
	byName := map[string]int{}
	for i, n := range names {
		byName[n] = i
	}
	get := func(n string) string {
		if i, ok := byName[n]; ok {
			return vals[i]
		}
		return ""
	}
	secret, err := openSealed(s.key, s.sealed, vaultTargetAAD(get("hostname"), get("port"), get("username")))
	if err != nil {
		return nil, err
	}
	out := append([]string{}, elems...)
	placed := false
	for _, n := range []string{"password", "private-key"} {
		if i, ok := byName[n]; ok && vals[i] == s.placeholder {
			out[1+i] = secret
			placed = true
		}
	}
	if !placed {
		return nil, errors.New("vault: no placeholder in password or private-key")
	}
	return out, nil
}
