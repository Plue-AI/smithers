package services

import (
	"context"
	"testing"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

func TestTodoInterruptedRecoveryKeepsPinAndEvidence(t *testing.T) {
	for _, state := range []jobs.State{jobs.StateUncertain, jobs.StateFailed} {
		for _, tag := range []string{"@smthrs/flow/IrreversibleRetryRequiresIdempotencyKey", "@smthrs/flow/IrreversibleRetryRequiresIdempotencyKey/irreversible_retry_requires_idempotency_key"} {
			t.Run(string(state)+"/"+tag, func(t *testing.T) {
				o, session := newTodoAdmission(t)
				o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
				item := o.fileTodo(session, "interrupted")
				o.wake()
				launch := o.launcher.byFlow("todo")[0]
				o.projectTodo(launch, jobs.StateWaiting, "run-interrupted", todoPinOne, "")
				update := flowdispatch.ProjectionUpdate{State: state, Checkpoint: flowdispatch.RuntimeCheckpoint{
					FlowID: launch.FlowID, Projection: launch.Projection, RunID: "run-interrupted", ExecutionDigest: todoPinOne,
					Run: &flowruntime.FlowRuntimeRun{RunID: "run-interrupted", Status: "failed", FailureTag: tag},
				}}
				require.NoError(t, o.service.ProjectFlowRuntime(context.Background(), update))
				card := o.todoCard(item.Number.Int64)
				require.Equal(t, "failed", card["state"])
				require.Equal(t, map[string]any{"step": "runtime", "class": "interrupted", "message": "Interrupted", "retryable": true}, card["failure"])
				require.NoError(t, o.service.ProjectFlowRuntime(context.Background(), update), "terminal replay is harmless")
				o.wake()
				require.Len(t, o.launcher.byFlow("todo"), 1, "no automatic repeat")
				o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinTwo, nil })
				receipt, err := o.service.ControlTodo(session, item.Number.Int64, TodoControlInput{Op: "retry", Repository: o.repoID, Actor: o.userID, Request: "retry-interrupted"})
				require.NoError(t, err)
				require.EqualValues(t, 2, receipt.Attempt)
				o.wake()
				launches := o.launcher.byFlow("todo")
				require.Len(t, launches, 2)
				next := o.byID(uuidString(item.ID))
				require.Equal(t, todoPinOne, next.FlowDigest.String)
				require.EqualValues(t, 2, next.Attempt)
				require.NotEmpty(t, mythicalChecksOf(next).Attempts, "previous evidence survives")
			})
		}
	}
}
