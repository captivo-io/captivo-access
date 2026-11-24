package main

import (
	"fmt"
	"io"
	"log"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/crypto/ssh"
)

// TCP tunnel resources (lib/gateway/tcp-tunnel.ts). The portal hands out
//
//	ssh -L <local>:<host>:<port> -o ExitOnForwardFailure=yes -p 2222 <ticket>@<console>
//
// and every connection the user's app makes to the local port arrives here
// as a direct-tcpip channel, which goes to the ticket's resource through its
// connector, whatever host and port the command was edited to name. The bytes
// are the app's own protocol, so nothing is recorded: one SSH connection is
// one session in the hub (listed, rechecked every minute, ended by an admin),
// and its close is audited with how long it lasted and how much it carried.

type sshTunnel struct {
	id, host  string // host: the service's host, as the audit names it
	addr      string
	start     time.Time
	conns     atomic.Int64
	down, up  atomic.Int64
	window    ssh.Channel // the terminal the command opened, if any
	windowMu  sync.Mutex
	closeOnce sync.Once
}

// kind names the connection in audit reasons.
func (j *sshJumpConn) kind() string {
	j.tunMu.Lock()
	defer j.tunMu.Unlock()
	return j.via
}

// tunnelSession is this connection's tunnel, started on first use.
func (j *sshJumpConn) tunnelSession(target sshTarget) *sshTunnel {
	j.tunMu.Lock()
	defer j.tunMu.Unlock()
	if j.tunnel != nil {
		return j.tunnel
	}
	t := &sshTunnel{id: newSessionID(), host: target.Host, addr: net.JoinHostPort(target.Host, target.Port), start: j.d.now()}
	j.tunnel, j.via = t, "native_tcp"
	if j.d.hub != nil {
		j.d.hub.RegisterNative(t.id, "tcp", j.tk.SiteID, j.tk.UserID, target.Host, t.start, target.ConnectorID, j.clientIP)
		j.d.hub.clearEnded(j.tk.UserID, j.tk.SiteID)
		j.d.hub.SetCloser(t.id, func() {
			j.closeTunnel("\r\nCaptivo Access: this tunnel was ended (an admin ended it, or your access ended).\r\n")
		})
	}
	j.auditEvent("ALLOW", "session_open native_tcp", target.Host)
	log.Printf("ssh jump: site=%s user=%s tunnel id=%s target=%s", j.tk.SiteID, j.tk.UserID, t.id, t.addr)
	return t
}

// closeTunnel tells the command's window why, then ends the SSH connection
// and with it every connection through the tunnel.
func (j *sshJumpConn) closeTunnel(why string) {
	j.tunMu.Lock()
	t := j.tunnel
	j.tunMu.Unlock()
	if t == nil {
		_ = j.sc.Close()
		return
	}
	t.closeOnce.Do(func() {
		t.windowMu.Lock()
		if t.window != nil && why != "" {
			_, _ = io.WriteString(t.window, why)
		}
		t.windowMu.Unlock()
		_ = j.sc.Close()
	})
}

// tunnelForward carries one connection of the user's app to the service.
func (j *sshJumpConn) tunnelForward(nc ssh.NewChannel, target sshTarget) {
	t := j.tunnelSession(target)
	remote, err := j.d.dial(target.ConnectorID, net.JoinHostPort(target.Host, target.Port))
	if err != nil {
		log.Printf("ssh jump: site=%s tunnel dial %s:%s via connector %s failed: %v", j.tk.SiteID, target.Host, target.Port, target.ConnectorID, err)
		_ = nc.Reject(ssh.ConnectionFailed, "the service can't be reached from its connector")
		return
	}
	ch, chReqs, err := nc.Accept()
	if err != nil {
		remote.Close()
		return
	}
	go ssh.DiscardRequests(chReqs)
	t.conns.Add(1)
	var once sync.Once
	closeBoth := func() { once.Do(func() { ch.Close(); remote.Close() }) }
	done := make(chan struct{}, 2)
	go func() { n, _ := io.Copy(ch, remote); t.down.Add(n); _ = ch.CloseWrite(); done <- struct{}{} }()
	go func() { n, _ := io.Copy(remote, ch); t.up.Add(n); done <- struct{}{} }()
	<-done
	closeBoth()
	<-done
}

// endTunnel closes the session once the SSH connection is gone.
func (j *sshJumpConn) endTunnel() {
	j.tunMu.Lock()
	t := j.tunnel
	j.tunMu.Unlock()
	if t == nil {
		return
	}
	if j.d.hub != nil {
		j.d.hub.Remove(t.id)
	}
	dur := compactDur(j.d.now().Sub(t.start))
	j.auditClose(dur, t.host, t.down.Load())
	log.Printf("ssh jump: site=%s user=%s tunnel %s closed after %s (%d connections, down %d B, up %d B)", j.tk.SiteID, j.tk.UserID, t.id, dur, t.conns.Load(), t.down.Load(), t.up.Load())
}

// session answers the terminal ssh opens next to the forward: for a tunnel it
// says the tunnel is open and how to end it; otherwise how to use the jump host.
func (j *sshJumpConn) session(nc ssh.NewChannel) {
	target, err := j.d.ctrl.NativeSshTarget(j.tk.UserID, j.tk.SiteID)
	if err != nil || !target.Tunnel || target.TenantID != j.tk.TenantID {
		j.explain(nc)
		return
	}
	if j.d.pick != nil && len(target.Candidates) > 0 {
		target.ConnectorID = j.d.pick(target.Candidates).ID
	}
	ch, reqs, err := nc.Accept()
	if err != nil {
		return
	}
	defer ch.Close()
	t := j.tunnelSession(target)
	t.windowMu.Lock()
	t.window = ch
	t.windowMu.Unlock()
	go func() {
		for r := range reqs {
			switch r.Type {
			case "shell", "exec":
				_ = r.Reply(true, nil)
				name := target.SiteName
				if name == "" {
					name = target.Host
				}
				t.windowMu.Lock()
				_, _ = io.WriteString(ch, fmt.Sprintf("Captivo Access: the tunnel to %s is open.\r\n"+
					"Connect your app to localhost on the port in your command.\r\n"+
					"Leave this window open while you work. Press Ctrl+C here to close the tunnel.\r\n", name))
				t.windowMu.Unlock()
			default:
				_ = r.Reply(r.Type == "pty-req" || r.Type == "env" || r.Type == "window-change", nil)
			}
		}
	}()
	// Ctrl+C or Ctrl+D in the window ends the tunnel; anything else typed is ignored.
	buf := make([]byte, 256)
	for {
		n, err := ch.Read(buf)
		for _, b := range buf[:n] {
			if b == 0x03 || b == 0x04 {
				j.closeTunnel("\r\nCaptivo Access: tunnel closed.\r\n")
				return
			}
		}
		if err != nil {
			return
		}
	}
}
