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
)

type transferRequestReaderQuerier struct {
	*mockRepoQuerier
	getRequestFn func(context.Context, int64) (db.RepositoryTransferRequest, error)
	listFn       func(context.Context, int64) ([]db.RepositoryTransferRequest, error)
}

type canonicalTransferRequestReaderQuerier struct{ *transferRequestReaderQuerier }

func (*canonicalTransferRequestReaderQuerier) GetUserByID(context.Context, int64) (db.User, error) {
	return db.User{}, pgx.ErrNoRows
}

func (*canonicalTransferRequestReaderQuerier) GetOrgByID(context.Context, int64) (db.Organization, error) {
	return db.Organization{}, pgx.ErrNoRows
}

func (q *transferRequestReaderQuerier) GetRepositoryTransferRequest(ctx context.Context, id int64) (db.RepositoryTransferRequest, error) {
	if q.getRequestFn != nil {
		return q.getRequestFn(ctx, id)
	}
	return db.RepositoryTransferRequest{}, pgx.ErrNoRows
}

func (q *transferRequestReaderQuerier) ListRepositoryTransferRequests(ctx context.Context, recipientID int64) ([]db.RepositoryTransferRequest, error) {
	if q.listFn != nil {
		return q.listFn(ctx, recipientID)
	}
	return nil, nil
}

func testPendingUserTransfer(repository db.Repository) db.RepositoryTransferRequest {
	return db.RepositoryTransferRequest{
		ID: 9, RepositoryID: repository.ID, SenderID: repository.UserID.Int64, RecipientID: 77,
		SourceUserID: repository.UserID, SourceOrgID: repository.OrgID,
		SourceOwner: "owner", SourceName: repository.Name, Status: "pending",
	}
}

func TestRepoTransferRequest_RepeatedRequestReturnsSamePendingRecord(t *testing.T) {
	t.Parallel()
	repository := testRepo(nil)
	request := testPendingUserTransfer(repository)
	for _, tc := range []struct {
		name      string
		request   db.RepositoryTransferRequest
		wantError int
	}{
		{name: "same sender and recipient", request: request},
		{name: "different recipient already pending", request: func() db.RepositoryTransferRequest {
			other := request
			other.RecipientID = 88
			return other
		}(), wantError: 409},
		{name: "different sender already pending", request: func() db.RepositoryTransferRequest {
			other := request
			other.SenderID = 88
			return other
		}(), wantError: 409},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			q := transferQuerierToUser(repository, false)
			tx := &fakeOwnershipTx{
				q:         q,
				getByIDFn: func(context.Context, int64) (db.Repository, error) { return repository, nil },
				getPendingTransferRequestFn: func(_ context.Context, id int64) (db.RepositoryTransferRequest, error) {
					assert.Equal(t, repository.ID, id)
					return tc.request, nil
				},
				createTransferRequestFn: func(context.Context, db.CreateRepositoryTransferRequestParams) (db.RepositoryTransferRequest, error) {
					t.Fatal("a second request must not be created")
					return db.RepositoryTransferRequest{}, nil
				},
			}
			host := &mockRepoHostClient{}
			svc := NewRepoService(q, host, "s1")
			svc.ownershipTx = &fakeOwnershipTxManager{tx: tx}
			result, err := svc.TransferRepo(context.Background(), &db.User{ID: repository.UserID.Int64}, "owner", repository.Name, "bob")
			if tc.wantError != 0 {
				assert.Equal(t, tc.wantError, apiStatus(t, err))
				assert.False(t, tx.committed)
				assert.True(t, tx.rolledBack)
			} else {
				require.NoError(t, err)
				require.NotNil(t, result.PendingTransfer)
				assert.Equal(t, request.ID, result.PendingTransfer.ID)
				assert.Equal(t, repository, result.Repository)
				assert.True(t, tx.committed)
			}
			assert.Zero(t, host.moveRepoCalls)
		})
	}
}

func TestRepoTransferRequest_ExpiryIsCommittedWithoutMovingRepo(t *testing.T) {
	t.Parallel()
	repository := testRepo(nil)
	request := testPendingUserTransfer(repository)
	q := &transferRequestReaderQuerier{mockRepoQuerier: transferQuerierToUser(repository, false)}
	q.getRequestFn = func(_ context.Context, id int64) (db.RepositoryTransferRequest, error) {
		assert.Equal(t, request.ID, id)
		return request, nil
	}
	tx := &fakeOwnershipTx{q: q.mockRepoQuerier, getByIDFn: func(context.Context, int64) (db.Repository, error) { return repository, nil }}
	tx.expireTransferRequestsFn = func(_ context.Context, repositoryID int64) error {
		assert.Equal(t, repository.ID, repositoryID)
		request.Status = "expired"
		return nil
	}
	tx.getTransferRequestFn = func(context.Context, int64) (db.RepositoryTransferRequest, error) { return request, nil }
	host := &mockRepoHostClient{}
	svc := NewRepoService(q, host, "s1")
	svc.ownershipTx = &fakeOwnershipTxManager{tx: tx}

	err := svc.DeclineRepoTransfer(context.Background(), &db.User{ID: request.RecipientID}, request.ID)
	assert.Equal(t, 409, apiStatus(t, err))
	assert.Equal(t, "expired", request.Status)
	assert.True(t, tx.committed, "expiry must persist even when decline loses the race")
	assert.Zero(t, host.moveRepoCalls)
	assert.False(t, q.transferToUserCalled)
}

