package services

import (
	"context"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
	"github.com/smithersai/smithers/packages/backend/internal/repohostserver"
)

// variableTransferFixture crosses the real SQL and repo-host HTTP boundaries.
// The native library is supplied by the caller; this test never builds it.
type variableTransferFixture struct {
	pool      *pgxpool.Pool
	owner     db.User
	recipient db.User
	repo      db.Repository
	queries   *db.Queries
	transfer  *RepoService
	cfg       repohostserver.Config
}

func newVariableTransferFixture(t *testing.T) variableTransferFixture {
	t.Helper()
	library := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	if library == "" {
		t.Skip("set SMITHERS_FFI_LIBRARY_PATH to run the native repo-host boundary")
	}
	pool := getAgentTestPool(t)
	ctx := context.Background()
	ownerID, repoID := setupTestUserAndRepo(t, pool)
	q := db.New(pool)
	owner, err := q.GetUserByID(ctx, ownerID)
	require.NoError(t, err)
	recipient := createSecretIntegrationUser(t, "variabletransfer")
	_, err = pool.Exec(ctx, `UPDATE repositories SET is_public = false WHERE id = $1`, repoID)
	require.NoError(t, err)
	repository, err := q.GetRepoByID(ctx, repoID)
	require.NoError(t, err)

	native := repohostffi.New(library)
	require.NoError(t, native.Load())
	cfg := repohostserver.Config{StoragePath: t.TempDir(), AuthToken: "variable-transfer-test", PushHookCallbackToken: "test-callback"}
	backend, err := repohostserver.NewWithFFI(cfg, native)
	require.NoError(t, err)
	server := httptest.NewServer(backend.Handler())
	t.Cleanup(server.Close)
	host := repohost.NewClient(&repohost.StaticStorageSetResolver{URL: server.URL}, cfg.AuthToken)
	require.NoError(t, host.InitRepo(ctx, owner.Username, repository.Name, "main", false))

	return variableTransferFixture{
		pool: pool, owner: owner, recipient: *recipient, repo: repository, queries: q,
		transfer: NewProductRepoServiceWithPool(q, host, pool), cfg: cfg,
	}
}

