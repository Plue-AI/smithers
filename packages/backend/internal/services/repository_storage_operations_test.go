package services

import (
	"context"
	stdErrors "errors"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

type canonicalRepoQuerier struct {
	*mockRepoQuerier
	users map[int64]db.User
	orgs  map[int64]db.Organization
}

func (q *canonicalRepoQuerier) GetUserByID(_ context.Context, id int64) (db.User, error) {
	user, ok := q.users[id]
	if !ok {
		return db.User{}, pgx.ErrNoRows
	}
	return user, nil
}

func (q *canonicalRepoQuerier) GetOrgByID(_ context.Context, id int64) (db.Organization, error) {
	org, ok := q.orgs[id]
	if !ok {
		return db.Organization{}, pgx.ErrNoRows
	}
	return org, nil
}

type memoryRepositoryStorageOperationStore struct {
	mu            sync.Mutex
	operation     repositoryStorageOperation
	active        bool
	createErr     error
	verifyErr     error
	completeErr   error
	completeCalls int
	events        *[]string
}

func (s *memoryRepositoryStorageOperationStore) Create(_ context.Context, operation repositoryStorageOperation) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.events != nil {
		*s.events = append(*s.events, "persist-intent")
	}
	if s.createErr != nil {
		return s.createErr
	}
	if s.active {
		return errRepositoryStorageOperationExists
	}
	s.operation = operation
	s.active = true
	return nil
}

func (s *memoryRepositoryStorageOperationStore) Verify(_ context.Context, repositoryID int64, token string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.verifyErr != nil {
		return false, s.verifyErr
	}
	return s.active && s.operation.RepositoryID == repositoryID && s.operation.Token == token, nil
}

func (s *memoryRepositoryStorageOperationStore) Complete(_ context.Context, repositoryID int64, token string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.completeCalls++
	if s.events != nil {
		*s.events = append(*s.events, "complete-intent")
	}
	if s.completeErr != nil {
		return s.completeErr
	}
	if !s.active || s.operation.RepositoryID != repositoryID || s.operation.Token != token {
		return stdErrors.New("unexpected operation completion")
	}
	s.active = false
	return nil
}

type preparedRepoHost struct {
	*mockRepoHostClient
	prepareDeleteFn func(context.Context, string, string) (repohost.StagedDelete, error)
	executeDeleteFn func(context.Context, repohost.StagedDelete) error
	prepareMoveFn   func(context.Context, string, string, string, string) (repohost.StagedMove, error)
	executeMoveFn   func(context.Context, repohost.StagedMove) error
}

func (h *preparedRepoHost) PrepareStagedDelete(ctx context.Context, owner, repo string) (repohost.StagedDelete, error) {
	return h.prepareDeleteFn(ctx, owner, repo)
}

func (h *preparedRepoHost) ExecuteStagedDelete(ctx context.Context, staged repohost.StagedDelete) error {
	return h.executeDeleteFn(ctx, staged)
}

func (h *preparedRepoHost) PrepareStagedMove(ctx context.Context, srcOwner, srcRepo, dstOwner, dstRepo string) (repohost.StagedMove, error) {
	return h.prepareMoveFn(ctx, srcOwner, srcRepo, dstOwner, dstRepo)
}

func (h *preparedRepoHost) ExecuteStagedMove(ctx context.Context, staged repohost.StagedMove) error {
	return h.executeMoveFn(ctx, staged)
}

