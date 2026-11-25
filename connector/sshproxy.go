package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
	"golang.org/x/crypto/ssh"
)

// Recorded SSH (Kind "ssh"): a user's own SSH client on a recorded resource.
// The data plane terminates that client's SSH session (dataplane/sshrec.go),
// so it can record the terminal; this side signs in to the resource's server
// with the saved password or key, which opens here only, and then serves SSH
// on the stream: each channel and request the data plane opens is carried to
// the signed-in connection, and the answers come back. The data plane decides
// what is allowed (no port forwarding, file transfer as the resource says);
// this side only carries it.
//
// The server's host key is checked against the one pinned for the resource,
// shared with password rotation (VaultCredential.sshHostKey): on first contact
// whatever it shows is taken and reported, after that a different key refuses
// the connection.

const sshSignInLimit = 20 * time.Second

var errSSHHostKeyChanged = errors.New("the server's SSH host key changed since Captivo first connected to it")

func handleSsh(st io.ReadWriteCloser, allow *TargetMatcher, reqBytes []byte) {
	var req tunnel.SshDialRequest
	if json.Unmarshal(reqBytes, &req) != nil {
		writeSshResp(st, tunnel.SshDialResponse{Error: "bad request"})
		return
	}
	addr := net.JoinHostPort(req.Host, req.Port)
	if !egressAllowed(allow, addr) {
		denied()
		logDenied("ssh", addr)
		writeSshResp(st, tunnel.SshDialResponse{Error: "target not allowed"})
		return
	}
	secret := req.Secret
	if req.Sealed != "" {
		s, err := openSecretOrCA(vaultKey, req.Sealed, vaultTargetAAD(req.Host, req.Port, req.Username))
		if err != nil {
			writeSshResp(st, tunnel.SshDialResponse{Error: "the saved password does not open on this connector; enter it again"})
			return
		}
		secret = s
	}
	var auth []ssh.AuthMethod
	var err error
	if secret == sshCAMarker {
		auth, err = sshCertAuth(req.Username, req.KeyID)
	} else {
		auth, err = sshAuthFor(req.SecretKind, secret)
	}
	if err != nil {
		writeSshResp(st, tunnel.SshDialResponse{Error: err.Error()})
		return
	}
	client, seen, err := sshSignIn(addr, req.Username, auth, req.PinnedHostKey)
	if err != nil {
		resp := tunnel.SshDialResponse{Error: sshSignInError(err), HostKey: seen}
		if errors.Is(err, errSSHHostKeyChanged) {
			resp.HostKeyChanged = true
		} else {
			logUpstreamErr("ssh", addr, err.Error())
		}
		writeSshResp(st, resp)
		return
	}
	defer client.Close()
	if !writeSshResp(st, tunnel.SshDialResponse{HostKey: seen}) {
		return
	}
	cfg := &ssh.ServerConfig{ServerVersion: "SSH-2.0-CaptivoConnector", NoClientAuth: true}
	cfg.AddHostKey(streamHostKey())
	_ = setStreamDeadline(st, time.Now().Add(sshSignInLimit))
	sc, chans, reqs, err := ssh.NewServerConn(rwcConn{st}, cfg)
	if err != nil {
		return
	}
	_ = setStreamDeadline(st, time.Time{})
	bridgeSSH(sc, chans, reqs, client)
}

func writeSshResp(st io.Writer, r tunnel.SshDialResponse) bool {
	b, _ := json.Marshal(r)
	return tunnel.WriteFrame(st, b) == nil
}

// sshAuthFor turns the saved secret into the way to sign in.
func sshAuthFor(kind, secret string) ([]ssh.AuthMethod, error) {
	if strings.EqualFold(kind, "KEY") {
		signer, err := ssh.ParsePrivateKey([]byte(secret))
		if err != nil {
			return nil, errors.New("the saved private key does not parse (keys with a passphrase are not supported)")
		}
		return []ssh.AuthMethod{ssh.PublicKeys(signer)}, nil
	}
	return passwordAuth(secret), nil
}

// sshSignIn connects and signs in, returning the host key the server showed.
func sshSignIn(addr, user string, auth []ssh.AuthMethod, pinned string) (*ssh.Client, string, error) {
	var seen string
	conn, err := net.DialTimeout("tcp", addr, 8*time.Second)
	if err != nil {
		return nil, "", err
	}
	_ = conn.SetDeadline(time.Now().Add(sshSignInLimit))
	cc, chans, reqs, err := ssh.NewClientConn(conn, addr, &ssh.ClientConfig{
		User: user,
		Auth: auth,
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			seen = ssh.FingerprintSHA256(key)
			if pinned != "" && pinned != seen {
				return errSSHHostKeyChanged
			}
			return nil
		},
		Timeout: 8 * time.Second,
	})
	if err != nil {
		conn.Close()
		return nil, seen, err
	}
	_ = conn.SetDeadline(time.Time{})
	return ssh.NewClient(cc, chans, reqs), seen, nil
}

// sshSignInError words a failed sign-in for the user; never the secret.
func sshSignInError(err error) string {
	switch {
	case errors.Is(err, errSSHHostKeyChanged):
		return errSSHHostKeyChanged.Error()
	case strings.Contains(err.Error(), "unable to authenticate"):
		return "the server refused the saved account; an admin can enter its password or key again (for a certificate: the server must trust this connector's CA and accept the account name)"
	case strings.Contains(err.Error(), "i/o timeout"), strings.Contains(err.Error(), "connection refused"), strings.Contains(err.Error(), "no route"):
		return "the server can't be reached from its connector"
	}
	return "could not sign in to the server over SSH"
}

