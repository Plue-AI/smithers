package flowdispatch

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

func TestSignalInTxRequiresTransaction(t *testing.T) {
	receipt, err := (&Service{}).SignalInTx(context.Background(), nil, SignalRequest{})
	require.ErrorContains(t, err, "transaction is required")
	require.Empty(t, receipt)
}

// This uses real PostgreSQL for the commit boundary. The recording runtime is
// deliberate: it proves no runtime call occurs in the product transaction;
// guest execution and the TODO doors have separate production acceptance gates.
func TestSignalInTxCommitRollbackAndReplay(t *testing.T) {
	store, pool := newFlowDispatchStore(t)
	ctx := context.Background()
	runtime := newRecordingRuntime()
	runtime.status = "waiting"
	service, err := New(Config{Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) { return runtime, nil })})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, "CREATE TABLE product_fixture (revision integer PRIMARY KEY, text text NOT NULL)")
	require.NoError(t, err)
	request := SignalRequest{
		Scope: jobs.Scope{TenantID: "repository:5", PrincipalID: "user:9"}, RequestID: "amend-1",
		Target: flowruntime.Target{BindingKind: "repository-job-dispatch", BindingID: "dispatch-1"},
		FlowID: "coding/dispatch", RunID: "run-1", Name: "steer", Payload: json.RawMessage(`{"text":"Keep the wait open","actor":9,"via":"codex"}`),
		AuthorizationContext: json.RawMessage(`{"role":"member"}`),
	}
	for _, commit := range []bool{false, true} {
		tx, err := pool.Begin(ctx)
		require.NoError(t, err)
		_, err = tx.Exec(ctx, "INSERT INTO product_fixture VALUES (2, 'Keep the wait open')")
		require.NoError(t, err)
		receipt, err := service.SignalInTx(ctx, tx, request)
		require.NoError(t, err)
		duplicate, err := service.SignalInTx(ctx, tx, request)
		require.NoError(t, err)
		require.True(t, duplicate.Joined)
		require.Equal(t, receipt.OperationID, duplicate.OperationID)
		// An independent connection sees neither side of the uncommitted input.
		var count int
		require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM product_fixture").Scan(&count))
		require.Zero(t, count)
		_, err = store.Get(ctx, request.Scope, receipt.OperationID)
		require.Error(t, err)
		runtime.mu.Lock()
		require.Empty(t, runtime.signals)
		runtime.mu.Unlock()
		if !commit {
			require.NoError(t, tx.Rollback(ctx))
			_, err = store.Get(ctx, request.Scope, receipt.OperationID)
			require.Error(t, err)
			continue
		}
		require.NoError(t, tx.Commit(ctx))
		require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM product_fixture WHERE revision = 2 AND text = 'Keep the wait open'").Scan(&count))
		require.Equal(t, 1, count)
		operation, err := store.Get(ctx, request.Scope, receipt.OperationID)
		require.NoError(t, err)
		require.Equal(t, jobs.StateAccepted, operation.State)
		// The existing nontransactional door joins the same identity after commit.
		replay, err := service.Signal(ctx, request)
		require.NoError(t, err)
		require.True(t, replay.Joined)
		require.Equal(t, receipt.OperationID, replay.OperationID)
		startTestWorker(t, service, "transactional-signal")
		waitOperation(t, store, request.Scope, receipt.OperationID, func(operation jobs.Operation) bool { return operation.State == jobs.StateCompleted })
		runtime.mu.Lock()
		require.Len(t, runtime.signals, 1)
		require.JSONEq(t, string(request.Payload), string(runtime.signals[0].Payload))
		runtime.mu.Unlock()
	}
}

// A steer rides the signal path's durable admission and worker, and reaches
// the runtime as its steer mutation (a Message), never as a named signal.
func TestSignalInTxDeliversASteerMessage(t *testing.T) {
	_, err := signalAdmission(SignalRequest{RequestID: "s", FlowID: "coding/request", RunID: "run-1", Steer: &SteerMessage{MessageID: "m"}})
	require.ErrorContains(t, err, "message id and body are required")
	_, err = signalAdmission(SignalRequest{RequestID: "s", FlowID: "coding/request", RunID: "run-1", Steer: &SteerMessage{Body: "Use the helper"}})
	require.ErrorContains(t, err, "message id and body are required")

	store, pool := newFlowDispatchStore(t)
	ctx := context.Background()
	runtime := newRecordingRuntime()
	runtime.status, runtime.flowID = "waiting", "coding/request"
	service, err := New(Config{Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) { return runtime, nil })})
	require.NoError(t, err)
	request := SignalRequest{
		Scope: jobs.Scope{TenantID: "repository:5", PrincipalID: "user:9"}, RequestID: "todo-steer:1",
		Target: flowruntime.Target{BindingKind: "repository-job-dispatch", BindingID: "dispatch-1"},
		FlowID: "coding/request", RunID: "run-1",
		Steer:  &SteerMessage{MessageID: "steer-1", CreatedAt: 1700000000000, Body: "Use the helper in lib/retry.ts"},
	}
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	receipt, err := service.SignalInTx(ctx, tx, request)
	require.NoError(t, err)
	require.NoError(t, tx.Commit(ctx))
	replay, err := service.Signal(ctx, request)
	require.NoError(t, err)
	require.True(t, replay.Joined)
	startTestWorker(t, service, "transactional-steer")
	waitOperation(t, store, request.Scope, receipt.OperationID, func(operation jobs.Operation) bool { return operation.State == jobs.StateCompleted })
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	require.Empty(t, runtime.signals)
	require.Len(t, runtime.steers, 1)
	steer := runtime.steers[0]
	require.Equal(t, "run-1", steer.RunID)
	require.Equal(t, "Message", steer.Kind)
	require.Equal(t, "steer-1", steer.MessageID)
	require.Equal(t, "Use the helper in lib/retry.ts", steer.Body)
	require.Equal(t, float64(1700000000000), steer.CreatedAt)
	require.Equal(t, receipt.OperationID, steer.ApplicationRequestID)
}
