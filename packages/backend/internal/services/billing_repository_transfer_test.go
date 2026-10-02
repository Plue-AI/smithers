package services

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestBillingService_AuthorizeRepositoryTransferCommitted_FallbackLimits(t *testing.T) {
	t.Parallel()

	const storageCap = int64(100 * 1024 * 1024 * 1024)
	tests := []struct {
		name         string
		privateRepos int64
		storageBytes int64
		footprint    int64
		privateRepo  bool
		wantStatus   int
	}{
		{
			name:         "storage exact fit",
			storageBytes: storageCap - 10,
			footprint:    10,
		},
		{
			name:         "storage one byte over",
			storageBytes: storageCap - 10,
			footprint:    11,
			wantStatus:   403,
		},
		{
			name:         "private repository exact fit",
			privateRepos: 99,
			privateRepo:  true,
		},
		{
			name:         "private repository cap reached",
			privateRepos: 100,
			privateRepo:  true,
			wantStatus:   403,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			queries := newBillingQuerierMock()
			queries.countPrivateReposByOwnerFn = func(_ context.Context, arg db.CountPrivateReposByOwnerParams) (int64, error) {
				assert.Equal(t, BillingOwnerTypeUser, arg.OwnerType)
				assert.Equal(t, int64(77), arg.OwnerID)
				return test.privateRepos, nil
			}
			queries.sumStorageBytesByOwnerFn = func(_ context.Context, arg db.SumStorageBytesByOwnerParams) (int64, error) {
				assert.Equal(t, BillingOwnerTypeUser, arg.OwnerType)
				assert.Equal(t, int64(77), arg.OwnerID)
				return test.storageBytes, nil
			}
			queries.sumStorageBytesByRepositoryFn = func(_ context.Context, repositoryID int64) (int64, error) {
				assert.Equal(t, int64(42), repositoryID)
				return test.footprint, nil
			}

			committed := false
			err := NewBillingService(queries, nil, BillingServiceConfig{}).
				AuthorizeRepositoryTransferCommitted(
					context.Background(),
					42,
					BillingOwnerTypeUser,
					77,
					test.privateRepo,
					func(context.Context) error {
						committed = true
						return nil
					},
				)
			if test.wantStatus == 0 {
				require.NoError(t, err)
				assert.True(t, committed)
				return
			}
			require.Error(t, err)
			assert.Equal(t, test.wantStatus, httpStatus(err))
			assert.False(t, committed, "quota denial must leave the transfer callback untouched")
		})
	}
}

func TestBillingService_AuthorizePrivateRepoCommitted_FallbackLimits(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		name       string
		usage      int64
		wantStatus int
	}{
		{name: "one slot remains", usage: 99},
		{name: "cap reached", usage: 100, wantStatus: 403},
	} {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			queries := newBillingQuerierMock()
			queries.countPrivateReposByOwnerFn = func(_ context.Context, arg db.CountPrivateReposByOwnerParams) (int64, error) {
				assert.Equal(t, BillingOwnerTypeOrg, arg.OwnerType)
				assert.Equal(t, int64(77), arg.OwnerID)
				return test.usage, nil
			}
			committed := false
			err := NewBillingService(queries, nil, BillingServiceConfig{}).AuthorizePrivateRepoCommitted(
				context.Background(),
				BillingOwnerTypeOrg,
				77,
				func(context.Context) error {
					committed = true
					return nil
				},
			)
			if test.wantStatus == 0 {
				require.NoError(t, err)
				assert.True(t, committed)
				return
			}
			require.Error(t, err)
			assert.Equal(t, test.wantStatus, httpStatus(err))
			assert.False(t, committed)
		})
	}
}

