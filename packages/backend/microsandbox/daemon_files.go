package microsandbox

import (
	"context"

	"github.com/smithersai/smithers/packages/backend/internal/machined"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// CompareWriteFiles uses only the admitted daemon. The unqualified S1 guest
// candidate remains inaccessible; absence of a daemon never selects it.
func (r *Runtime) CompareWriteFiles(ctx context.Context, id string, changes []workspaceapi.FileMutation) (*workspaceapi.FileWriteResult, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if _, err := r.runningWorkspace(id); err != nil {
		return nil, err
	}
	return (machined.WorkspaceWriter{Client: &r.machined}).CompareWriteFiles(ctx, id, changes)
}
