package jobs

import (
	"context"
	"encoding/json"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"testing"
	"time"
)

func TestClaimOperationDoesNotConsumeAnotherAdmission(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	scope := Scope{TenantID: "install", PrincipalID: "owner"}
	first, err := store.Admit(ctx, testAdmission(scope, "first", EffectReconcile, `{"owner":"first"}`))
	require.NoError(t, err)
	second, err := store.Admit(ctx, testAdmission(scope, "second", EffectReconcile, `{"owner":"second"}`))
	require.NoError(t, err)
	_, err = store.ClaimOperation(ctx, "worker", time.Minute, "invalid")
	require.Error(t, err)
	_, err = store.ClaimOperation(ctx, "worker", time.Minute, uuid.NewString())
	require.ErrorIs(t, err, ErrNoWork)
	claim, err := store.ClaimOperation(ctx, "worker", time.Minute, second.OperationID)
	require.NoError(t, err)
	require.Equal(t, second.OperationID, claim.OperationID)
	_, err = store.ClaimOperation(ctx, "other-worker", time.Minute, second.OperationID)
	require.ErrorIs(t, err, ErrNoWork)
	other, err := store.Claim(ctx, "other-worker", time.Minute)
	require.NoError(t, err)
	require.Equal(t, first.OperationID, other.OperationID)
	_, err = store.pool.Exec(ctx, `UPDATE product_job_dispatches SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1`, claim.OperationID)
	require.NoError(t, err)
	_, err = store.RecoverExpired(ctx, 1)
	require.NoError(t, err)
	recovered, err := store.ClaimOperation(ctx, "new-worker", time.Minute, second.OperationID)
	require.NoError(t, err)
	require.Greater(t, recovered.Generation, claim.Generation)
	require.ErrorIs(t, store.Complete(ctx, claim, json.RawMessage(`{"stale":true}`)), ErrClaimLost)
	require.NoError(t, store.Complete(ctx, recovered, json.RawMessage(`{"done":true}`)))
}
