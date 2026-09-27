package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/process"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

func TestStopResultKeepsCleanupFailuresVisible(t *testing.T) {
	stopped, stop := context.WithCancel(context.Background())
	stop()
	cleanupErr := errors.New("commit process workspace metadata: permission denied")
	signalErr := fmt.Errorf("serve: %w", context.Canceled)

	if err := stopResult(stopped, signalErr, nil); err != nil {
		t.Fatalf("clean signal stop = %v", err)
	}
	if err := stopResult(stopped, signalErr, cleanupErr); !errors.Is(err, cleanupErr) || errors.Is(err, context.Canceled) {
		t.Fatalf("signal stop with failed cleanup = %v", err)
	}
	if err := stopResult(context.Background(), signalErr, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation without a stop signal was treated as clean: %v", err)
	}
	serveErr := errors.New("listen: address in use")
	if err := stopResult(stopped, serveErr, cleanupErr); !errors.Is(err, serveErr) || !errors.Is(err, cleanupErr) {
		t.Fatalf("serve and cleanup failures = %v", err)
	}
}

// A signal stop exits cleanly, but a failed shutdown must still reach main's
// error report instead of hiding behind the cancellation. The embedded
// repository engine needs the built smithers-ffi library.
func TestSignalStopReportsShutdownFailure(t *testing.T) {
	if os.Getenv("SMITHERS_FFI_LIBRARY_PATH") == "" {
		t.Skip("set SMITHERS_FFI_LIBRARY_PATH to serve the embedded repository engine")
	}
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("needs POSIX directory permissions enforced for the current user")
	}
	dataRoot, workspace := serveFixture(t)
	if err := os.Chmod(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := stopDuringMigration(t, nil); err != nil {
		t.Fatalf("clean signal stop = %v", err)
	}

	err := stopDuringMigration(t, func() {
		// Close can no longer persist the stopped workspace metadata.
		if err := os.Chmod(workspace, 0o500); err != nil {
			t.Fatal(err)
		}
	})
	t.Cleanup(func() { _ = os.Chmod(workspace, 0o700) })
	if err == nil {
		t.Fatalf("signal stop hid a failed workspace shutdown under %s", dataRoot)
	}
	if errors.Is(err, context.Canceled) || !strings.Contains(err.Error(), "process workspace metadata") {
		t.Fatalf("signal stop with failed shutdown = %v", err)
	}
}

// serveFixture prepares a valid external-PostgreSQL serve configuration with
// one persisted workspace, and returns the data root and workspace directory.
func serveFixture(t *testing.T) (string, string) {
	t.Helper()
	dataRoot := t.TempDir()
	bundleDir := t.TempDir()
	executable := func(name string) string {
		path := filepath.Join(bundleDir, name)
		if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		return path
	}
	digest := func(path string) string {
		content, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(content)
		return hex.EncodeToString(sum[:])
	}
	hosts := map[string]any{}
	for family, flows := range map[string][]string{
		"coding":    {"coding/dispatch"},
		"librarian": {},
	} {
		name := "smithers-" + family + "-host"
		hosts[family] = map[string]any{"executable": name, "sha256": digest(executable(name)), "flows": flows}
	}
	manifest, err := json.Marshal(map[string]any{"version": 1, "hosts": hosts})
	if err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(bundleDir, "flow-hosts.json")
	if err := os.WriteFile(manifestPath, manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	bundle := executable("smithers-model-host")
	if err := os.WriteFile(bundle+".sha256", []byte(digest(bundle)+"  smithers-model-host\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	workspaces, err := process.New(process.Config{Root: filepath.Join(dataRoot, "workspaces")})
	if err != nil {
		t.Fatal(err)
	}
	created, err := workspaces.CreateWorkspace(context.Background(), workspaceapi.WorkspaceSpec{ID: "shutdown-probe"})
	if err != nil {
		t.Fatal(err)
	}
	if err := workspaces.Close(); err != nil {
		t.Fatal(err)
	}

	for name, value := range map[string]string{
		"SMITHERS_DATA_ROOT":                     dataRoot,
		"SMITHERS_NATIVE_POSTGRES_BIN":           "",
		"SMITHERS_FLOW_HOST_MANIFEST":            manifestPath,
		"SMITHERS_MODEL_HOST_BUNDLE":             bundle,
		"SMITHERS_NODE_BINARY":                   executable("node"),
		"SMITHERS_AUTH_BOOTSTRAP_TOKEN":          "operator-chosen-setup-token",
		"SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY": "shutdown-test-encryption-key",
	} {
		t.Setenv(name, value)
	}
	return dataRoot, filepath.Dir(created.Root)
}

// stopDuringMigration serves against a PostgreSQL address that accepts and
// never answers, runs beforeSignal once migration is connecting, then delivers
// the stop signal and returns run's result.
func stopDuringMigration(t *testing.T, beforeSignal func()) error {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	connected := make(chan net.Conn, 1)
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr == nil {
			connected <- conn
		}
	}()
	t.Setenv("SMITHERS_DATABASE_URL", "postgres://smithers@"+listener.Addr().String()+"/smithers?sslmode=disable&connect_timeout=30")

	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	done := make(chan error, 1)
	go func() { done <- run(ctx, nil) }()
	select {
	case conn := <-connected:
		defer conn.Close()
	case err := <-done:
		t.Fatalf("serve stopped before migration connected: %v", err)
	case <-time.After(30 * time.Second):
		t.Fatal("migration never connected to PostgreSQL")
	}
	if beforeSignal != nil {
		beforeSignal()
	}
	stop()
	select {
	case err := <-done:
		return err
	case <-time.After(30 * time.Second):
		t.Fatal("serve did not stop after the signal")
		return nil
	}
}