func TestRepoTransferRequest_AcceptRejectsWrongRecipientOrChangedSource(t *testing.T) {
	t.Parallel()
	repository := testRepo(nil)
	for _, tc := range []struct {
		name       string
		actorID    int64
		change     func(*db.RepositoryTransferRequest)
		wantStatus int
		wantTx     bool
	}{
		{name: "wrong recipient", actorID: 88, wantStatus: 404},
		{name: "source owner changed", actorID: 77, change: func(r *db.RepositoryTransferRequest) {
			r.SourceUserID = pgtype.Int8{Int64: 22, Valid: true}
		}, wantStatus: 409, wantTx: true},
		{name: "sender no longer owns source", actorID: 77, change: func(r *db.RepositoryTransferRequest) {
			r.SenderID = 22
		}, wantStatus: 403, wantTx: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			request := testPendingUserTransfer(repository)
			if tc.change != nil {
				tc.change(&request)
			}
			base := transferQuerierToUser(repository, false)
			base.getRepoByIDFn = func(context.Context, int64) (db.Repository, error) { return repository, nil }
			q := &transferRequestReaderQuerier{mockRepoQuerier: base}
			q.getRequestFn = func(context.Context, int64) (db.RepositoryTransferRequest, error) { return request, nil }
			tx := &fakeOwnershipTx{q: base, getByIDFn: func(context.Context, int64) (db.Repository, error) { return repository, nil }}
			tx.getTransferRequestFn = func(context.Context, int64) (db.RepositoryTransferRequest, error) { return request, nil }
			host := &mockRepoHostClient{}
			svc := NewRepoService(q, host, "s1")
			manager := &fakeOwnershipTxManager{tx: tx}
			svc.ownershipTx = manager

			_, err := svc.AcceptRepoTransfer(context.Background(), &db.User{ID: tc.actorID, Username: "bob"}, request.ID)
			assert.Equal(t, tc.wantStatus, apiStatus(t, err))
			if tc.wantTx {
				assert.Equal(t, 1, manager.begun)
				assert.True(t, tx.rolledBack)
			} else {
				assert.Zero(t, manager.begun)
			}
			assert.False(t, tx.committed)
			assert.Zero(t, host.moveRepoCalls)
			assert.Zero(t, host.stageMoveCalls)
			assert.False(t, base.transferToUserCalled)
		})
	}
}

func TestRepoTransferRequest_QueryAndCommitFailuresLeaveOwnershipUntouched(t *testing.T) {
	t.Parallel()
	repository := testRepo(nil)
	for _, tc := range []struct {
		name string
		set  func(*fakeOwnershipTx)
	}{
		{name: "pending lookup fails", set: func(tx *fakeOwnershipTx) {
			tx.getPendingTransferRequestFn = func(context.Context, int64) (db.RepositoryTransferRequest, error) {
				return db.RepositoryTransferRequest{}, fmt.Errorf("database unavailable")
			}
		}},
		{name: "commit fails", set: func(tx *fakeOwnershipTx) {
			tx.commitErr = fmt.Errorf("commit failed")
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			q := transferQuerierToUser(repository, false)
			tx := &fakeOwnershipTx{q: q, getByIDFn: func(context.Context, int64) (db.Repository, error) { return repository, nil }}
			tc.set(tx)
			host := &mockRepoHostClient{}
			svc := NewRepoService(q, host, "s1")
			svc.ownershipTx = &fakeOwnershipTxManager{tx: tx}

			_, err := svc.TransferRepo(context.Background(), &db.User{ID: repository.UserID.Int64}, "owner", repository.Name, "bob")
			assert.Equal(t, 500, apiStatus(t, err))
			assert.False(t, tx.committed)
			assert.True(t, tx.rolledBack)
			assert.Zero(t, host.moveRepoCalls)
			assert.False(t, q.transferToUserCalled)
		})
	}
}

func TestRepoTransferRequest_AcceptMovesOnlyAfterConsent(t *testing.T) {
	t.Parallel()
	repository := testRepo(nil)
	request := testPendingUserTransfer(repository)
	base := transferQuerierToUser(repository, false)
	base.getRepoByIDFn = func(context.Context, int64) (db.Repository, error) { return repository, nil }
	base.transferRepoToUserFn = func(_ context.Context, arg db.TransferRepoToUserParams) (db.Repository, error) {
		assert.Equal(t, request.RecipientID, arg.NewUserID.Int64)
		updated := repository
		updated.UserID = arg.NewUserID
		return updated, nil
	}
	q := &transferRequestReaderQuerier{mockRepoQuerier: base}
	q.getRequestFn = func(context.Context, int64) (db.RepositoryTransferRequest, error) { return request, nil }
	tx := &fakeOwnershipTx{q: base, getByIDFn: func(context.Context, int64) (db.Repository, error) { return repository, nil }}
	tx.getTransferRequestFn = func(context.Context, int64) (db.RepositoryTransferRequest, error) { return request, nil }
	tx.resolveTransferRequestFn = func(_ context.Context, arg db.ResolveRepositoryTransferRequestParams) (db.RepositoryTransferRequest, error) {
		assert.Equal(t, request.ID, arg.ID)
		assert.Equal(t, "accepted", arg.Status)
		request.Status = arg.Status
		return request, nil
	}
	host := &mockRepoHostClient{}
	svc := NewRepoService(q, host, "s1")
	svc.ownershipTx = &fakeOwnershipTxManager{tx: tx}

	updated, err := svc.AcceptRepoTransfer(context.Background(), &db.User{ID: request.RecipientID, Username: "bob"}, request.ID)
	require.NoError(t, err)
	assert.Equal(t, request.RecipientID, updated.UserID.Int64)
	assert.Equal(t, "accepted", request.Status)
	assert.True(t, tx.committed)
	assert.Equal(t, []string{
		"GetRepoByIDForUpdate", "ExpireRepositoryTransferRequests", "GetRepositoryTransferRequest",
		"ResolveRepositoryTransferRequest", "DeleteCollaboratorsByRepo", "DeleteTeamReposByRepo",
		"TransferRepoToUser", "Commit",
	}, tx.calls)
	assert.Equal(t, 1, host.moveRepoCalls)
}

