package services

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/runtimeports"
)

// ProductWorkflowSandboxScheduler is the scheduler store of every deployment:
// the product queries plus the generation-fenced claim lease in
// workflow_sandbox_claims (product migration 0091, #3155).
type ProductWorkflowSandboxScheduler struct {
	*db.Queries
}

var _ WorkflowSandboxSchedulerQuerier = ProductWorkflowSandboxScheduler{}

// NewProductWorkflowSandboxScheduler returns the product scheduler store.
func NewProductWorkflowSandboxScheduler(queries *db.Queries) ProductWorkflowSandboxScheduler {
	return ProductWorkflowSandboxScheduler{Queries: queries}
}

// ClaimQueuedWorkflowRuns leases up to limit queued (or lease-expired)
// sandbox-plane runs and moves them to running.
func (s ProductWorkflowSandboxScheduler) ClaimQueuedWorkflowRuns(ctx context.Context, limit int32) ([]runtimeports.ClaimQueuedWorkflowRunsRow, error) {
	rows, err := s.Queries.ClaimQueuedSandboxWorkflowRuns(ctx, limit)
	if err != nil {
		return nil, err
	}
	claimed := make([]runtimeports.ClaimQueuedWorkflowRunsRow, 0, len(rows))
	for _, row := range rows {
		var token pgtype.UUID
		if err := token.Scan(row.ClaimToken); err != nil {
			return nil, fmt.Errorf("workflow sandbox claim token for run %d: %w", row.ID, err)
		}
		claimed = append(claimed, runtimeports.ClaimQueuedWorkflowRunsRow{
			ID:                   row.ID,
			RepositoryID:         row.RepositoryID,
			WorkflowDefinitionID: row.WorkflowDefinitionID,
			TriggerRef:           row.TriggerRef,
			TriggerCommitSha:     row.TriggerCommitSha,
			TriggerEvent:         row.TriggerEvent,
			ClaimToken:           token,
			ClaimGeneration:      row.ClaimGeneration,
			ClaimLeaseExpiresAt:  pgtype.Timestamptz{Time: row.ClaimLeaseExpiresAt, Valid: true},
		})
	}
	return claimed, nil
}

// RenewWorkflowSandboxClaim extends a live lease. pgx.ErrNoRows means the
// token or generation no longer owns a running sandbox-plane run.
func (s ProductWorkflowSandboxScheduler) RenewWorkflowSandboxClaim(ctx context.Context, arg runtimeports.RenewWorkflowSandboxClaimParams) (pgtype.Timestamptz, error) {
	expiresAt, err := s.Queries.RenewSandboxWorkflowRunClaim(ctx, db.RenewSandboxWorkflowRunClaimParams{
		WorkflowRunID: arg.ID, ClaimToken: arg.ClaimToken, ClaimGeneration: arg.ClaimGeneration,
	})
	if err != nil {
		return pgtype.Timestamptz{}, err
	}
	return pgtype.Timestamptz{Time: expiresAt, Valid: true}, nil
}

// MarkWorkflowRunSuccess finishes a run the caller's claim still owns.
// pgx.ErrNoRows means a cancel, resume, or newer owner took the run.
func (s ProductWorkflowSandboxScheduler) MarkWorkflowRunSuccess(ctx context.Context, arg runtimeports.MarkWorkflowRunSuccessParams) (db.WorkflowRun, error) {
	return s.finish(ctx, arg.ID, arg.ClaimToken, arg.ClaimGeneration, "success")
}

// MarkWorkflowRunFailure is MarkWorkflowRunSuccess for a failed run.
func (s ProductWorkflowSandboxScheduler) MarkWorkflowRunFailure(ctx context.Context, arg runtimeports.MarkWorkflowRunFailureParams) (db.WorkflowRun, error) {
	return s.finish(ctx, arg.ID, arg.ClaimToken, arg.ClaimGeneration, "failure")
}

func (s ProductWorkflowSandboxScheduler) finish(ctx context.Context, runID int64, token string, generation int64, status string) (db.WorkflowRun, error) {
	return s.Queries.FinishClaimedSandboxWorkflowRun(ctx, db.FinishClaimedSandboxWorkflowRunParams{
		Status: status, WorkflowRunID: runID, ClaimToken: token, ClaimGeneration: generation,
	})
}