func TestDeleteRepoPersistsPreparedHandleBeforeStorageMutation(t *testing.T) {
	actor := &db.User{ID: 11, Username: "Alice", LowerUsername: "alice"}
	repository := db.Repository{
		ID: 91, UserID: pgtype.Int8{Int64: actor.ID, Valid: true},
		Name: "Demo", LowerName: "demo", IsPublic: true,
	}
	events := make([]string, 0, 6)
	baseQ := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repository, nil
		},
	}
	q := &canonicalRepoQuerier{
		mockRepoQuerier: baseQ,
		users:           map[int64]db.User{actor.ID: *actor},
	}
	tx := &fakeOwnershipTx{q: baseQ, getByIDFn: func(context.Context, int64) (db.Repository, error) {
		return repository, nil
	}}
	store := &memoryRepositoryStorageOperationStore{events: &events}
	token := strings.Repeat("a", 64)
	host := &preparedRepoHost{
		mockRepoHostClient: &mockRepoHostClient{finalizeDeleteRepoFn: func(_ context.Context, staged repohost.StagedDelete) error {
			events = append(events, "finalize-delete")
			assert.Equal(t, token, staged.Token)
			return nil
		}},
		prepareDeleteFn: func(_ context.Context, owner, repo string) (repohost.StagedDelete, error) {
			events = append(events, "prepare-delete")
			assert.Equal(t, "Alice", owner, "request casing must not become the physical path")
			return repohost.StagedDelete{BaseURL: "http://s1.test", StorageRouteKey: "s1", Token: token, Owner: owner, Repo: repo}, nil
		},
		executeDeleteFn: func(_ context.Context, staged repohost.StagedDelete) error {
			events = append(events, "execute-delete")
			assert.True(t, store.active, "intent must be durable before repo-host mutation")
			assert.Equal(t, token, staged.Token)
			return nil
		},
	}
	svc := NewRepoService(q, host, "s1")
	svc.ownershipTx = &fakeOwnershipTxManager{tx: tx}
	svc.storageOperations = store

	err := svc.DeleteRepo(context.Background(), actor, "ALICE", "demo")
	require.NoError(t, err)
	assert.Equal(t, []string{
		"prepare-delete", "persist-intent", "execute-delete", "finalize-delete", "complete-intent",
	}, events)
	assert.False(t, store.active)
	assert.Contains(t, tx.calls, "AuthorizeStorageOperation")
}

func TestDeleteRepoRetainsIntentWhenFinalizationFails(t *testing.T) {
	actor := &db.User{ID: 12, Username: "alice", LowerUsername: "alice"}
	repository := db.Repository{ID: 92, UserID: pgtype.Int8{Int64: actor.ID, Valid: true}, Name: "demo", LowerName: "demo"}
	baseQ := &mockRepoQuerier{getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		return repository, nil
	}}
	q := &canonicalRepoQuerier{mockRepoQuerier: baseQ, users: map[int64]db.User{actor.ID: *actor}}
	tx := &fakeOwnershipTx{q: baseQ, getByIDFn: func(context.Context, int64) (db.Repository, error) { return repository, nil }}
	store := &memoryRepositoryStorageOperationStore{}
	token := strings.Repeat("b", 64)
	host := &preparedRepoHost{
		mockRepoHostClient: &mockRepoHostClient{finalizeDeleteRepoFn: func(context.Context, repohost.StagedDelete) error {
			return stdErrors.New("repo-host unavailable")
		}},
		prepareDeleteFn: func(_ context.Context, owner, repo string) (repohost.StagedDelete, error) {
			return repohost.StagedDelete{BaseURL: "http://s1.test", StorageRouteKey: "s1", Token: token, Owner: owner, Repo: repo}, nil
		},
		executeDeleteFn: func(context.Context, repohost.StagedDelete) error { return nil },
	}
	svc := NewRepoService(q, host, "s1")
	svc.ownershipTx = &fakeOwnershipTxManager{tx: tx}
	svc.storageOperations = store

	require.NoError(t, svc.DeleteRepo(context.Background(), actor, "alice", "demo"))
	assert.True(t, store.active, "failed finalization must retain the only durable recovery handle")
	assert.Zero(t, store.completeCalls)
	assert.Equal(t, 2, host.finalizeDeleteCalls, "idempotent completion gets one immediate retry")
}

