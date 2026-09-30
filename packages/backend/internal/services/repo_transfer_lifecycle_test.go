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

type transferCommitBillingPolicy struct {
	*stubBillingPolicy
	authorizeTransferFn func(
		ctx context.Context,
		repositoryID int64,
		targetOwnerType string,
		targetOwnerID int64,
		privateRepository bool,
		commit func(context.Context) error,
	) error
	authorizeTransferInTxFn func(
		ctx context.Context,
		tx db.DBTX,
		repositoryID int64,
		targetOwnerType string,
		targetOwnerID int64,
		privateRepository bool,
		commit func(context.Context) error,
	) error
}

func (p *transferCommitBillingPolicy) AuthorizeRepositoryTransferCommitted(
	ctx context.Context,
	repositoryID int64,
	targetOwnerType string,
	targetOwnerID int64,
	privateRepository bool,
	commit func(context.Context) error,
) error {
	return p.authorizeTransferFn(ctx, repositoryID, targetOwnerType, targetOwnerID, privateRepository, commit)
}

func (p *transferCommitBillingPolicy) AuthorizeRepositoryTransferCommittedInTransaction(
	ctx context.Context,
	tx db.DBTX,
	repositoryID int64,
	targetOwnerType string,
	targetOwnerID int64,
	privateRepository bool,
	commit func(context.Context) error,
) error {
	return p.authorizeTransferInTxFn(ctx, tx, repositoryID, targetOwnerType, targetOwnerID, privateRepository, commit)
}

type fakeOwnershipDBTransaction struct {
	*fakeOwnershipTx
	dbtx db.DBTX
}

func (t *fakeOwnershipDBTransaction) OwnershipDBTX() db.DBTX {
	return t.dbtx
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
func transferQuerierToUser(repository db.Repository, isOrgOwner bool) *mockRepoQuerier {
	return &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			if arg.Owner == "owner" && arg.LowerName == repository.LowerName {
				return repository, nil
			}
			return db.Repository{}, pgx.ErrNoRows
		},
		isOrgOwnerForRepoUserFn: func(_ context.Context, _ db.IsOrgOwnerForRepoUserParams) (bool, error) {
			return isOrgOwner, nil
		},
		getUserByLowerUsernameFn: func(_ context.Context, lowerUsername string) (db.User, error) {
			if lowerUsername == "bob" {
				return db.User{ID: 77, Username: "bob", LowerUsername: "bob"}, nil
			}
			return db.User{}, pgx.ErrNoRows
		},
	}
}

// These tests cover the transfer machinery that runs after a recipient accepts
// a pending user transfer. The public TransferRepo method now only creates the
// pending request, so exercise the machinery at its existing service seam.
func transferToBobSerialized(ctx context.Context, svc *RepoService, _ *db.User, repository db.Repository) (db.Repository, error) {
	return svc.transferRepoSerialized(ctx, repository, "owner", repository.Name, repoTransferTarget{
		ownerName:   "bob",
		userID:      pgtype.Int8{Int64: 77, Valid: true},
		conflictMsg: "user 'bob' already has a repository named '" + repository.Name + "'",
	})
}

func transferToBobCompensating(ctx context.Context, svc *RepoService, _ *db.User, repository db.Repository) (db.Repository, error) {
	return transferToUserCompensating(ctx, svc, repository, 77)
}

func transferToUserCompensating(ctx context.Context, svc *RepoService, repository db.Repository, targetUserID int64) (db.Repository, error) {
	return svc.transferRepoCompensating(ctx, repository, "owner", repository.Name, repoTransferTarget{
		ownerName:   "bob",
		userID:      pgtype.Int8{Int64: targetUserID, Valid: true},
		conflictMsg: "user 'bob' already has a repository named '" + repository.Name + "'",
	})
}

