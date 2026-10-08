package microsandbox

import (
	"context"
	"errors"
	"fmt"
	"io/fs"

	"github.com/smithersai/smithers/packages/backend/internal/machined"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// CompareWriteFiles uses only the admitted daemon. The unqualified S1 guest
// candidate remains inaccessible; absence of a daemon never selects it.
func (r *Runtime) CompareWriteFiles(ctx context.Context, id string, changes []workspaceapi.FileMutation) (*workspaceapi.FileWriteResult, error) {
	ctx, releaseFence, fenceErr := r.CleanupGate.Enter(ctx, id)
	if fenceErr != nil {
		return nil, fenceErr
	}
	defer releaseFence()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if _, err := r.runningWorkspace(id); err != nil {
		return nil, err
	}
	return (machined.WorkspaceWriter{Client: &r.machined, EnsureReady: r.EnsureMachined}).CompareWriteFiles(ctx, id, changes)
}

// ReadWorkingCopyFile uses the admitted per-boot daemon; a failed connection never
// selects the one-shot guest reader.
func (r *Runtime) ReadWorkingCopyFile(ctx context.Context, workspaceID, path string) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := r.EnsureMachined(ctx, workspaceID); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("%w: %v", workspaceapi.ErrReadFileUnavailable, err)
	}
	file, err := r.machined.ReadFile(ctx, workspaceID, path, "")
	if err != nil {
		var refusal *machined.SessionError
		if errors.As(err, &refusal) && refusal.Code == "not_found" {
			return nil, fs.ErrNotExist
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("%w: %v", workspaceapi.ErrReadFileUnavailable, err)
	}
	if int64(len(file.Content)) > r.config.FileReadLimit && r.config.FileReadLimit > 0 {
		return nil, fmt.Errorf("%w: file exceeds read limit", ErrUnavailable)
	}
	return file.Content, nil
}
