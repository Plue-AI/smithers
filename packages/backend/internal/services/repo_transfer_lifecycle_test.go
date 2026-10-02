package services

import (
	"context"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// fakeOwnershipTx implements repoOwnershipTx over a mockRepoQuerier, recording
// call order and commit/rollback outcomes.
type fakeOwnershipTx struct {
	q                           *mockRepoQuerier
	getByIDFn                   func(ctx context.Context, id int64) (db.Repository, error)
	createTransferRequestFn     func(context.Context, db.CreateRepositoryTransferRequestParams) (db.RepositoryTransferRequest, error)
	getTransferRequestFn        func(context.Context, int64) (db.RepositoryTransferRequest, error)
	getPendingTransferRequestFn func(context.Context, int64) (db.RepositoryTransferRequest, error)
	expireTransferRequestsFn    func(context.Context, int64) error
	resolveTransferRequestFn    func(context.Context, db.ResolveRepositoryTransferRequestParams) (db.RepositoryTransferRequest, error)
	commitFn                    func(ctx context.Context) error
	rollbackFn                  func(ctx context.Context) error
	commitErr                   error
	committed                   bool
	rolledBack                  bool
	calls                       []string
}

func (t *fakeOwnershipTx) CreateRepositoryTransferRequest(ctx context.Context, arg db.CreateRepositoryTransferRequestParams) (db.RepositoryTransferRequest, error) {
	t.calls = append(t.calls, "CreateRepositoryTransferRequest")
	if t.createTransferRequestFn != nil {
		return t.createTransferRequestFn(ctx, arg)
	}
	return db.RepositoryTransferRequest{ID: 1, RepositoryID: arg.RepositoryID, SenderID: arg.SenderID, RecipientID: arg.RecipientID, SourceUserID: arg.SourceUserID, SourceOrgID: arg.SourceOrgID, SourceOwner: arg.SourceOwner, SourceName: arg.SourceName, Status: "pending"}, nil
}

func (t *fakeOwnershipTx) GetRepositoryTransferRequest(ctx context.Context, id int64) (db.RepositoryTransferRequest, error) {
	t.calls = append(t.calls, "GetRepositoryTransferRequest")
	if t.getTransferRequestFn != nil {
		return t.getTransferRequestFn(ctx, id)
	}
	return db.RepositoryTransferRequest{}, pgx.ErrNoRows
}

func (t *fakeOwnershipTx) GetPendingRepositoryTransferRequest(ctx context.Context, repositoryID int64) (db.RepositoryTransferRequest, error) {
	t.calls = append(t.calls, "GetPendingRepositoryTransferRequest")
	if t.getPendingTransferRequestFn != nil {
		return t.getPendingTransferRequestFn(ctx, repositoryID)
	}
	return db.RepositoryTransferRequest{}, pgx.ErrNoRows
}

func (t *fakeOwnershipTx) ExpireRepositoryTransferRequests(ctx context.Context, repositoryID int64) error {
	t.calls = append(t.calls, "ExpireRepositoryTransferRequests")
	if t.expireTransferRequestsFn != nil {
		return t.expireTransferRequestsFn(ctx, repositoryID)
	}
	return nil
}

func (t *fakeOwnershipTx) ResolveRepositoryTransferRequest(ctx context.Context, arg db.ResolveRepositoryTransferRequestParams) (db.RepositoryTransferRequest, error) {
	t.calls = append(t.calls, "ResolveRepositoryTransferRequest")
	if t.resolveTransferRequestFn != nil {
		return t.resolveTransferRequestFn(ctx, arg)
	}
	return db.RepositoryTransferRequest{}, pgx.ErrNoRows
}

func (t *fakeOwnershipTx) IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
	t.calls = append(t.calls, "IsOrgOwnerForRepoUser")
	return t.q.IsOrgOwnerForRepoUser(ctx, arg)
}

