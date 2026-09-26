package microsandbox

import (
	"context"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// ResolveWorkspaceSourceRevision applies the common source rule inside the VM.
func (r *Runtime) ResolveWorkspaceSourceRevision(ctx context.Context, workspaceID string) (string, error) {
	return workspaceapi.ResolveSourceRevision(ctx, r, workspaceID)
}

var _ workspaceapi.WorkspaceSourceRevisionResolver = (*Runtime)(nil)