func TestRepoTransferRequest_DeclineAndCancelRequireTheRightActor(t *testing.T) {
	t.Parallel()
	repository := testRepo(nil)
	for _, tc := range []struct {
		name   string
		status string
		actor  int64
		want   int
	}{
		{name: "recipient declines", status: "declined", actor: 77},
		{name: "sender cancels", status: "cancelled", actor: repository.UserID.Int64},
		{name: "sender cannot decline", status: "declined", actor: repository.UserID.Int64, want: 404},
		{name: "recipient cannot cancel", status: "cancelled", actor: 77, want: 404},
		{name: "unrelated actor cannot decline", status: "declined", actor: 88, want: 404},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			request := testPendingUserTransfer(repository)
			base := transferQuerierToUser(repository, false)
			base.getRepoByIDFn = func(context.Context, int64) (db.Repository, error) { return repository, nil }
			q := &transferRequestReaderQuerier{mockRepoQuerier: base}
			q.getRequestFn = func(context.Context, int64) (db.RepositoryTransferRequest, error) { return request, nil }
			tx := &fakeOwnershipTx{q: base, getByIDFn: func(context.Context, int64) (db.Repository, error) { return repository, nil }}
			tx.getTransferRequestFn = func(context.Context, int64) (db.RepositoryTransferRequest, error) { return request, nil }
			tx.resolveTransferRequestFn = func(_ context.Context, arg db.ResolveRepositoryTransferRequestParams) (db.RepositoryTransferRequest, error) {
				assert.Equal(t, tc.status, arg.Status)
				request.Status = arg.Status
				return request, nil
			}
			host := &mockRepoHostClient{}
			svc := NewRepoService(q, host, "s1")
			manager := &fakeOwnershipTxManager{tx: tx}
			svc.ownershipTx = manager
			actor := &db.User{ID: tc.actor}
			var err error
			if tc.status == "declined" {
				err = svc.DeclineRepoTransfer(context.Background(), actor, request.ID)
			} else {
				err = svc.CancelRepoTransfer(context.Background(), actor, request.ID)
			}
			if tc.want != 0 {
				assert.Equal(t, tc.want, apiStatus(t, err))
				assert.Equal(t, "pending", request.Status)
				assert.Zero(t, manager.begun)
			} else {
				require.NoError(t, err)
				assert.Equal(t, tc.status, request.Status)
				assert.True(t, tx.committed)
			}
			assert.False(t, base.transferToUserCalled)
			assert.Zero(t, host.moveRepoCalls)
		})
	}
}

func TestRepoTransferRequest_CancelledContextStillRollsBack(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(context.Background())
	repository := testRepo(nil)
	q := transferQuerierToUser(repository, false)
	tx := &fakeOwnershipTx{q: q}
	tx.getByIDFn = func(context.Context, int64) (db.Repository, error) {
		cancel()
		return db.Repository{}, fmt.Errorf("database request interrupted")
	}
	cleanedUp := false
	tx.rollbackFn = func(rollbackCtx context.Context) error {
		assert.NoError(t, rollbackCtx.Err())
		cleanedUp = true
		return nil
	}
	svc := NewRepoService(q, &mockRepoHostClient{}, "s1")
	svc.ownershipTx = &fakeOwnershipTxManager{tx: tx}
	_, err := svc.TransferRepo(ctx, &db.User{ID: repository.UserID.Int64}, "owner", repository.Name, "bob")
	assert.Equal(t, 500, apiStatus(t, err))
	assert.True(t, cleanedUp)
	assert.True(t, tx.rolledBack)
	assert.False(t, tx.committed)
	assert.False(t, q.transferToUserCalled)
}

