package services

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// checkViolation reproduces what pgx surfaces when Postgres rejects a row on a
// CHECK constraint (SQLSTATE 23514) — the exact failure that made the scheduled
// production canary undispatchable.
func checkViolation(constraint string) error {
	return &pgconn.PgError{
		Severity:       "ERROR",
		Code:           "23514",
		Message:        `new row for relation "workflow_tasks" violates check constraint "` + constraint + `"`,
		ConstraintName: constraint,
		TableName:      "workflow_tasks",
		SchemaName:     "public",
		Routine:        "ExecConstraints",
	}
}

// The dispatcher used to discard the driver error entirely and return only
// "failed to create workflow task: <job>". That made a production-only CHECK
// constraint violation invisible: the scheduler logged the same opaque line
// every five minutes with no way to learn the cause. The message must now carry
// the status that was attempted and the driver's own text.
func TestWorkflowRunService_DispatchForEvent_TaskCreateFailure_ReportsDriverCause(t *testing.T) {
	t.Parallel()

	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "canary", true, `{
					"on":{"push":{}},
					"jobs":{
						"canary-auth":{"runs-on":"ubuntu","steps":[{"run":"probe"}]},
						"notify-failure":{
							"needs":["canary-auth"],
							"if":"failure()",
							"runs-on":"ubuntu",
							"steps":[{"run":"notify"}]
						}
					}
				}`),
			}, nil
		},
		createTaskFn: func(_ context.Context, arg db.CreateWorkflowTaskParams) (db.WorkflowTask, error) {
			if arg.Status == "blocked" {
				return db.WorkflowTask{}, checkViolation("workflow_tasks_status_check")
			}
			return db.WorkflowTask{ID: arg.WorkflowStepID, WorkflowStepID: arg.WorkflowStepID}, nil
		},
	}

	_, err := newCurrentPushTestService(mock).DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	require.Error(t, err)

	assert.Contains(t, err.Error(), "notify-failure", "the failing job must stay identifiable")
	assert.Contains(t, err.Error(), "status=blocked", "the attempted status is what the constraint rejected")
	assert.Contains(t, err.Error(), "workflow_tasks_status_check",
		"the driver's cause must reach the log line, not be discarded")
}

// Same contract for the sibling writes in the dispatch path: a swallowed cause
// anywhere in createWorkflowRunRows produces the same undebuggable log line.
func TestWorkflowRunService_DispatchForEvent_StepCreateFailure_ReportsDriverCause(t *testing.T) {
	t.Parallel()

	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "ci", true, `{
					"on":{"push":{}},
					"jobs":{"build":{"runs-on":"ubuntu","steps":[{"run":"go test ./..."}]}}
				}`),
			}, nil
		},
		createStepFn: func(_ context.Context, _ db.CreateWorkflowStepParams) (db.WorkflowStep, error) {
			return db.WorkflowStep{}, checkViolation("workflow_steps_status_check")
		},
	}

	_, err := newCurrentPushTestService(mock).DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	require.Error(t, err)

	assert.Contains(t, err.Error(), "build")
	assert.Contains(t, err.Error(), "status=queued")
	assert.Contains(t, err.Error(), "workflow_steps_status_check")
}

func TestWorkflowRunService_DispatchForEvent_RunCreateFailure_ReportsDriverCause(t *testing.T) {
	t.Parallel()

	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "ci", true, `{
					"on":{"push":{}},
					"jobs":{"build":{"runs-on":"ubuntu","steps":[{"run":"go test ./..."}]}}
				}`),
			}, nil
		},
		createRunFn: func(_ context.Context, _ db.CreateWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{}, errors.New("connection reset by peer")
		},
	}

	_, err := newCurrentPushTestService(mock).DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "connection reset by peer")
}
