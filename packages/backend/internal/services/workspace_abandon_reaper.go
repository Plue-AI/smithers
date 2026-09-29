package services

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const (
	// A client lease shorter than a minute cannot survive one renew round
	// trip under load; one longer than a day is not a liveness signal.
	minWorkspaceClientLeaseSeconds = 60
	maxWorkspaceClientLeaseSeconds = 24 * 60 * 60
	// defaultWorkspaceLeaseDeleteAfter is how long a lapsed workspace stays
	// suspended before the abandon reaper deletes it.
	defaultWorkspaceLeaseDeleteAfter = 24 * time.Hour
	// workspaceAbandonBatch bounds one sweep; the rest wait for the next tick.
	workspaceAbandonBatch = 50
	workspaceAbandonReason = "client lease lapsed"
)

// workspaceLeaseStore is the client-lease surface of the workspace store.
// *db.Queries implements it.
type workspaceLeaseStore interface {
	SetWorkspaceClientLease(ctx context.Context, arg db.SetWorkspaceClientLeaseParams) (db.Workspace, error)
	RenewWorkspaceClientLease(ctx context.Context, id string) (db.Workspace, error)
	ListLapsedLeaseWorkspaces(ctx context.Context, maxRows int32) ([]db.Workspace, error)
}

// WithWorkspaceLeaseDeleteAfter sets how long after a client lease lapses the
// abandon reaper deletes the workspace. Zero deletes on the first sweep after
// the lapse; a negative value keeps the default.
func WithWorkspaceLeaseDeleteAfter(after time.Duration) WorkspaceServiceOption {
	return func(s *WorkspaceService) {
		if after >= 0 {
			s.leaseDeleteAfter = after
		}
	}
}

func validateWorkspaceClientLease(seconds int32) error {
	if seconds == 0 {
		return nil
	}
	if seconds < minWorkspaceClientLeaseSeconds || seconds > maxWorkspaceClientLeaseSeconds {
		return pkgerrors.BadRequest(fmt.Sprintf("client_lease_seconds must be between %d and %d", minWorkspaceClientLeaseSeconds, maxWorkspaceClientLeaseSeconds))
	}
	return nil
}

// applyWorkspaceClientLease starts the requested lease on a created or reused
// workspace. A create without a lease clears one a reused row still carries,
// so a workspace another caller now depends on is never reaped for a client
// that stopped renewing it.
func (s *WorkspaceService) applyWorkspaceClientLease(ctx context.Context, workspace db.Workspace, seconds int32) (db.Workspace, error) {
	if seconds == 0 && !workspace.ClientLeaseSecs.Valid {
		return workspace, nil
	}
	store, ok := s.q.(workspaceLeaseStore)
	if !ok {
		return workspace, pkgerrors.Internal("workspace lease store unavailable")
	}
	lease := pgtype.Int4{Int32: seconds, Valid: seconds > 0}
	leased, err := store.SetWorkspaceClientLease(ctx, db.SetWorkspaceClientLeaseParams{ID: workspace.ID, LeaseSecs: lease})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return workspace, pkgerrors.NotFound("workspace not found")
		}
		return workspace, pkgerrors.Internal("set workspace client lease: " + err.Error())
	}
	return leased, nil
}

// RenewWorkspaceLease extends a leased workspace by its lease length.
func (s *WorkspaceService) RenewWorkspaceLease(ctx context.Context, workspaceID string, repositoryID, userID int64) (WorkspaceResponse, error) {
	store, ok := s.q.(workspaceLeaseStore)
	if !ok {
		return WorkspaceResponse{}, pkgerrors.Internal("workspace lease store unavailable")
	}
	workspace, err := s.loadOwnedWorkspace(ctx, workspaceID, repositoryID, userID)
	if err != nil {
		return WorkspaceResponse{}, err
	}
	renewed, err := store.RenewWorkspaceClientLease(ctx, workspace.ID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return WorkspaceResponse{}, pkgerrors.Conflict("workspace has no client lease")
		}
		return WorkspaceResponse{}, pkgerrors.Internal("renew workspace client lease: " + err.Error())
	}
	return s.toWorkspaceResponse(renewed), nil
}

// CleanupAbandonedWorkspaces reclaims workspaces whose client lease lapsed: a
// running one is suspended, and any one lapsed for leaseDeleteAfter is
// deleted. Workspaces without a lease are never listed.
func (s *WorkspaceService) CleanupAbandonedWorkspaces(ctx context.Context) error {
	store, ok := s.q.(workspaceLeaseStore)
	if !ok {
		return nil
	}
	lapsed, err := store.ListLapsedLeaseWorkspaces(ctx, workspaceAbandonBatch)
	if err != nil {
		return fmt.Errorf("list lapsed-lease workspaces: %w", err)
	}
	var errs []error
	for _, listed := range lapsed {
		if err := ctx.Err(); err != nil {
			return errors.Join(append(errs, err)...)
		}
		// Re-read so a renew or delete since the list wins over the reaper.
		workspace, err := s.q.GetWorkspace(ctx, listed.ID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				continue
			}
			errs = append(errs, fmt.Errorf("load lapsed workspace %s: %w", listed.ID, err))
			continue
		}
		if workspace.DeletedAt.Valid || !workspace.ClientLeaseExpiresAt.Valid || workspace.ClientLeaseExpiresAt.Time.After(time.Now()) {
			continue
		}
		logArgs := []any{
			"workspace_id", workspace.ID,
			"repository_id", workspace.RepositoryID,
			"repository", s.abandonedWorkspaceRepository(ctx, workspace),
			"reason", workspaceAbandonReason,
			"lease_expired_at", workspace.ClientLeaseExpiresAt.Time,
		}
		if !workspace.ClientLeaseExpiresAt.Time.Add(s.leaseDeleteAfter).After(time.Now()) {
			if err := s.destroyWorkspace(ctx, workspace); err != nil {
				slog.Warn("abandoned workspace delete failed", append(logArgs, "error", err)...)
				errs = append(errs, fmt.Errorf("delete abandoned workspace %s: %w", workspace.ID, err))
				continue
			}
			slog.Info("abandoned workspace deleted", logArgs...)
			continue
		}
		if workspace.Status != "running" {
			continue
		}
		if err := s.suspendWorkspace(ctx, workspace); err != nil {
			slog.Warn("abandoned workspace suspend failed", append(logArgs, "error", err)...)
			errs = append(errs, fmt.Errorf("suspend abandoned workspace %s: %w", workspace.ID, err))
			continue
		}
		slog.Info("abandoned workspace suspended", logArgs...)
	}
	return errors.Join(errs...)
}

// abandonedWorkspaceRepository names the repository for the reaper's log; an
// unresolvable repository is logged by id alone.
func (s *WorkspaceService) abandonedWorkspaceRepository(ctx context.Context, workspace db.Workspace) string {
	slug, err := s.workspaceRepoSlug(ctx, workspace.RepositoryID)
	if err != nil {
		return ""
	}
	return slug
}
