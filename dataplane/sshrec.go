package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/kurtserdar/captivo-access/tunnel"
	"golang.org/x/crypto/ssh"
)

// Recorded native SSH. On a resource whose sessions are recorded, the jump
// host does not relay the user's SSH connection to the server; it ends it
// here, speaking SSH to the user's client with the jump host's own key, and
// carries the session to the connector, which signs in to the server with the
// saved account (connector/sshproxy.go). In between it sees the session:
//
//   - the terminal is recorded (sshrec_term.go) and, where keystrokes are
//     logged, the typed lines too;
//   - file transfer follows the resource's rule: SFTP is read packet by packet
//     (sshrec_sftp.go), scp and rsync are allowed or refused as a whole, and
//     every transfer is in the audit log;
//   - what can't be recorded is refused: port forwarding (-L, -R, -D), agent
//     and X11 forwarding.
//
// The user signs in to nothing on this hop: the ticket in the jump user name
// already said who they are. The server sees the saved account, whatever user
// name the command gave.

const sshRecHandshakeLimit = 30 * time.Second

// sshRecMinConnector is the first connector release that serves Kind "ssh".
const sshRecMinConnector = "2.49.0"

type sshRecDeps struct {
	hostKey  ssh.Signer
	session  func(connectorID string) *Session
	recIndex func(userID, siteID, host string, body []byte) error
}

// openConnectorSSH asks the connector to sign in and returns the SSH
// connection it then serves on the stream.
func openConnectorSSH(s *Session, target sshTarget, sealed string) (*ssh.Client, tunnel.SshDialResponse, error) {
	if s == nil || s.mux == nil {
		return nil, tunnel.SshDialResponse{}, errors.New("the connector is offline")
	}
	st, err := s.mux.Open()
	if err != nil {
		return nil, tunnel.SshDialResponse{}, err
	}
	req := tunnel.SshDialRequest{
		Kind: "ssh", Host: target.Host, Port: target.Port, Username: target.Username,
		Sealed: sealed, SecretKind: target.SecretKind, PinnedHostKey: target.PinnedHostKey,
	}
	if sealed == "" {
		req.Secret = target.Secret
	}
	b, _ := json.Marshal(req)
	_ = st.SetDeadline(time.Now().Add(sshRecHandshakeLimit))
	if err := tunnel.WriteFrame(st, b); err != nil {
		st.Close()
		return nil, tunnel.SshDialResponse{}, err
	}
	rb, err := tunnel.ReadFrame(st)
	if err != nil {
		st.Close()
		return nil, tunnel.SshDialResponse{}, err
	}
	var resp tunnel.SshDialResponse
	if err := json.Unmarshal(rb, &resp); err != nil {
		st.Close()
		return nil, resp, err
	}
	if resp.Error != "" {
		st.Close()
		return nil, resp, errors.New(resp.Error)
	}
	cc, chans, reqs, err := ssh.NewClientConn(st, "connector", &ssh.ClientConfig{
		User: "captivo",
		// The stream is the connector's own authenticated tunnel; its SSH key
		// is made per process and proves nothing more.
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), // #nosec G106 -- see above
		Timeout:         sshRecHandshakeLimit,
	})
	if err != nil {
		st.Close()
		return nil, resp, err
	}
	_ = st.SetDeadline(time.Time{})
	return ssh.NewClient(cc, chans, reqs), resp, nil
}

