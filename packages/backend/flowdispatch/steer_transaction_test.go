package flowdispatch

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

func TestSteerInTxRequiresTransaction(t *testing.T) {
	receipt, err := (&Service{}).SteerInTx(context.Background(), nil, SteerRequest{})
	require.ErrorContains(t, err, "transaction is required")
	require.Empty(t, receipt)
}

// This uses real PostgreSQL for the commit boundary. The recording runtime is
// deliberate: it proves no runtime call occurs in the product transaction;
// guest execution and the TODO doors have separate production acceptance gates.
func TestSteerInTxCommitRollbackAndReplay(t *testing.T) {
	store, pool := newFlowDispatchStore(t)
	ctx := context.Background()
	runtime := newRecordingRuntime()
	runtime.status = "waiting"
	service, err := New(Config{Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) { return runtime, nil })})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, "CREATE TABLE product_fixture (revision integer PRIMARY KEY, text text NOT NULL)")
	require.NoError(t, err)
	request := SteerRequest{
		Scope: jobs.Scope{TenantID: "repository:5", PrincipalID: "user:9"}, RequestID: "amend-1",
		Target: flowruntime.Target{BindingKind: "repository-job-dispatch", BindingID: "dispatch-1"},
		FlowID: "coding/dispatch", RunID: "run-1", MessageID: "feedback-1", CreatedAt: 1791228000000, Body: "Keep the wait open",
		AuthorizationContext: json.RawMessage(`{"role":"member"}`),
	}
	for _, commit := range []bool{false, true} {
		tx, err := pool.Begin(ctx)
		require.NoError(t, err)
		_, err = tx.Exec(ctx, "INSERT INTO product_fixture VALUES (2, 'Keep the wait open')")
		require.NoError(t, err)
		receipt, err := service.SteerInTx(ctx, tx, request)
		require.NoError(t, err)
		duplicate, err := service.SteerInTx(ctx, tx, request)
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
		require.Empty(t, runtime.steers)
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
		replay, err := service.Steer(ctx, request)
		require.NoError(t, err)
		require.True(t, replay.Joined)
		require.Equal(t, receipt.OperationID, replay.OperationID)
		changed := request
		changed.Body = "A different instruction"
		_, err = service.Steer(ctx, changed)
		require.Error(t, err, "a committed identity cannot silently replace its feedback")
		startTestWorker(t, service, "transactional-steer")
		waitOperation(t, store, request.Scope, receipt.OperationID, func(operation jobs.Operation) bool { return operation.State == jobs.StateCompleted })
		runtime.mu.Lock()
		require.Len(t, runtime.steers, 1)
		require.Empty(t, runtime.signals, "feedback must never settle a named wait")
		require.Equal(t, request.Body, runtime.steers[0].Body)
		require.Equal(t, request.MessageID, runtime.steers[0].MessageID)
		require.Equal(t, request.CreatedAt, runtime.steers[0].CreatedAt)
		require.Equal(t, "Message", runtime.steers[0].Kind)
		require.Equal(t, receipt.OperationID, runtime.steers[0].ApplicationRequestID)
		require.Equal(t, int64(1), runtime.steers[0].OwnerGeneration)
		runtime.mu.Unlock()
	}
}