func TestRepoTransferRequest_CurrentOrganizationOwnerCanCancel(t *testing.T) {
	t.Parallel()
	repository := testRepo(func(r *db.Repository) {
		r.UserID = pgtype.Int8{}
		r.OrgID = pgtype.Int8{Int64: 7, Valid: true}
	})
	request := db.RepositoryTransferRequest{
		ID: 9, RepositoryID: repository.ID, SenderID: 1, RecipientID: 77,
		SourceOrgID: repository.OrgID, SourceOwner: "acme", SourceName: repository.Name, Status: "pending",
	}
	base := &mockRepoQuerier{isOrgOwnerForRepoUserFn: func(_ context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
		assert.Equal(t, repository.ID, arg.RepositoryID)
		return arg.UserID == 5, nil
	}}
	base.getRepoByIDFn = func(context.Context, int64) (db.Repository, error) { return repository, nil }
	q := &transferRequestReaderQuerier{mockRepoQuerier: base}
	q.getRequestFn = func(context.Context, int64) (db.RepositoryTransferRequest, error) { return request, nil }
	tx := &fakeOwnershipTx{q: base, getByIDFn: func(context.Context, int64) (db.Repository, error) { return repository, nil }}
	tx.getTransferRequestFn = func(context.Context, int64) (db.RepositoryTransferRequest, error) { return request, nil }
	tx.resolveTransferRequestFn = func(_ context.Context, arg db.ResolveRepositoryTransferRequestParams) (db.RepositoryTransferRequest, error) {
		assert.Equal(t, "cancelled", arg.Status)
		request.Status = arg.Status
		return request, nil
	}
	svc := NewRepoService(q, &mockRepoHostClient{}, "s1")
	svc.ownershipTx = &fakeOwnershipTxManager{tx: tx}

	require.NoError(t, svc.CancelRepoTransfer(context.Background(), &db.User{ID: 5}, request.ID))
	assert.Equal(t, "cancelled", request.Status)
	assert.True(t, tx.committed)
	assert.False(t, base.transferToUserCalled)
}

func TestRepoTransferRequest_ListRequiresAuthAndReportsReaderFailures(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	actor := &db.User{ID: 77}
	_, err := NewRepoService(&mockRepoQuerier{}, &mockRepoHostClient{}, "s1").ListRepoTransfers(ctx, nil)
	assert.Equal(t, 401, apiStatus(t, err))
	_, err = NewRepoService(&mockRepoQuerier{}, &mockRepoHostClient{}, "s1").ListRepoTransfers(ctx, actor)
	assert.Equal(t, 500, apiStatus(t, err))
	q := &transferRequestReaderQuerier{mockRepoQuerier: &mockRepoQuerier{}}
	q.listFn = func(_ context.Context, recipientID int64) ([]db.RepositoryTransferRequest, error) {
		assert.Equal(t, actor.ID, recipientID)
		return nil, fmt.Errorf("database unavailable")
	}
	svc := NewRepoService(q, &mockRepoHostClient{}, "s1")
	_, err = svc.ListRepoTransfers(ctx, actor)
	assert.Equal(t, 500, apiStatus(t, err))
	q.listFn = func(_ context.Context, recipientID int64) ([]db.RepositoryTransferRequest, error) {
		assert.Equal(t, actor.ID, recipientID)
		return []db.RepositoryTransferRequest{{ID: 9, RecipientID: actor.ID, Status: "pending"}}, nil
	}
	requests, err := svc.ListRepoTransfers(ctx, actor)
	require.NoError(t, err)
	require.Len(t, requests, 1)
	assert.Equal(t, int64(9), requests[0].ID)
}

type ownershipOnlyTransferTx struct{ repoOwnershipTx }

func TestRepoTransferRequest_UnsupportedTransactionalQuerySurfaceFailsClosed(t *testing.T) {
	t.Parallel()
	repository := testRepo(nil)
	base := transferQuerierToUser(repository, false)
	inner := &fakeOwnershipTx{q: base, getByIDFn: func(context.Context, int64) (db.Repository, error) { return repository, nil }}
	svc := NewRepoService(base, &mockRepoHostClient{}, "s1")
	svc.ownershipTx = &fakeOwnershipTxManager{tx: ownershipOnlyTransferTx{repoOwnershipTx: inner}}
	_, err := svc.TransferRepo(context.Background(), &db.User{ID: repository.UserID.Int64}, "owner", repository.Name, "bob")
	assert.Equal(t, 500, apiStatus(t, err))
	assert.True(t, inner.rolledBack)
	assert.False(t, inner.committed)
	assert.False(t, base.transferToUserCalled)
}