func TestRepositoryStorageReconcilerUsesOnlyStableExactIdentity(t *testing.T) {
	host := &mockRepoHostClient{}
	reconciler := &RepositoryStorageOperationReconciler{repoHost: host}
	userOne := pgtype.Int8{Int64: 1, Valid: true}
	userTwo := pgtype.Int8{Int64: 2, Valid: true}

	t.Run("delete absent finalizes", func(t *testing.T) {
		host.finalizeDeleteCalls = 0
		err := reconciler.reconcile(context.Background(), repositoryStorageOperation{
			RepositoryID: 1, OperationType: repositoryStorageOperationDelete,
			Token: strings.Repeat("d", 64), StorageRouteKey: "s1",
			SourceOwner: "Alice", SourceRepo: "Demo", SourceUserID: userOne,
		}, nil)
		require.NoError(t, err)
		assert.Equal(t, 1, host.finalizeDeleteCalls)
	})

	t.Run("delete exact source restores", func(t *testing.T) {
		host.restoreDeleteCalls = 0
		err := reconciler.reconcile(context.Background(), repositoryStorageOperation{
			RepositoryID: 1, OperationType: repositoryStorageOperationDelete,
			Token: strings.Repeat("e", 64), StorageRouteKey: "s1",
			SourceOwner: "Alice", SourceRepo: "Demo", SourceUserID: userOne,
		}, &db.Repository{ID: 1, UserID: userOne, Name: "Demo", LowerName: "demo"})
		require.NoError(t, err)
		assert.Equal(t, 1, host.restoreDeleteCalls)
	})

	t.Run("delete changed identity remains unresolved", func(t *testing.T) {
		host.restoreDeleteCalls = 0
		host.finalizeDeleteCalls = 0
		err := reconciler.reconcile(context.Background(), repositoryStorageOperation{
			RepositoryID: 1, OperationType: repositoryStorageOperationDelete,
			Token: strings.Repeat("f", 64), StorageRouteKey: "s1",
			SourceOwner: "Alice", SourceRepo: "Demo", SourceUserID: userOne,
		}, &db.Repository{ID: 1, UserID: userTwo, Name: "Demo", LowerName: "demo"})
		require.ErrorIs(t, err, errRepositoryStorageStateUnknown)
		assert.Zero(t, host.restoreDeleteCalls)
		assert.Zero(t, host.finalizeDeleteCalls)
	})

	move := repositoryStorageOperation{
		RepositoryID: 2, OperationType: repositoryStorageOperationMove,
		Token: strings.Repeat("1", 64), StorageRouteKey: "s1",
		SourceOwner: "Alice", SourceRepo: "Demo", SourceUserID: userOne,
		TargetOwner: pgtype.Text{String: "Bob", Valid: true},
		TargetRepo:  pgtype.Text{String: "Demo", Valid: true}, TargetUserID: userTwo,
	}
	t.Run("move exact target finalizes", func(t *testing.T) {
		host.finalizeMoveCalls = 0
		err := reconciler.reconcile(context.Background(), move, &db.Repository{ID: 2, UserID: userTwo, Name: "Demo", LowerName: "demo"})
		require.NoError(t, err)
		assert.Equal(t, 1, host.finalizeMoveCalls)
	})
	t.Run("move exact source rolls back", func(t *testing.T) {
		host.rollbackMoveCalls = 0
		err := reconciler.reconcile(context.Background(), move, &db.Repository{ID: 2, UserID: userOne, Name: "Demo", LowerName: "demo"})
		require.NoError(t, err)
		assert.Equal(t, 1, host.rollbackMoveCalls)
	})
	t.Run("move absence remains unresolved", func(t *testing.T) {
		err := reconciler.reconcile(context.Background(), move, nil)
		require.ErrorIs(t, err, errRepositoryStorageStateUnknown)
	})
}

