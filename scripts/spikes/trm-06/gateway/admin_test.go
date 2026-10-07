package main

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"sync/atomic"
	"testing"
	"time"
)

func TestReservedControlRevokesWhenNewAdmissionIsUnavailable(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	accepted := make(chan net.Conn, 1)
	go func() { stream, _ := listener.Accept(); accepted <- stream }()
	var dials atomic.Int32
	admin := newAdminControl(context.Background(), func(ctx context.Context) (net.Conn, error) {
		dials.Add(1)
		return (&net.Dialer{}).DialContext(ctx, "tcp", address)
	})
	defer admin.close()
	if err = admin.ensure(context.Background()); err != nil {
		t.Fatal(err)
	}
	guest := <-accepted
	defer guest.Close()
	listener.Close()
	// No new TCP connection is possible now, modeling occupied admission. The
	// trusted real TCP transport already held must still carry kill_sessions.
	done := make(chan error, 1)
	go func() {
		var length uint32
		if err := binary.Read(guest, binary.BigEndian, &length); err != nil {
			done <- err
			return
		}
		body := make([]byte, length)
		_, err := io.ReadFull(guest, body)
		if err != nil {
			done <- err
			return
		}
		if string(body) != "{\"type\":\"kill_sessions\"}" {
			done <- io.ErrUnexpectedEOF
			return
		}
		done <- (&frameWriter{w: guest}).write(map[string]bool{"ok": true})
	}()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err = admin.revoke(ctx); err != nil {
		t.Fatal(err)
	}
	if err = <-done; err != nil {
		t.Fatal(err)
	}
	if dials.Load() != 1 {
		t.Fatalf("revocation tried new admission %d times", dials.Load())
	}
	if err = admin.revoke(ctx); err == nil {
		t.Fatal("reused one-shot revocation lease")
	}
}
func TestReservedControlCancellationClosesActualTransport(t *testing.T) {
	host, guest := net.Pipe()
	defer guest.Close()
	admin := newAdminControl(context.Background(), func(context.Context) (net.Conn, error) { return host, nil })
	defer admin.close()
	if err := admin.ensure(context.Background()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := admin.revoke(ctx); err == nil {
		t.Fatal("accepted canceled revocation")
	}
	guest.SetReadDeadline(time.Now().Add(time.Second))
	if n, _ := guest.Read(make([]byte, 1)); n != 0 {
		t.Fatal("canceled control retained a transport")
	}
}
