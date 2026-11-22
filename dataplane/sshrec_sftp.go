package main

import (
	"encoding/binary"
	"errors"
	"io"
	"sync"
)

// SFTP on a recorded native SSH session. The packets are read both ways so
// the resource's file transfer rule holds (no_upload, no_download) and every
// transfer is in the audit log with its path and size, as in a browser
// session. File contents are not recorded. A refused request is answered
// here with SSH_FX_PERMISSION_DENIED and never reaches the server.

const (
	sftpOpen     = 3
	sftpClose    = 4
	sftpRead     = 5
	sftpWrite    = 6
	sftpSetstat  = 9
	sftpFsetstat = 10
	sftpRemove   = 13
	sftpMkdir    = 14
	sftpRmdir    = 15
	sftpRename   = 18
	sftpSymlink  = 20
	sftpStatus   = 101
	sftpHandle   = 102
	sftpData     = 103

	sftpFxfWrite  = 0x02
	sftpFxfAppend = 0x04
	sftpFxfCreat  = 0x08
	sftpFxfTrunc  = 0x10

	sftpFxPermissionDenied = 3

	// OpenSSH writes up to 256 KiB per packet; anything larger is not SFTP.
	sftpMaxPacket = 1 << 20
)

var errSftpPacket = errors.New("sftp: malformed packet")

// sftpTransfer is one file a handle was opened on.
type sftpTransfer struct {
	path   string
	upload bool
	bytes  int64
}

type sftpGate struct {
	allowUpload, allowDownload bool
	// toClient writes one whole packet to the user's channel. Both directions
	// use it (a refusal is written from the client side), hence its lock.
	toClient func([]byte) error
	// done reports a finished (or, at the end, unfinished) transfer.
	done func(t sftpTransfer, partial bool)
	// change reports a refused request or a change other than a transfer
	// (remove, rename, mkdir), for the audit log and the recording.
	change func(op, path string, refused bool)

	mu      sync.Mutex
	opens   map[uint32]*sftpTransfer
	handles map[string]*sftpTransfer
	reads   map[uint32]string
}

func newSftpGate(mode string, toClient func([]byte) error, done func(sftpTransfer, bool), change func(string, string, bool)) *sftpGate {
	return &sftpGate{
		allowUpload: mode == "allow" || mode == "no_download", allowDownload: mode == "allow" || mode == "no_upload",
		toClient: toClient, done: done, change: change,
		opens: map[uint32]*sftpTransfer{}, handles: map[string]*sftpTransfer{}, reads: map[uint32]string{},
	}
}

// readSftpPacket reads one length-prefixed packet, length included.
func readSftpPacket(r io.Reader) ([]byte, error) {
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return nil, err
	}
	n := binary.BigEndian.Uint32(hdr[:])
	if n == 0 || n > sftpMaxPacket {
		return nil, errSftpPacket
	}
	pkt := make([]byte, 4+int(n))
	copy(pkt, hdr[:])
	if _, err := io.ReadFull(r, pkt[4:]); err != nil {
		return nil, err
	}
	return pkt, nil
}

type sftpReader struct {
	b   []byte
	bad bool
}

func (r *sftpReader) u32() uint32 {
	if len(r.b) < 4 {
		r.bad = true
		return 0
	}
	v := binary.BigEndian.Uint32(r.b)
	r.b = r.b[4:]
	return v
}

func (r *sftpReader) str() string {
	n := int(r.u32())
	if r.bad || n < 0 || n > len(r.b) {
		r.bad = true
		return ""
	}
	s := string(r.b[:n])
	r.b = r.b[n:]
	return s
}

func sftpStatusPacket(id uint32, msg string) []byte {
	body := make([]byte, 0, 32+len(msg))
	body = append(body, sftpStatus)
	body = binary.BigEndian.AppendUint32(body, id)
	body = binary.BigEndian.AppendUint32(body, sftpFxPermissionDenied)
	body = binary.BigEndian.AppendUint32(body, uint32(len(msg)))
	body = append(body, msg...)
	body = binary.BigEndian.AppendUint32(body, 0) // language tag
	return append(binary.BigEndian.AppendUint32(nil, uint32(len(body))), body...)
}