func TestTransferRepo_UserRequestLeavesOwnershipAndStorageUntouched(t *testing.T) {
	t.Parallel()
	actor := &db.User{ID: 1, Username: "actor"}
	repository := testRepo(nil)
	q := transferQuerierToUser(repository, false)
	q.transferRepoToUserFn = func(context.Context, db.TransferRepoToUserParams) (db.Repository, error) {
		t.Fatal("request creation must not change ownership")
		return db.Repository{}, nil
	}
	q.deleteCollaboratorsByRepoFn = func(context.Context, int64) error {
		t.Fatal("request creation must not remove collaborators")
		return nil
	}
	q.deleteTeamReposByRepoFn = func(context.Context, int64) error {
		t.Fatal("request creation must not remove team access")
		return nil
	}
	tx := &fakeOwnershipTx{q: q, getByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
		require.Equal(t, repository.ID, id)
		return repository, nil
	}}
	tx.createTransferRequestFn = func(_ context.Context, arg db.CreateRepositoryTransferRequestParams) (db.RepositoryTransferRequest, error) {
		assert.Equal(t, repository.ID, arg.RepositoryID)
		assert.Equal(t, actor.ID, arg.SenderID)
		assert.Equal(t, int64(77), arg.RecipientID)
		assert.Equal(t, repository.UserID, arg.SourceUserID)
		assert.Equal(t, repository.OrgID, arg.SourceOrgID)
		assert.Equal(t, "owner", arg.SourceOwner)
		assert.Equal(t, repository.Name, arg.SourceName)
		return db.RepositoryTransferRequest{ID: 9, RepositoryID: arg.RepositoryID, RecipientID: arg.RecipientID, Status: "pending"}, nil
	}
	host := &mockRepoHostClient{}
	billing := &stubBillingPolicy{authorizePrivateRepoFn: func(context.Context, string, int64) error {
		t.Fatal("recipient billing must wait until acceptance")
		return nil
	}}
	svc := NewRepoService(q, host, "s1", WithRepoBillingPolicy(billing))
	svc.ownershipTx = &fakeOwnershipTxManager{tx: tx}

	result, err := svc.TransferRepo(context.Background(), actor, "owner", repository.Name, "bob")
	require.NoError(t, err)
	require.NotNil(t, result.PendingTransfer)
	assert.Equal(t, int64(9), result.PendingTransfer.ID)
	assert.Equal(t, repository, result.Repository)
	assert.Equal(t, "owner", result.Owner)
	assert.Equal(t, []string{"GetRepoByIDForUpdate", "ExpireRepositoryTransferRequests", "GetPendingRepositoryTransferRequest", "CreateRepositoryTransferRequest", "Commit"}, tx.calls)
	assert.True(t, tx.committed)
	assert.Zero(t, host.moveRepoCalls)
	assert.Zero(t, host.stageMoveCalls)
}

func TestTransferRepo_UserRequestRequiresTransactionalStorage(t *testing.T) {
	t.Parallel()
	repository := testRepo(nil)
	q := transferQuerierToUser(repository, false)
	host := &mockRepoHostClient{}
	_, err := NewRepoService(q, host, "s1").TransferRepo(context.Background(), &db.User{ID: 1}, "owner", repository.Name, "bob")
	assert.Equal(t, 500, apiStatus(t, err))
	assert.False(t, q.transferToUserCalled)
	assert.Zero(t, host.moveRepoCalls)
}