// recorded serves one jump (a direct-tcpip channel) on a recorded resource.
func (j *sshJumpConn) recorded(nc ssh.NewChannel, target sshTarget) {
	tk := j.tk
	s := j.d.rec.session(target.ConnectorID)
	if s == nil || !connectorAtLeast(s, sshRecMinConnector) {
		log.Printf("ssh jump: site=%s connector %s can't carry a recorded session", tk.SiteID, target.ConnectorID)
		j.auditDeny("native_ssh_connector_outdated")
		_ = nc.Reject(ssh.ConnectionFailed, "this resource's connector must be updated to "+sshRecMinConnector+" for recorded SSH")
		return
	}
	sealed := ""
	for _, c := range target.Candidates {
		if c.ID == target.ConnectorID {
			sealed = c.SealedSecret
		}
	}
	client, resp, err := openConnectorSSH(s, target, sealed)
	if resp.HostKey != "" && target.PinnedHostKey == "" && !resp.HostKeyChanged && j.d.noteHostKey != nil {
		go j.d.noteHostKey(tk.SiteID, resp.HostKey)
	}
	if err != nil {
		log.Printf("ssh jump: site=%s user=%s recorded sign-in via %s failed: %v", tk.SiteID, tk.UserID, target.ConnectorID, err)
		if resp.HostKeyChanged {
			j.auditDeny("native_ssh_host_key_changed")
			_ = nc.Reject(ssh.Prohibited, "the server's SSH host key changed since Captivo first connected to it ("+resp.HostKey+"); an admin must confirm the new key on the resource")
			return
		}
		j.auditDeny("native_ssh_sign_in_failed")
		msg := resp.Error
		if msg == "" {
			msg = "the server can't be reached from its connector"
		}
		_ = nc.Reject(ssh.ConnectionFailed, msg)
		return
	}
	defer client.Close()
	ch, chReqs, err := nc.Accept()
	if err != nil {
		return
	}
	go ssh.DiscardRequests(chReqs)

	cfg := &ssh.ServerConfig{
		ServerVersion: "SSH-2.0-CaptivoAccess",
		NoClientAuth:  true,
		BannerCallback: func(ssh.ConnMetadata) string {
			return fmt.Sprintf("Captivo Access: this session is recorded. You are signed in to %s as %s.\r\n", target.SiteName, target.Username)
		},
	}
	cfg.AddHostKey(j.d.rec.hostKey)
	conn := &channelConn{Channel: ch}
	timer := time.AfterFunc(sshRecHandshakeLimit, func() { ch.Close() })
	sc, chans, reqs, err := ssh.NewServerConn(conn, cfg)
	timer.Stop()
	if err != nil {
		ch.Close()
		return
	}
	defer sc.Close()

	start := j.d.now()
	sess := &sshRecSession{j: j, target: target, client: client, start: start, id: newSessionID()}
	sess.begin(s)
	go func() {
		_ = client.Wait()
		sc.Close()
	}()
	go sess.globalRequests(reqs)
	var wg sync.WaitGroup
	for c := range chans {
		wg.Add(1)
		go func(c ssh.NewChannel) {
			defer wg.Done()
			sess.channel(c)
		}(c)
	}
	client.Close()
	wg.Wait()
	sess.end()
}

type sshRecSession struct {
	j      *sshJumpConn
	target sshTarget
	client *ssh.Client
	start  time.Time
	id     string

	ls   *liveSession
	term *termRecorder
	keys *keyWriter
	live *termLive

	mu         sync.Mutex
	controlWho string // who holds control (watcher.who); "" when the user does
	down       int64
	refusedFw  bool
	closers    []func()
	chans      map[*sshRecChannel]struct{}
	lastNotice time.Time // of "an admin is watching"
}

