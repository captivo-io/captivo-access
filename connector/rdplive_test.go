package main

import (
	"bufio"
	"io"
	"os"
	"strings"
	"testing"
	"time"
)

func TestReadRawGuac(t *testing.T) {
	r := bufio.NewReader(strings.NewReader("4.size,1.0,4.1280,3.800;4.blob,1.3,5.şçöüğ;"))
	inst, op, err := readRawGuac(r)
	if err != nil || op != "size" || string(inst) != "4.size,1.0,4.1280,3.800;" {
		t.Fatalf("%q %q %v", inst, op, err)
	}
	inst, op, err = readRawGuac(r)
	if err != nil || op != "blob" || string(inst) != "4.blob,1.3,5.şçöüğ;" {
		t.Fatalf("lengths are in characters: %q %q %v", inst, op, err)
	}
}

func testLive(t *testing.T) (*rdpLive, *io.PipeWriter, *bufio.Reader) {
	t.Helper()
	cr, cw, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cr.Close(); cw.Close() })
	pr, pw := io.Pipe()
	l := &rdpLive{start: time.Now(), in: make(chan []byte, 2), ctrl: cw, viewers: map[*rdpViewer]struct{}{}}
	go l.fanOut(pr)
	return l, pw, bufio.NewReader(cr)
}

func TestRdpLiveViewerStartsAtAWholeScreen(t *testing.T) {
	l, decoder, ctrl := testLive(t)
	v, err := l.join()
	if err != nil {
		t.Fatal(err)
	}
	if c, _ := ctrl.ReadString('\n'); c != "join\n" {
		t.Fatalf("command %q", c)
	}
	_, _ = io.WriteString(decoder, "3.end,1.7;4.sync,1.1;4.size,1.0,1.8,1.8;4.sync,1.2;")
	for _, want := range []string{"4.size,1.0,1.8,1.8;", "4.sync,1.2;"} {
		select {
		case got := <-v.out:
			if string(got) != want {
				t.Fatalf("got %q want %q", got, want)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("nothing for %q", want)
		}
	}
	l.leave(v)
	if c, _ := ctrl.ReadString('\n'); c != "idle\n" {
		t.Fatalf("command %q", c)
	}
}

func TestRdpLiveEndsWatchingWhenTheDecoderFallsBehind(t *testing.T) {
	l, _, ctrl := testLive(t)
	l.cmd = nil
	l.once.Do(func() {}) // no process in this test
	v, _ := l.join()
	_, _ = ctrl.ReadString('\n')
	for range 5 { // the queue holds 2
		l.server([]byte{3, 0, 0, 4})
	}
	select {
	case <-v.gone:
	case <-time.After(2 * time.Second):
		t.Fatal("the viewer was not let go")
	}
	if _, err := l.join(); err == nil {
		t.Fatal("a new viewer joined a broken session")
	}
}
