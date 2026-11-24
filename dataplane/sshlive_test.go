package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/crypto/ssh"
)

func TestTermTailRedrawsFromTheLastClearAndKeepsTheMainScreenUnderVim(t *testing.T) {
	var tl termTail
	tl.write("old output\r\n\x1b[H\x1b[2Jops@box:~$ ls\r\nfile\r\n")
	if got := tl.snapshot(); got != "ops@box:~$ ls\r\nfile\r\n" {
		t.Fatalf("after clear %q", got)
	}
	// vim, with its entering sequence cut across two reads.
	tl.write("ops@box:~$ vim\r\n\x1b[?10")
	if tl.settled() {
		t.Fatal("settled in the middle of a sequence")
	}
	tl.write("49h\x1b[HVIM")
	if got := tl.snapshot(); got != "ops@box:~$ ls\r\nfile\r\nops@box:~$ vim\r\n\x1b[?1049h\x1b[HVIM" {
		t.Fatalf("in vim %q", got)
	}
	if tl.settled() {
		t.Fatal("settled while a full-screen program runs")
	}
	tl.write(" more\x1b[?1049lops@box:~$ ")
	if got := tl.snapshot(); got != "ops@box:~$ ls\r\nfile\r\nops@box:~$ vim\r\nops@box:~$ " || !tl.settled() {
		t.Fatalf("after vim %q settled=%v", got, tl.settled())
	}
	tl.write("\x1b[38;5")
	if tl.settled() {
		t.Fatal("settled inside a colour sequence")
	}
	tl.write(";1mred")
	if !tl.settled() {
		t.Fatal("not settled after the sequence ended")
	}
	tl.write("\r\nops@box:~$ sys")
	if got := tl.currentLine(); got != "ops@box:~$ sys" {
		t.Fatalf("current line %q", got)
	}
	tl.write("\x1bcfresh")
	if got := tl.snapshot(); got != "fresh" {
		t.Fatalf("after reset %q", got)
	}
}

func TestTermTailIsBounded(t *testing.T) {
	var tl termTail
	line := strings.Repeat("x", 99) + "\n"
	for i := 0; i < (termTailMax/len(line))+500; i++ {
		tl.write(line)
	}
	got := tl.snapshot()
	if len(got) > termTailMax || !strings.HasPrefix(got, "x") || len(got)%len(line) != 0 {
		t.Fatalf("tail %d bytes, starts %q", len(got), got[:5])
	}
}

func TestTermLiveJoinGetsTheScreenThenEverythingAfter(t *testing.T) {
	l := newTermLive()
	l.open(1, "Terminal", 120, 40)
	l.output(1, "ops@box:~$ ")
	v, frames := l.join()
	if len(frames) != 1 || frames[0].T != "open" || frames[0].Cols != 120 || frames[0].D != "ops@box:~$ " {
		t.Fatalf("join %+v", frames)
	}
	l.output(1, "ls")
	l.resize(1, 100, 30)
	l.closeTerm(1)
	l.end()
	var got []string
	for b := range drain(v) {
		got = append(got, b)
	}
	want := []string{`{"t":"o","ch":1,"d":"ls"}`, `{"t":"r","ch":1,"cols":100,"rows":30}`, `{"t":"close","ch":1}`, `{"t":"end"}`}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("frames %v", got)
	}
	if _, f := l.join(); f != nil {
		t.Fatal("joined an ended session")
	}
}

func drain(v *termViewer) <-chan string {
	out := make(chan string, termViewerQueue)
	go func() {
		defer close(out)
		for {
			select {
			case b := <-v.out:
				out <- string(b)
			default:
				return
			}
		}
	}()
	return out
}

func TestTermLiveDropsAViewerThatFallsBehind(t *testing.T) {
	l := newTermLive()
	l.open(1, "Terminal", 80, 24)
	v, _ := l.join()
	for i := 0; i <= termViewerQueue; i++ {
		l.output(1, "x")
	}
	select {
	case <-v.gone:
	default:
		t.Fatal("a stuck viewer was kept")
	}
	l.output(1, "y") // the user's terminal goes on
}

