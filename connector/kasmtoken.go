package main

import (
	"net/http"
	"os"
	"strings"
)

// kasmTokenFile is the isolated-browser control service's shared secret, on a
// volume the broker writes (kasm-browser/entrypoint.sh) and this container
// mounts read-only. It is re-read on every dial, so a broker that generated it
// after this connector started is picked up at the next reconnect.
var kasmTokenFile = envOr("KASM_TOKEN_FILE", "/kasmsecret/token")

// kasmTokenHeader adds the token to the tunnel handshake. The data-plane keeps
// it in memory for this connection only and presents it on every call it
// relays to the broker; it is not stored centrally. No file, no header: an
// older broker without a token accepts calls without one.
func kasmTokenHeader(h http.Header) http.Header {
	b, err := os.ReadFile(kasmTokenFile)
	if err != nil {
		return h
	}
	if t := strings.TrimSpace(string(b)); t != "" && len(t) <= 256 {
		h.Set("X-Kasm-Control-Token", t)
	}
	return h
}