func TestBillingService_CommittedStorageWaitsForTransferThenUsesNewOwnerLock(t *testing.T) {
	pool := getAgentTestPool(t)

	oldOwnerID := createBillingTransferUser(t, pool, "old")
	targetOwnerID := createBillingTransferUser(t, pool, "target")
	repositoryID := createBillingTransferRepo(t, pool, oldOwnerID, false)
	transferToken := stageBillingTransferOperation(t, pool, repositoryID, targetOwnerID)

	// The deadline bounds only the lock choreography under test (a wedged
	// writer must fail here, not at the package timeout). It starts after the
	// fixture rows exist so slow fixture inserts on a loaded database cannot
	// silently consume the budget and surface as a bogus lock timeout.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Holding only the old owner's storage lock makes stale-owner resolution
	// observable: a correct writer will remain blocked on repository ownership,
	// then resolve the target and finish without waiting for this transaction.
	oldOwnerLock, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = oldOwnerLock.Rollback(context.Background()) }()
	_, err = oldOwnerLock.Exec(ctx, storageAuthorizationLockSQL, BillingOwnerTypeUser, oldOwnerID)
	require.NoError(t, err)

	transferTx, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = transferTx.Rollback(context.Background()) }()
	_, err = transferTx.Exec(ctx, repoOwnershipLockSQL, repositoryID)
	require.NoError(t, err)
	_, err = transferTx.Exec(ctx, `SELECT set_config('smithers.repository_storage_operation_token', $1, TRUE)`, transferToken)
	require.NoError(t, err)
	_, err = transferTx.Exec(ctx, `UPDATE repositories SET user_id = $1, org_id = NULL WHERE id = $2`, targetOwnerID, repositoryID)
	require.NoError(t, err)

	callbackCalled := make(chan struct{})
	result := make(chan error, 1)
	done := make(chan struct{})
	service := NewBillingService(db.New(pool), nil, BillingServiceConfig{})
	go func() {
		defer close(done)
		result <- service.AuthorizeStorageIncreaseCommitted(ctx, repositoryID, 1, func(context.Context) error {
			close(callbackCalled)
			return nil
		})
	}()
	defer func() {
		cancel()
		<-done
	}()

	// Observe the actual ownership-lock wait before releasing the transfer.
	// Sleeping could pass without the writer ever having been scheduled.
	waitForBillingTransferLockWaiters(t, ctx, pool, transferTx, 1)
	select {
	case <-callbackCalled:
		t.Fatal("storage writer resolved an owner before the transfer released repository ownership")
	default:
	}
	require.NoError(t, transferTx.Commit(ctx))

	select {
	case err := <-result:
		require.NoError(t, err)
	case <-ctx.Done():
		t.Fatal("storage writer did not finish while the old-owner lock remained held:", ctx.Err())
	}
	select {
	case <-callbackCalled:
	default:
		t.Fatal("storage writer returned without committing under the new owner's lock")
	}
}

