package db

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type workflowTaskFixture struct {
	repoID int64
	runID  int64
	stepID int64
}

func mustCreateWorkflowTaskFixture(t *testing.T, q *Queries, pool DBTX, prefix string, executionPlanes ...string) workflowTaskFixture {
	t.Helper()
	executionPlane := ""
	if len(executionPlanes) > 0 {
		executionPlane = executionPlanes[0]
	}

	userID := mustCreateUser(t, pool, prefix+"-user")
	repoID := mustCreateRepo(t, pool, userID, prefix+"-repo")

	cfg := []byte(`{"triggers":[{"type":"push"}],"steps":[{"name":"test","run":"make test"}]}`)
	def, err := q.CreateWorkflowDefinition(context.Background(), CreateWorkflowDefinitionParams{
		RepositoryID: repoID,
		Name:         "Workflow",
		Path:         ".smithers/workflows/test.tsx",
		Config:       cfg,
	})
	require.NoError(t, err)

	run, err := q.CreateWorkflowRun(context.Background(), CreateWorkflowRunParams{
		RepositoryID:         repoID,
		WorkflowDefinitionID: def.ID,
		Status:               "queued",
		TriggerEvent:         "push",
		TriggerRef:           "main",
		TriggerCommitSha:     "sha-task-fixture",
		ExecutionPlane:       executionPlane,
	})
	require.NoError(t, err)

	step, err := q.CreateWorkflowStep(context.Background(), CreateWorkflowStepParams{
		WorkflowRunID: run.ID,
		Name:          "test",
		Position:      1,
		Status:        "queued",
	})
	require.NoError(t, err)

	return workflowTaskFixture{
		repoID: repoID,
		runID:  run.ID,
		stepID: step.ID,
	}
}

// mustFinishWorkflowRun moves a fixture run through running to success with
// completedAt. A sandbox-plane run cannot jump from queued to a terminal
// scheduler outcome (migration 0091's terminal claim fence), so a fixture
// that needs a finished run takes the same route a scheduler does.
func mustFinishWorkflowRun(t *testing.T, pool DBTX, runID int64, completedAt time.Time) {
	t.Helper()
	for _, status := range []string{"running", "success"} {
		tag, err := pool.Exec(context.Background(), `UPDATE workflow_runs SET status=$1, completed_at=$2 WHERE id=$3`, status, completedAt, runID)
		require.NoError(t, err)
		require.Equal(t, int64(1), tag.RowsAffected(), "workflow run %d did not reach %s", runID, status)
	}
}

func mustCreateWorkflowTask(t *testing.T, q *Queries, fixture workflowTaskFixture, status string) WorkflowTask {
	t.Helper()

	task, err := q.CreateWorkflowTask(context.Background(), CreateWorkflowTaskParams{
		WorkflowRunID:  fixture.runID,
		WorkflowStepID: fixture.stepID,
		RepositoryID:   fixture.repoID,
		Status:         status,
		Priority:       1,
		Payload:        []byte(`{"kind":"step"}`),
		AvailableAt:    time.Now().UTC().Add(-1 * time.Second),
	})
	require.NoError(t, err)
	return task
}

func mustSetTaskPriorityAndCreatedAt(t *testing.T, pool DBTX, taskID int64, priority int16, createdAt time.Time) {
	t.Helper()

	_, err := pool.Exec(
		context.Background(),
		`UPDATE workflow_tasks
		 SET priority = $2, created_at = $3, updated_at = $3
		 WHERE id = $1`,
		taskID,
		priority,
		createdAt,
	)
	require.NoError(t, err)
}

func mustSetWorkflowTaskState(t *testing.T, pool DBTX, taskID int64, status string, availableAt time.Time) {
	t.Helper()

	_, err := pool.Exec(
		context.Background(),
		`UPDATE workflow_tasks
		 SET status = $2,
		     available_at = $3,
		     updated_at = NOW()
		 WHERE id = $1`,
		taskID,
		status,
		availableAt,
	)
	require.NoError(t, err)
}

func mustSetWorkflowTaskAssignment(
	t *testing.T,
	pool DBTX,
	taskID int64,
	status string,
	runnerID int64,
	assignedAt time.Time,
	startedAt pgtype.Timestamptz,
) {
	t.Helper()

	_, err := pool.Exec(
		context.Background(),
		`UPDATE workflow_tasks
		 SET status = $2,
		     runner_id = $3,
		     assigned_at = $4,
		     started_at = $5,
		     updated_at = NOW()
		 WHERE id = $1`,
		taskID,
		status,
		runnerID,
		assignedAt,
		startedAt,
	)
	require.NoError(t, err)
}

