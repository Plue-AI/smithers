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

	// The good row carries a one-job graph; the bad rows must never run it.
	base := nixCIQuerier([]db.WorkflowTask{nixCITaskRow(1, 11, "build", nil)})
	guests := &fakeNixCIGuests{polls: map[string]int{}, scripts: map[string]nixCIGuestScript{"build": {exitCode: "0"}}}
	sandboxClient := guests.client(t)
	worker := NewWorkflowSandboxSchedulerWorker(
		badClaimSchedulerQuerier{mockWorkflowSandboxSchedulerQuerier: base, rows: []runtimeports.ClaimQueuedWorkflowRunsRow{missingToken, expired, good}},
		sandboxClient,
		WithWorkflowSandboxSchedulerGitBaseURL("https://api.smithers.test"),
		WithWorkflowSandboxSchedulerCIGuests(guests),
		WithWorkflowSandboxSchedulerCIPollInterval(time.Millisecond),
	)
	require.NoError(t, worker.PollOnce(context.Background()))
	assert.Equal(t, []int64{42}, base.markSuccessIDs)
	assert.Empty(t, base.markFailureIDs, "a skipped claim is left for lease expiry, never finalized")
	assert.Len(t, sandboxClient.createCalls, 1, "only the good claim boots a guest")
}