func (r *sshRecSession) begin(s *Session) {
	j, t := r.j, r.target
	r.closers = append(r.closers, func() { r.client.Close() })
	r.live = newTermLive()
	r.chans = map[*sshRecChannel]struct{}{}
	if j.d.hub != nil {
		r.ls = j.d.hub.RegisterNative(r.id, "ssh", j.tk.SiteID, j.tk.UserID, t.Host, r.start, t.ConnectorID, j.clientIP)
		r.ls.SetCapture(true, t.Keystrokes)
		r.ls.setTerm(r.live, r.notify)
		r.ls.setTakeover(r.adminInput, r.controlChanged)
		j.d.hub.clearEnded(j.tk.UserID, j.tk.SiteID)
		j.d.hub.SetCloser(r.id, func() { r.client.Close() })
	}
	key := newRecordingKey(j.tk.SiteID, j.tk.UserID)
	send := func(req tunnel.RecWriteRequest) (int, error) {
		return writeRecChunk(j.d.rec.session(t.ConnectorID), req)
	}
	r.term = newTermRecorder(send,
		&recIndexReporter{send: j.d.rec.recIndex, userID: j.tk.UserID, siteID: j.tk.SiteID, host: t.Host, format: termFormat, proto: "ssh", connectorID: t.ConnectorID},
		func() { notifyRecDone(j.d.rec.session(t.ConnectorID), j.tk.TenantID, key) },
		j.tk.TenantID, key, j.tk.SiteID, r.start)
	if t.Keystrokes {
		r.keys = newKeyWriter(send, j.tk.TenantID, key)
	}
	j.auditEvent("ALLOW", "session_open native_ssh_recorded", t.Host)
	log.Printf("ssh jump: site=%s user=%s recorded session id=%s via %s", j.tk.SiteID, j.tk.UserID, r.id, t.ConnectorID)
}

func (r *sshRecSession) end() {
	j := r.j
	if j.d.hub != nil {
		j.d.hub.Remove(r.id)
	}
	r.live.end()
	r.term.marker("Session ended")
	r.term.stop()
	dur := compactDur(j.d.now().Sub(r.start))
	r.mu.Lock()
	down := r.down
	r.mu.Unlock()
	j.auditClose(dur, r.target.Host, down)
	log.Printf("ssh jump: site=%s user=%s recorded session %s closed after %s", j.tk.SiteID, j.tk.UserID, r.id, dur)
}

// adminInput writes what an admin who took control typed into one of the
// user's terminals ({"t":"i","ch":N,"d":"..."} from the live viewer). It is
// logged as the admin's, apart from the user's lines.
func (r *sshRecSession) adminInput(msg []byte) {
	var in struct {
		T  string `json:"t"`
		Ch int    `json:"ch"`
		D  string `json:"d"`
	}
	if json.Unmarshal(msg, &in) != nil || in.T != "i" || in.D == "" {
		return
	}
	r.mu.Lock()
	var target *sshRecChannel
	for c := range r.chans {
		c.mu.Lock()
		if c.num == in.Ch && c.kind == chanTerminal && c.pty {
			target = c
		}
		c.mu.Unlock()
	}
	r.mu.Unlock()
	if target == nil {
		return
	}
	if _, err := target.server.Write([]byte(in.D)); err != nil {
		return
	}
	target.mu.Lock()
	var evs []keyEvent
	if target.admin != nil {
		evs = target.admin.typed([]byte(in.D), r.j.d.now())
	}
	target.mu.Unlock()
	r.mu.Lock()
	by := byOf(r.controlWho)
	r.mu.Unlock()
	for i := range evs {
		evs[i].By = by
	}
	if len(evs) > 0 {
		if r.keys != nil {
			r.keys.post(evs)
		}
		r.ls.keyEvents(evs)
	}
}

// controlChanged tells the user, in their terminals, that an admin (or an
// invited guest) took control -- their typing is paused -- or gave it back.
func (r *sshRecSession) controlChanged(taken bool, who string) {
	r.mu.Lock()
	r.controlWho = who
	r.mu.Unlock()
	if taken {
		r.notify(who+" has taken control of this session. Your typing is paused until it is given back.", false)
	} else {
		r.notify("Control of this session is back with you.", false)
	}
}

// notify writes a line from Captivo into each of the user's terminals: that an
// admin started watching (watch, said once a minute at most) or an admin's
// message. A terminal running a full-screen program gets it when that ends.
func (r *sshRecSession) notify(text string, watch bool) string {
	r.mu.Lock()
	if watch {
		if now := time.Now(); now.Sub(r.lastNotice) < watchNoticeQuiet {
			r.mu.Unlock()
			return noticeShown
		} else {
			r.lastNotice = now
		}
	}
	terms := make([]*sshRecChannel, 0, len(r.chans))
	for c := range r.chans {
		if c.isTerminal() {
			terms = append(terms, c)
		}
	}
	r.mu.Unlock()
	res := noticeNone
	for _, c := range terms {
		if c.notice(text) {
			res = noticeShown
		} else if res == noticeNone {
			res = noticeQueued
		}
	}
	return res
}