func mustSetWorkflowTaskAttempt(t *testing.T, pool DBTX, taskID int64, attempt int32) {
	t.Helper()

	_, err := pool.Exec(
		context.Background(),
		`UPDATE workflow_tasks
		 SET attempt = $2,
		     updated_at = NOW()
		 WHERE id = $1`,
		taskID,
		attempt,
	)
	require.NoError(t, err)
}

func assertWorkflowTaskStatus(t *testing.T, pool DBTX, taskID int64, wantStatus string) {
	t.Helper()

	var status string
	err := pool.QueryRow(context.Background(), `SELECT status FROM workflow_tasks WHERE id = $1`, taskID).Scan(&status)
	require.NoError(t, err)
	assert.Equal(t, wantStatus, status)
}

func assertWorkflowTaskAssignmentState(
	t *testing.T,
	pool DBTX,
	taskID int64,
	wantStatus string,
	wantRunner bool,
	wantAssignedAt bool,
	wantStartedAt bool,
) {
	t.Helper()

	var status string
	var runnerID pgtype.Int8
	var assignedAt pgtype.Timestamptz
	var startedAt pgtype.Timestamptz
	err := pool.QueryRow(
		context.Background(),
		`SELECT status, runner_id, assigned_at, started_at
		 FROM workflow_tasks
		 WHERE id = $1`,
		taskID,
	).Scan(&status, &runnerID, &assignedAt, &startedAt)
	require.NoError(t, err)

	assert.Equal(t, wantStatus, status)
	assert.Equal(t, wantRunner, runnerID.Valid)
	assert.Equal(t, wantAssignedAt, assignedAt.Valid)
	assert.Equal(t, wantStartedAt, startedAt.Valid)
}

func workflowTaskAvailableAt(t *testing.T, pool DBTX, taskID int64) time.Time {
	t.Helper()

	var availableAt time.Time
	err := pool.QueryRow(context.Background(), `SELECT available_at FROM workflow_tasks WHERE id = $1`, taskID).Scan(&availableAt)
	require.NoError(t, err)
	return availableAt
}

func assertWorkflowTaskAvailableAfter(t *testing.T, pool DBTX, taskID int64, after time.Time) {
	t.Helper()

	availableAt := workflowTaskAvailableAt(t, pool, taskID)
	assert.True(t, availableAt.After(after), "task %d should be delayed until after %s, got %s", taskID, after, availableAt)
}

func assertWorkflowStepState(
	t *testing.T,
	pool DBTX,
	stepID int64,
	wantStatus string,
	wantStartedAt bool,
	wantCompletedAt bool,
) {
	t.Helper()

	var status string
	var startedAt pgtype.Timestamptz
	var completedAt pgtype.Timestamptz
	err := pool.QueryRow(
		context.Background(),
		`SELECT status, started_at, completed_at
		 FROM workflow_steps
		 WHERE id = $1`,
		stepID,
	).Scan(&status, &startedAt, &completedAt)
	require.NoError(t, err)

	assert.Equal(t, wantStatus, status)
	assert.Equal(t, wantStartedAt, startedAt.Valid)
	assert.Equal(t, wantCompletedAt, completedAt.Valid)
}

func runnerParam(runnerID int64) pgtype.Int8 {
	return pgtype.Int8{Int64: runnerID, Valid: true}
}
func fcovWorkflowRun(t *testing.T, ctx context.Context, q *Queries, repoID int64, status string, executionPlanes ...string) WorkflowRun {
	t.Helper()
	executionPlane := ""
	if len(executionPlanes) > 0 {
		executionPlane = executionPlanes[0]
	}
	def, err := q.UpsertWorkflowDefinition(ctx, UpsertWorkflowDefinitionParams{
		RepositoryID: repoID,
		Name:         "cov",
		Path:         ".smithers/workflows/cov-" + randSlug(t) + ".yml",
		Config:       json.RawMessage(`{"steps":[]}`),
	})
	require.NoError(t, err)
	run, err := q.CreateWorkflowRun(ctx, CreateWorkflowRunParams{
		RepositoryID:         repoID,
		WorkflowDefinitionID: def.ID,
		Status:               status,
		TriggerEvent:         "push",
		TriggerRef:           "main",
		TriggerCommitSha:     "sha-" + randSlug(t),
		DispatchInputs:       []byte(`{}`),
		ExecutionPlane:       executionPlane,
	})
	require.NoError(t, err)
	return run
}
