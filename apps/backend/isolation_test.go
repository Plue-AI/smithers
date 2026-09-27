package main

import (
	"context"
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
	runtimes, err := openExecutionRuntimes(context.Background(), t.TempDir())
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
			runtimes, err := openExecutionRuntimes(context.Background(), t.TempDir())
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
	if _, err := openExecutionRuntimes(context.Background(), t.TempDir()); err == nil {
		t.Fatal("unknown isolation mode accepted")
	}
	t.Setenv("SMITHERS_WORKSPACE_ISOLATION", "microvm")
	t.Setenv("SMITHERS_SERVER_ADDR", ":0")
	t.Setenv("SMITHERS_MICROSANDBOX_BIN", "/bin/sh")
	if _, err := openExecutionRuntimes(context.Background(), t.TempDir()); err == nil || !strings.Contains(err.Error(), "fixed SMITHERS_SERVER_ADDR port") {
		t.Fatalf("dynamic port accepted: %v", err)
	}
}