func (r *sshRecSession) liveEvent(typ, text string) {
	if r.ls != nil {
		r.ls.event(typ, text)
	}
}

// globalRequests: keepalives are answered, remote forwarding is refused.
func (r *sshRecSession) globalRequests(reqs <-chan *ssh.Request) {
	for q := range reqs {
		switch q.Type {
		case "keepalive@openssh.com":
			_ = q.Reply(true, nil)
		case "tcpip-forward", "streamlocal-forward@openssh.com":
			r.refuse("Remote port forwarding refused: this session is recorded")
			_ = q.Reply(false, nil)
		default:
			_ = q.Reply(false, nil)
		}
	}
}

func (r *sshRecSession) refuse(text string) {
	r.mu.Lock()
	first := !r.refusedFw
	r.refusedFw = true
	r.mu.Unlock()
	r.term.marker(text)
	if first {
		r.liveEvent("text", text)
	}
}

func (r *sshRecSession) channel(nc ssh.NewChannel) {
	switch nc.ChannelType() {
	case "session":
	case "direct-tcpip", "direct-streamlocal@openssh.com":
		r.refuse("Port forwarding refused: this session is recorded")
		r.j.enqueue("DENY", "native_ssh_port_forward", r.target.Host, 0)
		_ = nc.Reject(ssh.Prohibited, "port forwarding is off: this session is recorded by Captivo Access")
		return
	default:
		_ = nc.Reject(ssh.UnknownChannelType, "not allowed on a recorded session")
		return
	}
	tch, treqs, err := r.client.OpenChannel("session", nc.ExtraData())
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
	c := &sshRecChannel{r: r, user: ch, server: tch, started: make(chan struct{})}
	r.mu.Lock()
	r.chans[c] = struct{}{}
	r.mu.Unlock()
	c.run(creqs, treqs)
	r.mu.Lock()
	delete(r.chans, c)
	r.mu.Unlock()
}

// What a session channel turned out to be.
const (
	chanUnknown = iota
	chanTerminal
	chanExec
	chanSftp
	chanTransfer
)

type sshRecChannel struct {
	r            *sshRecSession
	user, server ssh.Channel

	mu      sync.Mutex
	kind    int
	pty     bool
	num     int
	cols    int
	rows    int
	notices []string
	command string
	upload  bool
	out     utf8Stream
	errOut  utf8Stream
	lines   *lineObserver
	admin   *lineObserver // what an admin who took control typed (takeover)
	gate    *sftpGate
	moved   int64 // scp / rsync bytes
	started chan struct{}
	once    sync.Once
	writeMu sync.Mutex
}

// run carries the channel. Data flows once the user's client asked for a
// shell, a command or a subsystem and it was allowed.
func (c *sshRecChannel) run(creqs <-chan *ssh.Request, treqs <-chan *ssh.Request) {
	reqsDone := make(chan struct{})
	go func() {
		forwardChannelReqs(treqs, c.user)
		close(reqsDone)
	}()
	go c.userRequests(creqs)

	go func() {
		<-c.started
		c.pumpUp()
	}()
	var out sync.WaitGroup
	out.Add(2)
	go func() { defer out.Done(); <-c.started; c.pumpDown(false) }()
	go func() { defer out.Done(); <-c.started; c.pumpDown(true) }()
	go func() {
		// A channel closed before it started anything still has to end.
		<-reqsDone
		c.begin(chanUnknown)
	}()
	out.Wait()
	_ = c.user.CloseWrite()
	select {
	case <-reqsDone:
	case <-time.After(2 * time.Second):
	}
	c.user.Close()
	c.server.Close()
	c.finish()
}

