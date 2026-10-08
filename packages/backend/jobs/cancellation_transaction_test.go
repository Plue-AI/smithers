package jobs

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestCancellationInTxRequiresTransactionAndScope(t *testing.T) {
	store := &Store{}
	_, err := store.RequestCancellationInTx(context.Background(), nil, Scope{TenantID: "repo", PrincipalID: "person"}, "id")
	require.EqualError(t, err, "jobs: transaction is required")
	tx := &fenceTx{}
	_, err = store.RequestCancellationInTx(context.Background(), tx, Scope{}, "id")
	require.EqualError(t, err, "jobs: tenant and principal are required")
	require.Empty(t, tx.args)
}
func TestCancellationInTxRollsBackIntentAndTerminalEvent(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	scope := Scope{TenantID: "repo", PrincipalID: "person"}
	receipt, err := store.Admit(ctx, testAdmission(scope, "cancel-in-transaction", EffectUnsafe, `{"command":"fixture"}`))
	require.NoError(t, err)
	tx, err := store.pool.Begin(ctx)
	require.NoError(t, err)
	defer rollback(tx)
	value, err := store.RequestCancellationInTx(ctx, tx, scope, receipt.OperationID)
	require.NoError(t, err)
	require.Equal(t, StateCancelled, value.State)
	outside, err := store.Get(ctx, scope, receipt.OperationID)
	require.NoError(t, err)
	require.False(t, outside.CancellationRequested)
	require.False(t, outside.State.Terminal())
	require.NoError(t, tx.Rollback(ctx))
	outside, err = store.Get(ctx, scope, receipt.OperationID)
	require.NoError(t, err)
	require.False(t, outside.CancellationRequested)
	require.False(t, outside.State.Terminal())
	for range 2 {
		commit, err := store.pool.Begin(ctx)
		require.NoError(t, err)
		value, err := store.RequestCancellationInTx(ctx, commit, scope, receipt.OperationID)
		require.NoError(t, err)
		require.Equal(t, StateCancelled, value.State)
		require.NoError(t, commit.Commit(ctx))
	}
	var events int
	require.NoError(t, store.pool.QueryRow(ctx, "SELECT count(*) FROM product_job_events WHERE operation_id=$1 AND event_type='operation.cancelled'", receipt.OperationID).Scan(&events))
	require.Equal(t, 1, events)
}
