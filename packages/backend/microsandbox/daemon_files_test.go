package microsandbox

import (
	"testing"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

func TestDaemonCompareWriteNeverFallsBackToGuest(t *testing.T) {
	// No CLI is installed in this fixture. Any attempt to borrow the guest's
	// unqualified candidate or unconditional writer would panic.
	r := &Runtime{workspaces: map[string]*workspace{"a": newWorkspace(metadata{ID: "a", Machine: "vm", State: string(workspaceapi.WorkspaceRunning)}, "")}}
	ctx := workspaceapi.WithOperation(t.Context(), workspaceapi.Operation{TenantID: "1", PrincipalID: "2", OperationID: "write"})
	_, err := r.CompareWriteFiles(ctx, "a", []workspaceapi.FileMutation{{Path: "a", BaseDigest: "absent", Content: []byte("new")}})
	require.ErrorIs(t, err, workspaceapi.ErrCompareWriteUnavailable)
}