func TestRepoTransferRequest_AcceptEarlyBoundaryFailuresDoNotMoveRepo(t *testing.T) {
	t.Parallel()
	repository := testRepo(nil)
	for _, tc := range []struct {
		name       string
		configure  func(*transferRequestReaderQuerier, *db.RepositoryTransferRequest)
		withoutTx  bool
		wantStatus int
	}{
		{name: "unauthenticated", configure: nil, wantStatus: 401},
		{name: "request missing", configure: func(q *transferRequestReaderQuerier, _ *db.RepositoryTransferRequest) {
			q.getRequestFn = func(context.Context, int64) (db.RepositoryTransferRequest, error) {
				return db.RepositoryTransferRequest{}, pgx.ErrNoRows
			}
		}, wantStatus: 404},
		{name: "request lookup failure", configure: func(q *transferRequestReaderQuerier, _ *db.RepositoryTransferRequest) {
			q.getRequestFn = func(context.Context, int64) (db.RepositoryTransferRequest, error) {
				return db.RepositoryTransferRequest{}, fmt.Errorf("database unavailable")
			}
		}, wantStatus: 500},
		{name: "already declined", configure: func(_ *transferRequestReaderQuerier, request *db.RepositoryTransferRequest) {
			request.Status = "declined"
		}, wantStatus: 409},
		{name: "transaction unavailable", withoutTx: true, wantStatus: 500},
		{name: "repository missing", configure: func(q *transferRequestReaderQuerier, _ *db.RepositoryTransferRequest) {
			q.getRepoByIDFn = func(context.Context, int64) (db.Repository, error) { return db.Repository{}, pgx.ErrNoRows }
		}, wantStatus: 404},
		{name: "repository lookup failure", configure: func(q *transferRequestReaderQuerier, _ *db.RepositoryTransferRequest) {
			q.getRepoByIDFn = func(context.Context, int64) (db.Repository, error) {
				return db.Repository{}, fmt.Errorf("database unavailable")
			}
		}, wantStatus: 500},
		{name: "recipient name conflict", configure: func(q *transferRequestReaderQuerier, _ *db.RepositoryTransferRequest) {
			q.getRepoByOwnerAndLowerNameFn = func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repository, nil
			}
		}, wantStatus: 409},
		{name: "recipient lookup failure", configure: func(q *transferRequestReaderQuerier, _ *db.RepositoryTransferRequest) {
			q.getRepoByOwnerAndLowerNameFn = func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return db.Repository{}, fmt.Errorf("database unavailable")
			}
		}, wantStatus: 500},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			request := testPendingUserTransfer(repository)
			base := transferQuerierToUser(repository, false)
			base.getRepoByIDFn = func(context.Context, int64) (db.Repository, error) { return repository, nil }
			q := &transferRequestReaderQuerier{mockRepoQuerier: base}
			q.getRequestFn = func(context.Context, int64) (db.RepositoryTransferRequest, error) { return request, nil }
			if tc.configure != nil {
				tc.configure(q, &request)
			}
			host := &mockRepoHostClient{}
			svc := NewRepoService(q, host, "s1")
			manager := &fakeOwnershipTxManager{tx: &fakeOwnershipTx{q: base, getByIDFn: func(context.Context, int64) (db.Repository, error) { return repository, nil }}}
			if !tc.withoutTx {
				svc.ownershipTx = manager
			}
			var actor *db.User
			if tc.name != "unauthenticated" {
				actor = &db.User{ID: request.RecipientID, Username: "bob"}
			}
			_, err := svc.AcceptRepoTransfer(context.Background(), actor, request.ID)
			assert.Equal(t, tc.wantStatus, apiStatus(t, err))
			assert.Zero(t, manager.begun)
			assert.Zero(t, host.moveRepoCalls)
			assert.False(t, base.transferToUserCalled)
		})
	}
}

func TestRepoTransferRequest_RecipientBillingDenialRollsBackConsent(t *testing.T) {
	t.Parallel()
	repository := testRepo(nil)
	repository.IsPublic = false
	request := testPendingUserTransfer(repository)
	base := transferQuerierToUser(repository, false)
	base.getRepoByIDFn = func(context.Context, int64) (db.Repository, error) { return repository, nil }
	q := &transferRequestReaderQuerier{mockRepoQuerier: base}
	q.getRequestFn = func(context.Context, int64) (db.RepositoryTransferRequest, error) { return request, nil }
	tx := &fakeOwnershipTx{q: base, getByIDFn: func(context.Context, int64) (db.Repository, error) { return repository, nil }}
	tx.getTransferRequestFn = func(context.Context, int64) (db.RepositoryTransferRequest, error) { return request, nil }
	tx.resolveTransferRequestFn = func(_ context.Context, arg db.ResolveRepositoryTransferRequestParams) (db.RepositoryTransferRequest, error) {
		assert.Equal(t, "accepted", arg.Status)
		return request, nil // the fake transaction has not committed this update
	}
	billing := &stubBillingPolicy{authorizePrivateRepoFn: func(_ context.Context, ownerType string, ownerID int64) error {
		assert.Equal(t, BillingOwnerTypeUser, ownerType)
		assert.Equal(t, request.RecipientID, ownerID)
		return fmt.Errorf("recipient billing denied")
	}}
	host := &mockRepoHostClient{}
	svc := NewRepoService(q, host, "s1", WithRepoBillingPolicy(billing))
	svc.ownershipTx = &fakeOwnershipTxManager{tx: tx}
	_, err := svc.AcceptRepoTransfer(context.Background(), &db.User{ID: request.RecipientID, Username: "bob"}, request.ID)
	require.Error(t, err)
	assert.Equal(t, "pending", request.Status)
	assert.True(t, tx.rolledBack)
	assert.False(t, tx.committed)
	assert.Zero(t, host.moveRepoCalls)
	assert.False(t, base.transferToUserCalled)
}

func TestRepoTransferRequest_ExpiryCommitFailureNeverMovesRepo(t *testing.T) {
	t.Parallel()
	repository := testRepo(nil)
	request := testPendingUserTransfer(repository)
	base := transferQuerierToUser(repository, false)
	base.getRepoByIDFn = func(context.Context, int64) (db.Repository, error) { return repository, nil }
	q := &transferRequestReaderQuerier{mockRepoQuerier: base}
	q.getRequestFn = func(context.Context, int64) (db.RepositoryTransferRequest, error) { return request, nil }
	tx := &fakeOwnershipTx{q: base, getByIDFn: func(context.Context, int64) (db.Repository, error) { return repository, nil }, commitErr: fmt.Errorf("commit failed")}
	tx.expireTransferRequestsFn = func(context.Context, int64) error { request.Status = "expired"; return nil }
	tx.getTransferRequestFn = func(context.Context, int64) (db.RepositoryTransferRequest, error) { return request, nil }
	host := &mockRepoHostClient{}
	svc := NewRepoService(q, host, "s1")
	svc.ownershipTx = &fakeOwnershipTxManager{tx: tx}
	err := svc.DeclineRepoTransfer(context.Background(), &db.User{ID: request.RecipientID}, request.ID)
	assert.Equal(t, 500, apiStatus(t, err))
	assert.True(t, tx.rolledBack)
	assert.False(t, tx.committed)
	assert.Zero(t, host.moveRepoCalls)
	assert.False(t, base.transferToUserCalled)
}