func TestRepositoryStorageOperationCreateRejectsStaleSnapshotAfterTransfer(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	sourceName := "source-" + uuid.NewString()
	targetName := "target-" + uuid.NewString()
	var sourceID, targetID int64
	err := pool.QueryRow(ctx, `
		INSERT INTO users (username, lower_username, email, lower_email, display_name)
		VALUES ($1, $1, $2, $2, $1) RETURNING id
	`, sourceName, sourceName+"@test.invalid").Scan(&sourceID)
	require.NoError(t, err)
	err = pool.QueryRow(ctx, `
		INSERT INTO users (username, lower_username, email, lower_email, display_name)
		VALUES ($1, $1, $2, $2, $1) RETURNING id
	`, targetName, targetName+"@test.invalid").Scan(&targetID)
	require.NoError(t, err)
	repoName := "race-" + uuid.NewString()
	repository := db.Repository{
		UserID: pgtype.Int8{Int64: sourceID, Valid: true}, Name: repoName, LowerName: repoName,
	}
	err = pool.QueryRow(ctx, `
		INSERT INTO repositories (
			user_id, name, lower_name, description,
			is_public, default_bookmark
		) VALUES ($1, $2, $2, '', TRUE, 'main')
		RETURNING id
	`, sourceID, repoName).Scan(&repository.ID)
	require.NoError(t, err)
	t.Cleanup(func() {
		cleanupCtx := context.Background()
		cleanupTx, beginErr := pool.Begin(cleanupCtx)
		if beginErr != nil {
			return
		}
		defer cleanupTx.Rollback(cleanupCtx) //nolint:errcheck -- best-effort cleanup
		cleanupToken := strings.Repeat("4", 64)
		_, _ = cleanupTx.Exec(cleanupCtx, `DELETE FROM repository_storage_operations WHERE repository_id = $1`, repository.ID)
		_, _ = cleanupTx.Exec(cleanupCtx, `
			INSERT INTO repository_storage_operations (
				repository_id, operation_type, token, storage_route_key,
				source_owner, source_repo, source_user_id
			) VALUES ($1, 'delete', $2, 's1', $3, $4, $5)
		`, repository.ID, cleanupToken, targetName, repository.Name, targetID)
		_, _ = cleanupTx.Exec(cleanupCtx,
			`SELECT set_config('smithers.repository_storage_operation_token', $1, TRUE)`, cleanupToken)
		_, _ = cleanupTx.Exec(cleanupCtx, `DELETE FROM repositories WHERE id = $1`, repository.ID)
		_, _ = cleanupTx.Exec(cleanupCtx, `DELETE FROM repository_storage_operations WHERE repository_id = $1`, repository.ID)
		_, _ = cleanupTx.Exec(cleanupCtx, `DELETE FROM users WHERE id IN ($1, $2)`, sourceID, targetID)
		_ = cleanupTx.Commit(cleanupCtx)
	})

	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, repoOwnershipLockSQL, repository.ID)
	require.NoError(t, err)
	moveToken := strings.Repeat("3", 64)
	_, err = tx.Exec(ctx, `
		INSERT INTO repository_storage_operations (
			repository_id, operation_type, token, storage_route_key,
			source_owner, source_repo, source_user_id,
			target_owner, target_repo, target_user_id
		) VALUES ($1, 'move', $2, 's1', $3, $4, $5, $6, $4, $7)
	`, repository.ID, moveToken, sourceName, repository.Name, sourceID, targetName, targetID)
	require.NoError(t, err)
	_, err = tx.Exec(ctx,
		`SELECT set_config('smithers.repository_storage_operation_token', $1, TRUE)`, moveToken)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `UPDATE repositories SET user_id = $1, org_id = NULL WHERE id = $2`, targetID, repository.ID)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `DELETE FROM repository_storage_operations WHERE repository_id = $1`, repository.ID)
	require.NoError(t, err)

	store := newPostgresRepositoryStorageOperationStore(pool)
	createResult := make(chan error, 1)
	go func() {
		createResult <- store.Create(context.Background(), newDeleteStorageOperation(repository, sourceName, repohost.StagedDelete{
			BaseURL: "http://s1.test", StorageRouteKey: "s1", Token: strings.Repeat("2", 64), Owner: sourceName, Repo: repository.Name,
		}))
	}()
	require.NoError(t, tx.Commit(ctx))
	require.ErrorIs(t, <-createResult, errRepositoryStorageSourceChanged)

	var intentCount int
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM repository_storage_operations WHERE repository_id = $1`, repository.ID).Scan(&intentCount))
	assert.Zero(t, intentCount, "a stale never-executed intent must not poison reconciliation forever")
}
