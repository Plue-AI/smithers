package jobs

import (
	"context"
	"encoding/json"
	"maps"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
)

// A separate pool gives every worker connection a bounded PostgreSQL query.
// The database and job rows are otherwise the same real fixture as the test.
func heartbeatTimeoutStore(t *testing.T, store *Store) *Store {
	t.Helper()
	config := store.pool.Config()
	config.ConnConfig.RuntimeParams = maps.Clone(config.ConnConfig.RuntimeParams)
	config.ConnConfig.RuntimeParams["statement_timeout"] = "60ms"
	pool, err := pgxpool.NewWithConfig(t.Context(), config)
	require.NoError(t, err)
	require.NoError(t, pool.Ping(t.Context()))
	t.Cleanup(pool.Close)
	workerStore, err := NewStore(pool)
	require.NoError(t, err)
	return workerStore
}

func lockHeartbeatDispatch(t *testing.T, store *Store, operationID string) func() {
	t.Helper()
	tx, err := store.pool.Begin(t.Context())
	require.NoError(t, err)
	var lockedID string
	err = tx.QueryRow(t.Context(), `SELECT operation_id FROM product_job_dispatches WHERE operation_id=$1 FOR UPDATE`, operationID).
		Scan(&lockedID)
	require.NoError(t, err)
	require.Equal(t, operationID, lockedID)
	return func() { require.NoError(t, tx.Rollback(context.Background())) }
}

func TestWorkerRejectsHeartbeatIntervalOutsideLease(t *testing.T) {
	for _, interval := range []time.Duration{-time.Millisecond, time.Second, 2 * time.Second} {
		t.Run(interval.String(), func(t *testing.T) {
			err := (&Store{}).RunWorker(t.Context(), WorkerConfig{
				WorkerID: "invalid-heartbeat", Capacity: 1, Lease: time.Second,
				HeartbeatInterval: interval,
			}, func(context.Context, *Lease) error { return nil })
			require.ErrorContains(t, err, "heartbeat interval")
		})
	}
}

func TestWorkerTransientHeartbeatTimeoutDoesNotCancelUnsafeCommand(t *testing.T) {
	store := newTestStore(t)
	workerStore := heartbeatTimeoutStore(t, store)
	scope := Scope{TenantID: "tenant", PrincipalID: "owner"}
	input := testAdmission(scope, "heartbeat-grace", EffectUnsafe, `{"command":"sleep 600"}`)
	input.Operation = "workspace.command.heartbeat-grace"
	receipt, err := store.Admit(t.Context(), input)
	require.NoError(t, err)

	workerCtx, stopWorker := context.WithCancel(context.Background())
	defer stopWorker()
	started := make(chan struct{})
	releaseHandler := make(chan struct{})
	defer releaseWorkerHandler(releaseHandler)
	handlerCancelled := make(chan struct{})
	completed := make(chan error, 1)
	done := make(chan error, 1)
	go func() {
		done <- workerStore.RunWorker(workerCtx, WorkerConfig{
			WorkerID: "heartbeat-grace-worker", Capacity: 1,
			Lease: 700 * time.Millisecond, HeartbeatInterval: 30 * time.Millisecond,
			PollInterval: 5 * time.Millisecond, RecoveryInterval: time.Hour,
			Operations: []string{input.Operation},
		}, func(ctx context.Context, lease *Lease) error {
			if err := lease.StartExternal(ctx, json.RawMessage(`{"launched":true}`)); err != nil {
				completed <- err
				return err
			}
			close(started)
			select {
			case <-releaseHandler:
			case <-ctx.Done():
				close(handlerCancelled)
				return ctx.Err()
			}
			err := lease.Complete(ctx, json.RawMessage(`{"exit_code":0}`))
			completed <- err
			return err
		})
	}()
	waitWorkerSignal(t, started, "unsafe handler start")
	unlock := lockHeartbeatDispatch(t, store, receipt.OperationID)
	defer func() { unlock() }()
	// Multiple heartbeat attempts hit a real PostgreSQL statement timeout while
	// the committed lease remains valid. The command must keep running.
	time.Sleep(190 * time.Millisecond)
	select {
	case <-handlerCancelled:
		t.Fatal("transient heartbeat timeout cancelled an active unsafe command")
	default:
	}
	unlock()
	unlock = func() {}
	releaseWorkerHandler(releaseHandler)
	require.NoError(t, waitWorkerSignal(t, completed, "unsafe command completion"))
	stopWorker()
	require.NoError(t, waitWorkerSignal(t, done, "worker shutdown"))
	operation, err := store.Get(t.Context(), scope, receipt.OperationID)
	require.NoError(t, err)
	require.Equal(t, StateCompleted, operation.State)
	require.JSONEq(t, `{"exit_code":0}`, string(operation.TerminalReceipt))
}

func TestWorkerHeartbeatTimeoutAfterLeaseExpiryFencesUnsafeCommand(t *testing.T) {
	store := newTestStore(t)
	workerStore := heartbeatTimeoutStore(t, store)
	scope := Scope{TenantID: "tenant", PrincipalID: "owner"}
	input := testAdmission(scope, "heartbeat-expired", EffectUnsafe, `{"command":"sleep 600"}`)
	input.Operation = "workspace.command.heartbeat-expired"
	receipt, err := store.Admit(t.Context(), input)
	require.NoError(t, err)

	workerCtx, stopWorker := context.WithCancel(context.Background())
	defer stopWorker()
	started := make(chan struct{})
	handlerCancelled := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- workerStore.RunWorker(workerCtx, WorkerConfig{
			WorkerID: "heartbeat-expired-worker", Capacity: 1,
			Lease: 350 * time.Millisecond, HeartbeatInterval: 25 * time.Millisecond,
			PollInterval: 5 * time.Millisecond, RecoveryInterval: time.Hour,
			Operations: []string{input.Operation},
		}, func(ctx context.Context, lease *Lease) error {
			if err := lease.StartExternal(ctx, json.RawMessage(`{"launched":true}`)); err != nil {
				return err
			}
			close(started)
			<-ctx.Done()
			close(handlerCancelled)
			return ctx.Err()
		})
	}()
	waitWorkerSignal(t, started, "unsafe handler start")
	unlock := lockHeartbeatDispatch(t, store, receipt.OperationID)
	defer func() { unlock() }()
	waitWorkerSignal(t, handlerCancelled, "lease-expiry cancellation")
	unlock()
	unlock = func() {}
	stopWorker()
	require.NoError(t, waitWorkerSignal(t, done, "worker shutdown"))
	var operation Operation
	require.Eventually(t, func() bool {
		_, recoverErr := store.RecoverExpired(t.Context(), 1)
		if recoverErr != nil {
			return false
		}
		operation, recoverErr = store.Get(t.Context(), scope, receipt.OperationID)
		return recoverErr == nil && operation.State == StateUncertain
	}, 2*time.Second, 10*time.Millisecond, "expired unsafe lease must become uncertain")
	operation, err = store.Get(t.Context(), scope, receipt.OperationID)
	require.NoError(t, err)
	require.Equal(t, StateUncertain, operation.State)
	require.JSONEq(t, `{"kind":"uncertain","reason":"claim lease expired"}`, string(operation.TerminalReceipt))
}