// changeOwner exercises the real ownership fence without the retired forge API.
func (f variableTransferFixture) changeOwner(ctx context.Context) error {
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, repoOwnershipLockSQL, f.repo.ID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE repositories SET user_id=$2 WHERE id=$1`, f.repo.ID, f.recipient.ID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (f variableTransferFixture) move(t *testing.T, ctx context.Context) {
	t.Helper()
	require.NoError(t, f.changeOwner(ctx))
	f.assertOwner(t, f.recipient.ID)
	fresh, err := f.queries.GetRepoByID(ctx, f.repo.ID)
	require.NoError(t, err)
	allowed, err := canWriteRepo(ctx, f.queries, fresh, f.owner.ID)
	require.NoError(t, err)
	require.False(t, allowed, "old owner must lose write permission")
}

func (f variableTransferFixture) assertOwner(t *testing.T, want int64) {
	t.Helper()
	var ownerID int64
	require.NoError(t, f.pool.QueryRow(context.Background(), `SELECT user_id FROM repositories WHERE id = $1`, f.repo.ID).Scan(&ownerID))
	require.Equal(t, want, ownerID)
}

func (f variableTransferFixture) assertVariable(t *testing.T, name string, want *string) {
	t.Helper()
	var value string
	err := f.pool.QueryRow(context.Background(), `SELECT value FROM repository_variables WHERE repository_id = $1 AND name = $2`, f.repo.ID, name).Scan(&value)
	if want == nil {
		require.ErrorIs(t, err, pgx.ErrNoRows)
		return
	}
	require.NoError(t, err)
	require.Equal(t, *want, value)
}

func variableValue(s string) *string { return &s }

// The pause is immediately before acquiring the real PostgreSQL ownership
// fence. Authorization and quota reads have already used canonical SQL.
type pausedVariableGuard struct {
	delegate RepoOwnershipGuard
	entered  chan struct{}
	release  chan struct{}
	inside   bool
	once     sync.Once
}

// pause is also installed at the canonical SQL boundary so these tests reproduce
// the unfenced implementation: it reaches SQL without consulting the guard.
func (g *pausedVariableGuard) pause(ctx context.Context) error {
	g.once.Do(func() { close(g.entered) })
	select {
	case <-g.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (g *pausedVariableGuard) WithRepoOwnershipShared(ctx context.Context, snapshot db.Repository, write func() error) error {
	if g.inside {
		return g.delegate.WithRepoOwnershipShared(ctx, snapshot, func() error {
			if err := g.pause(ctx); err != nil {
				return err
			}
			return write()
		})
	}
	if err := g.pause(ctx); err != nil {
		return err
	}
	return g.delegate.WithRepoOwnershipShared(ctx, snapshot, write)
}

type pausedVariableQueries struct {
	*db.Queries
	guard *pausedVariableGuard
}

func (q *pausedVariableQueries) CreateOrUpdateVariable(ctx context.Context, arg db.CreateOrUpdateVariableParams) (db.RepositoryVariable, error) {
	if err := q.guard.pause(ctx); err != nil {
		return db.RepositoryVariable{}, err
	}
	return q.Queries.CreateOrUpdateVariable(ctx, arg)
}
func (q *pausedVariableQueries) DeleteVariable(ctx context.Context, arg db.DeleteVariableParams) error {
	if err := q.guard.pause(ctx); err != nil {
		return err
	}
	return q.Queries.DeleteVariable(ctx, arg)
}
func awaitVariableFence(t *testing.T, ctx context.Context, entered <-chan struct{}) {
	t.Helper()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}

func newPausedVariableGuard(pool *pgxpool.Pool, inside bool) *pausedVariableGuard {
	return &pausedVariableGuard{delegate: NewRepoOwnershipFence(pool), entered: make(chan struct{}), release: make(chan struct{}), inside: inside}
}

func variableFenceContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func TestSetVariable_RefusesAfterConcurrentTransfer(t *testing.T) {
	for _, tc := range []struct {
		name     string
		initial  *string
		incoming string
	}{
		{name: "create", incoming: "stale-create"},
		{name: "update", initial: variableValue("original"), incoming: "stale-update"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newVariableTransferFixture(t)
			ctx := variableFenceContext(t)
			const name = "CONFIG"
			if tc.initial != nil {
				_, err := f.queries.CreateOrUpdateVariable(ctx, db.CreateOrUpdateVariableParams{RepositoryID: f.repo.ID, Name: name, Value: *tc.initial})
				require.NoError(t, err)
			}
			guard := newPausedVariableGuard(f.pool, false)
			service := NewVariableService(&pausedVariableQueries{Queries: f.queries, guard: guard}, WithVariableOwnershipGuard(guard))
			result := make(chan error, 1)
			go func() {
				_, err := service.SetVariable(ctx, &f.owner, f.owner.Username, f.repo.Name, name, tc.incoming)
				result <- err
			}()
			awaitVariableFence(t, ctx, guard.entered)
			f.move(t, ctx)
			close(guard.release)
			require.Equal(t, 409, apiStatus(t, <-result))
			f.assertVariable(t, name, tc.initial)
		})
	}
}

func TestDeleteVariable_RefusesAfterConcurrentTransfer(t *testing.T) {
	f := newVariableTransferFixture(t)
	ctx := variableFenceContext(t)
	const name = "CONFIG"
	_, err := f.queries.CreateOrUpdateVariable(ctx, db.CreateOrUpdateVariableParams{RepositoryID: f.repo.ID, Name: name, Value: "original"})
	require.NoError(t, err)
	guard := newPausedVariableGuard(f.pool, false)
	service := NewVariableService(&pausedVariableQueries{Queries: f.queries, guard: guard}, WithVariableOwnershipGuard(guard))
	result := make(chan error, 1)
	go func() { result <- service.DeleteVariable(ctx, &f.owner, f.owner.Username, f.repo.Name, name) }()
	awaitVariableFence(t, ctx, guard.entered)
	f.move(t, ctx)
	close(guard.release)
	require.Equal(t, 409, apiStatus(t, <-result))
	f.assertVariable(t, name, variableValue("original"))
}

func TestVariableWrite_FencesTransferAndNewOwnerCanWrite(t *testing.T) {
	for _, tc := range []struct {
		name string
		set  bool
	}{
		{name: "set", set: true},
		{name: "delete"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newVariableTransferFixture(t)
			ctx := variableFenceContext(t)
			const name = "CONFIG"
			if !tc.set {
				_, err := f.queries.CreateOrUpdateVariable(ctx, db.CreateOrUpdateVariableParams{RepositoryID: f.repo.ID, Name: name, Value: "original"})
				require.NoError(t, err)
			}
			guard := newPausedVariableGuard(f.pool, true)
			service := NewVariableService(&pausedVariableQueries{Queries: f.queries, guard: guard}, WithVariableOwnershipGuard(guard))
			writeResult := make(chan error, 1)
			go func() {
				if tc.set {
					_, err := service.SetVariable(ctx, &f.owner, f.owner.Username, f.repo.Name, name, "old-owner-write")
					writeResult <- err
				} else {
					writeResult <- service.DeleteVariable(ctx, &f.owner, f.owner.Username, f.repo.Name, name)
				}
			}()
			awaitVariableFence(t, ctx, guard.entered) // the shared advisory lock is held during the write callback
			transferResult := make(chan error, 1)
			go func() {
				transferResult <- f.changeOwner(ctx)
			}()
			require.Eventually(t, func() bool {
				select {
				case err := <-transferResult:
					t.Fatalf("transfer escaped an active variable write: %v", err)
				default:
				}
				var waiting bool
				err := f.pool.QueryRow(ctx, `SELECT EXISTS (
                    SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
                    WHERE a.datname = current_database() AND l.locktype = 'advisory'
                      AND l.mode = 'ExclusiveLock' AND NOT l.granted
                      AND l.objsubid = 1
                      AND l.classid = ((hashtextextended('repository_ownership:' || ($1::bigint)::text, 0) >> 32) & 4294967295)::oid
                      AND l.objid = (hashtextextended('repository_ownership:' || ($1::bigint)::text, 0) & 4294967295)::oid
                )`, f.repo.ID).Scan(&waiting)
				require.NoError(t, err)
				return waiting
			}, 5*time.Second, 10*time.Millisecond, "transfer must wait on the variable ownership lock")
			f.assertOwner(t, f.owner.ID)
			close(guard.release)
			require.NoError(t, <-writeResult)
			require.NoError(t, <-transferResult)
			f.assertOwner(t, f.recipient.ID)
			if tc.set {
				f.assertVariable(t, name, variableValue("old-owner-write"))
			} else {
				f.assertVariable(t, name, nil)
			}
			newOwnerService := NewVariableService(f.queries, WithVariableOwnershipGuard(NewRepoOwnershipFence(f.pool)))
			_, err := newOwnerService.SetVariable(ctx, &f.recipient, f.recipient.Username, f.repo.Name, name, "new-owner-write")
			require.NoError(t, err)
			f.assertVariable(t, name, variableValue("new-owner-write"))
		})
	}
}

func TestVariableWrite_RefusesRevokedCollaboratorBeforeGuardedWrite(t *testing.T) {
	for _, tc := range []struct {
		name string
		set  bool
	}{
		{name: "set", set: true},
		{name: "delete"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newVariableTransferFixture(t)
			ctx := variableFenceContext(t)
			const name = "CONFIG"
			_, err := f.queries.CreateOrUpdateVariable(ctx, db.CreateOrUpdateVariableParams{RepositoryID: f.repo.ID, Name: name, Value: "original"})
			require.NoError(t, err)
			_, err = f.pool.Exec(ctx, `INSERT INTO collaborators (repository_id, user_id, permission) VALUES ($1, $2, 'write')`, f.repo.ID, f.recipient.ID)
			require.NoError(t, err)
			guard := newPausedVariableGuard(f.pool, false)
			service := NewVariableService(&pausedVariableQueries{Queries: f.queries, guard: guard}, WithVariableOwnershipGuard(guard))
			result := make(chan error, 1)
			go func() {
				if tc.set {
					_, err := service.SetVariable(ctx, &f.recipient, f.owner.Username, f.repo.Name, name, "revoked-write")
					result <- err
				} else {
					result <- service.DeleteVariable(ctx, &f.recipient, f.owner.Username, f.repo.Name, name)
				}
			}()
			awaitVariableFence(t, ctx, guard.entered)
			_, err = f.pool.Exec(ctx, `DELETE FROM collaborators WHERE repository_id = $1 AND user_id = $2`, f.repo.ID, f.recipient.ID)
			require.NoError(t, err)
			close(guard.release)
			require.Equal(t, 403, apiStatus(t, <-result))
			f.assertVariable(t, name, variableValue("original"))
		})
	}
}
