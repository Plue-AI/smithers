package db

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestWorkflowsSQL_H_DefinitionsRunsTasksAndStatusesRoundTrip(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	_, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))

	def, err := q.UpsertWorkflowDefinition(ctx, UpsertWorkflowDefinitionParams{
		RepositoryID: repoID,
		Name:         "CI",
		Path:         ".smithers/workflows/ci-h.yml",
		Config:       json.RawMessage(`{"steps":[{"name":"build"}]}`),
	})
	require.NoError(t, err)
	assert.True(t, def.IsActive)

	ref, err := q.EnsureWorkflowDefinitionReference(ctx, EnsureWorkflowDefinitionReferenceParams{
		RepositoryID: repoID,
		Name:         "Reference",
		Path:         ".smithers/workflows/reference-h.yml",
		Config:       json.RawMessage(`{"referenced":true}`),
	})
	require.NoError(t, err)
	assert.False(t, ref.IsActive)
	refAgain, err := q.EnsureWorkflowDefinitionReference(ctx, EnsureWorkflowDefinitionReferenceParams{
		RepositoryID: repoID,
		Name:         "Ignored",
		Path:         ref.Path,
		Config:       json.RawMessage(`{"ignored":true}`),
	})
	require.NoError(t, err)
	assert.Equal(t, ref.ID, refAgain.ID)

	require.NoError(t, q.DeactivateWorkflowDefinitionByPath(ctx, DeactivateWorkflowDefinitionByPathParams{
		RepositoryID: repoID,
		Path:         def.Path,
	}))
	inactive, err := q.GetWorkflowDefinitionByPath(ctx, GetWorkflowDefinitionByPathParams{RepositoryID: repoID, Path: def.Path})
	require.NoError(t, err)
	assert.False(t, inactive.IsActive)

	def, err = q.UpsertWorkflowDefinition(ctx, UpsertWorkflowDefinitionParams{
		RepositoryID: repoID,
		Name:         "CI Reactivated",
		Path:         def.Path,
		Config:       json.RawMessage(`{"steps":[{"name":"build"},{"name":"canary-linux"}]}`),
	})
	require.NoError(t, err)
	assert.True(t, def.IsActive)

	agentDef, err := q.UpsertAgentWorkflowDefinition(ctx, repoID)
	require.NoError(t, err)
	assert.Equal(t, ".smithers/agent", agentDef.Path)
	agentDefAgain, err := q.UpsertAgentWorkflowDefinition(ctx, repoID)
	require.NoError(t, err)
	assert.Equal(t, agentDef.ID, agentDefAgain.ID)

	gotDef, err := q.GetWorkflowDefinition(ctx, GetWorkflowDefinitionParams{ID: def.ID, RepositoryID: repoID})
	require.NoError(t, err)
	assert.Equal(t, def.ID, gotDef.ID)

	defs, err := q.ListWorkflowDefinitionsByRepo(ctx, ListWorkflowDefinitionsByRepoParams{RepositoryID: repoID, PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	assert.True(t, workflowsSQLHHasDefinition(defs, def.ID))
	assert.True(t, workflowsSQLHHasDefinition(defs, ref.ID))

	run, err := q.CreateWorkflowRun(ctx, CreateWorkflowRunParams{
		RepositoryID:         repoID,
		WorkflowDefinitionID: def.ID,
		Status:               "queued",
		TriggerEvent:         "push",
		TriggerRef:           "main",
		TriggerCommitSha:     "sha-h-1",
		DispatchInputs:       []byte(`{"source":"h"}`),
	})
	require.NoError(t, err)

	checkedRun, err := q.UpdateWorkflowRunCheckRun(ctx, UpdateWorkflowRunCheckRunParams{
		CheckRunID:  pgtype.Int8{Int64: 4242, Valid: true},
		CheckRunUrl: pgtype.Text{String: "https://checks.example/h", Valid: true},
		ID:          run.ID,
	})
	require.NoError(t, err)
	assert.Equal(t, int64(4242), checkedRun.CheckRunID.Int64)

	buildStep, err := q.CreateWorkflowStep(ctx, CreateWorkflowStepParams{WorkflowRunID: run.ID, Name: "build", Position: 1, Status: "queued"})
	require.NoError(t, err)
	canaryStep, err := q.CreateWorkflowStep(ctx, CreateWorkflowStepParams{WorkflowRunID: run.ID, Name: "canary-linux", Position: 2, Status: "queued"})
	require.NoError(t, err)

	require.NoError(t, q.FailWorkflowRun(ctx, run.ID))
	_, err = q.UpdateWorkflowStepStatusTerminal(ctx, UpdateWorkflowStepStatusTerminalParams{Status: "success", StepID: canaryStep.ID})
	require.NoError(t, err)

	assigned := workflowsSQLHCreateTask(t, q, run.ID, buildStep.ID, repoID, "pending", `{"task":"assigned"}`)
	affected, err := q.MarkWorkflowTaskVMRunning(ctx, MarkWorkflowTaskVMRunningParams{
		VmID: pgtype.Text{String: "vm-h-0", Valid: true},
		ID:   assigned.ID,
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), affected)
	terminalRunID, err := q.MarkWorkflowTaskTerminalByID(ctx, MarkWorkflowTaskTerminalByIDParams{
		Status: "done", LastError: pgtype.Text{}, ID: assigned.ID,
	})
	require.NoError(t, err)
	assert.Equal(t, run.ID, terminalRunID)

	vmTask := workflowsSQLHCreateTask(t, q, run.ID, buildStep.ID, repoID, "pending", `{"task":"vm"}`)
	affected, err = q.MarkWorkflowTaskVMRunning(ctx, MarkWorkflowTaskVMRunningParams{
		VmID: pgtype.Text{String: "vm-h-1", Valid: true},
		ID:   vmTask.ID,
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), affected)

	blocked := workflowsSQLHCreateTask(t, q, run.ID, buildStep.ID, repoID, "blocked", `{"task":"blocked"}`)
	require.NoError(t, q.SkipBlockedWorkflowTask(ctx, blocked.ID))

	blockedForUnblock := workflowsSQLHCreateTask(t, q, run.ID, buildStep.ID, repoID, "blocked", `{"task":"unblock"}`)
	require.NoError(t, q.UnblockWorkflowTask(ctx, blockedForUnblock.ID))

	gotTask, err := q.GetWorkflowTask(ctx, GetWorkflowTaskParams{ID: assigned.ID, RepositoryID: repoID})
	require.NoError(t, err)
	assert.Equal(t, assigned.ID, gotTask.ID)
	latestTask, err := q.GetWorkflowTaskByRunID(ctx, run.ID)
	require.NoError(t, err)
	assert.Equal(t, blockedForUnblock.ID, latestTask.ID)

	taskInfo, err := q.ListTaskStepInfoForRun(ctx, run.ID)
	require.NoError(t, err)
	assert.True(t, workflowsSQLHHasTaskInfo(taskInfo, assigned.ID, "build"))

	_, err = q.UpdateWorkflowStepStatusRunning(ctx, buildStep.ID)
	require.NoError(t, err)
	_, err = q.UpdateWorkflowStepStatusTerminal(ctx, UpdateWorkflowStepStatusTerminalParams{Status: "success", StepID: buildStep.ID})
	require.NoError(t, err)

	mustExec(t, pool, `UPDATE workflow_steps SET status = 'failure', completed_at = NOW() WHERE id = $1`, buildStep.ID)
	mustExec(t, pool, `UPDATE workflow_tasks SET status = 'failed', finished_at = NOW() WHERE id = $1`, vmTask.ID)
	require.NoError(t, q.ResumeWorkflowRun(ctx, run.ID))
	require.NoError(t, q.ResumeWorkflowSteps(ctx, run.ID))
	require.NoError(t, q.ResumeWorkflowTasks(ctx, run.ID))

	var resumedRunStatus, resumedStepStatus, resumedTaskStatus string
	require.NoError(t, pool.QueryRow(ctx, `SELECT status FROM workflow_runs WHERE id = $1`, run.ID).Scan(&resumedRunStatus))
	require.NoError(t, pool.QueryRow(ctx, `SELECT status FROM workflow_steps WHERE id = $1`, buildStep.ID).Scan(&resumedStepStatus))
	require.NoError(t, pool.QueryRow(ctx, `SELECT status FROM workflow_tasks WHERE id = $1`, vmTask.ID).Scan(&resumedTaskStatus))
	assert.Equal(t, "queued", resumedRunStatus)
	assert.Equal(t, "queued", resumedStepStatus)
	assert.Equal(t, "pending", resumedTaskStatus)

	status1, err := q.CreateCommitStatus(ctx, CreateCommitStatusParams{
		RepositoryID:  repoID,
		ChangeID:      pgtype.Text{String: "change-h-1", Valid: true},
		CommitSha:     pgtype.Text{String: "sha-h-1", Valid: true},
		Context:       "ci/test",
		Status:        "pending",
		Description:   "old",
		TargetUrl:     "https://checks.example/old",
		WorkflowRunID: pgtype.Int8{Int64: run.ID, Valid: true},
	})
	require.NoError(t, err)
	status2, err := q.CreateCommitStatus(ctx, CreateCommitStatusParams{
		RepositoryID:  repoID,
		ChangeID:      pgtype.Text{String: "change-h-1", Valid: true},
		CommitSha:     pgtype.Text{String: "sha-h-1", Valid: true},
		Context:       "ci/test",
		Status:        "failure",
		Description:   "new",
		TargetUrl:     "https://checks.example/new",
		WorkflowRunID: pgtype.Int8{Int64: run.ID, Valid: true},
	})
	require.NoError(t, err)
	_, err = q.CreateCommitStatus(ctx, CreateCommitStatusParams{
		RepositoryID:  repoID,
		ChangeID:      pgtype.Text{String: "change-h-1", Valid: true},
		CommitSha:     pgtype.Text{String: "sha-h-1", Valid: true},
		Context:       "lint",
		Status:        "success",
		Description:   "lint ok",
		TargetUrl:     "https://checks.example/lint",
		WorkflowRunID: pgtype.Int8{Int64: run.ID, Valid: true},
	})
	require.NoError(t, err)
	mustExec(t, pool, `UPDATE commit_statuses SET created_at = NOW() - INTERVAL '2 minutes' WHERE id = $1`, status1.ID)
	mustExec(t, pool, `UPDATE commit_statuses SET created_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, status2.ID)

	count, err := q.CountCommitStatusesByRef(ctx, CountCommitStatusesByRefParams{RepositoryID: repoID, Ref: pgtype.Text{String: "change-h-1", Valid: true}})
	require.NoError(t, err)
	assert.Equal(t, int64(3), count)

	byRef, err := q.ListCommitStatusesByRef(ctx, ListCommitStatusesByRefParams{
		RepositoryID: repoID,
		Ref:          pgtype.Text{String: "change-h-1", Valid: true},
		PageOffset:   0,
		PageSize:     10,
	})
	require.NoError(t, err)
	require.Len(t, byRef, 3)
	bySHA, err := q.ListCommitStatusesBySHA(ctx, ListCommitStatusesBySHAParams{
		RepositoryID: repoID,
		CommitSha:    pgtype.Text{String: "sha-h-1", Valid: true},
		PageOffset:   0,
		PageSize:     10,
	})
	require.NoError(t, err)
	require.Len(t, bySHA, 3)

	latestSHA, err := q.GetLatestCommitStatusBySHA(ctx, GetLatestCommitStatusBySHAParams{
		RepositoryID: repoID,
		CommitSha:    pgtype.Text{String: "sha-h-1", Valid: true},
	})
	require.NoError(t, err)
	assert.Equal(t, repoID, latestSHA.RepositoryID)

	latestByContext, err := q.GetLatestCommitStatusesByChangeIDsAndContexts(ctx, GetLatestCommitStatusesByChangeIDsAndContextsParams{
		RepositoryID: repoID,
		ChangeIds:    []string{"change-h-1"},
		Contexts:     []string{"ci/test", "lint"},
	})
	require.NoError(t, err)
	require.Len(t, latestByContext, 2)

	updatedStatus, err := q.UpdateLatestCommitStatusByWorkflowRunID(ctx, UpdateLatestCommitStatusByWorkflowRunIDParams{
		WorkflowRunID: pgtype.Int8{Int64: run.ID, Valid: true},
		Status:        "success",
		Description:   "all green",
		TargetUrl:     "https://checks.example/success",
	})
	require.NoError(t, err)
	assert.Equal(t, "success", updatedStatus.Status)

	runsByDef, err := q.ListWorkflowRunsByDefinition(ctx, ListWorkflowRunsByDefinitionParams{
		WorkflowDefinitionID: def.ID,
		RepositoryID:         repoID,
		PageOffset:           0,
		PageSize:             10,
	})
	require.NoError(t, err)
	assert.True(t, workflowsSQLHHasRun(runsByDef, run.ID))
	runsByRepo, err := q.ListWorkflowRunsByRepo(ctx, ListWorkflowRunsByRepoParams{RepositoryID: repoID, PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	assert.True(t, workflowsSQLHHasRun(runsByRepo, run.ID))

	successDef, err := q.UpsertWorkflowDefinition(ctx, UpsertWorkflowDefinitionParams{
		RepositoryID: repoID,
		Name:         "Success",
		Path:         ".smithers/workflows/success-h.yml",
		Config:       json.RawMessage(`{"steps":[{"name":"success"}]}`),
	})
	require.NoError(t, err)
	successRun, err := q.CreateWorkflowRun(ctx, CreateWorkflowRunParams{
		RepositoryID:         repoID,
		WorkflowDefinitionID: successDef.ID,
		Status:               "queued",
		TriggerEvent:         "push",
		TriggerRef:           "main",
		TriggerCommitSha:     "sha-h-success",
		DispatchInputs:       []byte(`{}`),
		// Task-derived status belongs to agent-plane runs; a sandbox run
		// reaches a terminal outcome only through its scheduler claim (0091).
		ExecutionPlane: "agent",
	})
	require.NoError(t, err)
	successStep, err := q.CreateWorkflowStep(ctx, CreateWorkflowStepParams{WorkflowRunID: successRun.ID, Name: "success", Position: 1, Status: "queued"})
	require.NoError(t, err)
	workflowsSQLHCreateTask(t, q, successRun.ID, successStep.ID, repoID, "done", `{"task":"done"}`)
	derivedStatus, err := q.UpdateWorkflowRunStatusBasedOnTasks(ctx, successRun.ID)
	require.NoError(t, err)
	assert.Equal(t, "success", derivedStatus)
}

func TestWorkflowsSQL_H_MissingRowsAndConstraintErrors(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	_, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))

	count, err := q.CountCommitStatusesByRef(ctx, CountCommitStatusesByRefParams{RepositoryID: repoID, Ref: pgtype.Text{String: "missing", Valid: true}})
	require.NoError(t, err)
	assert.Zero(t, count)

	_, err = q.GetLatestCommitStatusBySHA(ctx, GetLatestCommitStatusBySHAParams{RepositoryID: repoID, CommitSha: pgtype.Text{String: "missing", Valid: true}})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.GetWorkflowDefinition(ctx, GetWorkflowDefinitionParams{ID: 999999999, RepositoryID: repoID})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.GetWorkflowDefinitionByPath(ctx, GetWorkflowDefinitionByPathParams{RepositoryID: repoID, Path: "missing"})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.GetWorkflowTask(ctx, GetWorkflowTaskParams{ID: 999999999, RepositoryID: repoID})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.GetWorkflowTaskByRunID(ctx, 999999999)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.MarkWorkflowTaskTerminalByID(ctx, MarkWorkflowTaskTerminalByIDParams{Status: "done", ID: 999999999})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.UpdateLatestCommitStatusByWorkflowRunID(ctx, UpdateLatestCommitStatusByWorkflowRunIDParams{WorkflowRunID: pgtype.Int8{Int64: 999999999, Valid: true}, Status: "success"})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.UpdateWorkflowRunCheckRun(ctx, UpdateWorkflowRunCheckRunParams{ID: 999999999})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.UpdateWorkflowRunStatusBasedOnTasks(ctx, 999999999)
	require.ErrorIs(t, err, pgx.ErrNoRows)

	mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.EnsureWorkflowDefinitionReference(ctx, EnsureWorkflowDefinitionReferenceParams{
			RepositoryID: 999999999,
			Name:         "bad",
			Path:         ".smithers/workflows/bad-ref.yml",
			Config:       json.RawMessage(`{"bad":true}`),
		})
		return err
	})
	mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.UpsertAgentWorkflowDefinition(ctx, 999999999)
		return err
	})
	mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.UpsertWorkflowDefinition(ctx, UpsertWorkflowDefinitionParams{
			RepositoryID: 999999999,
			Name:         "bad",
			Path:         ".smithers/workflows/bad-upsert.yml",
			Config:       json.RawMessage(`{"bad":true}`),
		})
		return err
	})
}

func TestWorkflowsSQL_H_ManyErrorBranches(t *testing.T) {
	sentinel := errors.New("workflows h rows failed")
	cases := []struct {
		name string
		call func(*Queries) error
	}{
		{"GetLatestCommitStatusesByChangeIDsAndContexts", func(q *Queries) error {
			_, err := q.GetLatestCommitStatusesByChangeIDsAndContexts(context.Background(), GetLatestCommitStatusesByChangeIDsAndContextsParams{
				RepositoryID: 1, ChangeIds: []string{"change"}, Contexts: []string{"ci"},
			})
			return err
		}},
		{"ListCommitStatusesByRef", func(q *Queries) error {
			_, err := q.ListCommitStatusesByRef(context.Background(), ListCommitStatusesByRefParams{RepositoryID: 1, Ref: pgtype.Text{String: "ref", Valid: true}, PageOffset: 0, PageSize: 1})
			return err
		}},
		{"ListCommitStatusesBySHA", func(q *Queries) error {
			_, err := q.ListCommitStatusesBySHA(context.Background(), ListCommitStatusesBySHAParams{RepositoryID: 1, CommitSha: pgtype.Text{String: "sha", Valid: true}, PageOffset: 0, PageSize: 1})
			return err
		}},

		{"ListTaskStepInfoForRun", func(q *Queries) error { _, err := q.ListTaskStepInfoForRun(context.Background(), 1); return err }},
		{"ListWorkflowDefinitionsByRepo", func(q *Queries) error {
			_, err := q.ListWorkflowDefinitionsByRepo(context.Background(), ListWorkflowDefinitionsByRepoParams{RepositoryID: 1, PageOffset: 0, PageSize: 1})
			return err
		}},
		{"ListWorkflowRunsByDefinition", func(q *Queries) error {
			_, err := q.ListWorkflowRunsByDefinition(context.Background(), ListWorkflowRunsByDefinitionParams{WorkflowDefinitionID: 1, RepositoryID: 1, PageOffset: 0, PageSize: 1})
			return err
		}},
		{"ListWorkflowRunsByRepo", func(q *Queries) error {
			_, err := q.ListWorkflowRunsByRepo(context.Background(), ListWorkflowRunsByRepoParams{RepositoryID: 1, PageOffset: 0, PageSize: 1})
			return err
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name+"_query", func(t *testing.T) {
			err := tc.call(New(workflowsSQLHDB{queryErr: sentinel}))
			require.ErrorIs(t, err, sentinel)
		})
		t.Run(tc.name+"_scan", func(t *testing.T) {
			err := tc.call(New(workflowsSQLHDB{rows: &workflowsSQLHRows{next: true, scanErr: sentinel}}))
			require.ErrorIs(t, err, sentinel)
		})
		t.Run(tc.name+"_rows_err", func(t *testing.T) {
			err := tc.call(New(workflowsSQLHDB{rows: &workflowsSQLHRows{err: sentinel}}))
			require.ErrorIs(t, err, sentinel)
		})
	}
}

func TestWorkflowsSQL_H_ExecErrorBranches(t *testing.T) {
	sentinel := errors.New("workflows h exec failed")
	q := New(workflowsSQLHDB{execErr: sentinel})
	cases := []struct {
		name string
		call func() error
	}{
		{"DeactivateWorkflowDefinitionByPath", func() error {
			return q.DeactivateWorkflowDefinitionByPath(context.Background(), DeactivateWorkflowDefinitionByPathParams{RepositoryID: 1, Path: "path"})
		}},
		{"FailWorkflowRun", func() error { return q.FailWorkflowRun(context.Background(), 1) }},
		{"MarkWorkflowTaskVMRunning", func() error {
			_, err := q.MarkWorkflowTaskVMRunning(context.Background(), MarkWorkflowTaskVMRunningParams{VmID: pgtype.Text{String: "vm", Valid: true}, ID: 1})
			return err
		}},
		{"ResumeWorkflowRun", func() error { return q.ResumeWorkflowRun(context.Background(), 1) }},
		{"ResumeWorkflowSteps", func() error { return q.ResumeWorkflowSteps(context.Background(), 1) }},
		{"ResumeWorkflowTasks", func() error { return q.ResumeWorkflowTasks(context.Background(), 1) }},
		{"SkipBlockedWorkflowTask", func() error { return q.SkipBlockedWorkflowTask(context.Background(), 1) }},
		{"UnblockWorkflowTask", func() error { return q.UnblockWorkflowTask(context.Background(), 1) }},
		{"UpdateWorkflowStepStatusRunning", func() error {
			_, err := q.UpdateWorkflowStepStatusRunning(context.Background(), 1)
			return err
		}},
		{"UpdateWorkflowStepStatusTerminal", func() error {
			_, err := q.UpdateWorkflowStepStatusTerminal(context.Background(), UpdateWorkflowStepStatusTerminalParams{Status: "success", StepID: 1})
			return err
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			require.ErrorIs(t, tc.call(), sentinel)
		})
	}
}

func workflowsSQLHCreateTask(t *testing.T, q *Queries, runID, stepID, repoID int64, status, payload string) WorkflowTask {
	t.Helper()
	task, err := q.CreateWorkflowTask(context.Background(), CreateWorkflowTaskParams{
		WorkflowRunID:  runID,
		WorkflowStepID: stepID,
		RepositoryID:   repoID,
		Status:         status,
		Priority:       1,
		Payload:        json.RawMessage(payload),
		AvailableAt:    time.Now().Add(-time.Minute),
		VmID:           pgtype.Text{},
	})
	require.NoError(t, err)
	return task
}

func workflowsSQLHHasDefinition(defs []WorkflowDefinition, id int64) bool {
	for _, def := range defs {
		if def.ID == id {
			return true
		}
	}
	return false
}

func workflowsSQLHHasRun(runs []WorkflowRun, id int64) bool {
	for _, run := range runs {
		if run.ID == id {
			return true
		}
	}
	return false
}

func workflowsSQLHHasTaskInfo(tasks []ListTaskStepInfoForRunRow, id int64, stepName string) bool {
	for _, task := range tasks {
		if task.ID == id && task.StepName == stepName {
			return true
		}
	}
	return false
}

type workflowsSQLHDB struct {
	execErr  error
	queryErr error
	rows     pgx.Rows
	row      pgx.Row
}

func (db workflowsSQLHDB) Exec(context.Context, string, ...interface{}) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, db.execErr
}

func (db workflowsSQLHDB) Query(context.Context, string, ...interface{}) (pgx.Rows, error) {
	if db.queryErr != nil {
		return nil, db.queryErr
	}
	if db.rows != nil {
		return db.rows, nil
	}
	return &workflowsSQLHRows{}, nil
}

func (db workflowsSQLHDB) QueryRow(context.Context, string, ...interface{}) pgx.Row {
	if db.row != nil {
		return db.row
	}
	return workflowsSQLHRow{err: errors.New("workflows h row failed")}
}

type workflowsSQLHRow struct {
	err error
}

func (r workflowsSQLHRow) Scan(...any) error {
	return r.err
}

type workflowsSQLHRows struct {
	next    bool
	scanErr error
	err     error
}

func (r *workflowsSQLHRows) Close() {}

func (r *workflowsSQLHRows) Err() error {
	return r.err
}

func (r *workflowsSQLHRows) CommandTag() pgconn.CommandTag {
	return pgconn.CommandTag{}
}

func (r *workflowsSQLHRows) FieldDescriptions() []pgconn.FieldDescription {
	return nil
}

func (r *workflowsSQLHRows) Next() bool {
	if r.next {
		r.next = false
		return true
	}
	return false
}

func (r *workflowsSQLHRows) Scan(...any) error {
	if r.scanErr != nil {
		return r.scanErr
	}
	return errors.New("workflows h scan unexpectedly succeeded")
}

func (r *workflowsSQLHRows) Values() ([]any, error) {
	return nil, r.err
}

func (r *workflowsSQLHRows) RawValues() [][]byte {
	return nil
}

func (r *workflowsSQLHRows) Conn() *pgx.Conn {
	return nil
}
