package services

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/testkit/testdb"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// Readiness has no install-settings or projection owner yet. This test-only
// append-only receipt table checks committed state ordering against PostgreSQL;
// it does not claim a product schema, projection writer or notification contract.
// Controlled builders isolate ordering and failure behavior. Actual layer
// verification remains the responsibility of the real microVM layer suite.
type readinessPostgresStore struct{ pool *pgxpool.Pool }

func readinessPostgres(t *testing.T) (*pgxpool.Pool, *readinessPostgresStore) {
	t.Helper()
	database := testdb.New(t)
	pool, err := pgxpool.New(t.Context(), database.URL)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	_, err = pool.Exec(t.Context(), `CREATE TABLE readiness_test_receipts(seq bigserial PRIMARY KEY, repository text NOT NULL, state jsonb NOT NULL)`)
	require.NoError(t, err)
	return pool, &readinessPostgresStore{pool: pool}
}

func (p *readinessPostgresStore) Update(ctx context.Context, repository string, mutate func(InstallReadiness) (InstallReadiness, error)) (InstallReadiness, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return InstallReadiness{}, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, repository); err != nil {
		return InstallReadiness{}, err
	}
	var current InstallReadiness
	var raw []byte
	err = tx.QueryRow(ctx, `SELECT state FROM readiness_test_receipts WHERE repository=$1 ORDER BY seq DESC LIMIT 1`, repository).Scan(&raw)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return current, err
	}
	if err == nil {
		if err = json.Unmarshal(raw, &current); err != nil {
			return current, err
		}
	}
	next, err := mutate(current)
	if err != nil {
		return current, err
	}
	raw, err = json.Marshal(next)
	if err != nil {
		return current, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO readiness_test_receipts(repository,state) VALUES($1,$2)`, repository, raw); err != nil {
		return current, err
	}
	if err = tx.Commit(ctx); err != nil {
		return current, err
	}
	return next, nil
}

func loadReadiness(t *testing.T, pool *pgxpool.Pool) InstallReadiness {
	t.Helper()
	var raw []byte
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT state FROM readiness_test_receipts WHERE repository='owner/repo' ORDER BY seq DESC LIMIT 1`).Scan(&raw))
	var state InstallReadiness
	require.NoError(t, json.Unmarshal(raw, &state))
	return state
}

// Spec oracle (§8.6.3, §19.3): committed Source ready precedes machine work;
// verification failure is a terminal failed receipt, never Machine ready.
// Expected machine receipt states for that attempt: pending, running, failed.
func TestInstallMachineReadyPostgresCommittedOrderingAndFailures(t *testing.T) {
	pool, store := readinessPostgres(t)
	svc := InstallMachineReadyService{Persistence: store, Sources: readinessSources{resolve: func(context.Context, string, string) (string, error) { return readinessCommit, nil }}}
	svc.Layers = readinessLayers(func(context.Context, workspaceapi.WorkspaceSpec) (microsandbox.Layer, error) {
		state := loadReadiness(t, pool)
		require.Equal(t, InstallReady, state.Source.State)
		require.Equal(t, InstallRunning, state.Machine.State)
		return microsandbox.Layer{}, errors.New("layer verify VM failed")
	})
	state, err := svc.Prepare(t.Context(), "owner/repo")
	require.Error(t, err)
	require.Equal(t, InstallReady, state.Source.State)
	require.Equal(t, InstallFailed, state.Machine.State)
	durable := loadReadiness(t, pool)
	require.Equal(t, "machine_build_failed", durable.Machine.Error.Code)
	require.Equal(t, "infra", durable.Machine.Error.Class)
	var machineStates []string
	rows, err := pool.Query(t.Context(), `SELECT state->'machine'->>'state' FROM readiness_test_receipts ORDER BY seq`)
	require.NoError(t, err)
	machineStates, err = pgx.CollectRows(rows, pgx.RowTo[string])
	require.NoError(t, err)
	require.Equal(t, []string{"pending", "running", "failed"}, machineStates)
	resolves := 0
	svc.Layers = readinessLayers(func(context.Context, workspaceapi.WorkspaceSpec) (microsandbox.Layer, error) {
		resolves++
		require.Equal(t, InstallRunning, loadReadiness(t, pool).Machine.State)
		if resolves == 1 {
			return microsandbox.Layer{Key: "verified"}, nil
		}
		return microsandbox.Layer{Key: "changed-manifest"}, nil
	})
	state, err = svc.Prepare(t.Context(), "owner/repo")
	require.NoError(t, err)
	require.Equal(t, InstallReady, state.Machine.State)
	require.Equal(t, "verified", loadReadiness(t, pool).LayerKey)
	state, err = svc.Prepare(t.Context(), "owner/repo")
	require.NoError(t, err)
	require.Equal(t, 2, resolves, "unchanged main still resolves the current cached recipe")
	require.Equal(t, "changed-manifest", state.LayerKey)
	svc.Sources = readinessSources{resolve: func(context.Context, string, string) (string, error) { return "", fs.ErrNotExist }}
	state, err = svc.Prepare(t.Context(), "owner/repo")
	require.ErrorIs(t, err, fs.ErrNotExist)
	require.Equal(t, InstallFailed, state.Source.State)
	require.Equal(t, InstallPending, state.Machine.State)
	require.Empty(t, state.Revision)
	require.Equal(t, 2, resolves, "missing main must not invoke the builder")
	require.Equal(t, "source_main_unavailable", loadReadiness(t, pool).Source.Error.Code)
}

func TestInstallMachineReadyPostgresStaleVerificationCannotReplaceNewMain(t *testing.T) {
	pool, store := readinessPostgres(t)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	started := make(chan struct{})
	release := make(chan struct{})
	done := make(chan error, 1)
	newRevision := "fedcba9876543210fedcba9876543210fedcba98"
	var mu sync.Mutex
	resolves := 0
	svc := InstallMachineReadyService{Persistence: store, Sources: readinessSources{resolve: func(context.Context, string, string) (string, error) {
		mu.Lock()
		defer mu.Unlock()
		resolves++
		if resolves == 1 {
			return readinessCommit, nil
		}
		return newRevision, nil
	}}, Layers: readinessLayers(func(ctx context.Context, spec workspaceapi.WorkspaceSpec) (microsandbox.Layer, error) {
		if spec.Source.Revision == readinessCommit {
			close(started)
			select {
			case <-release:
				return microsandbox.Layer{}, errors.New("stale verify failure")
			case <-ctx.Done():
				return microsandbox.Layer{}, ctx.Err()
			}
		}
		return microsandbox.Layer{Key: "new-layer"}, nil
	})}
	go func() { _, err := svc.Prepare(ctx, "owner/repo"); done <- err }()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	state, err := svc.Prepare(ctx, "owner/repo")
	require.NoError(t, err)
	require.Equal(t, newRevision, state.Revision)
	var receiptsBefore int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM readiness_test_receipts`).Scan(&receiptsBefore))
	close(release)
	select {
	case err := <-done:
		require.ErrorIs(t, err, ErrInstallReadinessSuperseded)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	require.Equal(t, state, loadReadiness(t, pool))
	var receiptsAfter int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM readiness_test_receipts`).Scan(&receiptsAfter))
	require.Equal(t, receiptsBefore, receiptsAfter, "stale completion must not commit a receipt")
}
