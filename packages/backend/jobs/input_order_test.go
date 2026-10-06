package jobs

import (
	"encoding/json"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"
)

func TestInputOrderUsesCommittedEventsAcrossOperations(t *testing.T) {
	store := newTestStore(t)
	ctx := t.Context()
	scope := Scope{TenantID: "repository:1", PrincipalID: "user:1"}
	operations := []string{"flow.runtime.steer", "flow.runtime.signal"}
	fragment := json.RawMessage(`{"runId":"same-run"}`)
	admit := func(kind, key, run string) RequestReceipt {
		input := testAdmission(scope, key, EffectReconcile, `{"runId":"`+run+`"}`)
		input.Operation = kind
		receipt, err := store.Admit(ctx, input)
		require.NoError(t, err)
		return receipt
	}
	first := admit(operations[0], "first", "same-run")
	// A timestamp and random operation UUID are not commit order.
	_, err := store.pool.Exec(ctx, `UPDATE product_job_requests SET created_at=created_at+interval '1 day' WHERE id=$1`, first.OperationID)
	require.NoError(t, err)
	other := admit(operations[0], "other", "other-run")
	later := admit(operations[1], "second", "same-run")
	pending, err := store.HasEarlierPending(ctx, scope, first.OperationID, operations, fragment)
	require.NoError(t, err)
	require.False(t, pending)
	pending, err = store.HasEarlierPending(ctx, scope, other.OperationID, operations, json.RawMessage(`{"runId":"other-run"}`))
	require.NoError(t, err)
	require.False(t, pending)
	for _, state := range []string{"accepted", "dispatching", "running", "waiting", "uncertain", "completed", "failed", "cancelled"} {
		_, err := store.pool.Exec(ctx, `UPDATE product_job_requests SET state=$2,terminal_receipt=CASE WHEN $2 IN ('completed','failed','cancelled','uncertain') THEN '{}'::jsonb ELSE NULL END WHERE id=$1`, first.OperationID, state)
		require.NoError(t, err)
		pending, err = store.HasEarlierPending(ctx, scope, later.OperationID, operations, fragment)
		require.NoError(t, err)
		require.Equal(t, state != "completed" && state != "failed" && state != "cancelled", pending, state)
	}
	// Scope mismatch/missing admission and malformed filters fail closed.
	_, err = store.HasEarlierPending(ctx, Scope{TenantID: scope.TenantID, PrincipalID: "user:2"}, later.OperationID, operations, fragment)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = store.HasEarlierPending(ctx, Scope{}, later.OperationID, operations, fragment)
	require.Error(t, err)
	_, err = store.HasEarlierPending(ctx, scope, later.OperationID, operations, json.RawMessage(`{`))
	require.Error(t, err)
}