func TestNoticeLineStripsControlCharacters(t *testing.T) {
	got := noticeLine("save\x1b]0;pwned\x07 now\r\n")
	if strings.Contains(got[len("\r\n\x1b[1;7m Captivo Access \x1b[0m "):], "\x1b") || !strings.Contains(got, "save ]0;pwned  now") {
		t.Fatalf("%q", got)
	}
}

func TestRecordedSSHCanBeWatchedAndTellsTheUser(t *testing.T) {
	r := recordedJumpRig(t, sshTarget{Record: true, FileTransfer: "none", Username: "ops", Secret: "pw", SecretKind: "PASSWORD"})
	c, _, err := r.innerClient(t)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	s, _ := c.NewSession()
	if err := s.RequestPty("xterm", 40, 120, ssh.TerminalModes{}); err != nil {
		t.Fatal(err)
	}
	in, _ := s.StdinPipe()
	var out strings.Builder
	var outMu sync.Mutex
	s.Stdout = writerFunc(func(p []byte) (int, error) { outMu.Lock(); defer outMu.Unlock(); return out.Write(p) })
	shown := func() string { outMu.Lock(); defer outMu.Unlock(); return out.String() }
	if err := s.Shell(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return strings.Contains(shown(), "ops@box:~$ ") })
	list := r.hub.List()
	if len(list) != 1 || !list[0].Watchable {
		t.Fatalf("live %+v", list)
	}
	ls := r.hub.Get(list[0].SessionID)
	live, notify := ls.termHooks()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		serveTermView(ls, live, notify, watcher{id: "admin1"}, w, req)
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	frames := make(chan termFrame, 100)
	go func() {
		for {
			_, b, err := ws.Read(ctx)
			if err != nil {
				close(frames)
				return
			}
			var f termFrame
			_ = json.Unmarshal(b, &f)
			frames <- f
		}
	}()
	seen := ""
	next := func(want string) {
		t.Helper()
		for !strings.Contains(seen, want) {
			select {
			case f, ok := <-frames:
				if !ok {
					t.Fatalf("viewer closed before %q; saw %q", want, seen)
				}
				seen += f.T + ":" + f.D + "\n"
			case <-time.After(5 * time.Second):
				t.Fatalf("viewer never saw %q; saw %q", want, seen)
			}
		}
	}
	next("open:ops@box:~$ ")

	// The user is told, once, in their own terminal.
	waitFor(t, func() bool { return strings.Contains(shown(), "An admin is now watching this session.") })
	next("An admin is now watching")
	if n := r.hub.List()[0].ViewerCount; n != 1 {
		t.Fatalf("viewers %d", n)
	}
	_, _ = io.WriteString(in, "ls\r")
	next("out of ls")

	// A message while vim runs waits until it ends.
	_, _ = io.WriteString(in, "vim\r")
	next("VIM SCREEN")
	if d := r.hub.NoticeTerminal(ls.id, "Please save your work"); d != noticeQueued {
		t.Fatalf("delivery %q", d)
	}
	time.Sleep(100 * time.Millisecond)
	if strings.Contains(shown(), "Please save") {
		t.Fatal("message written over vim")
	}
	_, _ = io.WriteString(in, ":q\r")
	waitFor(t, func() bool { return strings.Contains(shown(), "Message from an admin: Please save your work") })
	if i, j := strings.Index(shown(), "\x1b[?1049l"), strings.Index(shown(), "Please save"); i < 0 || j < i {
		t.Fatal("message shown before vim ended")
	}
	if d := r.hub.NoticeTerminal(ls.id, "Thanks"); d != noticeShown {
		t.Fatalf("delivery %q", d)
	}
	// The prompt is drawn again under the notice.
	waitFor(t, func() bool { return strings.HasSuffix(shown(), "Thanks\r\nops@box:~$ ") })

	_, _ = io.WriteString(in, "exit\r")
	_ = s.Wait()
	c.Close()
	next("end:")
	waitFor(t, func() bool { return strings.Contains(r.conn.stream(t), "Session ended") })
	rec := r.conn.stream(t)
	for _, want := range []string{"Shown to the user: An admin is now watching", "Shown to the user: Message from an admin: Please save your work"} {
		if !strings.Contains(rec, want) {
			t.Errorf("recording lacks %q", want)
		}
	}
}

