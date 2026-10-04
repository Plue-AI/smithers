package services

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// CleanupStoppedAgentWorkspaceDisks remains on the shared five-minute cleaner.
// T-MCH-09 lands dark: the workspace contract has no branch identity/archive,
// settlement timestamp, verified final capture or fresh broker inventory yet.
// An old suspension and an absent lane binding prove none of those facts.
// Keep every disk until all four contracts can be checked atomically with
// admission and writers; never fall back to age-only runtime removal.
func (s *WorkspaceService) CleanupStoppedAgentWorkspaceDisks(ctx context.Context) error {
	return ctx.Err()
}

// keepTodoWorkspace is called under the runtime lock, after re-reading the
// workspace. Reuse the durable lane binding, including retired lanes: retirement
// is not proof of settlement or a retained final capture. Until the branch
// settlement/capture and quiet-service contracts land, all bound disks stay.
// Missing binding authority fails closed rather than treating it as no TODO.
func (s *WorkspaceService) keepTodoWorkspace(ctx context.Context, row db.Workspace) (bool, error) {
	store, ok := s.q.(interface {
		GetMythicalLane(context.Context, string) (db.MythicalLane, error)
	})
	if !ok {
		return row.Kind == "agent", nil
	}
	_, err := store.GetMythicalLane(ctx, row.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return row.Kind == "agent", nil
	}
	return true, err
}
