package microsandbox

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// These named reference-host suites exercise the installed adapter and real
// guest broker. They supplement the composed PR-reopen suite; they do not
// replace its retained-object reconstruction receipt.
func TestCleanupRepositoryExecutionBoundary(t *testing.T) {
	if os.Getenv("SMITHERS_GUEST_ROOT_BOUNDARY_CHECK") == "1" {
		require.NotEmpty(t, os.Getenv("SMITHERS_CHECK_BUNDLE"), "cleanup security requires the approved installed bundle")
	}
	r, digest := approvedRootBoundaryRuntime(t)
	require.NotZero(t, os.Geteuid(), "cleanup host must be the install service user")
	ctx := operation("cleanup-repository-boundary")
	const id = "cleanup-repository-boundary"
	_, err := r.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: id})
	require.NoError(t, err)
	canary := filepath.Join(t.TempDir(), "host-execution")
	hostile := fmt.Sprintf("#!/bin/sh\nprintf hostile > %q\nprintf '%%s\\n' \"$(id -u)\" >> /workspace/guest-execution\n", canary)
	for _, path := range []string{".hooks/post-checkout", ".hooks/pre-commit", "hostile.sh"} {
		require.NoError(t, r.WriteFile(ctx, id, path, []byte(hostile), 0755))
	}
	require.NoError(t, r.WriteFile(ctx, id, ".gitconfig", []byte("[core]\n hooksPath = /workspace/.hooks\n[filter \"hostile\"]\n smudge = /workspace/hostile.sh\n clean = /workspace/hostile.sh\n"), 0600))
	// Positive control: branch bytes execute only through guest command admission.
	result, err := r.ExecuteCommand(ctx, id, workspaceapi.Command{Args: []string{"/bin/sh", "/workspace/hostile.sh"}})
	require.NoError(t, err)
	require.Zero(t, result.ExitCode, result.Stderr)
	guest, err := r.ReadFile(ctx, id, "guest-execution")
	require.NoError(t, err)
	require.Equal(t, "19999\n", string(guest))
	require.NoFileExists(t, canary, "guest execution must not reach the host path")
	require.NoError(t, r.WithCaptureWritersExcluded(ctx, id, func(_ctx context.Context) error { return nil }))
	require.NoError(t, r.StopWorkspace(ctx, id))
	require.NoError(t, r.ReclaimWorkspaceDisk(ctx, id))
	require.NoFileExists(t, canary)
	t.Logf("host_euid=%d approved_helper_sha256=%s installed_adapter=%s guest_euid=19999 host_canary_absent=true", os.Geteuid(), digest, r.cli.binary)
}

func TestCleanupRootInputsValidatedBeforeUse(t *testing.T) {
	if os.Getenv("SMITHERS_GUEST_ROOT_BOUNDARY_CHECK") == "1" {
		require.NotEmpty(t, os.Getenv("SMITHERS_CHECK_BUNDLE"), "cleanup security requires the approved installed bundle")
	}
	r, digest := approvedRootBoundaryRuntime(t)
	ctx := operation("cleanup-root-inputs")
	for _, id := range []string{"cleanup-target", "cleanup-other"} {
		_, err := r.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: id})
		require.NoError(t, err)
	}
	_, err := r.StartService(ctx, "cleanup-other", workspaceapi.ServiceSpec{Name: "other", Command: workspaceapi.Command{Args: []string{"/bin/sh", "-c", "while :; do sleep 1; done"}}})
	require.NoError(t, err)
	// A service name registered only in another machine is never a root handle.
	require.NoError(t, r.StopService(ctx, "cleanup-target", "other"))
	for _, selector := range []string{"../cleanup-other", "--all", "/sys/fs/cgroup/smithers/other", "other/../../root", "nul\x00selector"} {
		// Installed fixed helper validates an opaque command handle before cgroup use.
		_, err := r.guest(ctx, r.machineName("cleanup-target"), nil, "kill", selector)
		require.Error(t, err, "selector must be refused before signal: %q", selector)
	}
	require.Error(t, r.StopService(ctx, "../cleanup-other", "other"))
	services, err := r.ListServices(ctx, "cleanup-other")
	require.NoError(t, err)
	require.Len(t, services, 1)
	require.Equal(t, workspaceapi.ServiceRunning, services[0].State)
	require.NoError(t, r.StopService(ctx, "cleanup-other", "other"))
	services, err = r.ListServices(ctx, "cleanup-other")
	require.NoError(t, err)
	require.Len(t, services, 1)
	require.NotEqual(t, workspaceapi.ServiceRunning, services[0].State)
	t.Logf("approved_helper_sha256=%s forged_selectors_refused=5 other_machine_unchanged=true", digest)
}
