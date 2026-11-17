package main

import (
	"fmt"
	"io"
	"sync/atomic"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
)

var startTime = time.Now()

var (
	statActive   int64
	statTotal    int64
	statDenied   int64
	statBytesIn  int64 // upstream -> vendor (written to the tunnel stream)
	statBytesOut int64 // vendor -> upstream (read from the tunnel stream)
)

func connOpen()  { atomic.AddInt64(&statActive, 1); atomic.AddInt64(&statTotal, 1) }
func connClose() { atomic.AddInt64(&statActive, -1) }
func denied()    { atomic.AddInt64(&statDenied, 1) }

func snapshot() tunnel.Telemetry {
	return tunnel.Telemetry{
		Version:           Version,
		UptimeSec:         int64(time.Since(startTime).Seconds()),
		ActiveConnections: int(atomic.LoadInt64(&statActive)),
		TotalConnections:  atomic.LoadInt64(&statTotal),
		DeniedCount:       atomic.LoadInt64(&statDenied),
		BytesIn:           atomic.LoadInt64(&statBytesIn),
		BytesOut:          atomic.LoadInt64(&statBytesOut),
		RecentLogs:        logRingBuf.tail(80),
		GuacdLogs:         guacdLogRing.tail(80),
		KasmLogs:          kasmLogRing.tail(80),
		Hostname:          host.hostname,
		OS:                host.os,
		LocalIP:           host.localIP,
	}
}

// logHeartbeat emits a periodic INFO activity summary so the recent-log tail
// carries an operational pulse without per-request spam. It stays silent during
// an idle window (no new requests since the last tick) to avoid noise on a calm
// connector.
func logHeartbeat() {
	tick := time.NewTicker(5 * time.Minute)
	defer tick.Stop()
	var lastTotal int64
	for range tick.C {
		total := atomic.LoadInt64(&statTotal)
		if total == lastTotal {
			continue
		}
		logInfo("activity: %d requests total (+%d since last), %d active, %d denied, in %s out %s",
			total, total-lastTotal,
			atomic.LoadInt64(&statActive), atomic.LoadInt64(&statDenied),
			humanBytes(atomic.LoadInt64(&statBytesIn)), humanBytes(atomic.LoadInt64(&statBytesOut)))
		lastTotal = total
	}
}

func humanBytes(b int64) string {
	switch {
	case b >= 1<<30:
		return fmt.Sprintf("%.1fGB", float64(b)/(1<<30))
	case b >= 1<<20:
		return fmt.Sprintf("%.1fMB", float64(b)/(1<<20))
	case b >= 1<<10:
		return fmt.Sprintf("%.1fKB", float64(b)/(1<<10))
	default:
		return fmt.Sprintf("%dB", b)
	}
}

// countingStream wraps a relay stream to tally bytes uniformly across all relay
// kinds. Writes to the stream carry upstream -> vendor data (BytesIn); reads
// carry vendor -> upstream data (BytesOut).
type countingStream struct{ io.ReadWriteCloser }

func (c *countingStream) Read(p []byte) (int, error) {
	n, err := c.ReadWriteCloser.Read(p)
	atomic.AddInt64(&statBytesOut, int64(n))
	return n, err
}
func (c *countingStream) Write(p []byte) (int, error) {
	n, err := c.ReadWriteCloser.Write(p)
	atomic.AddInt64(&statBytesIn, int64(n))
	return n, err
}
