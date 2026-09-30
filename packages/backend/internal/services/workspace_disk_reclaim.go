package services

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// defaultAgentWorkspaceDiskReclaimAfter bounds how long a stopped agent
// workspace keeps its machine disk (#2275). An agent's work lives on its
// bookmark in the repository, so a later resume boots a fresh machine and
// checks the repository out again; a follow-up within the day resumes the
// kept disk instantly.
const defaultAgentWorkspaceDiskReclaimAfter = 24 * time.Hour

// stoppedAgentWorkspaceLister is the store surface of the disk reclaim.
// *db.Queries implements it.
type stoppedAgentWorkspaceLister interface {
	ListStoppedAgentWorkspaceIDs(ctx context.Context, stoppedFor time.Duration) ([]string, error)
}

// WithWorkspaceAgentDiskReclaimAfter sets how long an agent workspace stays
// stopped before its runtime disk is reclaimed. A non-positive value keeps
// the default.
func WithWorkspaceAgentDiskReclaimAfter(after time.Duration) WorkspaceServiceOption {
	return func(s *WorkspaceService) {
		if after > 0 {
			s.agentDiskReclaimAfter = after
		}
	}
}

// CleanupStoppedAgentWorkspaceDisks reclaims the machine disk of every agent
// workspace stopped longer than the bound, on a runtime that can reclaim one.
// The workspace itself stays: its next resume boots a fresh machine and the
// product checks the repository out again. Human workspaces keep their disks.
func (s *WorkspaceService) CleanupStoppedAgentWorkspaceDisks(ctx context.Context) error {
	if !s.hasWorkspaceRuntime() || s.q == nil {
		return nil
	}
	reclaimer, ok := s.runtime.(workspaceapi.WorkspaceDiskReclaimer)
	if !ok {
		return nil
	}
	lister, ok := s.q.(stoppedAgentWorkspaceLister)
	if !ok {
		return nil
	}
	ids, err := lister.ListStoppedAgentWorkspaceIDs(ctx, s.agentDiskReclaimAfter)
	if err != nil {
		return fmt.Errorf("list stopped agent workspaces: %w", err)
	}
	var errs []error
	for _, id := range ids {
		if err := ctx.Err(); err != nil {
			return errors.Join(append(errs, err)...)
		}
		if err := s.reclaimAgentWorkspaceDisk(ctx, reclaimer, id); err != nil {
			slog.Warn("stopped agent workspace disk reclaim failed", "workspace_id", id, "error", err)
			errs = append(errs, fmt.Errorf("reclaim agent workspace %s disk: %w", id, err))
		}
	}
	return errors.Join(errs...)
}

// reclaimAgentWorkspaceDisk re-reads the row inside the workspace's runtime
// critical section, so a resume or delete since the list wins.
func (s *WorkspaceService) reclaimAgentWorkspaceDisk(ctx context.Context, reclaimer workspaceapi.WorkspaceDiskReclaimer, id string) error {
	unlock := s.lockRuntimeWorkspace(id)
	defer unlock()
	row, err := s.q.GetWorkspace(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if row.Kind != "agent" || row.Status != "suspended" || row.DeletedAt.Valid {
		return nil
	}
	operationCtx, err := s.workspaceRuntimeContext(ctx, row, row.UserID, workspaceLifecycleOperation(row, "reclaim-disk"))
	if err != nil {
		return err
	}
	if err := reclaimer.ReclaimWorkspaceDisk(operationCtx, row.ID); err != nil {
		if errors.Is(err, workspaceapi.ErrWorkspaceNotFound) {
			return nil
		}
		return err
	}
	return nil
}
