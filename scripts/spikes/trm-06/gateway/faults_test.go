package main

import (
	"context"
	"io"
	"net"
	"path/filepath"
	"testing"
	"time"
)

func TestOwnerControlCutsOwnedTransportAndRefusesReconnect(t *testing.T) {
	faults := &relayFaults{}
	listener, err := net.Listen("unix", filepath.Join(t.TempDir(), "control.sock"))
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		serveRevocation(ctx, listener, make(chan revocationRequest, 1), &ownerControl{faults: faults})
		close(done)
	}()
	guestListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer guestListener.Close()
	peer, err := net.Dial("tcp", guestListener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	transport, err := guestListener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	owned, err := faults.admit(transport)
	if err != nil {
		t.Fatal(err)
	}
	defer owned.Close()
	caller, err := net.Dial("unix", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer caller.Close()
	if err = writeAll(caller, []byte("cut-relay\n")); err != nil {
		t.Fatal(err)
	}
	var ack [4]byte
	if _, err = io.ReadFull(caller, ack[:]); err != nil || string(ack[:]) != "cut\n" {
		t.Fatalf("ack %q %v", ack, err)
	}
	peer.SetReadDeadline(time.Now().Add(time.Second))
	if n, err := peer.Read(make([]byte, 1)); n != 0 || err != io.EOF {
		t.Fatalf("transport survived cut: %d %v", n, err)
	}
	a, b := net.Pipe()
	defer b.Close()
	if _, err = faults.admit(a); err == nil {
		t.Fatal("admitted reconnect during real owner cut")
	}
	if n, err := b.Read(make([]byte, 1)); n != 0 || err != io.EOF {
		t.Fatal("denied transport retained")
	}
	faults.mu.Lock()
	if time.Until(faults.deniedUntil) < 9*time.Second {
		t.Fatal("owner cut is shorter than ten seconds")
	}
	if len(faults.connections) != 0 {
		t.Fatal("cut lost owned connections")
	}
	faults.mu.Unlock()
	// A zero-duration cut is an explicit local fixture reset, never a member op.
	faults.cut(0)
	a, b = net.Pipe()
	defer b.Close()
	owned, err = faults.admit(a)
	if err != nil {
		t.Fatal(err)
	}
	owned.Close()
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("owner control outlived cancellation")
	}
}