func (c *sshRecChannel) begin(kind int) {
	c.once.Do(func() {
		c.mu.Lock()
		if c.kind == chanUnknown {
			c.kind = kind
		}
		c.mu.Unlock()
		close(c.started)
	})
}

func forwardChannelReqs(in <-chan *ssh.Request, out ssh.Channel) {
	for q := range in {
		ok, err := out.SendRequest(q.Type, q.WantReply, q.Payload)
		if q.WantReply {
			_ = q.Reply(ok && err == nil, nil)
		}
	}
}

func (c *sshRecChannel) forward(q *ssh.Request) bool {
	ok, err := c.server.SendRequest(q.Type, q.WantReply, q.Payload)
	ok = ok && err == nil
	if q.WantReply {
		_ = q.Reply(ok, nil)
	}
	return ok
}

func (c *sshRecChannel) deny(q *ssh.Request, msg string) {
	if msg != "" {
		_, _ = io.WriteString(c.user.Stderr(), "Captivo Access: "+msg+"\r\n")
	}
	if q.WantReply {
		_ = q.Reply(false, nil)
	}
}

func (c *sshRecChannel) userRequests(creqs <-chan *ssh.Request) {
	r := c.r
	for q := range creqs {
		switch q.Type {
		case "pty-req":
			var p struct {
				Term                      string
				Cols, Rows, Width, Height uint32
				Modes                     string
			}
			if ssh.Unmarshal(q.Payload, &p) == nil {
				r.term.size(int(p.Cols), int(p.Rows))
			}
			c.mu.Lock()
			c.pty = true
			c.cols, c.rows = int(p.Cols), int(p.Rows)
			c.mu.Unlock()
			c.forward(q)
		case "window-change":
			var p struct{ Cols, Rows, Width, Height uint32 }
			if ssh.Unmarshal(q.Payload, &p) == nil {
				r.term.size(int(p.Cols), int(p.Rows))
				c.mu.Lock()
				c.cols, c.rows = int(p.Cols), int(p.Rows)
				num := c.num
				c.mu.Unlock()
				r.live.resize(num, int(p.Cols), int(p.Rows))
			}
			c.forward(q)
		case "env", "signal", "break", "eow@openssh.com", "keepalive@openssh.com":
			c.forward(q)
		case "shell":
			c.mu.Lock()
			c.num = r.term.opened()
			if r.keys != nil || r.ls != nil {
				c.lines = &lineObserver{start: r.start}
				c.admin = &lineObserver{start: r.start}
			}
			num, cols, rows := c.num, c.cols, c.rows
			c.mu.Unlock()
			r.live.open(num, "Terminal", cols, rows)
			if c.forward(q) {
				r.term.marker("Shell opened")
			}
			c.begin(chanTerminal)
		case "exec":
			var p struct{ Command string }
			_ = ssh.Unmarshal(q.Payload, &p)
			c.exec(q, p.Command)
		case "subsystem":
			var p struct{ Name string }
			_ = ssh.Unmarshal(q.Payload, &p)
			if p.Name != "sftp" {
				c.deny(q, "the "+p.Name+" subsystem is not allowed on a recorded session")
				continue
			}
			mode := r.target.FileTransfer
			if mode == "" || mode == "none" {
				r.term.marker("File transfer (SFTP) refused: off for this resource")
				r.j.enqueue("DENY", "native_ssh_sftp_off", r.target.Host, 0)
				c.deny(q, "file transfer is off for this resource")
				continue
			}
			c.mu.Lock()
			c.gate = newSftpGate(mode, c.writeUserPacket, c.transferDone, c.sftpChange)
			c.mu.Unlock()
			if c.forward(q) {
				r.term.marker("File transfer (SFTP) started")
			}
			c.begin(chanSftp)
		case "x11-req":
			r.refuse("X11 forwarding refused: this session is recorded")
			c.deny(q, "")
		case "auth-agent-req@openssh.com":
			r.refuse("Agent forwarding refused: this session is recorded")
			c.deny(q, "")
		default:
			c.deny(q, "")
		}
	}
}

