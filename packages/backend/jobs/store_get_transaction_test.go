package jobs

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestGetInTxRequiresTransactionAndScope(t *testing.T) {
	store := &Store{}
	_, err := store.GetInTx(context.Background(), nil, Scope{TenantID: "repo", PrincipalID: "person"}, "id")
	require.EqualError(t, err, "jobs: transaction is required")
	tx := &fenceTx{}
	_, err = store.GetInTx(context.Background(), tx, Scope{}, "id")
	require.EqualError(t, err, "jobs: tenant and principal are required")
	require.Empty(t, tx.args)
}
func TestGetInTxReadsUncommittedScopedOperation(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	scope := Scope{TenantID: "repo", PrincipalID: "person"}
	tx, err := store.pool.Begin(ctx)
	require.NoError(t, err)
	defer rollback(tx)
	receipt, err := store.AdmitInTx(ctx, tx, testAdmission(scope, "transaction-read", EffectIdempotent, `{"private":"receipt"}`))
	require.NoError(t, err)
	value, err := store.GetInTx(ctx, tx, scope, receipt.OperationID)
	require.NoError(t, err)
	require.JSONEq(t, `{"private":"receipt"}`, string(value.Payload))
	_, err = store.GetInTx(ctx, tx, Scope{TenantID: "repo", PrincipalID: "other"}, receipt.OperationID)
	require.ErrorIs(t, err, ErrNotFound)
	_, err = store.Get(ctx, scope, receipt.OperationID)
	require.ErrorIs(t, err, ErrNotFound)
	require.NoError(t, tx.Rollback(ctx))
	_, err = store.Get(ctx, scope, receipt.OperationID)
	require.ErrorIs(t, err, ErrNotFound)
}
