package services

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/runtimeports"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

type badClaimSchedulerQuerier struct {
	*mockWorkflowSandboxSchedulerQuerier
	rows []runtimeports.ClaimQueuedWorkflowRunsRow
}

func (q badClaimSchedulerQuerier) ClaimQueuedWorkflowRuns(context.Context, int32) ([]runtimeports.ClaimQueuedWorkflowRunsRow, error) {
	return q.rows, nil
}

// One malformed or already-expired claim must not strand the rest of the
// claimed batch until lease expiry.
func TestWorkflowSandboxSchedulerWorker_PollOnce_BadClaimDoesNotAbortBatch(t *testing.T) {
	t.Parallel()

	missingToken := testWorkflowSandboxClaimRow(db.WorkflowRun{ID: 40, RepositoryID: 100, WorkflowDefinitionID: 7})
	missingToken.ClaimToken = pgtype.UUID{}
	expired := testWorkflowSandboxClaimRow(db.WorkflowRun{ID: 41, RepositoryID: 100, WorkflowDefinitionID: 7})
	expired.ClaimLeaseExpiresAt = pgtype.Timestamptz{Time: time.Now().Add(-time.Second), Valid: true}
	good := testWorkflowSandboxClaimRow(db.WorkflowRun{ID: 42, RepositoryID: 100, WorkflowDefinitionID: 7, TriggerRef: "main", TriggerCommitSha: "deadbeef"})

	base := &mockWorkflowSandboxSchedulerQuerier{
		getWorkflowDefinitionFn: func(context.Context, db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			return db.WorkflowDefinition{ID: 7, RepositoryID: 100, Name: "CI", Path: ".smithers/workflows/ci.tsx"}, nil
		},
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 100, Name: "demo", UserID: pgtype.Int8{Int64: 11, Valid: true}}, nil
		},
		getUserByIDFn: func(context.Context, int64) (db.User, error) {
			return db.User{ID: 11, Username: "alice"}, nil
		},
		listWorkflowStepsByRunIDFn: func(_ context.Context, runID int64) ([]db.WorkflowStep, error) {
			return []db.WorkflowStep{{ID: 9, WorkflowRunID: runID, Status: "queued"}}, nil
		},
	}
	sandboxClient := &mockWorkflowSandboxVMClient{
		createVMFn: func(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-good"}, nil
		},
		execAwaitFn: func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
			success := int32(0)
			return sandbox.ExecResult{StatusCode: &success}, nil
		},
	}
	worker := newRunnableWorkflowSandboxScheduler(t,
		badClaimSchedulerQuerier{mockWorkflowSandboxSchedulerQuerier: base, rows: []runtimeports.ClaimQueuedWorkflowRunsRow{missingToken, expired, good}},
		sandboxClient,
		WithWorkflowSandboxSchedulerGitBaseURL("https://api.smithers.test"),
		WithWorkflowSandboxSchedulerAPIBaseURL("https://api.smithers.test/api"),
	)
	require.NoError(t, worker.PollOnce(context.Background()))
	assert.Equal(t, []int64{42}, base.markSuccessIDs)
}
