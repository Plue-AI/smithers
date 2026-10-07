package services

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

func TestTodoDailyAdmissionAllowance(t *testing.T) {
	o, session := newTodoAdmission(t)
	ctx := context.Background()
	o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
	q := db.New(o.pool)
	set := func(value string) {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: todoDailyAdmissionsSetting, Value: []byte(value)}))
	}
	set("1")
	first := o.fileTodo(session, "allowance-first")
	o.wake()
	first = o.byID(uuidString(first.ID))
	require.Equal(t, "running", first.State, first.Reason)
	day := mythicalChecksOf(first).AdmissionDay
	require.Equal(t, o.service.now().UTC().Format("2006-01-02"), day)
	second := o.fileTodo(session, "allowance-second")
	o.wake()
	second = o.byID(uuidString(second.ID))
	require.Equal(t, "queued", second.State)
	require.Equal(t, todoDailyLimitReason, second.Reason)
	require.Zero(t, second.Attempt)
	require.Empty(t, second.WorkspaceID)
	require.False(t, second.FlowDigest.Valid)
	require.Len(t, o.launcher.byFlow("todo"), 1)
	// Repeated wakes and a process restart preserve the charge, even when
	// the first TODO has spent no model tokens.
	o.wake()
	require.Len(t, o.launcher.byFlow("todo"), 1)
	require.ErrorIs(t, todoDailyAllowance(ctx, o.pool, o.service.now()), errTodoDailyLimit)
	set("2")
	o.wake()
	second = o.byID(uuidString(second.ID))
	require.Equal(t, "running", second.State, second.Reason)
	require.Len(t, o.launcher.byFlow("todo"), 2)
	require.Equal(t, day, mythicalChecksOf(second).AdmissionDay)
	require.NoError(t, todoDailyAllowance(ctx, o.pool, o.service.now().Add(24*time.Hour)))
	for _, invalid := range []string{"0", "-1", `"12"`, "1.5", "null", "{}"} {
		set(invalid)
		require.Error(t, todoDailyAllowance(ctx, o.pool, o.service.now()), invalid)
	}
}

func TestTodoLegacyDrain(t *testing.T) {
	o, session := newTodoAdmission(t)
	ctx := context.Background()
	legacy := o.fileTodo(session, "legacy-drain")
	q := db.New(o.pool)
	for _, state := range []string{"queued", "retrying", "running", "delivering", "integrating", "verifying", "proposing", "waiting", "blocked"} {
		_, err := o.pool.Exec(ctx, `UPDATE mythical_items SET attempt=1,state=$2 WHERE id=$1`, legacy.ID, state)
		require.NoError(t, err)
		drained, err := todoLegacyDrained(ctx, o.pool, o.repoID)
		require.NoError(t, err)
		require.False(t, drained, state)
	}
	_, err := o.pool.Exec(ctx, `UPDATE mythical_items SET state='landed',pending_op='{"kind":"push"}' WHERE id=$1`, legacy.ID)
	require.NoError(t, err)
	drained, err := todoLegacyDrained(ctx, o.pool, o.repoID)
	require.NoError(t, err)
	require.False(t, drained, "an unsettled write still blocks activation")
	_, err = o.pool.Exec(ctx, `UPDATE mythical_items SET pending_op=NULL WHERE id=$1`, legacy.ID)
	require.NoError(t, err)
	drained, err = todoLegacyDrained(ctx, o.pool, o.repoID)
	require.NoError(t, err)
	require.True(t, drained, "terminal audit history stays readable without blocking")
	store, err := jobs.NewStore(o.pool.(*pgxpool.Pool))
	require.NoError(t, err)
	for _, flow := range []string{"coding/request", "coding/vibe"} {
		receipt, err := store.Admit(ctx, jobs.Admission{Scope: jobs.Scope{TenantID: fmt.Sprintf("repository:%d", o.repoID), PrincipalID: "user:1"},
			Operation: flowdispatch.OperationLaunch, RequestID: flow, Payload: []byte(fmt.Sprintf(`{"flowId":%q}`, flow)), AuthorizationContext: []byte(`{}`), EffectPolicy: jobs.EffectReconcile, EffectKey: flow})
		require.NoError(t, err)
		drained, err = todoLegacyDrained(ctx, o.pool, o.repoID)
		require.NoError(t, err)
		require.False(t, drained, "queued legacy dispatch blocks activation")
		_, err = o.pool.Exec(ctx, `UPDATE product_job_requests SET state='completed',terminal_receipt='{}' WHERE id=$1`, receipt.OperationID)
		require.NoError(t, err)
	}
	drained, err = todoLegacyDrained(ctx, o.pool, o.repoID)
	require.NoError(t, err)
	require.True(t, drained)
	retained, err := q.GetMythicalItem(ctx, legacy.ID)
	require.NoError(t, err)
	require.EqualValues(t, 1, retained.Attempt)
	require.Equal(t, "landed", retained.State)
	require.False(t, retained.FlowDigest.Valid, "drain never reinterprets old checkpoints as pinned attempts")
}

func TestTodoLegacyRetryKeepsExecutor(t *testing.T) {
	o, session := newTodoAdmission(t)
	activeReads := 0
	o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { activeReads++; return todoPinOne, nil })
	legacy := o.fileTodo(session, "legacy-retry")
	_, err := o.pool.Exec(t.Context(), `UPDATE mythical_items SET attempt=1,state='retrying' WHERE id=$1`, legacy.ID)
	require.NoError(t, err)
	o.wake()
	retained := o.byID(uuidString(legacy.ID))
	require.Equal(t, 0, activeReads, "an old checkpoint is never reinterpreted at the current Active version")
	require.False(t, retained.FlowDigest.Valid)
	require.Equal(t, "running", retained.State, retained.Reason)
	require.Equal(t, "coding/request", o.launcher.last("coding/request").FlowID)
}
