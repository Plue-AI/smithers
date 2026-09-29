package db

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNeverStartedAgentSessionRecoveryUsesLinkedRunAgeAndIdentity(t *testing.T) {
	ctx := context.Background()
	q, tx := newQueries(t)
	owner := mustCreateUser(t, tx, uniqueTestUsername(t))
	repo := mustCreateRepoForUser(t, tx, owner, uniqueTestRepoName(t))
	definition, err := q.UpsertAgentWorkflowDefinition(ctx, repo)
	require.NoError(t, err)
	cutoff := time.Now().UTC().Truncate(time.Second).Add(-time.Hour)
	old := cutoff.Add(-time.Second)
	fresh := cutoff.Add(time.Second)

	newSession := func(created time.Time) AgentSession {
		session, createErr := q.CreateAgentSession(ctx, CreateAgentSessionParams{
			ID: uuid.NewString(), RepositoryID: repo, UserID: owner,
			Title: "Never started", Status: "active",
		})
		require.NoError(t, createErr)
		_, updateErr := tx.Exec(ctx, `UPDATE agent_sessions SET created_at = $1 WHERE id = $2`, created, session.ID)
		require.NoError(t, updateErr)
		return session
	}
	newRun := func(created time.Time) int64 {
		run, createErr := q.CreateWorkflowRun(ctx, CreateWorkflowRunParams{
			RepositoryID: repo, WorkflowDefinitionID: definition.ID, Status: "queued",
			TriggerEvent: "agent", TriggerRef: "main", TriggerCommitSha: "age-test",
		})
		require.NoError(t, createErr)
		_, updateErr := tx.Exec(ctx, `UPDATE workflow_runs SET created_at = $1 WHERE id = $2`, created, run.ID)
		require.NoError(t, updateErr)
		return run.ID
	}
	link := func(session AgentSession, runID int64) {
		_, linkErr := q.UpdateAgentSessionWorkflowRun(ctx, UpdateAgentSessionWorkflowRunParams{
			ID: session.ID, WorkflowRunID: pgtype.Int8{Int64: runID, Valid: true},
		})
		require.NoError(t, linkErr)
	}
	assertRun := func(runID int64, status string, completed bool) {
		var gotStatus string
		var completedAt pgtype.Timestamptz
		require.NoError(t, tx.QueryRow(ctx,
			`SELECT status, completed_at FROM workflow_runs WHERE id = $1`, runID,
		).Scan(&gotStatus, &completedAt))
		assert.Equal(t, status, gotStatus)
		assert.Equal(t, completed, completedAt.Valid)
	}

	oldSessionFreshRun := newSession(old)
	freshRun := newRun(fresh)
	link(oldSessionFreshRun, freshRun)
	oldSessionOldRun := newSession(old)
	oldRun := newRun(old)
	link(oldSessionOldRun, oldRun)
	relinked := newSession(old)
	staleRun := newRun(old)
	link(relinked, staleRun)
	relinkedFresh := newSession(old)
	link(relinkedFresh, newRun(old))
	unlinked := newSession(old)
	atCutoff := newSession(cutoff)

	listed, err := q.ListNeverStartedAgentSessions(ctx, cutoff)
	require.NoError(t, err)
	listedByID := make(map[string]AgentSession, len(listed))
	for _, session := range listed {
		listedByID[session.ID] = session
	}
	assert.NotContains(t, listedByID, oldSessionFreshRun.ID, "fresh linked run protects an old session")
	assert.NotContains(t, listedByID, atCutoff.ID, "cutoff is exclusive")
	for _, candidate := range []AgentSession{oldSessionOldRun, relinked, relinkedFresh, unlinked} {
		assert.Contains(t, listedByID, candidate.ID)
	}

	_, err = q.FailNeverStartedAgentSession(ctx, FailNeverStartedAgentSessionParams{
		ID: oldSessionFreshRun.ID, Cutoff: cutoff,
		WorkflowRunID: pgtype.Int8{Int64: freshRun, Valid: true},
	})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.FailNeverStartedAgentSession(ctx, FailNeverStartedAgentSessionParams{ID: atCutoff.ID, Cutoff: cutoff})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	// Listing can race with a new dispatch. The CAS must reject the stale
	// linked-run identity even if that replacement run were old enough.
	replacementRun := newRun(old)
	link(relinked, replacementRun)
	_, err = q.FailNeverStartedAgentSession(ctx, FailNeverStartedAgentSessionParams{
		ID: relinked.ID, Cutoff: cutoff,
		WorkflowRunID: listedByID[relinked.ID].WorkflowRunID,
	})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	relinkedNow, err := q.GetAgentSession(ctx, relinked.ID)
	require.NoError(t, err)
	assert.Equal(t, "active", relinkedNow.Status)
	assert.Equal(t, replacementRun, relinkedNow.WorkflowRunID.Int64)
	assertRun(staleRun, "queued", false)
	assertRun(replacementRun, "queued", false)

	link(relinkedFresh, freshRun)
	_, err = q.FailNeverStartedAgentSession(ctx, FailNeverStartedAgentSessionParams{
		ID: relinkedFresh.ID, Cutoff: cutoff,
		WorkflowRunID: listedByID[relinkedFresh.ID].WorkflowRunID,
	})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	freshlyRelinked, err := q.GetAgentSession(ctx, relinkedFresh.ID)
	require.NoError(t, err)
	assert.Equal(t, "active", freshlyRelinked.Status)
	assert.Equal(t, freshRun, freshlyRelinked.WorkflowRunID.Int64)
	assertRun(freshRun, "queued", false)

	failedOldRun, err := q.FailNeverStartedAgentSession(ctx, FailNeverStartedAgentSessionParams{
		ID: oldSessionOldRun.ID, Cutoff: cutoff,
		WorkflowRunID: listedByID[oldSessionOldRun.ID].WorkflowRunID,
	})
	require.NoError(t, err)
	assert.Equal(t, "failed", failedOldRun.Status)
	assert.True(t, failedOldRun.FinishedAt.Valid)
	assert.JSONEq(t, `{"failure_reason":"never_started"}`, string(failedOldRun.Metadata))
	assertRun(oldRun, "failure", true)

	failedUnlinked, err := q.FailNeverStartedAgentSession(ctx, FailNeverStartedAgentSessionParams{
		ID: unlinked.ID, Cutoff: cutoff, WorkflowRunID: listedByID[unlinked.ID].WorkflowRunID,
	})
	require.NoError(t, err)
	assert.Equal(t, "failed", failedUnlinked.Status)

	// A run write failure aborts the whole statement, leaving the session
	// eligible for retry. Use a savepoint because PostgreSQL aborts its parent
	// transaction until the failed statement is rolled back.
	rollbackSession := newSession(old)
	rollbackRun := newRun(old)
	link(rollbackSession, rollbackRun)
	rollbackStep, err := q.CreateWorkflowStep(ctx, CreateWorkflowStepParams{
		WorkflowRunID: rollbackRun, Name: "agent", Position: 1, Status: "queued",
	})
	require.NoError(t, err)
	rollbackTask, err := q.CreateWorkflowTask(ctx, CreateWorkflowTaskParams{
		WorkflowRunID: rollbackRun, WorkflowStepID: rollbackStep.ID,
		RepositoryID: repo, Status: "pending", Priority: 1,
		Payload: json.RawMessage(`{}`), AvailableAt: time.Now(),
	})
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `CREATE FUNCTION pg_temp.reject_reaper_run_update() RETURNS trigger
		LANGUAGE plpgsql AS $$ BEGIN
			IF NEW.status = 'failure' THEN RAISE EXCEPTION 'forced run write failure'; END IF;
			RETURN NEW;
		END $$`)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `CREATE TRIGGER reject_reaper_run_update BEFORE UPDATE ON workflow_runs
		FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_reaper_run_update()`)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `SAVEPOINT before_reaper_failure`)
	require.NoError(t, err)
	_, err = q.FailNeverStartedAgentSession(ctx, FailNeverStartedAgentSessionParams{
		ID: rollbackSession.ID, Cutoff: cutoff,
		WorkflowRunID: pgtype.Int8{Int64: rollbackRun, Valid: true},
	})
	require.ErrorContains(t, err, "forced run write failure")
	_, err = tx.Exec(ctx, `ROLLBACK TO SAVEPOINT before_reaper_failure`)
	require.NoError(t, err)
	stillActive, err := q.GetAgentSession(ctx, rollbackSession.ID)
	require.NoError(t, err)
	assert.Equal(t, "active", stillActive.Status)
	assert.False(t, stillActive.FinishedAt.Valid)
	assertRun(rollbackRun, "queued", false)
	var taskStatus, stepStatus string
	var taskFinished, stepCompleted pgtype.Timestamptz
	require.NoError(t, tx.QueryRow(ctx,
		`SELECT status, finished_at FROM workflow_tasks WHERE id = $1`, rollbackTask.ID,
	).Scan(&taskStatus, &taskFinished))
	assert.Equal(t, "pending", taskStatus)
	assert.False(t, taskFinished.Valid)
	require.NoError(t, tx.QueryRow(ctx,
		`SELECT status, completed_at FROM workflow_steps WHERE id = $1`, rollbackStep.ID,
	).Scan(&stepStatus, &stepCompleted))
	assert.Equal(t, "queued", stepStatus)
	assert.False(t, stepCompleted.Valid)
}

