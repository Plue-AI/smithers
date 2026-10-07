package main

import (
	"context"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestInstalledRevocationBoundaryWaitsForDrainAndRejectsMalformedRequests(t *testing.T) {
	// Keep the socket below Darwin's sockaddr_un path limit independently
	// of the test name and the caller's temporary-directory prefix.
	root, err := os.MkdirTemp("/tmp", "smthrs-ctl-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	path := filepath.Join(root, "control.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	requests := make(chan revocationRequest, 1)
	done := make(chan struct{})
	go func() { serveRevocation(ctx, listener, requests); close(done) }()
	malformed, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	if err = writeAll(malformed, []byte("root!!\n")); err != nil {
		t.Fatal(err)
	}
	if n, err := malformed.Read(make([]byte, 1)); n != 0 || err != io.EOF {
		t.Fatalf("malformed request: %d %v", n, err)
	}
	malformed.Close()
	select {
	case <-requests:
		t.Fatal("malformed input reached drain")
	default:
	}
	result := make(chan error, 1)
	go func() { result <- requestInstalledRevocation(ctx, path) }()
	var request revocationRequest
	select {
	case request = <-requests:
	case <-time.After(time.Second):
		t.Fatal("no revocation request")
	}
	select {
	case <-result:
		t.Fatal("reported completion before drain")
	case <-time.After(20 * time.Millisecond):
	}
	request.reply <- nil
	if err = <-result; err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("control server retained socket")
	}
}
func TestProtectedStateRefusesSymlinksAndOverbroadModes(t *testing.T) {
	// /tmp is intentionally untrusted. No fixtures under /tmp can become host
	// authority even if their leaf mode matches. This tests the real fd walk.
	root := t.TempDir()
	path := filepath.Join(root, "config.json")
	if err := os.WriteFile(path, []byte(`{"listen":"127.0.0.1:48000"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readState(path, 65536); err == nil {
		t.Fatal("accepted writable ancestor")
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if _, err := readState(link, 65536); err == nil {
		t.Fatal("accepted symlink")
	}
	if err := installedMain(context.Background(), "run"); err == nil {
		t.Fatal("test executable became installed authority")
	}
}
