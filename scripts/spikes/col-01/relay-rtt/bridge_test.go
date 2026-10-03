package main

import (
	"bytes"
	"context"
	"net"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/col01/measure"
)

func TestBridgeIgnoresClosedReadinessProbeBeforeRealEchoGuest(t *testing.T) {
	binary := os.Getenv("COL01_ECHO_BINARY")
	if binary == "" {
		t.Fatal("COL01_ECHO_BINARY must name the real host-built Rust echo")
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	listener.(*net.TCPListener).SetDeadline(time.Now().Add(3 * time.Second))
	probe, err := net.Dial("tcp4", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	probe.Close()
	// Fault injection uses real TCP peers. They must never become the measured
	// echo connection, even if they send complete but invalid handshake data.
	for _, malformed := range [][]byte{{0, 0, 0, 0}, {0, 16, 0, 1}, {0, 0}} {
		peer, err := net.Dial("tcp4", listener.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		if _, err := peer.Write(malformed); err != nil {
			peer.Close()
			t.Fatal(err)
		}
		peer.Close()
	}
	wrong, err := net.Dial("tcp4", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	if err := measure.WriteFrame(wrong, []byte("col01-dochost")); err != nil {
		wrong.Close()
		t.Fatal(err)
	}
	wrong.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, "dial", listener.Addr().String())
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { cmd.Process.Kill(); cmd.Wait() }()
	conn, err := acceptBridge(listener, "echo")
	if err != nil {
		t.Fatalf("accept guest after closed readiness probe: %v", err)
	}
	defer conn.Close()
	for _, size := range []int{64, 4096} {
		want := payload(size, size)
		if _, err := exchange(conn, want); err != nil {
			t.Fatalf("real guest %d-byte frame after probe: %v", size, err)
		}
	}
	// One valid handshake identifies the connection; subsequent framed data is
	// echoed unchanged, including bytes resembling the marker.
	if _, err := exchange(conn, bytes.Repeat([]byte("col01-echo"), 10)); err != nil {
		t.Fatal(err)
	}
}