func (t *fakeOwnershipTx) GetRepoByIDForUpdate(ctx context.Context, id int64) (db.Repository, error) {
	t.calls = append(t.calls, "GetRepoByIDForUpdate")
	return t.getByIDFn(ctx, id)
}

func (t *fakeOwnershipTx) DeleteCollaboratorsByRepo(ctx context.Context, repositoryID int64) error {
	t.calls = append(t.calls, "DeleteCollaboratorsByRepo")
	return t.q.DeleteCollaboratorsByRepo(ctx, repositoryID)
}

func (t *fakeOwnershipTx) DeleteTeamReposByRepo(ctx context.Context, repositoryID int64) error {
	t.calls = append(t.calls, "DeleteTeamReposByRepo")
	return t.q.DeleteTeamReposByRepo(ctx, repositoryID)
}

func (t *fakeOwnershipTx) TransferRepoToUser(ctx context.Context, arg db.TransferRepoToUserParams) (db.Repository, error) {
	t.calls = append(t.calls, "TransferRepoToUser")
	return t.q.TransferRepoToUser(ctx, arg)
}

func (t *fakeOwnershipTx) TransferRepoToOrg(ctx context.Context, arg db.TransferRepoToOrgParams) (db.Repository, error) {
	t.calls = append(t.calls, "TransferRepoToOrg")
	return t.q.TransferRepoToOrg(ctx, arg)
}

func (t *fakeOwnershipTx) UpdateRepo(ctx context.Context, arg db.UpdateRepoParams) (db.Repository, error) {
	t.calls = append(t.calls, "UpdateRepo")
	return t.q.UpdateRepo(ctx, arg)
}

func (t *fakeOwnershipTx) DeleteRepo(ctx context.Context, id int64) error {
	t.calls = append(t.calls, "DeleteRepo")
	return t.q.DeleteRepo(ctx, id)
}

func (t *fakeOwnershipTx) AuthorizeStorageOperation(_ context.Context, _ string) error {
	t.calls = append(t.calls, "AuthorizeStorageOperation")
	return nil
}

func (t *fakeOwnershipTx) Commit(ctx context.Context) error {
	t.calls = append(t.calls, "Commit")
	if t.commitFn != nil {
		if err := t.commitFn(ctx); err != nil {
			return err
		}
	}
	if t.commitErr != nil {
		return t.commitErr
	}
	t.committed = true
	return nil
}

func (t *fakeOwnershipTx) Rollback(ctx context.Context) error {
	t.rolledBack = true
	if t.rollbackFn != nil {
		return t.rollbackFn(ctx)
	}
	return nil
}

type fakeOwnershipTxManager struct {
	tx          repoOwnershipTx
	reconcileTx repoOwnershipTx
	beginErr    error
	begun       int
}

func (m *fakeOwnershipTxManager) BeginOwnershipTx(ctx context.Context, repositoryID int64) (repoOwnershipTx, error) {
	m.begun++
	if m.beginErr != nil {
		return nil, m.beginErr
	}
	if m.begun > 1 {
		if m.reconcileTx != nil {
			return m.reconcileTx, nil
		}
		// Ambiguous-commit tests historically supplied the post-COMMIT view on
		// the pooled querier. Model the new advisory-locked reconciliation as a
		// distinct transaction reading that same durable view.
		if primary, ok := m.tx.(*fakeOwnershipTx); ok && primary.q != nil {
			return &fakeOwnershipTx{
				q: primary.q,
				getByIDFn: func(ctx context.Context, id int64) (db.Repository, error) {
					return primary.q.GetRepoByID(ctx, id)
				},
			}, nil
		}
	}
	return m.tx, nil
}

