package services

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type workflowSandboxLogTxRow struct {
	values []any
	err    error
}

func (row workflowSandboxLogTxRow) Scan(dest ...any) error {
	if row.err != nil {
		return row.err
	}
	for i, target := range dest {
		switch value := target.(type) {
		case *int64:
			*value = row.values[i].(int64)
		case *string:
			*value = row.values[i].(string)
		case *time.Time:
			*value = row.values[i].(time.Time)
		default:
			panic("workflowSandboxLogTxRow: unsupported scan destination")
		}
	}
	return nil
}

type workflowSandboxLogTx struct {
	pgx.Tx
	execCalls      []string
	execArgs       [][]any
	execErr        error
	queryRowFn     func(context.Context, string, ...any) pgx.Row
	commitCalled   bool
	commitErr      error
	rollbackCalled bool
}

func (tx *workflowSandboxLogTx) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	tx.execCalls = append(tx.execCalls, sql)
	tx.execArgs = append(tx.execArgs, append([]any(nil), args...))
	if tx.execErr != nil {
		return pgconn.CommandTag{}, tx.execErr
	}
	return pgconn.NewCommandTag("SELECT 1"), nil
}

func (tx *workflowSandboxLogTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return tx.queryRowFn(ctx, sql, args...)
}

func (tx *workflowSandboxLogTx) Commit(context.Context) error {
	tx.commitCalled = true
	return tx.commitErr
}

func (tx *workflowSandboxLogTx) Rollback(context.Context) error {
	tx.rollbackCalled = true
	return nil
}

type transactionalWorkflowSandboxQuerier struct {
	*mockWorkflowSandboxSchedulerQuerier
	tx       *workflowSandboxLogTx
	beginErr error
}

func (q *transactionalWorkflowSandboxQuerier) BeginTx(context.Context) (pgx.Tx, error) {
	if q.beginErr != nil {
		return nil, q.beginErr
	}
	return q.tx, nil
}

func TestWorkflowSandboxAppendLog_TransactionLocksBeforeInsertAndNotifiesAfterCommit(t *testing.T) {
	ctx := context.Background()
	base := &mockWorkflowSandboxSchedulerQuerier{}
	fakeTx := &workflowSandboxLogTx{}
	fakeTx.queryRowFn = func(_ context.Context, sql string, _ ...any) pgx.Row {
		require.Len(t, fakeTx.execCalls, 2, "run ordering lock and sequence lock must precede ID allocation")
		assert.Contains(t, fakeTx.execCalls[0], "FOR UPDATE")
		assert.Contains(t, fakeTx.execCalls[1], "pg_advisory_xact_lock")
		assert.Contains(t, sql, "-- name: InsertWorkflowRunLogNextSequence")
		return workflowSandboxLogTxRow{values: []any{
			int64(91), int64(42), int64(7), int64(3), "stdout", "hello", time.Now().UTC(),
		}}
	}
	base.notifyWorkflowRunLogFn = func(_ context.Context, _ db.NotifyWorkflowRunLogParams) error {
		assert.True(t, fakeTx.commitCalled, "notification must not publish an uncommitted log row")
		return nil
	}

	queries := &transactionalWorkflowSandboxQuerier{mockWorkflowSandboxSchedulerQuerier: base, tx: fakeTx}
	worker := NewWorkflowSandboxSchedulerWorker(queries, &mockWorkflowSandboxVMClient{})

	require.NoError(t, worker.appendLog(ctx, 42, 7, "stdout", "hello"))
	require.Len(t, fakeTx.execCalls, 2)
	assert.Equal(t, []any{int64(42)}, fakeTx.execArgs[0])
	assert.True(t, fakeTx.commitCalled)
	assert.True(t, fakeTx.rollbackCalled, "deferred rollback closes the transaction after commit")
	assert.Empty(t, base.logInserts, "transaction path must insert through db.New(tx), not the outer querier")
	require.Len(t, base.logNotifies, 1)
	assert.Equal(t, int64(42), base.logNotifies[0].RunID)
	assert.Contains(t, base.logNotifies[0].Payload, `"sequence":3`)
}

func TestWorkflowSandboxAppendLog_TransactionFailureDoesNotNotify(t *testing.T) {
	t.Run("begin", func(t *testing.T) {
		base := &mockWorkflowSandboxSchedulerQuerier{}
		queries := &transactionalWorkflowSandboxQuerier{
			mockWorkflowSandboxSchedulerQuerier: base,
			beginErr:                            errors.New("pool exhausted"),
		}
		worker := NewWorkflowSandboxSchedulerWorker(queries, &mockWorkflowSandboxVMClient{})
		err := worker.appendLog(context.Background(), 42, 7, "stderr", "boom")
		assert.ErrorContains(t, err, "begin workflow run log transaction")
		assert.Empty(t, base.logNotifies)
	})

	t.Run("lock", func(t *testing.T) {
		base := &mockWorkflowSandboxSchedulerQuerier{}
		fakeTx := &workflowSandboxLogTx{execErr: errors.New("lock failed")}
		queries := &transactionalWorkflowSandboxQuerier{mockWorkflowSandboxSchedulerQuerier: base, tx: fakeTx}
		worker := NewWorkflowSandboxSchedulerWorker(queries, &mockWorkflowSandboxVMClient{})
		err := worker.appendLog(context.Background(), 42, 7, "stderr", "boom")
		assert.ErrorContains(t, err, "lock workflow run log stream")
		assert.True(t, fakeTx.rollbackCalled)
		assert.False(t, fakeTx.commitCalled)
		assert.Empty(t, base.logNotifies)
		assert.True(t, strings.Contains(fakeTx.execCalls[0], "FOR UPDATE"))
	})
}
