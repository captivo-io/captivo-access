package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"

	"github.com/kurtserdar/captivo-access/tunnel"
)

// Copying saved secrets to the other members of a connector group. A secret
// saved before a connector joined its group is sealed only to the members of
// that time; the control plane asks a member that can open it to seal it again
// to the newcomer's key. The connector opens each one with its own key and
// seals it for the SAME target (the additional data is reused, never taken
// from the request), so a copy only ever opens for the host, port and user it
// was entered for. The plaintext never leaves this process.
const (
	maxResealItems = 2000
	maxResealTo    = 16
)

// sealToKey is src/lib/vault/seal.ts's sealSecret: the format openSealed reads.
func sealToKey(pubB64, secret string, aad []byte) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(pubB64)
	if err != nil || len(raw) != 32 {
		return "", errors.New("bad recipient key")
	}
	pub, err := ecdh.X25519().NewPublicKey(raw)
	if err != nil {
		return "", err
	}
	eph, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return "", err
	}
	shared, err := eph.ECDH(pub)
	if err != nil {
		return "", err
	}
	salt := append(append([]byte{}, eph.PublicKey().Bytes()...), raw...)
	block, err := aes.NewCipher(hkdfSHA256(shared, salt, []byte(vaultHKDFInfo)))
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, 12)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	out := append(append(eph.PublicKey().Bytes(), nonce...), gcm.Seal(nil, nonce, []byte(secret), aad)...)
	return vaultSealPrefix + base64.StdEncoding.EncodeToString(out), nil
}

func reseal(k *ecdh.PrivateKey, req tunnel.ResealRequest) tunnel.ResealResponse {
	if k == nil {
		return tunnel.ResealResponse{Error: "no vault key"}
	}
	if len(req.Items) > maxResealItems {
		return tunnel.ResealResponse{Error: "too many items"}
	}
	own := vaultPublicKeyB64(k)
	out := tunnel.ResealResponse{Items: make([]tunnel.ResealResult, 0, len(req.Items))}
	for _, it := range req.Items {
		res := tunnel.ResealResult{ID: it.ID}
		if len(it.To) == 0 || len(it.To) > maxResealTo {
			res.Error = "bad recipients"
			out.Items = append(out.Items, res)
			continue
		}
		aad := vaultTargetAAD(it.Host, it.Port, it.Username)
		if it.Purpose == "reconcile" {
			aad = vaultReconcileAAD(it.Host, it.Port, it.Username)
		} else if it.Purpose != "" {
			res.Error = "unknown purpose"
			out.Items = append(out.Items, res)
			continue
		}
		plain, err := openSealed(k, it.Sealed, aad)
		if err != nil {
			res.Error = "does not open"
			out.Items = append(out.Items, res)
			continue
		}
		seals := map[string]string{}
		for _, to := range it.To {
			if to == own {
				continue // it already has its own copy
			}
			s, err := sealToKey(to, plain, aad)
			if err != nil {
				res.Error = "bad recipient key"
				seals = nil
				break
			}
			seals[to] = s
		}
		res.Seals = seals
		out.Items = append(out.Items, res)
	}
	return out
}

// handleReseal answers one reseal stream.
func handleReseal(st io.ReadWriter, reqBytes []byte) {
	var req tunnel.ResealRequest
	var resp tunnel.ResealResponse
	if err := json.Unmarshal(reqBytes, &req); err != nil {
		resp = tunnel.ResealResponse{Error: "bad request"}
	} else {
		resp = reseal(vaultKey, req)
		copied, keys := 0, map[string]bool{}
		for _, r := range resp.Items {
			if len(r.Seals) > 0 {
				copied++
			}
			for k := range r.Seals {
				keys[k] = true
			}
		}
		// The customer's own record of it, next to the console's audit row.
		logInfo("vault: copied %d saved secret(s) to %d other connector key(s) of this connector's group", copied, len(keys))
	}
	b, _ := json.Marshal(resp)
	_ = tunnel.WriteFrame(st, b)
}