func TestBillingService_ConcurrentPrivateTransfersStopAtExactTargetCap(t *testing.T) {
	pool := getAgentTestPool(t)

	targetOwnerID := createBillingTransferUser(t, pool, "cap-target")
	firstSourceID := createBillingTransferUser(t, pool, "cap-source-a")
	secondSourceID := createBillingTransferUser(t, pool, "cap-source-b")
	repositories := []int64{
		createBillingTransferRepo(t, pool, firstSourceID, true),
		createBillingTransferRepo(t, pool, secondSourceID, true),
	}
	transferTokens := make(map[int64]string, len(repositories))
	for _, repositoryID := range repositories {
		transferTokens[repositoryID] = stageBillingTransferOperation(t, pool, repositoryID, targetOwnerID)
	}

	// Bound only the concurrent admission race; see the sibling test above for
	// why the deadline must not start before the fixture rows exist.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	service := NewBillingService(db.New(pool), nil, BillingServiceConfig{})
	freePlan := service.checkoutPlans[BillingOwnerTypeUser][BillingPlanFree]
	freePlan.Limits.PrivateRepos = 1
	freePlan.Limits.StorageBytes = unlimitedBillingQuantity
	service.checkoutPlans[BillingOwnerTypeUser][BillingPlanFree] = freePlan

	// Hold admission until both transfers are contending for the target quota.
	// A start channel alone does not ensure their DB work overlaps.
	targetLock, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = targetLock.Rollback(context.Background()) }()
	_, err = targetLock.Exec(ctx, storageAuthorizationLockSQL, BillingOwnerTypeUser, targetOwnerID)
	require.NoError(t, err)

	start := make(chan struct{})
	results := make(chan error, len(repositories))
	var committed atomic.Int32
	var workers sync.WaitGroup
	for _, repositoryID := range repositories {
		repositoryID := repositoryID
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			transferToken := transferTokens[repositoryID]
			results <- service.AuthorizeRepositoryTransferCommitted(
				ctx,
				repositoryID,
				BillingOwnerTypeUser,
				targetOwnerID,
				true,
				func(commitCtx context.Context) error {
					tx, err := pool.Begin(commitCtx)
					if err != nil {
						return err
					}
					defer func() { _ = tx.Rollback(context.Background()) }()
					if _, err = tx.Exec(commitCtx, `SELECT set_config('smithers.repository_storage_operation_token', $1, TRUE)`, transferToken); err != nil {
						return err
					}
					if _, err = tx.Exec(commitCtx, `UPDATE repositories SET user_id = $1, org_id = NULL WHERE id = $2`, targetOwnerID, repositoryID); err != nil {
						return err
					}
					if err = tx.Commit(commitCtx); err != nil {
						return err
					}
					committed.Add(1)
					return nil
				},
			)
		}()
	}
	close(start)
	defer func() {
		cancel()
		workers.Wait()
	}()
	waitForBillingTransferLockWaiters(t, ctx, pool, targetLock, len(repositories))
	require.NoError(t, targetLock.Commit(ctx))
	workers.Wait()
	close(results)

	allowed, denied := 0, 0
	for err := range results {
		if err == nil {
			allowed++
			continue
		}
		if httpStatus(err) == 403 {
			denied++
			continue
		}
		t.Fatalf("unexpected transfer authorization error: %v", err)
	}
	assert.Equal(t, 1, allowed)
	assert.Equal(t, 1, denied)
	assert.Equal(t, int32(1), committed.Load())

	var targetPrivateRepos int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM repositories WHERE user_id = $1 AND NOT is_public`, targetOwnerID).Scan(&targetPrivateRepos))
	assert.Equal(t, int64(1), targetPrivateRepos)
}

func waitForBillingTransferLockWaiters(t *testing.T, ctx context.Context, pool *pgxpool.Pool, blocker pgx.Tx, want int) {
	t.Helper()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		var waiting int
		err := pool.QueryRow(ctx, `
			SELECT COUNT(*) FROM pg_stat_activity
			WHERE datname = current_database() AND wait_event = 'advisory'
			  AND $1::integer = ANY(pg_blocking_pids(pid))
		`, blocker.Conn().PgConn().PID()).Scan(&waiting)
		require.NoError(t, err, "observe advisory-lock waiters")
		if waiting == want {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("wanted %d advisory-lock waiters, observed %d: %v", want, waiting, ctx.Err())
		case <-ticker.C:
		}
	}
}

func TestBillingService_ConcurrentPrivateRepositoryCreatesStopAtExactCap(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	ownerID := createBillingTransferUser(t, pool, "create-cap")
	service := NewBillingService(db.New(pool), nil, BillingServiceConfig{})
	freePlan := service.checkoutPlans[BillingOwnerTypeUser][BillingPlanFree]
	freePlan.Limits.PrivateRepos = 1
	service.checkoutPlans[BillingOwnerTypeUser][BillingPlanFree] = freePlan

	start := make(chan struct{})
	results := make(chan error, 2)
	var committed atomic.Int32
	var workers sync.WaitGroup
	for range 2 {
		name := "billing-private-create-" + uuid.NewString()
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			results <- service.AuthorizePrivateRepoCommitted(
				ctx,
				BillingOwnerTypeUser,
				ownerID,
				func(commitCtx context.Context) error {
					_, err := pool.Exec(commitCtx,
						`INSERT INTO repositories (user_id, name, lower_name, description, is_public, default_bookmark)
						 VALUES ($1, $2, $2, '', FALSE, 'main')`,
						ownerID,
						name,
					)
					if err == nil {
						committed.Add(1)
					}
					return err
				},
			)
		}()
	}
	close(start)
	workers.Wait()
	close(results)

	allowed, denied := 0, 0
	for err := range results {
		if err == nil {
			allowed++
			continue
		}
		if httpStatus(err) == 403 {
			denied++
			continue
		}
		t.Fatalf("unexpected private repository authorization error: %v", err)
	}
	assert.Equal(t, 1, allowed)
	assert.Equal(t, 1, denied)
	assert.Equal(t, int32(1), committed.Load())

	var privateRepos int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM repositories WHERE user_id = $1 AND NOT is_public`, ownerID).Scan(&privateRepos))
	assert.Equal(t, int64(1), privateRepos)
}

type rollbackFailingBillingQuerier struct {
	*db.Queries
	pool          *pgxpool.Pool
	rollbackCalls *atomic.Int32
}

