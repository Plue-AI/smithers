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

func revocationTestRoot(t *testing.T) string {
	t.Helper()
	// Keep the Unix address below Darwin's limit even under the macOS TMPDIR.
	root, err := os.MkdirTemp("", "rev-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(root); err != nil {
			t.Error(err)
		}
	})
	return root
}

func TestInstalledRevocationBoundaryWaitsForDrainAndRejectsMalformedRequests(t *testing.T) {
	root := revocationTestRoot(t)
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
	// Create the unsafe ancestor explicitly; TMPDIR may be a protected home.
	// Its leaf mode alone must never confer host authority.
	root := t.TempDir()
	if err := os.Chmod(root, 0777); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chmod(root, 0700); err != nil {
			t.Error(err)
		}
	})
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
