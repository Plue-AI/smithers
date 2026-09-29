package services

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

// Gate the workspace lookup, which reconciliation makes after reading the
// registrations. A pause at this point previously updated the row while the
// reconciler still held its old enabled flag in memory.
type factoryPauseGate struct {
	pool    *pgxpool.Pool
	reached chan struct{}
	release chan struct{}
}

func (g *factoryPauseGate) Begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := g.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return &factoryPauseTx{Tx: tx, gate: g}, nil
}

type factoryPauseTx struct {
	pgx.Tx
	gate *factoryPauseGate
}

func (tx *factoryPauseTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	if strings.HasPrefix(sql, "-- name: GetActiveWorkspaceForUserRepo :one") {
		close(tx.gate.reached)
		select {
		case <-tx.gate.release:
		case <-ctx.Done():
		}
	}
	return tx.Tx.QueryRow(ctx, sql, args...)
}

func TestFactoryReconcileSerializesConcurrentPause(t *testing.T) {
	pool, q, service, gateway, _ := repositoryJobFixture(t)
	ctx := context.Background()
	repoID := gateway.target.RepositoryID
	projection := factoryFixture(t)
	firstRevision := strings.Repeat("a", 40)
	secondRevision := strings.Repeat("b", 40)
	require.NoError(t, service.ReconcileFactoryRules(ctx, repoID, firstRevision, projection))
	initial, err := q.ListRepositoryJobRegistrations(ctx, repoID)
	require.NoError(t, err)
	require.NotEmpty(t, initial)
	job := initial[0].Job

	gate := &factoryPauseGate{pool: pool, reached: make(chan struct{}), release: make(chan struct{})}
	service.transactions = gate
	done := make(chan error, 1)
	go func() { done <- service.ReconcileFactoryRules(ctx, repoID, secondRevision, projection) }()
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(gate.release) }) }
	doneRead := false
	defer func() {
		release()
		if !doneRead {
			<-done
		}
	}()
	select {
	case <-gate.reached:
	case err := <-done:
		doneRead = true
		t.Fatalf("reconciliation ended before reading the workspace: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("reconciliation did not reach the workspace lookup")
	}

	// The query starts while reconciliation holds its registration row lock.
	// PostgreSQL's lock timeout proves that Pause waited on that lock; without
	// the lock it would succeed here and reconciliation could overwrite it.
	pauseTx, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer pauseTx.Rollback(ctx) //nolint:errcheck -- explicit rollback below
	_, err = pauseTx.Exec(ctx, `SET LOCAL lock_timeout = '300ms'`)
	require.NoError(t, err)
	_, err = db.New(pauseTx).PauseRepositoryJob(ctx, db.PauseRepositoryJobParams{RepositoryID: repoID, Job: job})
	var pgErr *pgconn.PgError
	require.ErrorAs(t, err, &pgErr)
	require.Equal(t, "55P03", pgErr.Code)
	require.NoError(t, pauseTx.Rollback(ctx))

	release()
	err = <-done
	doneRead = true
	require.NoError(t, err)
	paused, err := q.PauseRepositoryJob(ctx, db.PauseRepositoryJobParams{RepositoryID: repoID, Job: job})
	require.NoError(t, err)
	require.Len(t, paused, 1)
	require.False(t, paused[0].Enabled)
	require.Equal(t, secondRevision, paused[0].SourceRevision)

	// Restarting reconciliation at the same main revision respects the pause.
	service.transactions = pool
	require.NoError(t, service.ReconcileFactoryRules(ctx, repoID, secondRevision, projection))
	rows, err := q.ListRepositoryJobRegistrations(ctx, repoID)
	require.NoError(t, err)
	for _, row := range rows {
		if row.Job == job {
			require.False(t, row.Enabled)
			require.Equal(t, paused[0].Revision, row.Revision)
			return
		}
	}
	t.Fatal("paused job disappeared")
}