// transferQuerier builds a mockRepoQuerier wired for a transfer of
// repository (owned per its UserID/OrgID) to target user "bob".
func TestUpdateRepo_Serialized_OwnershipChangedConflict(t *testing.T) {
	t.Parallel()

	actor := &db.User{ID: 1, Username: "actor"}
	repository := testRepo(nil)
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repository, nil
		},
	}
	tx := &fakeOwnershipTx{
		q: q,
		getByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			moved := repository
			moved.OrgID = pgtype.Int8{Int64: 5, Valid: true}
			moved.UserID = pgtype.Int8{}
			return moved, nil
		},
	}
	svc := NewRepoService(q, &mockRepoHostClient{}, "s1")
	svc.ownershipTx = &fakeOwnershipTxManager{tx: tx}

	_, err := svc.UpdateRepo(context.Background(), actor, "owner", "demo", UpdateRepoRequest{Description: stringPtr("new")})
	assert.Equal(t, 409, apiStatus(t, err))
	assert.True(t, tx.rolledBack)
	assert.Equal(t, []string{"GetRepoByIDForUpdate"}, tx.calls)
}

func TestUpdateRepo_Serialized_Success(t *testing.T) {
	t.Parallel()

	actor := &db.User{ID: 1, Username: "actor"}
	repository := testRepo(nil)
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repository, nil
		},
		updateRepoFn: func(_ context.Context, arg db.UpdateRepoParams) (db.Repository, error) {
			repository.Description = arg.Description
			return repository, nil
		},
	}
	tx := &fakeOwnershipTx{
		q: q,
		getByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			return repository, nil
		},
	}
	svc := NewRepoService(q, &mockRepoHostClient{}, "s1")
	svc.ownershipTx = &fakeOwnershipTxManager{tx: tx}

	updated, err := svc.UpdateRepo(context.Background(), actor, "owner", "demo", UpdateRepoRequest{Description: stringPtr("new")})
	require.NoError(t, err)
	assert.Equal(t, "new", updated.Description)
	assert.True(t, tx.committed)
	assert.Equal(t, []string{"GetRepoByIDForUpdate", "UpdateRepo", "Commit"}, tx.calls)
}

func TestDeleteRepo_Serialized_StorageFailureRollsBack(t *testing.T) {
	t.Parallel()

	actor := &db.User{ID: 1, Username: "actor"}
	repository := testRepo(nil)
	dbDeletes := 0
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repository, nil
		},
		deleteRepoFn: func(_ context.Context, id int64) error {
			dbDeletes++
			return nil
		},
	}
	rh := &mockRepoHostClient{
		deleteRepoFn: func(_ context.Context, owner, repo string) error {
			return fmt.Errorf("disk failure")
		},
	}
	tx := &fakeOwnershipTx{
		q: q,
		getByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			return repository, nil
		},
	}
	svc := NewRepoService(q, rh, "s1")
	svc.ownershipTx = &fakeOwnershipTxManager{tx: tx}

	err := svc.DeleteRepo(context.Background(), actor, "owner", "demo")
	assert.Equal(t, 500, apiStatus(t, err))
	assert.False(t, tx.committed)
	assert.True(t, tx.rolledBack)
	// The row delete ran inside the rolled-back transaction, so nothing is lost.
	assert.Equal(t, 1, dbDeletes)
	assert.Equal(t, 1, rh.restoreDeleteCalls, "a possibly-completed stage must always be restored")
}