// fromClient decides on one packet from the user's client: forward it (true)
// or answer it here (false).
func (g *sftpGate) fromClient(pkt []byte) (bool, error) {
	if len(pkt) < 5 {
		return false, errSftpPacket
	}
	typ := pkt[4]
	if typ < sftpOpen { // INIT and the like carry no request id
		return true, nil
	}
	r := &sftpReader{b: pkt[5:]}
	id := r.u32()
	refuse := func(op, path, why string) (bool, error) {
		g.change(op, path, true)
		return false, g.toClient(sftpStatusPacket(id, why))
	}
	switch typ {
	case sftpOpen:
		path := r.str()
		flags := r.u32()
		if r.bad {
			return false, errSftpPacket
		}
		upload := flags&(sftpFxfWrite|sftpFxfAppend|sftpFxfCreat|sftpFxfTrunc) != 0
		if upload && !g.allowUpload {
			return refuse("upload", path, "Uploads are off for this resource (Captivo Access)")
		}
		if !upload && !g.allowDownload {
			return refuse("download", path, "Downloads are off for this resource (Captivo Access)")
		}
		g.mu.Lock()
		g.opens[id] = &sftpTransfer{path: path, upload: upload}
		g.mu.Unlock()
	case sftpRead:
		h := r.str()
		g.mu.Lock()
		g.reads[id] = h
		g.mu.Unlock()
	case sftpWrite:
		h := r.str()
		r.u32()
		r.u32() // offset (uint64)
		data := r.str()
		g.mu.Lock()
		if t := g.handles[h]; t != nil && !r.bad {
			t.bytes += int64(len(data))
		}
		g.mu.Unlock()
	case sftpClose:
		h := r.str()
		g.mu.Lock()
		t := g.handles[h]
		delete(g.handles, h)
		g.mu.Unlock()
		if t != nil && (t.upload || t.bytes > 0) {
			g.done(*t, false)
		}
	case sftpRemove, sftpMkdir, sftpRmdir, sftpSetstat, sftpRename, sftpSymlink:
		path := r.str()
		op := map[byte]string{sftpRemove: "remove", sftpMkdir: "mkdir", sftpRmdir: "rmdir", sftpSetstat: "setstat", sftpRename: "rename", sftpSymlink: "symlink"}[typ]
		if typ == sftpRename || typ == sftpSymlink {
			if to := r.str(); to != "" {
				path += " → " + to
			}
		}
		if !g.allowUpload {
			return refuse(op, path, "Changing files is off for this resource (Captivo Access)")
		}
		if typ != sftpSetstat {
			g.change(op, path, false)
		}
	case sftpFsetstat:
		if !g.allowUpload {
			return refuse("setstat", "", "Changing files is off for this resource (Captivo Access)")
		}
	}
	return true, nil
}

// fromServer notes what a server packet answers; it is always passed on.
func (g *sftpGate) fromServer(pkt []byte) {
	if len(pkt) < 9 {
		return
	}
	r := &sftpReader{b: pkt[5:]}
	id := r.u32()
	g.mu.Lock()
	defer g.mu.Unlock()
	switch pkt[4] {
	case sftpHandle:
		h := r.str()
		if t := g.opens[id]; t != nil && !r.bad {
			g.handles[h] = t
		}
		delete(g.opens, id)
	case sftpData:
		data := r.str()
		if t := g.handles[g.reads[id]]; t != nil && !r.bad {
			t.bytes += int64(len(data))
		}
		delete(g.reads, id)
	case sftpStatus:
		delete(g.opens, id)
		delete(g.reads, id)
	}
}

// finish reports transfers still open when the channel ended.
func (g *sftpGate) finish() {
	g.mu.Lock()
	open := make([]sftpTransfer, 0, len(g.handles))
	for _, t := range g.handles {
		open = append(open, *t)
	}
	g.handles = map[string]*sftpTransfer{}
	g.mu.Unlock()
	for _, t := range open {
		if t.upload || t.bytes > 0 {
			g.done(t, true)
		}
	}
}