func TestTransferRepo_OrgOwnedMoveFailureRevertsToOrg(t *testing.T) {
	t.Parallel()

	actor := &db.User{ID: 11, Username: "actor"}
	repository := testRepo(func(r *db.Repository) {
		r.ID = 300
		r.UserID = pgtype.Int8{}
		r.OrgID = pgtype.Int8{Int64: 55, Valid: true}
	})

	q := transferQuerierToUser(repository, true)
	var revertedToOrg *db.TransferRepoToOrgParams
	q.transferRepoToOrgFn = func(_ context.Context, arg db.TransferRepoToOrgParams) (db.Repository, error) {
		revertedToOrg = &arg
		return db.Repository{ID: arg.ID, OrgID: arg.NewOrgID}, nil
	}
	var userTransfers []db.TransferRepoToUserParams
	q.transferRepoToUserFn = func(_ context.Context, arg db.TransferRepoToUserParams) (db.Repository, error) {
		userTransfers = append(userTransfers, arg)
		return db.Repository{ID: arg.ID, UserID: arg.NewUserID}, nil
	}
	rh := &mockRepoHostClient{
		moveRepoFn: func(_ context.Context, _, _, _, _ string) error {
			return fmt.Errorf("move failed")
		},
	}

	_, err := transferToBobCompensating(context.Background(), NewRepoService(q, rh, "s1"), actor, repository)
	assert.Equal(t, 500, apiStatus(t, err))

	// The initial transfer targeted user bob; the compensating revert must go
	// back to the original ORG owner, never TransferRepoToUser with a NULL id.
	require.Len(t, userTransfers, 1)
	assert.Equal(t, pgtype.Int8{Int64: 77, Valid: true}, userTransfers[0].NewUserID)
	require.NotNil(t, revertedToOrg)
	assert.Equal(t, repository.OrgID, revertedToOrg.NewOrgID)
	assert.Equal(t, repository.ID, revertedToOrg.ID)
}

func TestTransferRepo_RevertFailureSkipsGrantRestore(t *testing.T) {
	t.Parallel()

	actor := &db.User{ID: 1, Username: "actor"}
	repository := testRepo(nil) // user-owned by actor (ID 1)

	q := transferQuerierToUser(repository, false)
	q.listCollaboratorsByRepoFn = func(_ context.Context, repositoryID int64) ([]db.Collaborator, error) {
		return []db.Collaborator{{RepositoryID: repositoryID, UserID: pgtype.Int8{Int64: 20, Valid: true}, Permission: "write"}}, nil
	}
	q.listTeamReposByRepoFn = func(_ context.Context, repositoryID int64) ([]db.TeamRepo, error) {
		return []db.TeamRepo{{RepositoryID: repositoryID, TeamID: 40}}, nil
	}
	transferCalls := 0
	q.transferRepoToUserFn = func(_ context.Context, arg db.TransferRepoToUserParams) (db.Repository, error) {
		transferCalls++
		if transferCalls == 1 {
			return db.Repository{ID: arg.ID, UserID: arg.NewUserID}, nil
		}
		return db.Repository{}, fmt.Errorf("revert failed")
	}
	grantRestores := 0
	q.addCollaboratorFn = func(_ context.Context, arg db.AddCollaboratorParams) (db.Collaborator, error) {
		grantRestores++
		return db.Collaborator{}, nil
	}
	q.addTeamRepoFn = func(_ context.Context, arg db.AddTeamRepoParams) (db.TeamRepo, error) {
		grantRestores++
		return db.TeamRepo{}, nil
	}
	rh := &mockRepoHostClient{
		moveRepoFn: func(_ context.Context, _, _, _, _ string) error {
			return fmt.Errorf("move failed")
		},
	}

	_, err := transferToBobCompensating(context.Background(), NewRepoService(q, rh, "s1"), actor, repository)
	assert.Equal(t, 500, apiStatus(t, err))
	assert.Equal(t, 2, transferCalls)
	// Ownership is still with the target owner: restoring the old grants would
	// leak the previous owner's collaborators/teams onto the new owner's repo.
	assert.Equal(t, 0, grantRestores)
}