// Commands that move files: scp in either direction, rsync's server side.
var (
	scpUpload   = regexp.MustCompile(`^\s*scp\b.*\s-[a-zA-Z]*t\b`)
	scpDownload = regexp.MustCompile(`^\s*scp\b.*\s-[a-zA-Z]*f\b`)
	rsyncServer = regexp.MustCompile(`^\s*rsync\s+--server\b`)
)

func (c *sshRecChannel) exec(q *ssh.Request, command string) {
	r := c.r
	mode := r.target.FileTransfer
	transfer, upload := false, false
	switch {
	case scpUpload.MatchString(command):
		transfer, upload = true, true
	case scpDownload.MatchString(command):
		transfer = true
	case rsyncServer.MatchString(command):
		transfer, upload = true, !strings.Contains(command, "--sender")
	}
	if transfer {
		allowed := mode == "allow" || (upload && mode == "no_download") || (!upload && mode == "no_upload")
		what := "Download"
		if upload {
			what = "Upload"
		}
		if !allowed {
			r.term.marker(what + " refused (" + firstWord(command) + "): off for this resource")
			r.j.enqueue("DENY", "native_ssh_transfer_off", r.target.Host, 0)
			c.deny(q, strings.ToLower(what)+"s are off for this resource")
			return
		}
		c.mu.Lock()
		c.command, c.upload = command, upload
		c.mu.Unlock()
		if c.forward(q) {
			r.term.marker(what + " started: " + command)
		}
		c.begin(chanTransfer)
		return
	}
	c.mu.Lock()
	c.command = command
	c.num = r.term.opened()
	num, cols, rows := c.num, c.cols, c.rows
	c.mu.Unlock()
	label := "$ " + command
	if len(label) > 60 {
		label = label[:57] + "..."
	}
	r.live.open(num, label, cols, rows)
	r.term.marker("$ " + command)
	if r.keys != nil {
		r.keys.post([]keyEvent{{AtMs: r.j.d.now().Sub(r.start).Milliseconds(), Kind: "command", Text: command}})
	}
	if r.ls != nil {
		r.ls.keyEvents([]keyEvent{{Kind: "command", Text: command}})
	}
	c.forward(q)
	c.begin(chanExec)
}

func firstWord(s string) string {
	if f := strings.Fields(s); len(f) > 0 {
		return f[0]
	}
	return s
}

// pumpUp carries what the user's client sends to the server.
func (c *sshRecChannel) pumpUp() {
	defer func() { _ = c.server.CloseWrite() }()
	c.mu.Lock()
	kind, gate := c.kind, c.gate
	c.mu.Unlock()
	if kind == chanSftp && gate != nil {
		for {
			pkt, err := readSftpPacket(c.user)
			if err != nil {
				if errors.Is(err, errSftpPacket) {
					c.server.Close()
				}
				return
			}
			fwd, err := gate.fromClient(pkt)
			if err != nil {
				return
			}
			if fwd {
				if _, err := c.server.Write(pkt); err != nil {
					return
				}
			}
		}
	}
	buf := make([]byte, 32*1024)
	for {
		n, err := c.user.Read(buf)
		if n > 0 && kind == chanTerminal && c.r.ls != nil && !c.r.ls.vendorInputAllowed() && c.isTerminal() {
			n = 0 // an admin has control: the user's typing is dropped, not kept for later
		}
		if n > 0 {
			c.typed(buf[:n])
			if kind == chanTransfer && c.upload {
				c.mu.Lock()
				c.moved += int64(n)
				c.mu.Unlock()
			}
			if _, werr := c.server.Write(buf[:n]); werr != nil {
				return
			}
		}
		if err != nil {
			return
		}
	}
}

