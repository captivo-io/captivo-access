package main

import (
	"context"
	"math"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/hashicorp/yamux"
	"github.com/kurtserdar/captivo-access/tunnel"
)

// maxBackoff caps the reconnect delay after repeated dial failures.
const maxBackoff = 30 * time.Second

// minSessionLife is how long a session must have lasted for its end to be
// treated as a "successful run" that resets the backoff counter. A session
// that connects and dies again immediately (e.g. the data-plane accepting
// the WSS upgrade but then rejecting/dropping it) is treated the same as a
// dial failure for backoff purposes, so it doesn't busy-loop the relay.
const minSessionLife = 5 * time.Second

// runClient keeps a tunnel session to the data-plane alive for the life of
// the process, reconnecting with exponential backoff (capped at
// maxBackoff) whenever the session drops or fails to establish. Every
// iteration sleeps at least 1s before redialing, even on the "healthy
// reconnect" path, so a session that keeps dying right after the backoff
// window can never spin with zero delay.
func runClient(dataplaneURL, token string, allow *TargetMatcher, store *recStore) {
	attempt := 0
	for {
		start := time.Now()
		err := connectOnce(dataplaneURL, token, allow, store)
		lasted := time.Since(start)

		if err != nil || lasted < minSessionLife {
			if err != nil {
				logWarn("tunnel error: %v", err)
			} else {
				logWarn("tunnel session lasted only %s, treating as failure", lasted)
			}
			if attempt < 6 {
				attempt++
			}
		} else {
			attempt = 0
		}

		backoff := time.Duration(math.Min(float64(maxBackoff), math.Pow(2, float64(attempt))*float64(time.Second)))
		if backoff < time.Second {
			backoff = time.Second
		}
		logInfo("reconnecting in %s", backoff)
		time.Sleep(backoff)
	}
}

// connectOnce dials the data-plane's /tunnel WSS endpoint, establishes a
// yamux client session over it, and serves incoming streams until the
// session dies. It returns once the session ends (error or clean close).
func connectOnce(dataplaneURL, token string, allow *TargetMatcher, store *recStore) error {
	ctx := context.Background()
	c, _, err := websocket.Dial(ctx, dataplaneURL+"/tunnel", &websocket.DialOptions{
		HTTPHeader: http.Header{
			"Authorization":       {"Bearer " + token},
			"X-Connector-Version": {Version},
		},
	})
	if err != nil {
		return err
	}

	netConn := websocket.NetConn(ctx, c, websocket.MessageBinary)
	mux, err := yamux.Client(netConn, tunnel.SessionConfig())
	if err != nil {
		c.Close(websocket.StatusInternalError, "yamux setup failed")
		return err
	}

	logInfo("tunnel established to %s", dataplaneURL)
	serveStreams(mux, allow, store) // blocks until the session dies
	return mux.Close()
}