func TestTransferRepo_Serialized_Success(t *testing.T) {
	t.Parallel()

	actor := &db.User{ID: 1, Username: "actor"}
	repository := testRepo(nil)
	q := transferQuerierToUser(repository, false)
	q.transferRepoToUserFn = func(_ context.Context, arg db.TransferRepoToUserParams) (db.Repository, error) {
		return db.Repository{ID: arg.ID, UserID: arg.NewUserID, Name: repository.Name, LowerName: repository.LowerName}, nil
	}
	rh := &mockRepoHostClient{}

	tx := &fakeOwnershipTx{
		q: q,
		getByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			return repository, nil
		},
	}
	svc := NewRepoService(q, rh, "s1")
	txManager := &fakeOwnershipTxManager{tx: tx}
	svc.ownershipTx = txManager

	updated, err := transferToBobSerialized(context.Background(), svc, actor, repository)
	require.NoError(t, err)
	assert.Equal(t, int64(77), updated.UserID.Int64)
	assert.True(t, tx.committed)
	assert.Equal(t, []string{"GetRepoByIDForUpdate", "DeleteCollaboratorsByRepo", "DeleteTeamReposByRepo", "TransferRepoToUser", "Commit"}, tx.calls)
	assert.Equal(t, 1, rh.moveRepoCalls)
	assert.Equal(t, 1, rh.stageMoveCalls)
	assert.Equal(t, 0, rh.rollbackMoveCalls)
	assert.Equal(t, 1, rh.finalizeMoveCalls)
	assert.Equal(t, 1, txManager.begun)
}

func TestTransferRepo_Serialized_UsesOwnershipTransactionForBillingAdmission(t *testing.T) {
	t.Parallel()

	actor := &db.User{ID: 1, Username: "actor"}
	repository := testRepo(nil)
	q := transferQuerierToUser(repository, false)
	q.transferRepoToUserFn = func(_ context.Context, arg db.TransferRepoToUserParams) (db.Repository, error) {
		return db.Repository{ID: arg.ID, UserID: arg.NewUserID, Name: repository.Name, LowerName: repository.LowerName}, nil
	}
	tx := &fakeOwnershipTx{
		q: q,
		getByIDFn: func(context.Context, int64) (db.Repository, error) {
			return repository, nil
		},
	}
	sharedTx := &fakeOwnershipDBTransaction{fakeOwnershipTx: tx}
	calledInTx := false
	policy := &transferCommitBillingPolicy{
		stubBillingPolicy: &stubBillingPolicy{},
		authorizeTransferFn: func(context.Context, int64, string, int64, bool, func(context.Context) error) error {
			t.Fatal("production-capable ownership transactions must not open the legacy second billing transaction")
			return nil
		},
		authorizeTransferInTxFn: func(
			ctx context.Context,
			gotTx db.DBTX,
			repositoryID int64,
			targetOwnerType string,
			targetOwnerID int64,
			privateRepository bool,
			commit func(context.Context) error,
		) error {
			calledInTx = true
			assert.Equal(t, sharedTx.dbtx, gotTx)
			assert.Equal(t, repository.ID, repositoryID)
			assert.Equal(t, BillingOwnerTypeUser, targetOwnerType)
			assert.Equal(t, int64(77), targetOwnerID)
			assert.True(t, privateRepository)
			return commit(ctx)
		},
	}
	svc := NewRepoService(q, &mockRepoHostClient{}, "s1", WithRepoBillingPolicy(policy))
	svc.ownershipTx = &fakeOwnershipTxManager{tx: sharedTx}

	updated, err := transferToBobSerialized(context.Background(), svc, actor, repository)
	require.NoError(t, err)
	assert.True(t, calledInTx)
	assert.True(t, tx.committed)
	assert.Equal(t, int64(77), updated.UserID.Int64)
}