func TestNeverStartedAgentSessionRecoveryFinalizesWorkflowGraphAndReleasesUnstartedReservations(t *testing.T) {
	ctx := context.Background()
	q, tx := newQueries(t)
	owner := mustCreateUser(t, tx, uniqueTestUsername(t))
	repo := mustCreateRepoForUser(t, tx, owner, uniqueTestRepoName(t))
	definition, err := q.UpsertAgentWorkflowDefinition(ctx, repo)
	require.NoError(t, err)
	cutoff := time.Now().UTC().Truncate(time.Second).Add(-time.Hour)
	old := cutoff.Add(-time.Second)
	type graph struct {
		session AgentSession
		runID   int64
		stepID  int64
		taskID  int64
	}
	makeGraph := func(taskStatus, stepStatus string, started bool) graph {
		session, createErr := q.CreateAgentSession(ctx, CreateAgentSessionParams{
			ID: uuid.NewString(), RepositoryID: repo, UserID: owner,
			Title: "Admitted agent", Status: "active",
		})
		require.NoError(t, createErr)
		_, err = tx.Exec(ctx, `UPDATE agent_sessions SET created_at = $1 WHERE id = $2`, old, session.ID)
		require.NoError(t, err)
		run, createErr := q.CreateWorkflowRun(ctx, CreateWorkflowRunParams{
			RepositoryID: repo, WorkflowDefinitionID: definition.ID, Status: "queued",
			TriggerEvent: "agent_message", TriggerRef: "main", TriggerCommitSha: "reaper-graph",
		})
		require.NoError(t, createErr)
		_, err = tx.Exec(ctx, `UPDATE workflow_runs SET created_at = $1 WHERE id = $2`, old, run.ID)
		require.NoError(t, err)
		_, err = q.UpdateAgentSessionWorkflowRun(ctx, UpdateAgentSessionWorkflowRunParams{
			ID: session.ID, WorkflowRunID: pgtype.Int8{Int64: run.ID, Valid: true},
		})
		require.NoError(t, err)
		step, createErr := q.CreateWorkflowStep(ctx, CreateWorkflowStepParams{
			WorkflowRunID: run.ID, Name: "agent", Position: 1, Status: stepStatus,
		})
		require.NoError(t, createErr)
		task, createErr := q.CreateWorkflowTask(ctx, CreateWorkflowTaskParams{
			WorkflowRunID: run.ID, WorkflowStepID: step.ID, RepositoryID: repo,
			Status: taskStatus, Priority: 1, Payload: json.RawMessage(`{}`), AvailableAt: time.Now(),
		})
		require.NoError(t, createErr)
		if started {
			_, err = tx.Exec(ctx, `UPDATE workflow_tasks SET started_at = $1 WHERE id = $2`, old, task.ID)
			require.NoError(t, err)
		}
		return graph{session: session, runID: run.ID, stepID: step.ID, taskID: task.ID}
	}
	pending := makeGraph("pending", "queued", false)
	assigned := makeGraph("assigned", "running", false)
	running := makeGraph("running", "running", true)
	terminal := makeGraph("done", "success", false)
	count := func() int64 {
		got, countErr := q.CountAgentRunAdmissionsByOwner(ctx, CountAgentRunAdmissionsByOwnerParams{
			PeriodStart: cutoff.Add(-time.Hour), PeriodEnd: time.Now().Add(time.Hour),
			OwnerType: "user", OwnerID: owner,
		})
		require.NoError(t, countErr)
		return got
	}
	assert.Equal(t, int64(4), count(), "queued runs reserve capacity before recovery")
	for _, g := range []graph{pending, assigned, running, terminal} {
		failed, failErr := q.FailNeverStartedAgentSession(ctx, FailNeverStartedAgentSessionParams{
			ID: g.session.ID, Cutoff: cutoff,
			WorkflowRunID: pgtype.Int8{Int64: g.runID, Valid: true},
		})
		require.NoError(t, failErr)
		assert.Equal(t, "failed", failed.Status)
		var runStatus, taskStatus, stepStatus string
		var lastError pgtype.Text
		var runCompleted, taskFinished, taskStarted, stepCompleted pgtype.Timestamptz
		require.NoError(t, tx.QueryRow(ctx,
			`SELECT status, completed_at FROM workflow_runs WHERE id = $1`, g.runID,
		).Scan(&runStatus, &runCompleted))
		require.NoError(t, tx.QueryRow(ctx,
			`SELECT status, last_error, finished_at, started_at FROM workflow_tasks WHERE id = $1`, g.taskID,
		).Scan(&taskStatus, &lastError, &taskFinished, &taskStarted))
		require.NoError(t, tx.QueryRow(ctx,
			`SELECT status, completed_at FROM workflow_steps WHERE id = $1`, g.stepID,
		).Scan(&stepStatus, &stepCompleted))
		assert.Equal(t, "failure", runStatus)
		assert.True(t, runCompleted.Valid)
		if g.taskID == terminal.taskID {
			assert.Equal(t, "done", taskStatus)
			assert.Equal(t, "success", stepStatus)
		} else {
			assert.Equal(t, "failed", taskStatus)
			assert.True(t, lastError.Valid)
			assert.Equal(t, "never_started", lastError.String)
			assert.True(t, taskFinished.Valid)
			assert.Equal(t, "failure", stepStatus)
			assert.True(t, stepCompleted.Valid)
		}
		assert.Equal(t, g.taskID == running.taskID, taskStarted.Valid)
	}
	assert.Equal(t, int64(1), count(), "only a task that actually started consumes the monthly admission")
}