func TestDeleteRepo_Serialized_AmbiguousStageResponseRestoresKnownStage(t *testing.T) {
	t.Parallel()

	actor := &db.User{ID: 1, Username: "actor"}
	repository := testRepo(nil)
	staged := repohost.StagedDelete{BaseURL: "http://resolved-repo-host.test", Token: "client-owned-token"}
	var order []string
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(_ context.Context, _ db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repository, nil
		},
		deleteRepoFn: func(context.Context, int64) error {
			order = append(order, "db-delete")
			return nil
		},
	}
	rh := &mockRepoHostClient{
		stageDeleteRepoFn: func(context.Context, string, string) (repohost.StagedDelete, error) {
			order = append(order, "stage-response-lost")
			return staged, fmt.Errorf("response lost")
		},
		restoreDeleteRepoFn: func(ctx context.Context, got repohost.StagedDelete) error {
			require.NoError(t, ctx.Err())
			assert.Equal(t, staged, got)
			order = append(order, "restore-known-stage")
			return nil
		},
	}
	tx := &fakeOwnershipTx{
		q: q,
		getByIDFn: func(context.Context, int64) (db.Repository, error) {
			return repository, nil
		},
		commitFn: func(context.Context) error {
			t.Fatal("DB commit must not run after an ambiguous stage response")
			return nil
		},
	}
	svc := NewRepoService(q, rh, "s1")
	svc.ownershipTx = &fakeOwnershipTxManager{tx: tx}

	err := svc.DeleteRepo(context.Background(), actor, "owner", "demo")
	assert.Equal(t, 500, apiStatus(t, err))
	assert.Equal(t, []string{"db-delete", "stage-response-lost", "restore-known-stage"}, order)
	assert.True(t, tx.rolledBack)
	assert.Equal(t, 1, rh.restoreDeleteCalls)
	assert.Equal(t, 0, rh.finalizeDeleteCalls)
}

func TestDeleteRepo_Serialized_Success(t *testing.T) {
	t.Parallel()

	actor := &db.User{ID: 1, Username: "actor"}
	repository := testRepo(nil)
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repository, nil
		},
	}
	rh := &mockRepoHostClient{}
	tx := &fakeOwnershipTx{
		q: q,
		getByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			return repository, nil
		},
	}
	svc := NewRepoService(q, rh, "s1")
	svc.ownershipTx = &fakeOwnershipTxManager{tx: tx}

	err := svc.DeleteRepo(context.Background(), actor, "owner", "demo")
	require.NoError(t, err)
	assert.True(t, tx.committed)
	assert.Equal(t, []string{"GetRepoByIDForUpdate", "DeleteRepo", "Commit"}, tx.calls)
	assert.Equal(t, 1, rh.deleteRepoCalls)
	assert.Equal(t, 1, rh.stageDeleteCalls)
	assert.Equal(t, 0, rh.restoreDeleteCalls)
	assert.Equal(t, 1, rh.finalizeDeleteCalls)
}

func TestDeleteRepo_Serialized_CommitFailureRestoresStagedStorage(t *testing.T) {
	t.Parallel()

	actor := &db.User{ID: 1, Username: "actor"}
	repository := testRepo(nil)
	var order []string
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(_ context.Context, _ db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repository, nil
		},
		getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			assert.Equal(t, repository.ID, id)
			return repository, nil
		},
		deleteRepoFn: func(_ context.Context, _ int64) error {
			order = append(order, "db-delete")
			return nil
		},
	}
	staged := repohost.StagedDelete{BaseURL: "http://resolved-repo-host.test", Token: "delete-stage-token"}
	rh := &mockRepoHostClient{
		stageDeleteRepoFn: func(ctx context.Context, owner, repo string) (repohost.StagedDelete, error) {
			require.NoError(t, ctx.Err())
			assert.Equal(t, "owner", owner)
			assert.Equal(t, repository.Name, repo)
			order = append(order, "stage-storage")
			return staged, nil
		},
		restoreDeleteRepoFn: func(ctx context.Context, got repohost.StagedDelete) error {
			require.NoError(t, ctx.Err(), "restore must have a fresh consistency budget")
			assert.Equal(t, staged, got)
			order = append(order, "restore-storage")
			return nil
		},
		finalizeDeleteRepoFn: func(context.Context, repohost.StagedDelete) error {
			t.Fatal("a failed DB commit must never finalize the tombstone")
			return nil
		},
	}
	tx := &fakeOwnershipTx{
		q: q,
		getByIDFn: func(_ context.Context, _ int64) (db.Repository, error) {
			return repository, nil
		},
		commitFn: func(context.Context) error {
			order = append(order, "commit-fails")
			return fmt.Errorf("commit failed")
		},
	}
	svc := NewRepoService(q, rh, "s1")
	svc.ownershipTx = &fakeOwnershipTxManager{tx: tx}

	err := svc.DeleteRepo(context.Background(), actor, "owner", "demo")
	assert.Equal(t, 500, apiStatus(t, err))
	assert.Equal(t, []string{"db-delete", "stage-storage", "commit-fails", "restore-storage"}, order)
	assert.False(t, tx.committed)
	assert.True(t, tx.rolledBack)
	assert.Equal(t, 1, rh.restoreDeleteCalls)
	assert.Equal(t, 0, rh.finalizeDeleteCalls)
}