func TestTransferRepo_Serialized_TargetQuotaRejectionLeavesDatabaseAndStorageUnchanged(t *testing.T) {
	t.Parallel()

	actor := &db.User{ID: 1, Username: "actor"}
	repository := testRepo(nil)
	q := transferQuerierToUser(repository, false)
	q.transferRepoToUserFn = func(context.Context, db.TransferRepoToUserParams) (db.Repository, error) {
		t.Fatal("target quota denial must happen before the ownership update")
		return db.Repository{}, nil
	}
	rh := &mockRepoHostClient{
		stageMoveRepoFn: func(context.Context, string, string, string, string) (repohost.StagedMove, error) {
			t.Fatal("target quota denial must happen before the storage move")
			return repohost.StagedMove{}, nil
		},
	}
	policy := &transferCommitBillingPolicy{
		stubBillingPolicy: &stubBillingPolicy{},
		authorizeTransferFn: func(
			ctx context.Context,
			repositoryID int64,
			targetOwnerType string,
			targetOwnerID int64,
			privateRepository bool,
			commit func(context.Context) error,
		) error {
			require.NoError(t, ctx.Err())
			assert.Equal(t, repository.ID, repositoryID)
			assert.Equal(t, BillingOwnerTypeUser, targetOwnerType)
			assert.Equal(t, int64(77), targetOwnerID)
			assert.True(t, privateRepository)
			assert.NotNil(t, commit)
			return pkgerrors.Forbidden("target storage quota exceeded")
		},
	}
	tx := &fakeOwnershipTx{
		q: q,
		getByIDFn: func(context.Context, int64) (db.Repository, error) {
			return repository, nil
		},
	}
	svc := NewRepoService(q, rh, "s1", WithRepoBillingPolicy(policy))
	svc.ownershipTx = &fakeOwnershipTxManager{tx: tx}

	_, err := transferToBobSerialized(context.Background(), svc, actor, repository)
	assert.Equal(t, 403, apiStatus(t, err))
	assert.True(t, tx.rolledBack)
	assert.False(t, tx.committed)
	assert.Equal(t, []string{"GetRepoByIDForUpdate"}, tx.calls)
	assert.Equal(t, 0, rh.stageMoveCalls)
}

func TestTransferRepo_Serialized_OwnershipChangedConflict(t *testing.T) {
	t.Parallel()

	actor := &db.User{ID: 1, Username: "actor"}
	repository := testRepo(nil)
	q := transferQuerierToUser(repository, false)
	rh := &mockRepoHostClient{}

	tx := &fakeOwnershipTx{
		q: q,
		getByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			// Simulate a concurrent transfer having already changed the owner.
			moved := repository
			moved.UserID = pgtype.Int8{Int64: 999, Valid: true}
			return moved, nil
		},
	}
	svc := NewRepoService(q, rh, "s1")
	svc.ownershipTx = &fakeOwnershipTxManager{tx: tx}

	_, err := transferToBobSerialized(context.Background(), svc, actor, repository)
	assert.Equal(t, 409, apiStatus(t, err))
	assert.False(t, tx.committed)
	assert.True(t, tx.rolledBack)
	// No mutation ran after the stale-ownership detection.
	assert.Equal(t, []string{"GetRepoByIDForUpdate"}, tx.calls)
	assert.Equal(t, 0, rh.moveRepoCalls)
	assert.False(t, q.transferToUserCalled)
}

func TestTransferRepo_Serialized_ConcurrentDeleteNotFound(t *testing.T) {
	t.Parallel()

	actor := &db.User{ID: 1, Username: "actor"}
	repository := testRepo(nil)
	q := transferQuerierToUser(repository, false)
	rh := &mockRepoHostClient{}

	tx := &fakeOwnershipTx{
		q: q,
		getByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			return db.Repository{}, pgx.ErrNoRows
		},
	}
	svc := NewRepoService(q, rh, "s1")
	svc.ownershipTx = &fakeOwnershipTxManager{tx: tx}

	_, err := transferToBobSerialized(context.Background(), svc, actor, repository)
	assert.Equal(t, 404, apiStatus(t, err))
	assert.True(t, tx.rolledBack)
	assert.Equal(t, 0, rh.moveRepoCalls)
}

