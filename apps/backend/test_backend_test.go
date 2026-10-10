package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/smithersai/smithers/packages/backend/flowhost"
)

// testBackendServe selects the trusted-process test backend inside this
// package's test binary. Only `go test -c ./apps/backend` builds that binary;
// `go build ./apps/backend`, the release and packaging build, compiles no
// _test.go file, so the shipped backend cannot reach this entry or its flag.
const testBackendServe = "SMITHERS_TEST_BACKEND_SERVE"

// TestServeTrustedProcessBackend is the real-backend e2e entry. A harness
// builds it with `go test -c -o <bin> ./apps/backend` and runs
// `<bin> -test.run=^TestServeTrustedProcessBackend$ -test.timeout=0` with
// SMITHERS_TEST_BACKEND_SERVE=1 and the backend's usual environment. It
// serves the production composition with trusted-process workspaces and the
// Go journey rehearsal's trusted-process branch machines and machine images
// until SIGINT or SIGTERM, then shuts down cleanly. See
// apps/app/scripts/mode-matrix/local-own.ts.
func TestServeTrustedProcessBackend(t *testing.T) {
	if os.Getenv(testBackendServe) != "1" {
		t.Skip("the trusted-process test backend runs only under " + testBackendServe + "=1")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	test := trustedProcessTestBackend
	test.daemon = os.Getenv("SMITHERS_REHEARSAL_MACHINED_BINARY")
	if err := serve(ctx, nil, os.Executable, test); err != nil {
		t.Fatal(err)
	}
}

// trustedProcessTestBackend is the test backend's one exception set.
var trustedProcessTestBackend = testBackend{flowHost: flowhost.WorkspaceLauncherConfig{AllowTrustedProcessForTests: true}, machines: true}

// The shipped binary refuses trusted-process isolation even when it is given
// the test backend's selector and every isolation spelling. It refuses before
// it loads any input or prepares any state, so it never reaches the
// trusted-process machines either: they compose only on that runtime
// (compose TestTrustedProcessMachinesComposeOnlyForTests).
func TestReleaseBinaryRefusesTrustedProcessIsolation(t *testing.T) {
	if testing.Short() {
		t.Skip("builds the release backend")
	}
	binary := filepath.Join(t.TempDir(), "smithers-backend")
	build := exec.Command("go", "build", "-o", binary, ".")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build release backend: %v\n%s", err, output)
	}
	for _, mode := range []string{"", "process", "PROCESS"} {
		t.Run("isolation="+mode, func(t *testing.T) {
			root := t.TempDir()
			command := exec.Command(binary)
			command.Env = append(os.Environ(),
				testBackendServe+"=1",
				"SMITHERS_REHEARSAL_MACHINED_BINARY="+filepath.Join(root, "untrusted-daemon"),
				"SMITHERS_WORKSPACE_ISOLATION="+mode,
				"SMITHERS_DATA_ROOT="+root,
				"SMITHERS_DATABASE_URL=postgres://unused",
				"SMITHERS_FLOW_HOST_MANIFEST="+filepath.Join(root, "absent-manifest"),
			)
			output, err := command.CombinedOutput()
			var exit *exec.ExitError
			if !errors.As(err, &exit) || exit.ExitCode() != 1 || !strings.Contains(string(output), "process isolation is tests-only") {
				t.Fatalf("release backend with isolation %q = %v\n%s", mode, err, output)
			}
			if entries, err := os.ReadDir(root); err != nil || len(entries) != 0 {
				t.Fatalf("release backend produced state: %v, %v", entries, err)
			}
		})
	}
}