func TestRepoTransferRequest_CreateLockedFaultsLeaveRepositoryUntouched(t *testing.T) {
	t.Parallel()
	repository := testRepo(nil)
	for _, tc := range []struct {
		name       string
		configure  func(*fakeOwnershipTx, *fakeOwnershipTxManager)
		wantStatus int
		beganTx    bool
	}{
		{name: "transaction begin fails", wantStatus: 500, configure: func(_ *fakeOwnershipTx, manager *fakeOwnershipTxManager) {
			manager.beginErr = fmt.Errorf("begin failed")
		}},
		{name: "repository deleted before lock", wantStatus: 404, beganTx: true, configure: func(tx *fakeOwnershipTx, _ *fakeOwnershipTxManager) {
			tx.getByIDFn = func(context.Context, int64) (db.Repository, error) { return db.Repository{}, pgx.ErrNoRows }
		}},
		{name: "repository changed before lock", wantStatus: 409, beganTx: true, configure: func(tx *fakeOwnershipTx, _ *fakeOwnershipTxManager) {
			tx.getByIDFn = func(context.Context, int64) (db.Repository, error) {
				changed := repository
				changed.UserID = pgtype.Int8{Int64: 88, Valid: true}
				return changed, nil
			}
		}},
		{name: "expiration query fails", wantStatus: 500, beganTx: true, configure: func(tx *fakeOwnershipTx, _ *fakeOwnershipTxManager) {
			tx.expireTransferRequestsFn = func(context.Context, int64) error { return fmt.Errorf("expiration failed") }
		}},
		{name: "request insert fails", wantStatus: 500, beganTx: true, configure: func(tx *fakeOwnershipTx, _ *fakeOwnershipTxManager) {
			tx.createTransferRequestFn = func(context.Context, db.CreateRepositoryTransferRequestParams) (db.RepositoryTransferRequest, error) {
				return db.RepositoryTransferRequest{}, fmt.Errorf("insert failed")
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			base := transferQuerierToUser(repository, false)
			tx := &fakeOwnershipTx{q: base, getByIDFn: func(context.Context, int64) (db.Repository, error) { return repository, nil }}
			manager := &fakeOwnershipTxManager{tx: tx}
			tc.configure(tx, manager)
			host := &mockRepoHostClient{}
			svc := NewRepoService(base, host, "s1")
			svc.ownershipTx = manager
			_, err := svc.TransferRepo(context.Background(), &db.User{ID: repository.UserID.Int64}, "owner", repository.Name, "bob")
			assert.Equal(t, tc.wantStatus, apiStatus(t, err))
			assert.False(t, tx.committed)
			assert.Equal(t, tc.beganTx, tx.rolledBack)
			assert.Zero(t, host.moveRepoCalls)
			assert.False(t, base.transferToUserCalled)
		})
	}
}

func TestRepoTransferRequest_OrgOwnerRevokedUnderLock(t *testing.T) {
	t.Parallel()
	repository := testRepo(func(r *db.Repository) {
		r.UserID = pgtype.Int8{}
		r.OrgID = pgtype.Int8{Int64: 7, Valid: true}
	})
	for _, tc := range []struct {
		name       string
		secondErr  error
		wantStatus int
	}{
		{name: "owner role revoked", wantStatus: 403},
		{name: "membership query fails", secondErr: fmt.Errorf("database unavailable"), wantStatus: 500},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			base := transferQuerierToUser(repository, true)
			checks := 0
			base.isOrgOwnerForRepoUserFn = func(context.Context, db.IsOrgOwnerForRepoUserParams) (bool, error) {
				checks++
				if checks == 1 {
					return true, nil // request passes the initial authorization
				}
				return false, tc.secondErr
			}
			tx := &fakeOwnershipTx{q: base, getByIDFn: func(context.Context, int64) (db.Repository, error) { return repository, nil }}
			host := &mockRepoHostClient{}
			svc := NewRepoService(base, host, "s1")
			svc.ownershipTx = &fakeOwnershipTxManager{tx: tx}
			_, err := svc.TransferRepo(context.Background(), &db.User{ID: 1}, "owner", repository.Name, "bob")
			assert.Equal(t, tc.wantStatus, apiStatus(t, err))
			assert.Equal(t, 2, checks)
			assert.True(t, tx.rolledBack)
			assert.False(t, tx.committed)
			assert.Zero(t, host.moveRepoCalls)
			assert.False(t, base.transferToUserCalled)
		})
	}
}