// streamHostKey is the key this side shows the data plane on the stream. The
// stream is the connector's own authenticated tunnel, so the data plane does
// not check it and it need not outlive the process.
var streamHostKey = sync.OnceValue(func() ssh.Signer {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		panic(err)
	}
	s, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		panic(err)
	}
	return s
})

// bridgeSSH carries every channel and global request from the data plane's
// connection (sc) to the signed-in one, and ends both together. Channels the
// server opens toward the client (forwarded ports, agent, X11) are refused by
// ssh.NewClient, as nothing here asked for them.
func bridgeSSH(sc *ssh.ServerConn, chans <-chan ssh.NewChannel, reqs <-chan *ssh.Request, target *ssh.Client) {
	go func() {
		_ = target.Wait()
		sc.Close()
	}()
	go func() {
		for r := range reqs {
			ok, payload, _ := target.SendRequest(r.Type, r.WantReply, r.Payload)
			if r.WantReply {
				_ = r.Reply(ok, payload)
			}
		}
	}()
	var wg sync.WaitGroup
	for nc := range chans {
		wg.Add(1)
		go func(nc ssh.NewChannel) {
			defer wg.Done()
			tch, treqs, err := target.OpenChannel(nc.ChannelType(), nc.ExtraData())
			if err != nil {
				var oe *ssh.OpenChannelError
				if errors.As(err, &oe) {
					_ = nc.Reject(oe.Reason, oe.Message)
				} else {
					_ = nc.Reject(ssh.ConnectionFailed, "the server closed the connection")
				}
				return
			}
			ch, creqs, err := nc.Accept()
			if err != nil {
				tch.Close()
				return
			}
			pipeSSHChannel(ch, creqs, tch, treqs)
		}(nc)
	}
	target.Close()
	wg.Wait()
}

// pipeSSHChannel carries one channel both ways: data, stderr and requests.
// `a` faces the data plane, `b` the server. When the server's side ends, its
// last requests (exit-status) reach `a` before it closes.
func pipeSSHChannel(a ssh.Channel, areqs <-chan *ssh.Request, b ssh.Channel, breqs <-chan *ssh.Request) {
	// A request of the client's still on its way (an exec the server already
	// answered and finished) must get its reply before `a` closes, or the
	// client sees the channel end without one and reports EOF.
	var pending sync.WaitGroup
	go forwardChannelRequestsTracked(areqs, b, &pending)
	reqsDone := make(chan struct{})
	go func() {
		forwardChannelRequests(breqs, a)
		close(reqsDone)
	}()
	go func() {
		_, _ = io.Copy(b, a)
		_ = b.CloseWrite()
	}()
	var out sync.WaitGroup
	out.Add(2)
	go func() { defer out.Done(); _, _ = io.Copy(a, b) }()
	go func() { defer out.Done(); _, _ = io.Copy(a.Stderr(), b.Stderr()) }()
	out.Wait()
	_ = a.CloseWrite()
	select {
	case <-reqsDone:
	case <-time.After(2 * time.Second):
	}
	replied := make(chan struct{})
	go func() { pending.Wait(); close(replied) }()
	select {
	case <-replied:
	case <-time.After(2 * time.Second):
	}
	a.Close()
	b.Close()
}

// forwardChannelRequestsTracked is forwardChannelRequests, counting each
// request until its reply is sent.
func forwardChannelRequestsTracked(in <-chan *ssh.Request, out ssh.Channel, pending *sync.WaitGroup) {
	for r := range in {
		pending.Add(1)
		ok, err := out.SendRequest(r.Type, r.WantReply, r.Payload)
		if r.WantReply {
			_ = r.Reply(ok && err == nil, nil)
		}
		pending.Done()
	}
}

func forwardChannelRequests(in <-chan *ssh.Request, out ssh.Channel) {
	for r := range in {
		ok, err := out.SendRequest(r.Type, r.WantReply, r.Payload)
		if r.WantReply {
			_ = r.Reply(ok && err == nil, nil)
		}
	}
}

// rwcConn lets the SSH server run on a tunnel stream.
type rwcConn struct{ io.ReadWriteCloser }

type sshStreamAddr struct{}

func (sshStreamAddr) Network() string { return "tunnel" }
func (sshStreamAddr) String() string  { return "data-plane" }

func (rwcConn) LocalAddr() net.Addr              { return sshStreamAddr{} }
func (rwcConn) RemoteAddr() net.Addr             { return sshStreamAddr{} }
func (c rwcConn) SetDeadline(t time.Time) error  { return setStreamDeadline(c.ReadWriteCloser, t) }
func (rwcConn) SetReadDeadline(time.Time) error  { return nil }
func (rwcConn) SetWriteDeadline(time.Time) error { return nil }

// setStreamDeadline applies a deadline when the stream underneath has one.
func setStreamDeadline(st io.ReadWriteCloser, t time.Time) error {
	for {
		switch v := st.(type) {
		case interface{ SetDeadline(time.Time) error }:
			return v.SetDeadline(t)
		case *countingStream:
			st = v.ReadWriteCloser
		default:
			return nil
		}
	}
}
