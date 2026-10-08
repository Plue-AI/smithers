package microsandbox

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

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
	require.NoError(t, os.WriteFile(canary, []byte("positive host control"), 0600))
	require.NoError(t, os.Remove(canary))
	hostile := fmt.Sprintf("#!/bin/sh\nprintf hostile > %q\nprintf '%%s\\n' \"$(id -u)\" >> /workspace/guest-execution\n", canary)
	for _, path := range []string{".hooks/post-checkout", ".hooks/pre-commit", "hostile.sh"} {
		require.NoError(t, writeGuestFixture(r, ctx, id, path, []byte(hostile), 0755))
	}
	require.NoError(t, writeGuestFixture(r, ctx, id, ".gitconfig", []byte("[core]\n hooksPath = /workspace/.hooks\n[filter \"hostile\"]\n smudge = /workspace/hostile.sh\n clean = /workspace/hostile.sh\n"), 0600))
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
	require.NotZero(t, os.Geteuid(), "cleanup host must be the install service user")
	ctx := operation("cleanup-root-inputs")
	for _, id := range []string{"cleanup-target", "cleanup-other"} {
		_, err := r.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: id})
		require.NoError(t, err)
		// Member import bytes are deliberately hostile to root startup. The
		// positive control proves they execute after the normal UID drop.
		require.NoError(t, writeGuestFixture(r, ctx, id, "sitecustomize.py", []byte("import os\nwith open('/workspace/import-observed','a') as out: out.write(str(os.geteuid())+'\\n')\n"), 0600))
		positive, err := r.ExecuteCommand(ctx, id, workspaceapi.Command{Args: []string{"/usr/bin/python3", "-c", "import os; print(os.geteuid())"}, Environment: map[string]string{"PYTHONPATH": "/workspace"}})
		require.NoError(t, err)
		require.Zero(t, positive.ExitCode, positive.Stderr)
		require.Equal(t, "19999\n", positive.Stdout)
		observed, err := r.ReadFile(ctx, id, "import-observed")
		require.NoError(t, err)
		require.Equal(t, "19999\n", string(observed))
	}
	_, err := r.StartService(ctx, "cleanup-other", workspaceapi.ServiceSpec{Name: "other", Command: workspaceapi.Command{Args: []string{"/bin/sh", "-c", "while :; do sleep 1; done"}}})
	require.NoError(t, err)
	// Send the actual server-generated handle from another machine through
	// the same fixed helper used by StopService. It must address no target
	// cgroup, and the foreign machine must keep its live process.
	r.mu.Lock()
	foreignHandle := r.workspaces["cleanup-other"].services["other"].command.id
	r.mu.Unlock()
	require.NotEmpty(t, foreignHandle)
	_, err = r.guest(ctx, r.machineName("cleanup-target"), nil, "kill", foreignHandle)
	require.NoError(t, err, "an absent local handle is an idempotent no-op")
	// A service name registered only in another machine is never a root handle.
	require.NoError(t, r.StopService(ctx, "cleanup-target", "other"))
	for _, selector := range []string{"../cleanup-other", "--all", "/sys/fs/cgroup/smithers/other", "other/../../root", "nul\x00selector"} {
		// The installed host adapter refuses selectors before helper launch.
		_, err := r.guest(ctx, r.machineName("cleanup-target"), nil, "kill", selector)
		require.Error(t, err, "selector must be refused before signal: %q", selector)
		require.Contains(t, err.Error(), "invalid cleanup command identity", "transport failure is not selector validation")
	}
	require.Error(t, r.StopService(ctx, "../cleanup-other", "other"))
	services, err := r.ListServices(ctx, "cleanup-other")
	require.NoError(t, err)
	require.Len(t, services, 1)
	require.Equal(t, workspaceapi.ServiceRunning, services[0].State)
	require.Eventually(t, func() bool {
		alive, err := r.ExecuteCommand(ctx, "cleanup-other", workspaceapi.Command{Args: []string{"/bin/sh", "-c", "test -s /sys/fs/cgroup/smithers/" + foreignHandle + "/cgroup.procs && id -u"}})
		return err == nil && alive.ExitCode == 0 && alive.Stdout == "19999\n"
	}, 30*time.Second, 100*time.Millisecond, "foreign machine must retain a live kernel process, not only a cached service row")
	require.NoError(t, r.StopService(ctx, "cleanup-other", "other"))
	services, err = r.ListServices(ctx, "cleanup-other")
	require.NoError(t, err)
	require.Len(t, services, 1)
	require.NotEqual(t, workspaceapi.ServiceRunning, services[0].State)
	for _, id := range []string{"cleanup-target", "cleanup-other"} {
		observed, err := r.ReadFile(ctx, id, "import-observed")
		require.NoError(t, err)
		require.Equal(t, "19999\n", string(observed), "privileged helper must never import branch bytes")
	}
	t.Logf("approved_helper_sha256=%s forged_selectors_refused=5 other_machine_unchanged=true", digest)
}