func TestTransferRepo_Serialized_MoveFailureRollsBack(t *testing.T) {
	t.Parallel()

	actor := &db.User{ID: 1, Username: "actor"}
	repository := testRepo(nil)
	q := transferQuerierToUser(repository, false)
	rh := &mockRepoHostClient{
		moveRepoFn: func(_ context.Context, _, _, _, _ string) error {
			return fmt.Errorf("move failed")
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

	_, err := transferToBobSerialized(context.Background(), svc, actor, repository)
	assert.Equal(t, 500, apiStatus(t, err))
	assert.False(t, tx.committed)
	assert.True(t, tx.rolledBack)
	// The DB rollback restores grants and ownership; no compensating grant
	// re-inserts run outside the transaction.
	assert.Equal(t, 1, rh.moveRepoCalls)
	assert.Equal(t, 1, rh.rollbackMoveCalls)
}

func TestTransferRepo_Serialized_LostSuccessfulMoveResponseRollsStorageBack(t *testing.T) {
	t.Parallel()

	actor := &db.User{ID: 1, Username: "actor"}
	repository := testRepo(nil)
	q := transferQuerierToUser(repository, false)
	staged := repohost.StagedMove{
		BaseURL: "http://resolved-repo-host.test", Token: "client-owned-move-token",
		SrcOwner: "owner", SrcRepo: "demo", DstOwner: "bob", DstRepo: "demo",
	}
	var order []string
	rh := &mockRepoHostClient{
		stageMoveRepoFn: func(context.Context, string, string, string, string) (repohost.StagedMove, error) {
			order = append(order, "move-response-lost")
			return staged, fmt.Errorf("response lost after successful move")
		},
		rollbackMoveRepoFn: func(ctx context.Context, got repohost.StagedMove) error {
			require.NoError(t, ctx.Err())
			assert.Equal(t, staged, got)
			order = append(order, "move-rolled-back")
			return nil
		},
	}
	tx := &fakeOwnershipTx{
		q: q,
		getByIDFn: func(context.Context, int64) (db.Repository, error) {
			return repository, nil
		},
		commitFn: func(context.Context) error {
			t.Fatal("DB commit must not run after an ambiguous move response")
			return nil
		},
	}
	svc := NewRepoService(q, rh, "s1")
	svc.ownershipTx = &fakeOwnershipTxManager{tx: tx}

	_, err := transferToBobSerialized(context.Background(), svc, actor, repository)
	assert.Equal(t, 500, apiStatus(t, err))
	assert.Equal(t, []string{"move-response-lost", "move-rolled-back"}, order)
	assert.True(t, tx.rolledBack)
	assert.Equal(t, 1, rh.rollbackMoveCalls)
	assert.Equal(t, 0, rh.finalizeMoveCalls)
}

func TestTransferRepo_Serialized_CommitFailureMovesStorageBack(t *testing.T) {
	t.Parallel()

	actor := &db.User{ID: 1, Username: "actor"}
	repository := testRepo(nil)
	q := transferQuerierToUser(repository, false)
	q.getRepoByIDFn = func(_ context.Context, id int64) (db.Repository, error) {
		assert.Equal(t, repository.ID, id)
		return repository, nil
	}
	var moves [][4]string
	rh := &mockRepoHostClient{
		moveRepoFn: func(_ context.Context, srcOwner, srcRepo, dstOwner, dstRepo string) error {
			moves = append(moves, [4]string{srcOwner, srcRepo, dstOwner, dstRepo})
			return nil
		},
		rollbackMoveRepoFn: func(_ context.Context, staged repohost.StagedMove) error {
			moves = append(moves, [4]string{staged.DstOwner, staged.DstRepo, staged.SrcOwner, staged.SrcRepo})
			return nil
		},
	}

	tx := &fakeOwnershipTx{
		q: q,
		getByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			return repository, nil
		},
		commitErr: fmt.Errorf("commit failed"),
	}
	svc := NewRepoService(q, rh, "s1")
	svc.ownershipTx = &fakeOwnershipTxManager{tx: tx}

	_, err := transferToBobSerialized(context.Background(), svc, actor, repository)
	assert.Equal(t, 500, apiStatus(t, err))
	require.Len(t, moves, 2)
	assert.Equal(t, [4]string{"owner", "demo", "bob", "demo"}, moves[0])
	assert.Equal(t, [4]string{"bob", "demo", "owner", "demo"}, moves[1])
}

func TestTransferRepo_Serialized_AmbiguousCommitFinalizesWhenSourceRowIsGone(t *testing.T) {
	t.Parallel()

	actor := &db.User{ID: 1, Username: "actor"}
	repository := testRepo(nil)
	commitAttempted := false
	q := transferQuerierToUser(repository, false)
	q.transferRepoToUserFn = func(_ context.Context, arg db.TransferRepoToUserParams) (db.Repository, error) {
		return db.Repository{ID: arg.ID, UserID: arg.NewUserID, Name: repository.Name, LowerName: repository.LowerName}, nil
	}
	q.getRepoByIDFn = func(_ context.Context, id int64) (db.Repository, error) {
		assert.Equal(t, repository.ID, id)
		if commitAttempted {
			updated := repository
			updated.UserID = pgtype.Int8{Int64: 77, Valid: true}
			updated.OrgID = pgtype.Int8{}
			return updated, nil
		}
		return repository, nil
	}
	staged := repohost.StagedMove{
		BaseURL: "http://resolved-repo-host.test", Token: "client-owned-move-token",
		SrcOwner: "owner", SrcRepo: "demo", DstOwner: "bob", DstRepo: "demo",
	}
	var order []string
	rh := &mockRepoHostClient{
		stageMoveRepoFn: func(context.Context, string, string, string, string) (repohost.StagedMove, error) {
			order = append(order, "storage-moved")
			return staged, nil
		},
		rollbackMoveRepoFn: func(context.Context, repohost.StagedMove) error {
			t.Fatal("a durably committed transfer must not move storage back")
			return nil
		},
		finalizeMoveRepoFn: func(ctx context.Context, got repohost.StagedMove) error {
			require.NoError(t, ctx.Err())
			assert.Equal(t, staged, got)
			order = append(order, "move-finalized")
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
	txManager := &fakeOwnershipTxManager{tx: tx}
	svc.ownershipTx = txManager

	updated, err := transferToBobSerialized(context.Background(), svc, actor, repository)
	require.NoError(t, err)
	assert.Equal(t, int64(77), updated.UserID.Int64)
	assert.Equal(t, []string{"storage-moved", "commit-response-lost", "move-finalized"}, order)
	assert.Equal(t, 0, rh.rollbackMoveCalls)
	assert.Equal(t, 1, rh.finalizeMoveCalls)
	assert.Equal(t, 2, txManager.begun, "ambiguous COMMIT reconciliation must reacquire the repository ownership lock")
}

func TestTransferRepo_Serialized_AmbiguousCommitQueryErrorLeavesStageAtDestination(t *testing.T) {
	t.Parallel()

	actor := &db.User{ID: 1, Username: "actor"}
	repository := testRepo(nil)
	commitAttempted := false
	q := transferQuerierToUser(repository, false)
	q.transferRepoToUserFn = func(_ context.Context, arg db.TransferRepoToUserParams) (db.Repository, error) {
		return db.Repository{ID: arg.ID, UserID: arg.NewUserID, Name: repository.Name, LowerName: repository.LowerName}, nil
	}
	q.getRepoByIDFn = func(_ context.Context, id int64) (db.Repository, error) {
		assert.True(t, commitAttempted)
		assert.Equal(t, repository.ID, id)
		return db.Repository{}, fmt.Errorf("reconciliation database unavailable")
	}
	rh := &mockRepoHostClient{
		rollbackMoveRepoFn: func(context.Context, repohost.StagedMove) error {
			t.Fatal("an unknown commit outcome must not guess rollback")
			return nil
		},
		finalizeMoveRepoFn: func(context.Context, repohost.StagedMove) error {
			t.Fatal("an unknown commit outcome must not guess finalize")
			return nil
		},
	}
	tx := &fakeOwnershipTx{
		q: q,
		getByIDFn: func(context.Context, int64) (db.Repository, error) {
			return repository, nil
		},
		commitFn: func(context.Context) error {
			// Model COMMIT applying remotely while both its response and the
			// subsequent visibility query fail locally.
			commitAttempted = true
			return fmt.Errorf("connection lost after COMMIT")
		},
	}
	svc := NewRepoService(q, rh, "s1")
	svc.ownershipTx = &fakeOwnershipTxManager{tx: tx}

	_, err := transferToBobSerialized(context.Background(), svc, actor, repository)
	assert.Equal(t, 500, apiStatus(t, err))
	assert.Equal(t, 1, rh.stageMoveCalls)
	assert.Equal(t, 0, rh.rollbackMoveCalls)
	assert.Equal(t, 0, rh.finalizeMoveCalls)
}

func TestTransferRepo_Serialized_AmbiguousCommitMissingOrThirdOwnerLeavesStageAtDestination(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		visible   db.Repository
		lookupErr error
	}{
		{name: "repository missing", lookupErr: pgx.ErrNoRows},
		{
			name: "repository moved to third owner",
			visible: db.Repository{
				ID:        42,
				UserID:    pgtype.Int8{Int64: 999, Valid: true},
				Name:      "demo",
				LowerName: "demo",
			},
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			actor := &db.User{ID: 1, Username: "actor"}
			repository := testRepo(nil)
			q := transferQuerierToUser(repository, false)
			q.transferRepoToUserFn = func(_ context.Context, arg db.TransferRepoToUserParams) (db.Repository, error) {
				return db.Repository{ID: arg.ID, UserID: arg.NewUserID, Name: repository.Name, LowerName: repository.LowerName}, nil
			}
			q.getRepoByIDFn = func(_ context.Context, id int64) (db.Repository, error) {
				assert.Equal(t, repository.ID, id)
				return test.visible, test.lookupErr
			}
			rh := &mockRepoHostClient{
				rollbackMoveRepoFn: func(context.Context, repohost.StagedMove) error {
					t.Fatal("an unknown commit outcome must not guess rollback")
					return nil
				},
				finalizeMoveRepoFn: func(context.Context, repohost.StagedMove) error {
					t.Fatal("an unknown commit outcome must not guess finalize")
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

			_, err := transferToBobSerialized(context.Background(), svc, actor, repository)
			assert.Equal(t, 500, apiStatus(t, err))
			assert.Equal(t, 1, rh.stageMoveCalls)
			assert.Equal(t, 0, rh.rollbackMoveCalls)
			assert.Equal(t, 0, rh.finalizeMoveCalls)
		})
	}
}

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

func TestTransferRepo_Serialized_CancellationDuringMoveStillCommits(t *testing.T) {
	t.Parallel()

	requestCtx, cancelRequest := context.WithCancel(context.Background())
	actor := &db.User{ID: 1, Username: "actor"}
	repository := testRepo(nil)
	q := transferQuerierToUser(repository, false)
	q.transferRepoToUserFn = func(ctx context.Context, arg db.TransferRepoToUserParams) (db.Repository, error) {
		require.NoError(t, ctx.Err())
		return db.Repository{ID: arg.ID, UserID: arg.NewUserID, Name: repository.Name, LowerName: repository.LowerName}, nil
	}
	rh := &mockRepoHostClient{
		moveRepoFn: func(ctx context.Context, _, _, _, _ string) error {
			cancelRequest()
			require.ErrorIs(t, requestCtx.Err(), context.Canceled)
			require.NoError(t, ctx.Err())
			return nil
		},
	}
	tx := &fakeOwnershipTx{
		q: q,
		getByIDFn: func(_ context.Context, _ int64) (db.Repository, error) {
			return repository, nil
		},
		commitFn: func(ctx context.Context) error {
			require.NoError(t, ctx.Err())
			return nil
		},
	}
	svc := NewRepoService(q, rh, "s1")
	svc.ownershipTx = &fakeOwnershipTxManager{tx: tx}

	updated, err := transferToBobSerialized(requestCtx, svc, actor, repository)
	require.NoError(t, err)
	assert.Equal(t, int64(77), updated.UserID.Int64)
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