func (c *sshRecChannel) typed(b []byte) {
	r := c.r
	if r.ls != nil {
		r.ls.mu.Lock()
		now := time.Now()
		r.ls.act.shift(now)
		r.ls.act.buckets[activityBuckets-1]++
		r.ls.mu.Unlock()
	}
	c.mu.Lock()
	lines := c.lines
	var evs []keyEvent
	if lines != nil {
		evs = lines.typed(b, r.j.d.now())
	}
	c.mu.Unlock()
	if len(evs) == 0 {
		return
	}
	if r.keys != nil {
		r.keys.post(evs)
	}
	if r.ls != nil {
		r.ls.keyEvents(evs)
	}
}

// pumpDown carries what the server sends to the user's client (stdout, or
// stderr), recording it as the channel's kind says.
func (c *sshRecChannel) pumpDown(stderr bool) {
	c.mu.Lock()
	kind, gate := c.kind, c.gate
	c.mu.Unlock()
	var src io.Reader = c.server
	var dst io.Writer = c.user
	if stderr {
		src, dst = c.server.Stderr(), c.user.Stderr()
	}
	if kind == chanSftp && gate != nil && !stderr {
		for {
			pkt, err := readSftpPacket(src)
			if err != nil {
				return
			}
			gate.fromServer(pkt)
			if c.writeUserPacket(pkt) != nil {
				return
			}
		}
	}
	buf := make([]byte, 32*1024)
	for {
		n, err := src.Read(buf)
		if n > 0 {
			c.shown(buf[:n], kind, stderr)
			c.r.mu.Lock()
			c.r.down += int64(n)
			c.r.mu.Unlock()
			if !stderr {
				// A notice goes in between two writes, never inside one.
				c.writeMu.Lock()
			}
			_, werr := dst.Write(buf[:n])
			if !stderr {
				c.writeMu.Unlock()
				c.flushNotices()
			}
			if werr != nil {
				return
			}
		}
		if err != nil {
			return
		}
	}
}

func (c *sshRecChannel) writeUserPacket(pkt []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_, err := c.user.Write(pkt)
	return err
}

func (c *sshRecChannel) shown(b []byte, kind int, stderr bool) {
	r := c.r
	switch kind {
	case chanTerminal, chanExec:
		c.mu.Lock()
		stream := &c.out
		if stderr {
			stream = &c.errOut
		}
		text, ok := stream.text(b)
		if c.lines != nil {
			c.lines.shown(b)
		}
		if c.admin != nil {
			c.admin.shown(b)
		}
		num := c.num
		c.mu.Unlock()
		if !ok {
			r.term.marker("Binary output not recorded")
		}
		r.term.output(num, text)
		r.live.output(num, text)
	case chanTransfer:
		if !c.upload {
			c.mu.Lock()
			c.moved += int64(len(b))
			c.mu.Unlock()
		}
	}
}

func (c *sshRecChannel) transferDone(t sftpTransfer, partial bool) {
	c.r.transferAudit(t.upload, t.path, t.bytes, partial, "sftp")
}

func (c *sshRecChannel) sftpChange(op, path string, refused bool) {
	r := c.r
	if refused {
		r.term.marker("SFTP " + op + " refused: " + path)
		r.j.enqueue("DENY", "native_ssh_sftp_"+op+"_off", r.target.Host, 0)
		return
	}
	r.term.marker("SFTP " + op + ": " + path)
	r.liveEvent("file", "SFTP "+op+" "+path)
	r.j.d.audit.Enqueue(AuditEvent{
		Timestamp: time.Now(), UserID: r.j.tk.UserID, SiteID: r.j.tk.SiteID, Host: r.target.Host,
		Method: "SFTP", Path: "/" + strings.TrimLeft(path, "/"), Status: 200, Decision: "ALLOW", Reason: "sftp:" + op,
		ClientIP: r.j.clientIP, UserAgent: r.j.client,
	})
}