func TestDeleteRepo_Serialized_AmbiguousCommitFinalizesWhenRowIsGone(t *testing.T) {
	t.Parallel()

	actor := &db.User{ID: 1, Username: "actor"}
	repository := testRepo(nil)
	commitAttempted := false
	var order []string
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(_ context.Context, _ db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repository, nil
		},
		getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			assert.Equal(t, repository.ID, id)
			if commitAttempted {
				order = append(order, "row-gone")
				return db.Repository{}, pgx.ErrNoRows
			}
			return repository, nil
		},
		deleteRepoFn: func(context.Context, int64) error {
			order = append(order, "db-delete")
			return nil
		},
	}
	staged := repohost.StagedDelete{BaseURL: "http://resolved-repo-host.test", Token: "delete-stage-token"}
	rh := &mockRepoHostClient{
		stageDeleteRepoFn: func(context.Context, string, string) (repohost.StagedDelete, error) {
			order = append(order, "stage-storage")
			return staged, nil
		},
		restoreDeleteRepoFn: func(context.Context, repohost.StagedDelete) error {
			t.Fatal("a durably deleted row must finalize, not restore, its tombstone")
			return nil
		},
		finalizeDeleteRepoFn: func(ctx context.Context, got repohost.StagedDelete) error {
			require.NoError(t, ctx.Err())
			assert.Equal(t, staged, got)
			order = append(order, "finalize-storage")
			return nil
		},
	}
	tx := &fakeOwnershipTx{
		q: q,
		getByIDFn: func(context.Context, int64) (db.Repository, error) {
			return repository, nil
		},
		commitFn: func(context.Context) error {
			commitAttempted = true
			order = append(order, "commit-response-lost")
			return fmt.Errorf("connection lost after COMMIT")
		},
	}
	svc := NewRepoService(q, rh, "s1")
	svc.ownershipTx = &fakeOwnershipTxManager{tx: tx}

	require.NoError(t, svc.DeleteRepo(context.Background(), actor, "owner", "demo"))
	assert.Equal(t, []string{"db-delete", "stage-storage", "commit-response-lost", "row-gone", "finalize-storage"}, order)
	assert.Equal(t, 0, rh.restoreDeleteCalls)
	assert.Equal(t, 1, rh.finalizeDeleteCalls)
}

