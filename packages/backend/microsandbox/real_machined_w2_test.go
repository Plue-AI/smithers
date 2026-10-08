package microsandbox

import (
	"context"
	"os"
	"testing"
	"time"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// Run the cross-compiled Rust component tests through the real machine's file
// and execution boundaries. Branch-built test bytes run only as agent, never
// as root, and are not installed in the guest image. This is component evidence;
// it does not certify composed daemon capture or host transactional receipts.
func TestRealMicroVMMachinedW2Objects(t *testing.T) {
	binary := os.Getenv("SMITHERS_MACHINED_W2_TEST_BIN")
	if binary == "" {
		if os.Getenv("SMITHERS_REQUIRE_MICROVM_TESTS") == "1" {
			t.Fatal("SMITHERS_MACHINED_W2_TEST_BIN is required")
		}
		t.Skip("cross-compiled Rust component test binary is not set")
	}
	bytes, err := os.ReadFile(binary)
	require.NoError(t, err)
	require.Greater(t, len(bytes), 4)
	require.Equal(t, []byte{0x7f, 'E', 'L', 'F'}, bytes[:4])
	runtime, _ := approvedRootBoundaryRuntime(t)
	ctx, cancel := context.WithTimeout(operation("w2-objects"), 3*time.Minute)
	defer cancel()
	_, err = runtime.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: "w2-objects"})
	require.NoError(t, err)
	defer func() { require.NoError(t, runtime.DeleteWorkspace(operation("delete-w2"), "w2-objects")) }()
	require.NoError(t, writeGuestFixture(runtime, ctx, "w2-objects", "w2-component-tests", bytes, 0o755))
	result, err := runtime.ExecuteCommand(ctx, "w2-objects", workspaceapi.Command{
		Args: []string{"/bin/sh", "-c", "test \"$(id -u)\" = 19999 && exec /workspace/w2-component-tests git::tests --nocapture --test-threads=1"},
	})
	require.NoError(t, err)
	t.Log(result.Stdout)
	t.Log(result.Stderr)
	require.Equal(t, 0, result.ExitCode)
	for _, name := range []string{
		"bundle_verified_import_does_not_publish_advertised_pending_ref",
		"invalid_or_oversized_incoming_never_advances_a_ref_and_removes_spool",
		"restart_retains_pin_and_stale_receipt_preserves_acknowledged_head",
		"restart_removes_interrupted_transfer_without_touching_repository_refs",
		"restart_refuses_symlinks_hardlinks_and_unexpected_spool_entries",
	} {
		require.Contains(t, result.Stdout, "test git::tests::"+name+" ... ok")
	}
	require.Contains(t, result.Stdout, "0 failed")
}

func TestRealMicroVMMachinedW2Recovery(t *testing.T) {
	fixtures := []struct{ environment, name, filter, expected string }{
		{"SMITHERS_MACHINED_W2_BARRIER_BIN", "barrier", "", "test killed_rewrite_retains_admission_barrier_until_restore_ten_times ... ok"},
		{"SMITHERS_MACHINED_W2_LINK_BIN", "link", "", "test authenticated_status_cannot_report_ready_after_interrupted_rewrite ... ok"},
		{"SMITHERS_MACHINED_W2_RECONCILE_BIN", "reconcile", "", "test failed_wake_retains_restart_barrier_and_success_removes_it ... ok"},
		{"SMITHERS_MACHINED_W2_TEST_BIN", "files", "files::tests", "test files::tests::wrapper_delegates_rewrite_restore_to_native_core ... ok"},
	}
	for _, fixture := range fixtures {
		binary := os.Getenv(fixture.environment)
		if binary == "" {
			if os.Getenv("SMITHERS_REQUIRE_MICROVM_TESTS") == "1" {
				t.Fatalf("%s is required", fixture.environment)
			}
			t.Skipf("%s is not set", fixture.environment)
		}
	}
	runtime, _ := approvedRootBoundaryRuntime(t)
	ctx, cancel := context.WithTimeout(operation("w2-recovery"), 3*time.Minute)
	defer cancel()
	_, err := runtime.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: "w2-recovery"})
	require.NoError(t, err)
	defer func() { require.NoError(t, runtime.DeleteWorkspace(operation("delete-w2"), "w2-recovery")) }()
	for _, fixture := range fixtures {
		binary := os.Getenv(fixture.environment)
		bytes, err := os.ReadFile(binary)
		require.NoError(t, err)
		require.NoError(t, writeGuestFixture(runtime, ctx, "w2-recovery", fixture.name, bytes, 0o755))
		result, err := runtime.ExecuteCommand(ctx, "w2-recovery", workspaceapi.Command{
			Args: []string{"/bin/sh", "-c", "test \"$(id -u)\" = 19999 && exec /workspace/" + fixture.name + " " + fixture.filter + " --nocapture --test-threads=1"},
		})
		require.NoError(t, err)
		t.Log(result.Stdout)
		t.Log(result.Stderr)
		require.Equal(t, 0, result.ExitCode)
		require.Contains(t, result.Stdout, fixture.expected)
		require.Contains(t, result.Stdout, "0 failed")
	}
}