func TestRepoTransferRequest_DeclineLockedFaultsKeepPending(t *testing.T) {
	t.Parallel()
	repository := testRepo(nil)
	for _, tc := range []struct {
		name       string
		configure  func(*fakeOwnershipTx, *fakeOwnershipTxManager)
		wantStatus int
		beganTx    bool
	}{
		{name: "no transaction", wantStatus: 500},
		{name: "begin fails", wantStatus: 500, configure: func(_ *fakeOwnershipTx, m *fakeOwnershipTxManager) { m.beginErr = fmt.Errorf("begin failed") }},
		{name: "repository missing", wantStatus: 404, beganTx: true, configure: func(tx *fakeOwnershipTx, _ *fakeOwnershipTxManager) {
			tx.getByIDFn = func(context.Context, int64) (db.Repository, error) { return db.Repository{}, pgx.ErrNoRows }
		}},
		{name: "repository query fails", wantStatus: 500, beganTx: true, configure: func(tx *fakeOwnershipTx, _ *fakeOwnershipTxManager) {
			tx.getByIDFn = func(context.Context, int64) (db.Repository, error) {
				return db.Repository{}, fmt.Errorf("database unavailable")
			}
		}},
		{name: "transaction lacks request queries", wantStatus: 500, beganTx: true, configure: func(_ *fakeOwnershipTx, manager *fakeOwnershipTxManager) {
			manager.tx = ownershipOnlyTransferTx{repoOwnershipTx: manager.tx}
		}},
		{name: "expiration query fails", wantStatus: 500, beganTx: true, configure: func(tx *fakeOwnershipTx, _ *fakeOwnershipTxManager) {
			tx.expireTransferRequestsFn = func(context.Context, int64) error { return fmt.Errorf("expiration failed") }
		}},
		{name: "locked request missing", wantStatus: 404, beganTx: true, configure: func(tx *fakeOwnershipTx, _ *fakeOwnershipTxManager) {
			tx.getTransferRequestFn = func(context.Context, int64) (db.RepositoryTransferRequest, error) {
				return db.RepositoryTransferRequest{}, pgx.ErrNoRows
			}
		}},
		{name: "locked request query fails", wantStatus: 500, beganTx: true, configure: func(tx *fakeOwnershipTx, _ *fakeOwnershipTxManager) {
			tx.getTransferRequestFn = func(context.Context, int64) (db.RepositoryTransferRequest, error) {
				return db.RepositoryTransferRequest{}, fmt.Errorf("database unavailable")
			}
		}},
		{name: "resolve lost race", wantStatus: 409, beganTx: true, configure: func(tx *fakeOwnershipTx, _ *fakeOwnershipTxManager) {
			tx.resolveTransferRequestFn = func(context.Context, db.ResolveRepositoryTransferRequestParams) (db.RepositoryTransferRequest, error) {
				return db.RepositoryTransferRequest{}, pgx.ErrNoRows
			}
		}},
		{name: "resolve query fails", wantStatus: 500, beganTx: true, configure: func(tx *fakeOwnershipTx, _ *fakeOwnershipTxManager) {
			tx.resolveTransferRequestFn = func(context.Context, db.ResolveRepositoryTransferRequestParams) (db.RepositoryTransferRequest, error) {
				return db.RepositoryTransferRequest{}, fmt.Errorf("update failed")
			}
		}},
		{name: "commit fails", wantStatus: 500, beganTx: true, configure: func(tx *fakeOwnershipTx, _ *fakeOwnershipTxManager) {
			tx.resolveTransferRequestFn = func(context.Context, db.ResolveRepositoryTransferRequestParams) (db.RepositoryTransferRequest, error) {
				return db.RepositoryTransferRequest{Status: "declined"}, nil
			}
			tx.commitErr = fmt.Errorf("commit failed")
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			request := testPendingUserTransfer(repository)
			base := transferQuerierToUser(repository, false)
			q := &transferRequestReaderQuerier{mockRepoQuerier: base}
			q.getRequestFn = func(context.Context, int64) (db.RepositoryTransferRequest, error) { return request, nil }
			tx := &fakeOwnershipTx{q: base, getByIDFn: func(context.Context, int64) (db.Repository, error) { return repository, nil }}
			tx.getTransferRequestFn = func(context.Context, int64) (db.RepositoryTransferRequest, error) { return request, nil }
			manager := &fakeOwnershipTxManager{tx: tx}
			if tc.configure != nil {
				tc.configure(tx, manager)
			}
			host := &mockRepoHostClient{}
			svc := NewRepoService(q, host, "s1")
			if tc.name != "no transaction" {
				svc.ownershipTx = manager
			}
			err := svc.DeclineRepoTransfer(context.Background(), &db.User{ID: request.RecipientID}, request.ID)
			assert.Equal(t, tc.wantStatus, apiStatus(t, err))
			assert.Equal(t, "pending", request.Status)
			assert.False(t, tx.committed)
			assert.Equal(t, tc.beganTx, tx.rolledBack)
			assert.Zero(t, host.moveRepoCalls)
			assert.False(t, base.transferToUserCalled)
		})
	}
}

func TestRepoTransferRequest_ReaderAndCanonicalOwnerErrorsDoNotStartMove(t *testing.T) {
	t.Parallel()
	repository := testRepo(nil)
	request := testPendingUserTransfer(repository)
	actor := &db.User{ID: request.RecipientID, Username: "bob"}

	withoutReader := NewRepoService(transferQuerierToUser(repository, false), &mockRepoHostClient{}, "s1")
	_, err := withoutReader.AcceptRepoTransfer(context.Background(), actor, request.ID)
	assert.Equal(t, 500, apiStatus(t, err))

	base := transferQuerierToUser(repository, false)
	base.getRepoByIDFn = func(context.Context, int64) (db.Repository, error) { return repository, nil }
	reader := &transferRequestReaderQuerier{mockRepoQuerier: base}
	reader.getRequestFn = func(context.Context, int64) (db.RepositoryTransferRequest, error) { return request, nil }
	canonicalReader := &canonicalTransferRequestReaderQuerier{transferRequestReaderQuerier: reader}
	host := &mockRepoHostClient{}
	svc := NewRepoService(canonicalReader, host, "s1")
	svc.ownershipTx = &fakeOwnershipTxManager{tx: &fakeOwnershipTx{q: base, getByIDFn: func(context.Context, int64) (db.Repository, error) { return repository, nil }}}
	_, err = svc.AcceptRepoTransfer(context.Background(), actor, request.ID)
	assert.Equal(t, 500, apiStatus(t, err))
	assert.Zero(t, host.moveRepoCalls)
	assert.False(t, base.transferToUserCalled)
}