func TestDeleteRepo_Serialized_AmbiguousCommitUnknownLeavesTombstone(t *testing.T) {
	t.Parallel()

	repository := testRepo(nil)
	tests := []struct {
		name      string
		visible   db.Repository
		lookupErr error
	}{
		{name: "query error", lookupErr: fmt.Errorf("reconciliation database unavailable")},
		{
			name: "owner changed",
			visible: func() db.Repository {
				changed := repository
				changed.UserID = pgtype.Int8{Int64: 77, Valid: true}
				return changed
			}(),
		},
		{
			name: "name changed",
			visible: func() db.Repository {
				changed := repository
				changed.Name = "renamed"
				changed.LowerName = "renamed"
				return changed
			}(),
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			actor := &db.User{ID: 1, Username: "actor"}
			q := &mockRepoQuerier{
				getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
					return repository, nil
				},
				getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
					assert.Equal(t, repository.ID, id)
					return test.visible, test.lookupErr
				},
			}
			rh := &mockRepoHostClient{
				restoreDeleteRepoFn: func(context.Context, repohost.StagedDelete) error {
					t.Fatal("an unknown delete outcome must not guess restore")
					return nil
				},
				finalizeDeleteRepoFn: func(context.Context, repohost.StagedDelete) error {
					t.Fatal("an unknown delete outcome must not guess finalize")
					return nil
				},
			}
			tx := &fakeOwnershipTx{
				q: q,
				getByIDFn: func(context.Context, int64) (db.Repository, error) {
					return repository, nil
				},
				commitErr: fmt.Errorf("connection lost after COMMIT"),
			}
			svc := NewRepoService(q, rh, "s1")
			svc.ownershipTx = &fakeOwnershipTxManager{tx: tx}

			err := svc.DeleteRepo(context.Background(), actor, "owner", "demo")
			assert.Equal(t, 500, apiStatus(t, err))
			assert.True(t, tx.rolledBack)
			assert.Equal(t, 1, rh.stageDeleteCalls)
			assert.Equal(t, 0, rh.restoreDeleteCalls)
			assert.Equal(t, 0, rh.finalizeDeleteCalls)
		})
	}
}

func TestStagedDeleteCompletionRetriesAmbiguousErrors(t *testing.T) {
	t.Parallel()

	staged := repohost.StagedDelete{BaseURL: "http://resolved-repo-host.test", Token: "delete-stage-token"}
	rh := &mockRepoHostClient{}
	// Assign after construction so each callback can inspect the mock's call
	// counter, which is incremented before the callback runs.
	rh.restoreDeleteRepoFn = func(context.Context, repohost.StagedDelete) error {
		if rh.restoreDeleteCalls == 1 {
			return fmt.Errorf("restore response lost")
		}
		return nil
	}
	rh.finalizeDeleteRepoFn = func(context.Context, repohost.StagedDelete) error {
		if rh.finalizeDeleteCalls == 1 {
			return fmt.Errorf("finalize response lost")
		}
		return nil
	}

	require.NoError(t, restoreStagedRepoDelete(context.Background(), staged, rh))
	assert.Equal(t, 2, rh.restoreDeleteCalls)
	NewRepoService(&mockRepoQuerier{}, rh, "s1").finalizeRepoDelete(context.Background(), testRepo(nil), staged, rh)
	assert.Equal(t, 2, rh.finalizeDeleteCalls)
}

func TestDeleteRepo_Serialized_CancellationAfterStorageStartsStillCommitsInOrder(t *testing.T) {
	t.Parallel()

	requestCtx, cancelRequest := context.WithCancel(context.Background())
	actor := &db.User{ID: 1, Username: "actor"}
	repository := testRepo(nil)
	var order []string
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(_ context.Context, _ db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repository, nil
		},
		deleteRepoFn: func(ctx context.Context, _ int64) error {
			require.NoError(t, ctx.Err())
			order = append(order, "db-delete")
			return nil
		},
	}
	rh := &mockRepoHostClient{
		deleteRepoFn: func(ctx context.Context, _, _ string) error {
			order = append(order, "storage-delete")
			cancelRequest()
			require.ErrorIs(t, requestCtx.Err(), context.Canceled)
			require.NoError(t, ctx.Err(), "storage mutation already crossed the consistency boundary")
			return nil
		},
	}
	tx := &fakeOwnershipTx{
		q: q,
		getByIDFn: func(_ context.Context, _ int64) (db.Repository, error) {
			return repository, nil
		},
		commitFn: func(ctx context.Context) error {
			require.NoError(t, ctx.Err(), "DB commit must use the same detached consistency context")
			order = append(order, "commit")
			return nil
		},
	}
	svc := NewRepoService(q, rh, "s1")
	svc.ownershipTx = &fakeOwnershipTxManager{tx: tx}

	require.NoError(t, svc.DeleteRepo(requestCtx, actor, "owner", "demo"))
	assert.Equal(t, []string{"db-delete", "storage-delete", "commit"}, order)
	assert.True(t, tx.committed)
}

