package jobs

import (
	"encoding/json"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"
)

func TestBackgroundRetryKeepsIdentityAndJournalsOnce(t *testing.T) {
	store := newTestStore(t)
	ctx := t.Context()
	scope := Scope{TenantID: "repository:1", PrincipalID: "user:1"}
	receipt, err := store.Admit(ctx, testAdmission(scope, "learning:one", EffectIdempotent, `{"todo":7,"pin":"immutable"}`))
	require.NoError(t, err)
	_, err = store.pool.Exec(ctx, `UPDATE product_job_requests SET state='failed',terminal_receipt='{"error":"lint"}' WHERE id=$1`, receipt.OperationID)
	require.NoError(t, err)
	apply := func(action, key string, rollback bool) error {
		tx, err := store.pool.Begin(ctx)
		require.NoError(t, err)
		defer tx.Rollback(ctx)
		err = store.ControlFailedInTx(ctx, tx, scope, receipt.OperationID, action, key, json.RawMessage(`{"pin":"retained"}`))
		if err != nil || rollback {
			return err
		}
		return tx.Commit(ctx)
	}
	require.NoError(t, apply("retry", "rolled-back", true))
	original, err := store.Get(ctx, scope, receipt.OperationID)
	require.NoError(t, err)
	require.Equal(t, StateFailed, original.State)
	require.NoError(t, apply("retry", "same-key", false))
	require.NoError(t, apply("retry", "same-key", false))
	// Explicit journal retention must not erase request deduplication.
	require.NoError(t, store.ExpireEventsThrough(ctx, scope, 2))
	require.NoError(t, apply("retry", "same-key", false))
	require.ErrorIs(t, apply("retry", "different-key", false), ErrUncertainResolution)
	current, err := store.Get(ctx, scope, receipt.OperationID)
	require.NoError(t, err)
	require.Equal(t, original.ID, current.ID)
	require.Equal(t, original.RequestID, current.RequestID)
	require.Equal(t, original.PayloadFingerprint, current.PayloadFingerprint)
	require.JSONEq(t, string(original.Payload), string(current.Payload))
	require.Equal(t, StateAccepted, current.State)
	require.Equal(t, 2, current.ExternalAttempt)
	require.JSONEq(t, `{"pin":"retained"}`, string(current.ExternalReceipt))
	page, err := store.Replay(ctx, scope, 2, 100)
	require.NoError(t, err)
	require.Empty(t, page.Events)
	_, err = store.pool.Exec(ctx, `UPDATE product_job_requests SET state='uncertain',terminal_receipt='{"error":"unknown"}' WHERE id=$1`, receipt.OperationID)
	require.NoError(t, err)
	require.ErrorIs(t, apply("retry", "ambiguous", false), ErrUncertainResolution)
	require.NoError(t, apply("dismiss", "", false))
	require.NoError(t, apply("dismiss", "", false))
	current, err = store.Get(ctx, scope, receipt.OperationID)
	require.NoError(t, err)
	require.Equal(t, StateUncertain, current.State)
	require.JSONEq(t, `{"error":"unknown","homeDismissed":true}`, string(current.TerminalReceipt))
	tx, err := store.pool.Begin(ctx)
	require.NoError(t, err)
	defer tx.Rollback(ctx)
	require.ErrorIs(t, store.ControlFailedInTx(ctx, tx, Scope{TenantID: "repository:2", PrincipalID: "user:1"}, receipt.OperationID, "dismiss", "", nil), pgx.ErrNoRows)
}
