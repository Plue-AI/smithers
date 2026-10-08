package process

import (
	"context"
	"errors"
	"os"
	"path/filepath"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// WithCaptureWritersExcluded joins runtime admission with current child state.
// This adapter is for trusted-process rehearsals, not guest qualification.
func (r *Runtime) WithCaptureWritersExcluded(ctx context.Context, id string, visit func(context.Context) error) error {
	return r.CleanupGate.Exclude(ctx, id, func(ctx context.Context) error {
		r.mu.Lock()
		ws, err := r.workspaceLocked(id)
		if err == nil && len(ws.processes) != 0 {
			err = errors.New("active process blocks final capture")
		}
		r.mu.Unlock()
		if err != nil {
			return err
		}
		return visit(ctx)
	})
}

// ReclaimWorkspaceDisk retains the runtime identity while removing all mutable
// machine directories. Start recreates them before retained source restoration.
func (r *Runtime) ReclaimWorkspaceDisk(ctx context.Context, id string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, err := r.workspaceLocked(id)
	if err != nil {
		return err
	}
	if ws.State != string(workspaceapi.WorkspaceStopped) || len(ws.processes) != 0 {
		return errors.New("only a quiet stopped workspace disk is reclaimed")
	}
	for _, name := range []string{"root", "home", "state", "tmp"} {
		if err := os.RemoveAll(filepath.Join(ws.directory, name)); err != nil {
			return err
		}
	}
	return nil
}
