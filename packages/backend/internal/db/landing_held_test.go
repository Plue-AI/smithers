package db

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A landing its repository's host refused while holding the repository is
// queued again: its task waits out the delay without spending an attempt,
// its request reads "queued", and it is claimed again once the delay passes.
func TestDeferHeldLandingQueuesTheLandingAgain(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))
	lr, err := q.CreateLandingRequest(ctx, CreateLandingRequestParams{
		RepositoryID: repoID, Title: "held", AuthorID: userID,
		TargetBookmark: "main", SourceBookmark: "feature", StackSize: 1,
	})
	require.NoError(t, err)
	_, err = q.EnqueueLandingRequest(ctx, EnqueueLandingRequestParams{
		QueuedBy: pgtype.Int8{Int64: userID, Valid: true}, ID: lr.ID, TargetBookmark: "main", SourceBookmark: "feature",
	})
	require.NoError(t, err)
	task, err := q.CreateLandingTask(ctx, CreateLandingTaskParams{LandingRequestID: lr.ID, RepositoryID: repoID})
	require.NoError(t, err)

	claimed, err := q.ClaimPendingLandingTask(ctx)
	require.NoError(t, err)
	require.Equal(t, task.ID, claimed.ID)
	_, err = q.MarkLandingStarted(ctx, lr.ID)
	require.NoError(t, err)

	deferred, err := q.DeferHeldLanding(ctx, DeferHeldLandingParams{TaskID: task.ID, LastError: "repository held", DelaySeconds: 60})
	require.NoError(t, err)
	assert.Equal(t, "pending", deferred.Status)
	assert.Equal(t, claimed.Attempt-1, deferred.Attempt)
	assert.WithinDuration(t, time.Now().Add(time.Minute), deferred.AvailableAt, 10*time.Second)
	queued, err := q.GetLandingRequestByID(ctx, lr.ID)
	require.NoError(t, err)
	assert.Equal(t, "queued", queued.State)
	_, err = q.ClaimPendingLandingTask(ctx)
	require.ErrorIs(t, err, pgx.ErrNoRows, "a held landing was claimed before its delay")

	// Once the delay passes it is claimed again.
	_, err = pool.Exec(ctx, `UPDATE landing_tasks SET available_at = NOW() WHERE id = $1`, task.ID)
	require.NoError(t, err)
	again, err := q.ClaimPendingLandingTask(ctx)
	require.NoError(t, err)
	assert.Equal(t, task.ID, again.ID)
	assert.Equal(t, claimed.Attempt, again.Attempt)

	// Only a running task is deferred.
	_, err = q.MarkLandingTaskDone(ctx, task.ID)
	require.NoError(t, err)
	_, err = q.DeferHeldLanding(ctx, DeferHeldLandingParams{TaskID: task.ID, LastError: "late", DelaySeconds: 1})
	require.ErrorIs(t, err, pgx.ErrNoRows)
}