func (r *sshRecSession) transferAudit(upload bool, path string, bytes int64, partial bool, via string) {
	method := verbDownload
	verb := "Downloaded"
	if upload {
		method, verb = verbUpload, "Uploaded"
	}
	status := 200
	if partial {
		method += "-PARTIAL"
		verb += " (partly)"
		status = 499
	}
	name := strings.TrimLeft(path, "/")
	if len(name) > maxFilenameLen {
		name = name[:maxFilenameLen]
	}
	r.term.marker(fmt.Sprintf("%s %s (%s, %d bytes)", verb, path, via, bytes))
	r.liveEvent("file", verb+" "+path)
	if r.j.d.audit != nil {
		r.j.d.audit.Enqueue(AuditEvent{
			Timestamp: time.Now(), UserID: r.j.tk.UserID, SiteID: r.j.tk.SiteID, Host: r.target.Host,
			Method: method, Path: "/" + name, Status: status, BytesOut: bytes, Decision: "ALLOW", Reason: via,
			ClientIP: r.j.clientIP, UserAgent: r.j.client,
		})
	}
}

func (c *sshRecChannel) finish() {
	c.mu.Lock()
	kind, gate, command, upload, moved := c.kind, c.gate, c.command, c.upload, c.moved
	skipped := c.out.skipped + c.errOut.skipped
	c.mu.Unlock()
	switch kind {
	case chanSftp:
		if gate != nil {
			gate.finish()
		}
		c.r.term.marker("File transfer (SFTP) ended")
	case chanTransfer:
		c.r.transferAudit(upload, command, moved, false, firstWord(command))
	case chanExec:
		if skipped > 0 {
			c.r.term.marker(fmt.Sprintf("%d bytes of binary output were not recorded", skipped))
		}
	}
	if kind == chanTerminal || kind == chanExec {
		c.mu.Lock()
		num := c.num
		c.mu.Unlock()
		c.r.live.closeTerm(num)
	}
}

// isTerminal: an interactive shell the user sees, where a notice can go.
func (c *sshRecChannel) isTerminal() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.kind == chanTerminal && c.pty
}

// notice queues a line for the user's terminal and writes it at once if it
// can (true); otherwise it goes after the server's next output that leaves
// the terminal settled.
func (c *sshRecChannel) notice(text string) bool {
	c.mu.Lock()
	c.notices = append(c.notices, text)
	c.mu.Unlock()
	return c.flushNotices()
}

func (c *sshRecChannel) flushNotices() bool {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	c.mu.Lock()
	num, pending, split := c.num, len(c.notices), len(c.out.pending) > 0
	c.mu.Unlock()
	if pending == 0 {
		return true
	}
	settled, prompt := c.r.live.settled(num)
	if split || !settled {
		return false
	}
	c.mu.Lock()
	texts := c.notices
	c.notices = nil
	c.mu.Unlock()
	var b strings.Builder
	for _, text := range texts {
		b.WriteString(noticeLine(text))
		c.r.term.marker("Shown to the user: " + text)
	}
	// The prompt and anything typed after it, drawn again below the notice.
	b.WriteString(prompt)
	if _, err := io.WriteString(c.user, b.String()); err != nil {
		return false
	}
	c.r.live.output(num, b.String())
	return true
}

// channelConn lets an SSH server run inside an SSH channel: the jump's
// direct-tcpip channel carries the user's inner SSH connection.
type channelConn struct {
	ssh.Channel
}

type channelAddr struct{}

func (channelAddr) Network() string { return "ssh-channel" }
func (channelAddr) String() string  { return "jump" }

func (c *channelConn) LocalAddr() net.Addr              { return channelAddr{} }
func (c *channelConn) RemoteAddr() net.Addr             { return channelAddr{} }
func (c *channelConn) SetDeadline(time.Time) error      { return nil }
func (c *channelConn) SetReadDeadline(time.Time) error  { return nil }
func (c *channelConn) SetWriteDeadline(time.Time) error { return nil }
