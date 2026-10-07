package microsandbox

import (
	"context"
	"fmt"
	"testing"
	"time"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// This measures retained machine disks, not TODO delivery or capture safety.
// StopWorkspace is the machine operation behind the backend's suspended state.
// Sequential grants keep the campaign within one running machine's capacity.
func TestRealMicroVMTwentyRetainedWorkspaceDisks(t *testing.T) {
	r := realRuntime(t, t.TempDir())
	ctx, cancel := context.WithTimeout(operation("twenty-retained"), 18*time.Minute)
	defer cancel()
	var unique, allocated int64
	for i := 0; i < 20; i++ {
		id := fmt.Sprintf("retained-todo-%02d", i)
		_, err := r.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: id})
		require.NoError(t, err)
		require.NoError(t, r.WriteFile(ctx, id, "notes.txt", []byte(fmt.Sprintf("uncommitted notes %02d\n", i)), 0o600))
		require.NoError(t, r.StopWorkspace(ctx, id))
		dir := machineDirectory(r.cli.home, r.machineName(id))
		u, a := privateBytes(dir), allocatedBytes(dir)
		require.Positive(t, a, "stopped machine must retain allocated disk")
		unique += u
		allocated += a
		t.Logf("disk workspace=%s unique_bytes=%d allocated_clone_inclusive_bytes=%d", id, u, a)
	}
	t.Logf("retained_count=20 unique_bytes=%d allocated_clone_inclusive_bytes=%d; %s", unique, allocated, doctorLine(t, r, "stopped"))
	require.NoError(t, r.Close())
	reopened, err := New(context.Background(), r.config)
	require.NoError(t, err)
	t.Cleanup(func() { sweepOwner(t, reopened) })
	for i := 0; i < 20; i++ {
		id := fmt.Sprintf("retained-todo-%02d", i)
		state, err := reopened.InspectWorkspace(ctx, id)
		require.NoError(t, err)
		require.Equal(t, workspaceapi.WorkspaceStopped, state.State)
		_, err = reopened.StartWorkspace(ctx, id)
		require.NoError(t, err)
		contents, err := reopened.ReadFile(ctx, id, "notes.txt")
		require.NoError(t, err)
		require.Equal(t, fmt.Sprintf("uncommitted notes %02d\n", i), string(contents))
		require.NoError(t, reopened.StopWorkspace(ctx, id))
	}
}