func TestRepoTransferRequest_CancelPrecheckReadAndMembershipErrors(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name      string
		lookupErr error
		orgError  bool
		want      int
	}{
		{name: "repository missing", lookupErr: pgx.ErrNoRows, want: 404},
		{name: "repository query fails", lookupErr: fmt.Errorf("database unavailable"), want: 500},
		{name: "membership query fails", orgError: true, want: 500},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			repository := testRepo(func(r *db.Repository) {
				r.UserID = pgtype.Int8{}
				r.OrgID = pgtype.Int8{Int64: 7, Valid: true}
			})
			request := db.RepositoryTransferRequest{ID: 9, RepositoryID: repository.ID, SenderID: 1, RecipientID: 77, SourceOrgID: repository.OrgID, Status: "pending"}
			base := &mockRepoQuerier{
				getRepoByIDFn: func(context.Context, int64) (db.Repository, error) { return repository, tc.lookupErr },
				isOrgOwnerForRepoUserFn: func(context.Context, db.IsOrgOwnerForRepoUserParams) (bool, error) {
					if tc.orgError {
						return false, fmt.Errorf("membership unavailable")
					}
					return true, nil
				},
			}
			q := &transferRequestReaderQuerier{mockRepoQuerier: base}
			q.getRequestFn = func(context.Context, int64) (db.RepositoryTransferRequest, error) { return request, nil }
			svc := NewRepoService(q, &mockRepoHostClient{}, "s1")
			manager := &fakeOwnershipTxManager{tx: &fakeOwnershipTx{q: base}}
			svc.ownershipTx = manager
			err := svc.CancelRepoTransfer(context.Background(), &db.User{ID: 1}, request.ID)
			assert.Equal(t, tc.want, apiStatus(t, err))
			assert.Zero(t, manager.begun)
			assert.False(t, base.transferToUserCalled)
		})
	}
}

func TestRepoTransferRequest_AcceptAndCancelFailClosedOnMissingTxQueriesOrRevokedOrgRole(t *testing.T) {
	t.Parallel()
	repository := testRepo(nil)
	request := testPendingUserTransfer(repository)
	base := transferQuerierToUser(repository, false)
	base.getRepoByIDFn = func(context.Context, int64) (db.Repository, error) { return repository, nil }
	q := &transferRequestReaderQuerier{mockRepoQuerier: base}
	q.getRequestFn = func(context.Context, int64) (db.RepositoryTransferRequest, error) { return request, nil }
	inner := &fakeOwnershipTx{q: base, getByIDFn: func(context.Context, int64) (db.Repository, error) { return repository, nil }}
	host := &mockRepoHostClient{}
	svc := NewRepoService(q, host, "s1")
	svc.ownershipTx = &fakeOwnershipTxManager{tx: ownershipOnlyTransferTx{repoOwnershipTx: inner}}
	_, err := svc.AcceptRepoTransfer(context.Background(), &db.User{ID: request.RecipientID, Username: "bob"}, request.ID)
	assert.Equal(t, 500, apiStatus(t, err))
	assert.True(t, inner.rolledBack)
	assert.Zero(t, host.moveRepoCalls)

	orgRepo := testRepo(func(r *db.Repository) { r.UserID = pgtype.Int8{}; r.OrgID = pgtype.Int8{Int64: 7, Valid: true} })
	orgRequest := db.RepositoryTransferRequest{ID: 10, RepositoryID: orgRepo.ID, SenderID: 1, RecipientID: 77, SourceOrgID: orgRepo.OrgID, Status: "pending"}
	orgBase := &mockRepoQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) { return orgRepo, nil },
	}
	checks := 0
	orgBase.isOrgOwnerForRepoUserFn = func(context.Context, db.IsOrgOwnerForRepoUserParams) (bool, error) {
		checks++
		return checks == 1, nil // authorized before lock, revoked under lock
	}
	orgQ := &transferRequestReaderQuerier{mockRepoQuerier: orgBase}
	orgQ.getRequestFn = func(context.Context, int64) (db.RepositoryTransferRequest, error) { return orgRequest, nil }
	orgTx := &fakeOwnershipTx{q: orgBase, getByIDFn: func(context.Context, int64) (db.Repository, error) { return orgRepo, nil }}
	orgTx.getTransferRequestFn = func(context.Context, int64) (db.RepositoryTransferRequest, error) { return orgRequest, nil }
	orgSvc := NewRepoService(orgQ, &mockRepoHostClient{}, "s1")
	orgSvc.ownershipTx = &fakeOwnershipTxManager{tx: orgTx}
	err = orgSvc.CancelRepoTransfer(context.Background(), &db.User{ID: 1}, orgRequest.ID)
	assert.Equal(t, 403, apiStatus(t, err))
	assert.Equal(t, 2, checks)
	assert.True(t, orgTx.rolledBack)
	assert.False(t, orgTx.committed)
	assert.False(t, orgBase.transferToUserCalled)
}
