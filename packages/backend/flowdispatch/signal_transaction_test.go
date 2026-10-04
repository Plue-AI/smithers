package flowdispatch

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

func TestSignalInTxRequiresTransaction(t *testing.T) {
	receipt, err := (&Service{}).SignalInTx(context.Background(), nil, SignalRequest{})
	require.ErrorContains(t, err, "transaction is required")
	require.Empty(t, receipt)
}

// A real database proves rollback, invisibility before commit, and recovery by
// the existing worker rather than a second signal queue.
func TestSignalInTxCommitRollbackAndReplay(t *testing.T) {
	ctx := context.Background()
	store, pool := newFlowDispatchStore(t)
	runtime := newRecordingRuntime()
	service, err := New(Config{Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
		return runtime, nil
	}), ObservationDelay: 2 * time.Millisecond})
	require.NoError(t, err)
	request := SignalRequest{Scope: jobs.Scope{TenantID: "repository:5", PrincipalID: "user:9"}, RequestID: "review:42", Target: flowruntime.Target{BindingKind: "repository-job-dispatch", BindingID: "dispatch-1"}, FlowID: "todo", RunID: "run-1", Name: "steer", Payload: json.RawMessage(`{"text":"fix"}`)}
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	rolledBack, err := service.SignalInTx(ctx, tx, request)
	require.NoError(t, err)
	_, err = store.Get(ctx, request.Scope, rolledBack.OperationID)
	require.Error(t, err)
	require.NoError(t, tx.Rollback(ctx))
	_, err = store.Get(ctx, request.Scope, rolledBack.OperationID)
	require.Error(t, err)
	tx, err = pool.Begin(ctx)
	require.NoError(t, err)
	committed, err := service.SignalInTx(ctx, tx, request)
	require.NoError(t, err)
	require.NoError(t, tx.Commit(ctx))
	// Replay after commit joins the same intent, including after worker delivery.
	replay, err := service.Signal(ctx, request)
	require.NoError(t, err)
	require.True(t, replay.Joined)
	require.Equal(t, committed.OperationID, replay.OperationID)
	startTestWorker(t, service, "review-recovery")
	waitOperation(t, store, request.Scope, committed.OperationID, func(op jobs.Operation) bool { return op.State == jobs.StateCompleted })
	replay, err = service.Signal(ctx, request)
	require.NoError(t, err)
	require.Equal(t, committed.OperationID, replay.OperationID)
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	require.Len(t, runtime.signals, 1)
}
