package services

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// CleanupStoppedAgentWorkspaceDisks remains on the shared five-minute cleaner.
// The branch service owner identifies machines, but the workspace contract
// still lacks scratch archive and settlement timestamps, verified final
// capture and fresh broker inventory.
// An old suspension and an absent lane binding prove none of those facts.
// Keep every disk until all four contracts can be checked atomically with
// admission and writers; never fall back to age-only runtime removal.
func (s *WorkspaceService) CleanupStoppedAgentWorkspaceDisks(ctx context.Context) error {
	return ctx.Err()
}

// keepTodoWorkspace is called under the runtime lock, after re-reading the
// workspace. Reuse the branch service owner and durable lane binding, including
// retired lanes: retirement is not proof of settlement or final capture. Until the branch
// settlement/capture and quiet-service contracts land, all bound disks stay.
// Missing binding authority fails closed rather than treating it as no TODO.
func (s *WorkspaceService) keepTodoWorkspace(ctx context.Context, row db.Workspace) (bool, error) {
	// Scratch machines have no Mythical lane. The durable service owner is
	// their identity too; kind alone is not a branch-machine discriminator.
	branch, err := s.branchMachineOwned(ctx, row.UserID)
	if err != nil || branch {
		return true, err
	}
	store, ok := s.q.(interface {
		GetMythicalLane(context.Context, string) (db.MythicalLane, error)
	})
	if !ok {
		return row.Kind == "agent", nil
	}
	_, err = store.GetMythicalLane(ctx, row.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return row.Kind == "agent", nil
	}
	return true, err
}