// fakeOwnershipGuard is a RepoOwnershipGuard test double: it either rejects
// the write with err or runs it, recording how often it was consulted.
type fakeOwnershipGuard struct {
	err   error
	calls int
}

func (g *fakeOwnershipGuard) WithRepoOwnershipShared(_ context.Context, _ db.Repository, write func() error) error {
	g.calls++
	if g.err != nil {
		return g.err
	}
	return write()
}

func guardedTestRepo() db.Repository {
	return db.Repository{ID: 7, UserID: pgtype.Int8{Int64: 1, Valid: true}, Name: "repo", LowerName: "repo"}
}

// The guard*Querier mocks below embed their service querier interface so they
// stay self-contained: only the methods these tests exercise are implemented
// (the actor is the repo owner, so no permission queries run).

type guardSecretQuerier struct {
	SecretQuerier
	createOrUpdateFn func(ctx context.Context, arg db.CreateOrUpdateSecretParams) (db.RepositorySecret, error)
	deleteSecretFn   func(ctx context.Context, arg db.DeleteSecretParams) error
}

func (m *guardSecretQuerier) GetRepoByOwnerAndLowerName(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	return guardedTestRepo(), nil
}

// ListSecrets backs the pre-write quota check (enforceSecretQuota); an empty
// repo keeps every guarded write under the cap.
func (m *guardSecretQuerier) ListSecrets(context.Context, int64) ([]db.ListSecretsRow, error) {
	return nil, nil
}

func (m *guardSecretQuerier) CreateOrUpdateSecret(ctx context.Context, arg db.CreateOrUpdateSecretParams) (db.RepositorySecret, error) {
	return m.createOrUpdateFn(ctx, arg)
}

func (m *guardSecretQuerier) DeleteSecret(ctx context.Context, arg db.DeleteSecretParams) error {
	return m.deleteSecretFn(ctx, arg)
}

type guardWebhookQuerier struct {
	WebhookQuerier
	createWebhookFn func(ctx context.Context, arg db.CreateWebhookParams) (db.Webhook, error)
}

func (m *guardWebhookQuerier) GetRepoByOwnerAndLowerName(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	return guardedTestRepo(), nil
}

func (m *guardWebhookQuerier) CountWebhooksByRepo(context.Context, int64) (int64, error) {
	return 0, nil
}

func (m *guardWebhookQuerier) CreateWebhook(ctx context.Context, arg db.CreateWebhookParams) (db.Webhook, error) {
	return m.createWebhookFn(ctx, arg)
}

type guardIssueQuerier struct {
	IssueQuerier
	createIssueFn func(ctx context.Context, arg db.CreateIssueParams) (db.Issue, error)
}

func (m *guardIssueQuerier) GetRepoByOwnerAndLowerName(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	return guardedTestRepo(), nil
}

func (m *guardIssueQuerier) CreateIssue(ctx context.Context, arg db.CreateIssueParams) (db.Issue, error) {
	return m.createIssueFn(ctx, arg)
}

func TestSetSecret_OwnershipGuardBlocksStaleWrite(t *testing.T) {
	t.Parallel()

	writes := 0
	q := &guardSecretQuerier{
		createOrUpdateFn: func(_ context.Context, arg db.CreateOrUpdateSecretParams) (db.RepositorySecret, error) {
			writes++
			return db.RepositorySecret{Name: arg.Name}, nil
		},
	}
	guard := &fakeOwnershipGuard{err: pkgerrors.Conflict("repository ownership changed concurrently")}
	svc := NewSecretService(q, nil, WithSecretOwnershipGuard(guard))

	_, err := svc.SetSecret(context.Background(), &db.User{ID: 1}, "owner", "repo", "TOKEN", "v", nil, nil)
	assert.Equal(t, 409, apiStatus(t, err))
	assert.Equal(t, 1, guard.calls)
	assert.Equal(t, 0, writes)
}

