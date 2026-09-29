package db

import (
	"context"
	"github.com/stretchr/testify/require"
	"testing"
	"time"
)

func TestWorkflowLogRetentionBoundedAndPreservesRecent(t *testing.T) {
	q, pool := newQueries(t)
	ctx := context.Background()
	f := mustCreateWorkflowTaskFixture(t, q, pool, "log-retention")
	cutoff := time.Now().UTC().Truncate(time.Microsecond).Add(-30 * 24 * time.Hour)
	_, err := pool.Exec(ctx, `UPDATE workflow_runs SET status='success', completed_at=$1 WHERE id=$2`, cutoff.Add(-time.Hour), f.runID)
	require.NoError(t, err)
	for i, age := range []time.Duration{-time.Hour, -time.Minute, -time.Microsecond, 0, time.Hour} {
		log, err := q.InsertWorkflowLog(ctx, InsertWorkflowLogParams{WorkflowRunID: f.runID, WorkflowStepID: f.stepID, Sequence: int64(i + 1), Stream: "stdout", Entry: "hello"})
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `UPDATE workflow_logs SET created_at=$1 WHERE id=$2`, cutoff.Add(age), log.ID)
		require.NoError(t, err)
	}
	for _, expected := range []int64{2, 1, 0} {
		count, err := q.DeleteWorkflowLogsOlderThan(ctx, DeleteWorkflowLogsOlderThanParams{Cutoff: cutoff, BatchLimit: 2})
		require.NoError(t, err)
		require.Equal(t, expected, count)
	}
	var remaining, bytes, entries int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workflow_logs WHERE workflow_run_id=$1`, f.runID).Scan(&remaining))
	require.Equal(t, int64(2), remaining)
	require.NoError(t, pool.QueryRow(ctx, `SELECT log_bytes, log_entry_count FROM workflow_runs WHERE id=$1`, f.runID).Scan(&bytes, &entries))
	require.Equal(t, int64(10), bytes)
	require.Equal(t, int64(2), entries)
}

func TestWorkflowLogRetentionEnforcesDatabaseBatchCeiling(t *testing.T) {
	q, pool := newQueries(t)
	ctx := context.Background()
	f := mustCreateWorkflowTaskFixture(t, q, pool, "log-retention-cap")
	cutoff := time.Now().UTC().Add(-30 * 24 * time.Hour)
	_, err := pool.Exec(ctx, `UPDATE workflow_runs SET status='success', completed_at=$1 WHERE id=$2`, cutoff.Add(-time.Hour), f.runID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO workflow_logs (workflow_run_id, workflow_step_id, sequence, stream, entry, created_at)
 SELECT $1, $2, n, 'stdout', 'x', $3::timestamptz - interval '1 second' FROM generate_series(1,1005) n`, f.runID, f.stepID, cutoff)
	require.NoError(t, err)
	for _, limit := range []int32{0, -1} {
		count, err := q.DeleteWorkflowLogsOlderThan(ctx, DeleteWorkflowLogsOlderThanParams{Cutoff: cutoff, BatchLimit: limit})
		require.NoError(t, err)
		require.Zero(t, count)
	}
	count, err := q.DeleteWorkflowLogsOlderThan(ctx, DeleteWorkflowLogsOlderThanParams{Cutoff: cutoff, BatchLimit: 10000})
	require.NoError(t, err)
	require.Equal(t, int64(1000), count)
	count, err = q.DeleteWorkflowLogsOlderThan(ctx, DeleteWorkflowLogsOlderThanParams{Cutoff: cutoff, BatchLimit: 10000})
	require.NoError(t, err)
	require.Equal(t, int64(5), count)
}

