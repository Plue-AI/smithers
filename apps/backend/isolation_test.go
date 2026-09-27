package main

import (
	"context"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/process"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

func TestProcessIsolationKeepsOneTrustedRuntime(t *testing.T) {
	t.Setenv("SMITHERS_WORKSPACE_ISOLATION", "")
	runtimes, err := openExecutionRuntimes(context.Background(), t.TempDir(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer runtimes.Close()
	if _, ok := runtimes.workspace.(*process.Runtime); !ok || runtimes.control != runtimes.workspace {
		t.Fatalf("process mode composed %T/%T", runtimes.workspace, runtimes.control)
	}
	if runtimes.workspace.Isolation() != workspaceapi.IsolationTrustedProcess {
		t.Fatal("process mode must not claim isolation")
	}
}

// microvm mode never falls back to host processes: a missing, non-executable
// or unqualified msb refuses startup.
func TestMicroVMIsolationRefusesWithoutMicrosandbox(t *testing.T) {
	notMSB := filepath.Join(t.TempDir(), "msb")
	if err := os.WriteFile(notMSB, []byte("#!/bin/sh\necho 'not msb'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	for name, binary := range map[string]string{
		"unset":        "",
		"missing":      filepath.Join(t.TempDir(), "absent", "msb"),
		"relative":     "msb",
		"wrong binary": notMSB,
	} {
		t.Run(name, func(t *testing.T) {
			t.Setenv("SMITHERS_WORKSPACE_ISOLATION", "microvm")
			t.Setenv("SMITHERS_MICROSANDBOX_BIN", binary)
			runtimes, err := openExecutionRuntimes(context.Background(), t.TempDir(), guestBundle(t))
			if err == nil {
				_ = runtimes.Close()
				t.Fatal("microvm mode started without Microsandbox")
			}
			if !errors.Is(err, microsandbox.ErrUnavailable) || !strings.Contains(err.Error(), "refuses to start") {
				t.Fatalf("refusal = %v", err)
			}
		})
	}
}

func TestIsolationModeIsValidated(t *testing.T) {
	t.Setenv("SMITHERS_WORKSPACE_ISOLATION", "container")
	if _, err := openExecutionRuntimes(context.Background(), t.TempDir(), t.TempDir()); err == nil {
		t.Fatal("unknown isolation mode accepted")
	}
	t.Setenv("SMITHERS_WORKSPACE_ISOLATION", "microvm")
	t.Setenv("SMITHERS_SERVER_ADDR", ":0")
	t.Setenv("SMITHERS_MICROSANDBOX_BIN", "/bin/sh")
	if _, err := openExecutionRuntimes(context.Background(), t.TempDir(), guestBundle(t)); err == nil || !strings.Contains(err.Error(), "fixed SMITHERS_SERVER_ADDR port") {
		t.Fatalf("dynamic port accepted: %v", err)
	}
}

// guestBundle is a Flow host bundle holding a Linux arm64 helper header and
// names it as the coding host's workspace helper.
func guestBundle(t *testing.T) string {
	t.Helper()
	bundle := t.TempDir()
	header := make([]byte, 64)
	copy(header, "\x7fELF\x02\x01\x01")
	binary.LittleEndian.PutUint16(header[18:], 183)
	helper := filepath.Join(bundle, "linux-arm64", "smithers-jj-export")
	if err := os.MkdirAll(filepath.Dir(helper), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(helper, header, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY", helper)
	return bundle
}

// A coding host in a guest needs the Linux helper planted beside it: a
// helper outside the bundle, absent or built for the Mac refuses startup.
func TestMicroVMIsolationRefusesWithoutGuestHelper(t *testing.T) {
	t.Setenv("SMITHERS_WORKSPACE_ISOLATION", "microvm")
	t.Setenv("SMITHERS_SERVER_ADDR", "127.0.0.1:4000")
	t.Setenv("SMITHERS_MICROSANDBOX_BIN", "/bin/sh")
	bundle := guestBundle(t)
	darwin := filepath.Join(bundle, "smithers-jj-export-darwin")
	if err := os.WriteFile(darwin, []byte{0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}, 0o755); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "smithers-jj-export")
	for name, helper := range map[string]string{
		"unset":   "",
		"outside": outside,
		"missing": filepath.Join(bundle, "absent"),
		"darwin":  darwin,
	} {
		t.Run(name, func(t *testing.T) {
			t.Setenv("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY", helper)
			runtimes, err := openExecutionRuntimes(context.Background(), t.TempDir(), bundle)
			if err == nil {
				_ = runtimes.Close()
				t.Fatal("microvm mode started without a guest workspace helper")
			}
			if !strings.Contains(err.Error(), "refuses to start") || !strings.Contains(err.Error(), "helper") && !strings.Contains(err.Error(), "SMITHERS_WORKSPACE_JJ_EXPORT_BINARY") {
				t.Fatalf("refusal = %v", err)
			}
		})
	}
	// The same bundle with the Linux helper passes the helper check and is
	// refused only by the (fake) Microsandbox qualification.
	t.Setenv("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY", filepath.Join(bundle, "linux-arm64", "smithers-jj-export"))
	_, err := openExecutionRuntimes(context.Background(), t.TempDir(), bundle)
	if !errors.Is(err, microsandbox.ErrUnavailable) {
		t.Fatalf("a Linux helper was refused: %v", err)
	}
}
