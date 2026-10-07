package services

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// WakeTodoWorkspace runs only behind the resolver's host start. Re-read the
// item and lane inside the same lifecycle lock used by suspend and retirement;
// a stale delivery must not revive settled or paused work.
func (s *WorkspaceService) WakeTodoWorkspace(ctx context.Context, itemID, workspaceID string, repositoryID, userID int64) error {
	id, err := uuid.Parse(itemID)
	if err != nil {
		return mythicalFlowFailure{code: "runtime_target_invalid"}
	}
	store, ok := s.q.(interface {
		GetMythicalItem(context.Context, pgtype.UUID) (db.MythicalItem, error)
		GetMythicalLane(context.Context, string) (db.MythicalLane, error)
	})
	if !ok || !s.hasWorkspaceRuntime() {
		return mythicalFlowFailure{code: "runtime_binding_unavailable", retryable: true}
	}
	row, err := s.loadOwnedWorkspace(ctx, workspaceID, repositoryID, userID)
	if err != nil {
		return err
	}
	return s.withWorkspaceMutationAuthority(ctx, row, userID, func(ctx context.Context) error {
		unlock := s.lockRuntimeWorkspace(workspaceID)
		defer unlock()
		current, err := s.currentRuntimeWorkspaceLocked(ctx, row)
		if err != nil {
			return err
		}
		if current.DeletedAt.Valid {
			return mythicalFlowFailure{code: "runtime_target_forbidden"}
		}
		item, err := store.GetMythicalItem(ctx, pgtype.UUID{Bytes: id, Valid: true})
		if err != nil {
			return mythicalFlowFailure{code: "runtime_binding_unavailable", retryable: true}
		}
		lane, err := store.GetMythicalLane(ctx, workspaceID)
		if err != nil {
			return mythicalFlowFailure{code: "runtime_binding_unavailable", retryable: true}
		}
		if item.RepositoryID != repositoryID || item.WorkspaceID != workspaceID || lane.ItemID != item.ID || lane.RepositoryID != repositoryID {
			return mythicalFlowFailure{code: "runtime_target_forbidden"}
		}
		if item.PausedAt.Valid {
			return mythicalFlowFailure{code: "runtime_todo_paused", retryable: true}
		}
		switch item.State {
		case "landed", "cancelled", "rejected", "declined", "skipped", "dropped":
			return mythicalFlowFailure{code: "runtime_run_terminal"}
		}
		if current.Status != "running" && current.Status != "suspended" && current.Status != "stopped" {
			return mythicalLaneNotRunning(current, nil)
		}
		_, err = s.ensureRuntimeWorkspaceRunningLocked(ctx, current, userID)
		return err
	})
}