func TestWorkflowLogRetentionPreservesActiveAndRecentRuns(t *testing.T) {
	q, pool := newQueries(t)
	ctx := context.Background()
	f := mustCreateWorkflowTaskFixture(t, q, pool, "log-retention-active")
	cutoff := time.Now().UTC().Truncate(time.Microsecond).Add(-30 * 24 * time.Hour)
	_, err := q.InsertWorkflowLog(ctx, InsertWorkflowLogParams{WorkflowRunID: f.runID, WorkflowStepID: f.stepID, Sequence: 1, Stream: "stdout", Entry: "step"})
	require.NoError(t, err)
	_, err = q.InsertWorkflowRunLogNextSequence(ctx, InsertWorkflowRunLogNextSequenceParams{WorkflowRunID: f.runID, WorkflowStepID: f.stepID, Stream: "stdout", Entry: "run"})
	require.NoError(t, err)
	for _, table := range []string{"workflow_logs", "workflow_run_logs"} {
		_, err = pool.Exec(ctx, "UPDATE "+table+" SET created_at=$1 WHERE workflow_run_id=$2", cutoff.Add(-time.Hour), f.runID)
		require.NoError(t, err)
	}
	for _, status := range []string{"queued", "running", "success"} {
		_, err = pool.Exec(ctx, `UPDATE workflow_runs SET status=$1, completed_at=$2 WHERE id=$3`, status, cutoff, f.runID)
		require.NoError(t, err)
		n, err := q.DeleteWorkflowLogsOlderThan(ctx, DeleteWorkflowLogsOlderThanParams{Cutoff: cutoff, BatchLimit: 1000})
		require.NoError(t, err)
		require.Zero(t, n)
		n, err = q.DeleteWorkflowRunLogsOlderThan(ctx, DeleteWorkflowRunLogsOlderThanParams{Cutoff: cutoff, BatchLimit: 1000})
		require.NoError(t, err)
		require.Zero(t, n)
	}
	_, err = pool.Exec(ctx, `UPDATE workflow_runs SET completed_at=$1 WHERE id=$2`, cutoff.Add(-time.Microsecond), f.runID)
	require.NoError(t, err)
	n, err := q.DeleteWorkflowLogsOlderThan(ctx, DeleteWorkflowLogsOlderThanParams{Cutoff: cutoff, BatchLimit: 1000})
	require.NoError(t, err)
	require.Equal(t, int64(1), n)
	n, err = q.DeleteWorkflowRunLogsOlderThan(ctx, DeleteWorkflowRunLogsOlderThanParams{Cutoff: cutoff, BatchLimit: 1000})
	require.NoError(t, err)
	require.Equal(t, int64(1), n)
	var bytes, entries int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT log_bytes,log_entry_count FROM workflow_runs WHERE id=$1`, f.runID).Scan(&bytes, &entries))
	require.Zero(t, bytes)
	require.Zero(t, entries)
}

func TestWorkflowLogRetentionSkipsLockedParent(t *testing.T) {
	ctx := context.Background()
	q := New(sharedPool)
	f := mustCreateWorkflowTaskFixture(t, q, sharedPool, "log-retention-lock")
	t.Cleanup(func() {
		_, err := sharedPool.Exec(ctx, `DELETE FROM workflow_runs WHERE id=$1`, f.runID)
		require.NoError(t, err)
	})
	cutoff := time.Now().UTC().Add(-30 * 24 * time.Hour)
	_, err := q.InsertWorkflowLog(ctx, InsertWorkflowLogParams{WorkflowRunID: f.runID, WorkflowStepID: f.stepID, Sequence: 1, Stream: "stdout", Entry: "step"})
	require.NoError(t, err)
	_, err = q.InsertWorkflowRunLogNextSequence(ctx, InsertWorkflowRunLogNextSequenceParams{WorkflowRunID: f.runID, WorkflowStepID: f.stepID, Stream: "stdout", Entry: "run"})
	require.NoError(t, err)
	_, err = sharedPool.Exec(ctx, `UPDATE workflow_runs SET status='success',completed_at=$1 WHERE id=$2`, cutoff.Add(-time.Hour), f.runID)
	require.NoError(t, err)
	for _, table := range []string{"workflow_logs", "workflow_run_logs"} {
		_, err = sharedPool.Exec(ctx, "UPDATE "+table+" SET created_at=$1 WHERE workflow_run_id=$2", cutoff.Add(-time.Hour), f.runID)
		require.NoError(t, err)
	}
	tx, err := sharedPool.Begin(ctx)
	require.NoError(t, err)
	defer func() { require.NoError(t, tx.Rollback(ctx)) }()
	_, err = tx.Exec(ctx, `SELECT id FROM workflow_runs WHERE id=$1 FOR UPDATE`, f.runID)
	require.NoError(t, err)
	sweepCtx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	n, err := q.DeleteWorkflowLogsOlderThan(sweepCtx, DeleteWorkflowLogsOlderThanParams{Cutoff: cutoff, BatchLimit: 1000})
	require.NoError(t, err)
	require.Zero(t, n)
	n, err = q.DeleteWorkflowRunLogsOlderThan(sweepCtx, DeleteWorkflowRunLogsOlderThanParams{Cutoff: cutoff, BatchLimit: 1000})
	require.NoError(t, err)
	require.Zero(t, n)
	// A parent-first cascade must still acquire the child rows immediately.
	_, err = tx.Exec(sweepCtx, `DELETE FROM workflow_runs WHERE id=$1`, f.runID)
	require.NoError(t, err)
}