func TestSetSecret_OwnershipGuardAllowsWrite(t *testing.T) {
	t.Parallel()

	writes := 0
	q := &guardSecretQuerier{
		createOrUpdateFn: func(_ context.Context, arg db.CreateOrUpdateSecretParams) (db.RepositorySecret, error) {
			writes++
			return db.RepositorySecret{Name: arg.Name}, nil
		},
	}
	guard := &fakeOwnershipGuard{}
	svc := NewSecretService(q, nil, WithSecretOwnershipGuard(guard))

	created, err := svc.SetSecret(context.Background(), &db.User{ID: 1}, "owner", "repo", "TOKEN", "v", nil, nil)
	require.NoError(t, err)
	assert.Equal(t, "TOKEN", created.Name)
	assert.Equal(t, 1, guard.calls)
	assert.Equal(t, 1, writes)
}

func TestDeleteSecret_OwnershipGuardBlocksStaleWrite(t *testing.T) {
	t.Parallel()

	deletes := 0
	q := &guardSecretQuerier{
		deleteSecretFn: func(_ context.Context, _ db.DeleteSecretParams) error {
			deletes++
			return nil
		},
	}
	guard := &fakeOwnershipGuard{err: pkgerrors.Conflict("repository ownership changed concurrently")}
	svc := NewSecretService(q, nil, WithSecretOwnershipGuard(guard))

	err := svc.DeleteSecret(context.Background(), &db.User{ID: 1}, "owner", "repo", "TOKEN")
	assert.Equal(t, 409, apiStatus(t, err))
	assert.Equal(t, 0, deletes)
}

func TestCreateWebhook_OwnershipGuardBlocksStaleWrite(t *testing.T) {
	t.Parallel()

	creates := 0
	q := &guardWebhookQuerier{
		createWebhookFn: func(_ context.Context, arg db.CreateWebhookParams) (db.Webhook, error) {
			creates++
			return db.Webhook{ID: 1, RepositoryID: arg.RepositoryID, Url: arg.Url}, nil
		},
	}
	guard := &fakeOwnershipGuard{err: pkgerrors.Conflict("repository ownership changed concurrently")}
	svc := NewWebhookService(q, nil, WithWebhookOwnershipGuard(guard))

	_, err := svc.CreateWebhook(context.Background(), &db.User{ID: 1}, "owner", "repo", CreateWebhookInput{URL: "https://example.com/hook"})
	assert.Equal(t, 409, apiStatus(t, err))
	assert.Equal(t, 1, guard.calls)
	assert.Equal(t, 0, creates)
}

func TestCreateIssue_OwnershipGuardBlocksStaleWrite(t *testing.T) {
	t.Parallel()

	creates := 0
	q := &guardIssueQuerier{
		createIssueFn: func(_ context.Context, arg db.CreateIssueParams) (db.Issue, error) {
			creates++
			return db.Issue{ID: 1, RepositoryID: arg.RepositoryID, Title: arg.Title}, nil
		},
	}
	guard := &fakeOwnershipGuard{err: pkgerrors.Conflict("repository ownership changed concurrently")}
	svc := NewIssueService(q, WithIssueOwnershipGuard(guard))

	_, err := svc.CreateIssue(context.Background(), &db.User{ID: 1, Username: "actor"}, "owner", "repo", CreateIssueInput{Title: "hello"})
	assert.Equal(t, 409, apiStatus(t, err))
	assert.Equal(t, 1, guard.calls)
	assert.Equal(t, 0, creates)
}
