package services

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// workflowRunCancelReasonSuperseded is the cancel_reason prefix written to a
// run that a newer push run replaced. The full value is
// "superseded_by_run:<id>", which the API returns verbatim so a UI can render
// "Superseded by run 11763" instead of a bare cancelled.
const workflowRunCancelReasonSuperseded = "superseded_by_run:"

// maxSupersededRunsPerDispatch bounds one supersede sweep. A repository that
// pushed a long backlog while the runner pool was saturated (2026-09-15: runs
// 11751-11757 queued at once) still converges, but a single dispatch can never
// spend unbounded time cancelling.
const maxSupersededRunsPerDispatch = 64

// workflowRunSupersedeQuerier is the optional slice of the store needed for
// superseded-run cancellation. It is asserted rather than folded into
// WorkflowRunQuerier so an in-memory test fake that does not care about
// concurrency stays valid.
type workflowRunSupersedeQuerier interface {
	ListSupersededWorkflowRuns(ctx context.Context, arg db.ListSupersededWorkflowRunsParams) ([]int64, error)
	MarkWorkflowRunSuperseded(ctx context.Context, arg db.MarkWorkflowRunSupersededParams) error
}

// workflowCancelsSupersededRuns reports whether creating a run for this
// trigger event and workflow config should cancel older runs it supersedes.
//
// Only push runs supersede anything: a push to a ref replaces the previous
// push to the same ref, exactly as GitHub Actions' concurrency groups treat
// it. A manual_dispatch run is a human asking for THIS run, and a schedule run
// is a tick that nothing replaces, so neither is ever auto-cancelled and
// neither ever cancels anything.
func workflowCancelsSupersededRuns(configJSON json.RawMessage, triggerEvent string) bool {
	// A system credential's push (system_push) supersedes only the earlier
	// system pushes to its ref: the listing matches the recorded trigger.
	if trigger := NormalizeTriggerName(triggerEvent); trigger != "push" && trigger != SystemPushTriggerEvent {
		return false
	}
	if concurrency := parseWorkflowConcurrency(configJSON); concurrency != nil && concurrency.CancelSuperseded != nil {
		return *concurrency.CancelSuperseded
	}
	return true
}

// parseWorkflowConcurrency reads the optional top-level `concurrency` block.
// A config that fails to parse yields nil, which leaves the default in force:
// trigger matching already rejected an unparseable config before a run existed.
func parseWorkflowConcurrency(configJSON json.RawMessage) *WorkflowConcurrencyConfig {
	if len(configJSON) == 0 || len(configJSON) > maxWorkflowFileBytes {
		return nil
	}
	var cfg struct {
		Concurrency *WorkflowConcurrencyConfig `json:"concurrency"`
	}
	if err := json.Unmarshal(configJSON, &cfg); err != nil {
		return nil
	}
	return cfg.Concurrency
}

// cancelSupersededRuns cancels every older queued or running push run of the
// same (repository, workflow definition, trigger ref) as the run just created.
//
// It routes each cancellation through CancelRun rather than a bare status
// UPDATE, so a superseded run settles exactly the way an operator cancel does:
// CancelWorkflowTasks moves every pending/assigned/blocked task to 'cancelled'
// and CancelWorkflowRun moves the run out of ('queued','running'), so a queued
// run is never claimed afterwards. A running sandbox-plane run stops within
// one lease heartbeat (~30s): the
// trg_workflow_runs_90_invalidate_sandbox_claim trigger bumps the claim
// generation when status becomes 'cancelled', so RenewWorkflowSandboxClaim
// matches nothing, the scheduler's maintainClaimLease cancels the run context,
// and its guests are torn down.
//
// Credentials are revoked, and the commit status and GitHub check run are
// closed out, by CancelRun in every case.
//
// Failures are logged, never returned: the newly created run is already
// durable and must be dispatched regardless of whether an older run could be
// reaped.
func (s *workflowRunService) cancelSupersededRuns(ctx context.Context, run db.WorkflowRun, configJSON json.RawMessage) {
	if !workflowCancelsSupersededRuns(configJSON, run.TriggerEvent) {
		return
	}
	// An empty ref cannot identify a concurrency group; cancelling every run
	// with a blank ref would reach across unrelated pushes.
	if strings.TrimSpace(run.TriggerRef) == "" {
		return
	}
	querier, ok := s.queries.(workflowRunSupersedeQuerier)
	if !ok {
		return
	}

	logger := middleware.LoggerWithWorkflowRun(ctx, run.ID)
	olderRunIDs, err := querier.ListSupersededWorkflowRuns(ctx, db.ListSupersededWorkflowRunsParams{
		RepositoryID:         run.RepositoryID,
		WorkflowDefinitionID: run.WorkflowDefinitionID,
		TriggerRef:           run.TriggerRef,
		TriggerEvent:         run.TriggerEvent,
		NewerRunID:           run.ID,
	})
	if err != nil {
		logger.Error("failed to list superseded workflow runs",
			"repository_id", run.RepositoryID,
			"workflow_definition_id", run.WorkflowDefinitionID,
			"trigger_ref", run.TriggerRef,
			"error", err)
		return
	}
	if len(olderRunIDs) > maxSupersededRunsPerDispatch {
		olderRunIDs = olderRunIDs[len(olderRunIDs)-maxSupersededRunsPerDispatch:]
	}

	reason := fmt.Sprintf("%s%d", workflowRunCancelReasonSuperseded, run.ID)
	for _, olderRunID := range olderRunIDs {
		if olderRunID == run.ID {
			continue
		}
		if err := s.CancelRun(ctx, run.RepositoryID, olderRunID); err != nil {
			logger.Warn("failed to cancel superseded workflow run",
				"superseded_run_id", olderRunID,
				"repository_id", run.RepositoryID,
				"error", err)
			continue
		}
		if err := querier.MarkWorkflowRunSuperseded(ctx, db.MarkWorkflowRunSupersededParams{
			ID:           olderRunID,
			CancelReason: reason,
		}); err != nil {
			logger.Warn("failed to record superseded cancel reason",
				"superseded_run_id", olderRunID,
				"repository_id", run.RepositoryID,
				"error", err)
			continue
		}
		logger.Info("cancelled superseded workflow run",
			"superseded_run_id", olderRunID,
			"repository_id", run.RepositoryID,
			"trigger_ref", run.TriggerRef,
			"cancel_reason", reason)
	}
}
