package main

import (
	"bytes"
	"encoding/binary"
	"strconv"
	"testing"
)

func sftpPkt(typ byte, id uint32, fields ...any) []byte {
	body := []byte{typ}
	body = binary.BigEndian.AppendUint32(body, id)
	for _, f := range fields {
		switch v := f.(type) {
		case string:
			body = binary.BigEndian.AppendUint32(body, uint32(len(v)))
			body = append(body, v...)
		case uint32:
			body = binary.BigEndian.AppendUint32(body, v)
		case uint64:
			body = binary.BigEndian.AppendUint64(body, v)
		}
	}
	return append(binary.BigEndian.AppendUint32(nil, uint32(len(body))), body...)
}

type sftpLog struct {
	toClient [][]byte
	done     []string
	changes  []string
}

func newTestGate(mode string) (*sftpGate, *sftpLog) {
	l := &sftpLog{}
	g := newSftpGate(mode,
		func(p []byte) error { l.toClient = append(l.toClient, p); return nil },
		func(t sftpTransfer, partial bool) {
			dir := "down"
			if t.upload {
				dir = "up"
			}
			s := dir + " " + t.path
			if partial {
				s += " partial"
			}
			l.done = append(l.done, s+" "+itoa64(t.bytes))
		},
		func(op, path string, refused bool) {
			if refused {
				op += " refused"
			}
			l.changes = append(l.changes, op+" "+path)
		})
	return g, l
}

func itoa64(n int64) string { return strconv.FormatInt(n, 10) }

func TestSftpGateCountsATransferAndReportsItOnClose(t *testing.T) {
	g, l := newTestGate("allow")
	if fwd, _ := g.fromClient(sftpPkt(sftpOpen, 1, "/etc/hosts", uint32(0x01), uint32(0))); !fwd {
		t.Fatal("read refused")
	}
	g.fromServer(sftpPkt(sftpHandle, 1, "h1"))
	g.fromClient(sftpPkt(sftpRead, 2, "h1", uint64(0), uint32(4096)))
	g.fromServer(sftpPkt(sftpData, 2, "abc"))
	g.fromClient(sftpPkt(sftpClose, 3, "h1"))
	if len(l.done) != 1 || l.done[0] != "down /etc/hosts "+itoa64(3) {
		t.Fatalf("done %q", l.done)
	}
	// An upload left open when the channel ends is reported as partial.
	g.fromClient(sftpPkt(sftpOpen, 4, "/tmp/x", uint32(0x02|0x08), uint32(0)))
	g.fromServer(sftpPkt(sftpHandle, 4, "h2"))
	g.fromClient(sftpPkt(sftpWrite, 5, "h2", uint64(0), "hello"))
	g.finish()
	if len(l.done) != 2 || l.done[1] != "up /tmp/x partial "+itoa64(5) {
		t.Fatalf("done %q", l.done)
	}
}

func TestSftpGateRefusesWhatTheRuleForbids(t *testing.T) {
	g, l := newTestGate("no_upload")
	fwd, err := g.fromClient(sftpPkt(sftpOpen, 7, "/srv/app.conf", uint32(0x02|0x10), uint32(0)))
	if fwd || err != nil || len(l.toClient) != 1 {
		t.Fatalf("upload not refused: %v %v", fwd, err)
	}
	reply := l.toClient[0]
	if reply[4] != sftpStatus || binary.BigEndian.Uint32(reply[5:]) != 7 || binary.BigEndian.Uint32(reply[9:]) != sftpFxPermissionDenied {
		t.Fatalf("reply % x", reply)
	}
	if !bytes.Contains(reply, []byte("Uploads are off")) {
		t.Fatal("no reason in the reply")
	}
	if fwd, _ := g.fromClient(sftpPkt(sftpRemove, 8, "/srv/old")); fwd {
		t.Fatal("remove allowed with uploads off")
	}
	if fwd, _ := g.fromClient(sftpPkt(sftpOpen, 9, "/srv/app.conf", uint32(0x01), uint32(0))); !fwd {
		t.Fatal("download refused under no_upload")
	}
	if len(l.changes) != 2 || l.changes[0] != "upload refused /srv/app.conf" || l.changes[1] != "remove refused /srv/old" {
		t.Fatalf("changes %q", l.changes)
	}

	g2, _ := newTestGate("no_download")
	if fwd, _ := g2.fromClient(sftpPkt(sftpOpen, 1, "/etc/shadow", uint32(0x01), uint32(0))); fwd {
		t.Fatal("download allowed under no_download")
	}
	if fwd, _ := g2.fromClient(sftpPkt(sftpRename, 2, "/a", "/b")); !fwd {
		t.Fatal("rename refused under no_download")
	}
}

func TestSftpPacketReaderRejectsOversize(t *testing.T) {
	b := binary.BigEndian.AppendUint32(nil, sftpMaxPacket+1)
	if _, err := readSftpPacket(bytes.NewReader(b)); err != errSftpPacket {
		t.Fatalf("got %v", err)
	}
}
