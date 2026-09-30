package services

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5"
)

// FlowJournals drops and fences the per-workspace flow journal databases and
// roles a coding host keeps its journals in (#2099, #3172, #1868). A journal lives as long
// as its workspace: stopping, suspending or a lapsed lease keeps it, and
// deleting the workspace drops it. flowhost.PostgresJournals implements it.
type FlowJournals interface {
	// Drop removes one workspace's journal database and role; it is
	// idempotent and never touches a name outside the journal scheme.
	Drop(ctx context.Context, workspaceID string) error
	// Workspaces lists the workspaces that have a journal from this backend.
	Workspaces(ctx context.Context) ([]string, error)
	// Fence ends every session a workspace's journal role holds, so a host
	// on a lost box loses its connections to the journal its replacement
	// opens. It reports whether the workspace has a journal database; without
	// one a lost box has nothing to recover.
	Fence(ctx context.Context, workspaceID string) (bool, error)
}

// SetFlowJournals makes deleting a workspace drop its flow journal. The flow
// composition calls it when journals are on PostgreSQL, before the workspace
// cleaner starts.
func (s *WorkspaceService) SetFlowJournals(journals FlowJournals) { s.flowJournals = journals }

// dropFlowJournal runs once the workspace is tombstoned and its host is gone.
// A failure leaves the journal for the cleaner's orphan sweep, since the
// deleted workspace can no longer be deleted again.
func (s *WorkspaceService) dropFlowJournal(ctx context.Context, workspaceID string) {
	if s.flowJournals == nil {
		return
	}
	if err := s.flowJournals.Drop(ctx, workspaceID); err != nil {
		slog.Warn("flow journal drop failed; the workspace cleaner retries", "workspace_id", workspaceID, "error", err)
	}
}

// CleanupOrphanFlowJournals drops every journal whose workspace row is gone
// (a repository or account deletion cascaded it) or tombstoned (a drop at
// delete time failed). A live workspace's journal is never touched.
func (s *WorkspaceService) CleanupOrphanFlowJournals(ctx context.Context) error {
	if s.flowJournals == nil || s.q == nil {
		return nil
	}
	workspaces, err := s.flowJournals.Workspaces(ctx)
	if err != nil {
		return fmt.Errorf("list flow journals: %w", err)
	}
	var errs []error
	for _, workspaceID := range workspaces {
		if err := ctx.Err(); err != nil {
			return errors.Join(append(errs, err)...)
		}
		// GetWorkspace never answers a tombstoned row.
		if _, err := s.q.GetWorkspace(ctx, workspaceID); err == nil {
			continue
		} else if !errors.Is(err, pgx.ErrNoRows) {
			errs = append(errs, fmt.Errorf("load flow journal workspace %s: %w", workspaceID, err))
			continue
		}
		if err := s.flowJournals.Drop(ctx, workspaceID); err != nil {
			errs = append(errs, fmt.Errorf("drop flow journal of workspace %s: %w", workspaceID, err))
			continue
		}
		slog.Info("orphan flow journal dropped", "workspace_id", workspaceID)
	}
	return errors.Join(errs...)
}
