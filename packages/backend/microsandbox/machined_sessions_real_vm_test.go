package microsandbox

import (
	"os"
	"testing"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// The branch-built test runs only as the workspace user. Its broker dependency
// is a test-only kernel fake: this proves the real Linux socketpair transport,
// not root spawn, cgroup enforcement, or install activation. Even these
// unprivileged tests boot through the approved-helper gate: the generic VM
// fixture self-pins checkout bytes and is insufficient root provenance.
func TestRealMicroVMMachinedSessionTransport(t *testing.T) {
	binary := os.Getenv("SMITHERS_MACHINED_SESSION_TEST_BIN")
	if binary == "" {
		if os.Getenv("SMITHERS_REQUIRE_MICROVM_TESTS") == "1" {
			t.Fatal("SMITHERS_MACHINED_SESSION_TEST_BIN must name the Linux tests/sessions.rs executable")
		}
		t.Skip("Linux session test executable is not set")
	}
	body, err := os.ReadFile(binary)
	require.NoError(t, err)
	runtime, _ := approvedRootBoundaryRuntime(t)
	ctx := operation("machined-session-transport")
	const id = "machined-session-transport"
	_, err = runtime.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: id})
	require.NoError(t, err)
	defer func() { require.NoError(t, runtime.DeleteWorkspace(operation("delete"), id)) }()
	require.NoError(t, runtime.WriteFile(ctx, id, "session-tests", body, 0755))
	result, err := runtime.ExecuteCommand(ctx, id, workspaceapi.Command{Args: []string{"/bin/sh", "-c", `test "$(id -u)" = 19999 && exec /workspace/session-tests --nocapture --test-threads=1`}})
	require.NoError(t, err)
	t.Log(result.Stdout)
	require.Equal(t, 0, result.ExitCode, result.Stderr)
	require.Contains(t, result.Stdout, "6 passed; 0 failed")
}