func TestRecordedSSHCanBeTakenOver(t *testing.T) {
	r := recordedJumpRig(t, sshTarget{Record: true, Keystrokes: true, FileTransfer: "none", Username: "ops", Secret: "pw", SecretKind: "PASSWORD"})
	c, _, err := r.innerClient(t)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	s, _ := c.NewSession()
	if err := s.RequestPty("xterm", 40, 120, ssh.TerminalModes{}); err != nil {
		t.Fatal(err)
	}
	in, _ := s.StdinPipe()
	var out strings.Builder
	var outMu sync.Mutex
	s.Stdout = writerFunc(func(p []byte) (int, error) { outMu.Lock(); defer outMu.Unlock(); return out.Write(p) })
	shown := func() string { outMu.Lock(); defer outMu.Unlock(); return out.String() }
	if err := s.Shell(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return strings.Contains(shown(), "ops@box:~$ ") })
	list := r.hub.List()
	if len(list) != 1 || !list[0].Controllable {
		t.Fatalf("live %+v", list)
	}
	ls := r.hub.Get(list[0].SessionID)
	live, notify := ls.termHooks()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		serveTermView(ls, live, notify, watcher{id: "admin1"}, w, req)
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	ch := make(chan int, 1)
	go func() {
		for {
			_, b, err := ws.Read(ctx)
			if err != nil {
				return
			}
			var f termFrame
			_ = json.Unmarshal(b, &f)
			if f.T == "open" {
				select {
				case ch <- f.Ch:
				default:
				}
			}
		}
	}()
	term := <-ch
	send := func(d string) {
		b, _ := json.Marshal(map[string]any{"t": "i", "ch": term, "d": d})
		_ = ws.Write(ctx, websocket.MessageText, b)
	}

	// Typing before taking control goes nowhere.
	send("ls\r")
	time.Sleep(150 * time.Millisecond)
	if strings.Contains(shown(), "out of ls") {
		t.Fatal("a viewer without control typed into the session")
	}
	if err := r.hub.SetControl(ls.id, "admin1"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return strings.Contains(shown(), "An admin has taken control of this session.") })

	// The user's typing is dropped; the admin's runs.
	_, _ = io.WriteString(in, "ls\r")
	time.Sleep(150 * time.Millisecond)
	if strings.Contains(shown(), "out of ls") {
		t.Fatal("the user typed while an admin held control")
	}
	send("ls\r")
	waitFor(t, func() bool { return strings.Contains(shown(), "out of ls") })
	if err := r.hub.SetControl(ls.id, "admin2"); err == nil {
		t.Fatal("a second admin took control")
	}

	// The viewer leaving gives control back.
	_ = ws.Close(websocket.StatusNormalClosure, "")
	waitFor(t, func() bool { return strings.Contains(shown(), "Control of this session is back with you.") })
	before := strings.Count(shown(), "out of ls")
	_, _ = io.WriteString(in, "ls\r")
	waitFor(t, func() bool { return strings.Count(shown(), "out of ls") > before })

	_, _ = io.WriteString(in, "exit\r")
	_ = s.Wait()
	c.Close()
	waitFor(t, func() bool { return strings.Contains(r.conn.stream(t), "Session ended") })
	waitFor(t, func() bool { return strings.Contains(r.conn.keys(), `"by":"admin"`) })
	keys := r.conn.keys()
	if strings.Count(keys, `"text":"ls"`) != 2 || strings.Count(keys, `"by":"admin"`) != 1 {
		t.Errorf("the admin's command and the user's are not told apart: %s", keys)
	}
}
