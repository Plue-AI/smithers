package services

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// runtimeFailureOf is the code and retryability a flow host resolver
// refusal carries to the dispatcher.
func runtimeFailureOf(t *testing.T, err error) (string, bool) {
	t.Helper()
	var failure flowruntime.FlowRuntimeFailure
	require.True(t, errors.As(err, &failure), "%v", err)
	return failure.FlowRuntimeCode(), failure.FlowRuntimeRetryable()
}

// A lane whose provisioning failed for good (not a full host, which queues
// the lane) fails its TODO at provisioning with its step, class and message,
// instead of Starting forever (lane-release followup 3; m3-walk-full defect
// 7). The resolver answers the launch final, the dispatcher fails it, the
// stack stops the TODO and releases the failed lane, and a person's Retry
// starts the next attempt on a new lane.
func TestTodoOnAFailedLaneFailsAtProvisioning(t *testing.T) {
	o, session := newTodoAdmission(t)
	ctx := context.Background()
	o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
	item := o.fileTodo(session, "lane-fails")
	n, id := item.Number.Int64, uuidString(item.ID)
	o.wake()
	launches := o.launcher.byFlow("todo")
	require.Len(t, launches, 1)
	lane := o.byID(id).WorkspaceID
	require.NotEmpty(t, lane)
	resolver := NewMythicalFlowHostTargetResolver(o.service)

	// Provisioning, or waiting for a machine: pending, retried.
	_, err := o.pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,status) VALUES($1,$2,$3,'pending')`, lane, o.repoID, o.userID)
	require.NoError(t, err)
	_, err = resolver.ResolveFlowHostTarget(ctx, launches[0].Target)
	code, retryable := runtimeFailureOf(t, err)
	require.Equal(t, "runtime_workspace_pending", code)
	require.True(t, retryable)
	require.Equal(t, "starting", todoState(o.byID(id)))

	// Failed for good: final.
	_, err = o.pool.Exec(ctx, `UPDATE workspaces SET status='failed', failure_code='dependency_install_failed', failure_message='Dependency install failed' WHERE id=$1`, lane)
	require.NoError(t, err)
	_, err = resolver.ResolveFlowHostTarget(ctx, launches[0].Target)
	code, retryable = runtimeFailureOf(t, err)
	require.Equal(t, "runtime_workspace_failed", code)
	require.False(t, retryable, "a failed lane never hosts the launch")

	// The dispatcher fails the launch with that code, before any run.
	require.NoError(t, o.service.ProjectFlowRuntime(ctx, flowdispatch.ProjectionUpdate{State: jobs.StateFailed,
		Checkpoint: flowdispatch.RuntimeCheckpoint{FlowID: launches[0].FlowID, Projection: launches[0].Projection, FailureCode: code}}))
	o.wake()
	failed := o.byID(id)
	require.Equal(t, "failed", todoState(failed), failed.Reason)
	card := o.todoCard(n)
	require.Equal(t, map[string]any{"step": "provisioning", "class": "infra", "message": "Smithers could not set up a lane", "retryable": true}, card["failure"])
	require.Empty(t, failed.WorkspaceID, "the failed lane is released")
	require.Contains(t, o.lanes.deleted, lane)
	require.Len(t, o.launcher.byFlow("todo"), 1, "nothing relaunches on its own")

	receipt, err := o.service.ControlTodo(session, n, TodoControlInput{Op: "retry", Repository: o.repoID, Actor: o.userID, Request: "retry-lane"})
	require.NoError(t, err)
	require.EqualValues(t, 2, receipt.Attempt)
	o.wake()
	o.wake()
	launches = o.launcher.byFlow("todo")
	require.Len(t, launches, 2)
	retried := o.byID(id)
	require.NotEmpty(t, retried.WorkspaceID)
	require.NotEqual(t, lane, retried.WorkspaceID, "Retry runs on a new lane")
	require.Equal(t, "starting", todoState(retried))
}

// A failed lane is final; a pending one, or one that could not be read, is
// retried; a lane with no row stays a final pending refusal.
func TestMythicalLaneNotRunning(t *testing.T) {
	code, retryable := runtimeFailureOf(t, mythicalLaneNotRunning(db.Workspace{Status: "failed"}, nil))
	require.Equal(t, []any{"runtime_workspace_failed", false}, []any{code, retryable})
	code, retryable = runtimeFailureOf(t, mythicalLaneNotRunning(db.Workspace{Status: "pending"}, nil))
	require.Equal(t, []any{"runtime_workspace_pending", true}, []any{code, retryable})
	code, retryable = runtimeFailureOf(t, mythicalLaneNotRunning(db.Workspace{}, errors.New("connection reset")))
	require.Equal(t, []any{"runtime_workspace_pending", true}, []any{code, retryable})
	code, retryable = runtimeFailureOf(t, mythicalLaneNotRunning(db.Workspace{}, pgx.ErrNoRows))
	require.Equal(t, []any{"runtime_workspace_pending", false}, []any{code, retryable})
}