func (q *rollbackFailingBillingQuerier) BeginTx(ctx context.Context) (pgx.Tx, error) {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return &rollbackFailingBillingTx{Tx: tx, calls: q.rollbackCalls}, nil
}

func (*rollbackFailingBillingQuerier) RebindBillingQueries(conn db.DBTX) (BillingBaseQuerier, error) {
	return db.New(conn), nil
}

type rollbackFailingBillingTx struct {
	pgx.Tx
	calls *atomic.Int32
}

func (tx *rollbackFailingBillingTx) Rollback(ctx context.Context) error {
	tx.calls.Add(1)
	if err := tx.Tx.Rollback(ctx); err != nil {
		return err
	}
	return errors.New("injected advisory-lock release failure")
}

func TestBillingService_DurablePrivateCommitIgnoresLockReleaseFailure(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	ownerID := createBillingTransferUser(t, pool, "release-failure")
	var rollbackCalls atomic.Int32
	queries := &rollbackFailingBillingQuerier{
		Queries:       db.New(pool),
		pool:          pool,
		rollbackCalls: &rollbackCalls,
	}
	service := NewBillingService(queries, nil, BillingServiceConfig{})
	name := "billing-release-failure-" + uuid.NewString()

	err := service.AuthorizePrivateRepoCommitted(ctx, BillingOwnerTypeUser, ownerID, func(commitCtx context.Context) error {
		_, insertErr := pool.Exec(commitCtx,
			`INSERT INTO repositories (user_id, name, lower_name, description, is_public, default_bookmark)
			 VALUES ($1, $2, $2, '', FALSE, 'main')`,
			ownerID,
			name,
		)
		return insertErr
	})
	require.NoError(t, err, "lock-only rollback must not reinterpret a durable repository insert as failed")
	assert.Equal(t, int32(1), rollbackCalls.Load())

	var exists bool
	require.NoError(t, pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM repositories WHERE user_id = $1 AND lower_name = $2)`, ownerID, name).Scan(&exists))
	assert.True(t, exists)
}

func createBillingTransferUser(t *testing.T, pool *pgxpool.Pool, label string) int64 {
	t.Helper()
	suffix := uuid.NewString()
	username := fmt.Sprintf("billing-transfer-%s-%s", label, suffix)
	email := username + "@example.test"
	var id int64
	require.NoError(t, pool.QueryRow(
		context.Background(),
		`INSERT INTO users (username, lower_username, email, lower_email, display_name)
		 VALUES ($1, $1, $2, $2, $1) RETURNING id`,
		username,
		email,
	).Scan(&id))
	return id
}

func createBillingTransferRepo(t *testing.T, pool *pgxpool.Pool, ownerID int64, private bool) int64 {
	t.Helper()
	name := "billing-transfer-" + uuid.NewString()
	var id int64
	require.NoError(t, pool.QueryRow(
		context.Background(),
		`INSERT INTO repositories (user_id, name, lower_name, description, is_public, default_bookmark)
		 VALUES ($1, $2, $2, '', $3, 'main') RETURNING id`,
		ownerID,
		name,
		!private,
	).Scan(&id))
	return id
}

func stageBillingTransferOperation(t *testing.T, pool *pgxpool.Pool, repositoryID, targetOwnerID int64) string {
	t.Helper()
	ctx := context.Background()
	var sourceOwnerID int64
	var sourceOwner, targetOwner, repositoryName string
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT r.user_id, source.username, target.username, r.name
		FROM repositories AS r
		JOIN users AS source ON source.id = r.user_id
		JOIN users AS target ON target.id = $2
		WHERE r.id = $1
	`, repositoryID, targetOwnerID).Scan(&sourceOwnerID, &sourceOwner, &targetOwner, &repositoryName))

	token := strings.Repeat(strings.ReplaceAll(uuid.NewString(), "-", ""), 2)
	_, err := pool.Exec(ctx, `
		INSERT INTO repository_storage_operations (
			repository_id, operation_type, token, storage_route_key,
			source_owner, source_repo, source_user_id,
			target_owner, target_repo, target_user_id
		) VALUES ($1, 'move', $2, $3, $4, $5, $6, $7, $5, $8)
	`, repositoryID, token, "static", sourceOwner, repositoryName, sourceOwnerID, targetOwner, targetOwnerID)
	require.NoError(t, err)
	return token
}
