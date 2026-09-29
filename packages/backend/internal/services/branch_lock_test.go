package services

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type mockBranchLockQuerier struct {
	acquireInsertFn     func(ctx context.Context, arg db.AcquireBranchLockInsertParams) (db.BranchLock, error)
	getLockFn           func(ctx context.Context, arg db.GetBranchLockParams) (db.BranchLock, error)
	takeOverFn          func(ctx context.Context, arg db.TakeOverStaleBranchLockParams) (db.BranchLock, error)
	heartbeatFn         func(ctx context.Context, arg db.HeartbeatBranchLockParams) (int64, error)
	releaseFn           func(ctx context.Context, arg db.ReleaseBranchLockParams) (int64, error)
	createJoinFn        func(ctx context.Context, arg db.CreateBranchLockJoinRequestParams) (db.BranchLockJoinRequest, error)
	getJoinFn           func(ctx context.Context, id int64) (db.BranchLockJoinRequest, error)
	getJoinForRequester func(ctx context.Context, arg db.GetBranchLockJoinRequestForRequesterParams) (db.BranchLockJoinRequest, error)
	hasApprovedFn       func(ctx context.Context, arg db.HasApprovedBranchLockJoinParams) (bool, error)
	listPendingFn       func(ctx context.Context, arg db.ListPendingBranchLockJoinRequestsParams) ([]db.BranchLockJoinRequest, error)
	listForHolderFn     func(ctx context.Context, userID int64) ([]db.BranchLockJoinRequest, error)
	resolveJoinFn       func(ctx context.Context, arg db.ResolveBranchLockJoinRequestParams) (db.BranchLockJoinRequest, error)
	getUsernameFn       func(ctx context.Context, id int64) (string, error)
}

func (m *mockBranchLockQuerier) AcquireBranchLockInsert(ctx context.Context, arg db.AcquireBranchLockInsertParams) (db.BranchLock, error) {
	return m.acquireInsertFn(ctx, arg)
}
func (m *mockBranchLockQuerier) GetBranchLock(ctx context.Context, arg db.GetBranchLockParams) (db.BranchLock, error) {
	return m.getLockFn(ctx, arg)
}
func (m *mockBranchLockQuerier) TakeOverStaleBranchLock(ctx context.Context, arg db.TakeOverStaleBranchLockParams) (db.BranchLock, error) {
	return m.takeOverFn(ctx, arg)
}
func (m *mockBranchLockQuerier) HeartbeatBranchLock(ctx context.Context, arg db.HeartbeatBranchLockParams) (int64, error) {
	if m.heartbeatFn != nil {
		return m.heartbeatFn(ctx, arg)
	}
	return 1, nil
}
func (m *mockBranchLockQuerier) ReleaseBranchLock(ctx context.Context, arg db.ReleaseBranchLockParams) (int64, error) {
	if m.releaseFn != nil {
		return m.releaseFn(ctx, arg)
	}
	return 1, nil
}
func (m *mockBranchLockQuerier) CreateBranchLockJoinRequest(ctx context.Context, arg db.CreateBranchLockJoinRequestParams) (db.BranchLockJoinRequest, error) {
	return m.createJoinFn(ctx, arg)
}
func (m *mockBranchLockQuerier) GetBranchLockJoinRequest(ctx context.Context, id int64) (db.BranchLockJoinRequest, error) {
	return m.getJoinFn(ctx, id)
}
func (m *mockBranchLockQuerier) GetBranchLockJoinRequestForRequester(ctx context.Context, arg db.GetBranchLockJoinRequestForRequesterParams) (db.BranchLockJoinRequest, error) {
	if m.getJoinForRequester != nil {
		return m.getJoinForRequester(ctx, arg)
	}
	return db.BranchLockJoinRequest{}, pgx.ErrNoRows
}
func (m *mockBranchLockQuerier) HasApprovedBranchLockJoin(ctx context.Context, arg db.HasApprovedBranchLockJoinParams) (bool, error) {
	if m.hasApprovedFn != nil {
		return m.hasApprovedFn(ctx, arg)
	}
	return false, nil
}
func (m *mockBranchLockQuerier) ListPendingBranchLockJoinRequests(ctx context.Context, arg db.ListPendingBranchLockJoinRequestsParams) ([]db.BranchLockJoinRequest, error) {
	if m.listPendingFn != nil {
		return m.listPendingFn(ctx, arg)
	}
	return []db.BranchLockJoinRequest{}, nil
}
func (m *mockBranchLockQuerier) ListPendingBranchLockJoinRequestsForHolder(ctx context.Context, userID int64) ([]db.BranchLockJoinRequest, error) {
	if m.listForHolderFn != nil {
		return m.listForHolderFn(ctx, userID)
	}
	return []db.BranchLockJoinRequest{}, nil
}
func (m *mockBranchLockQuerier) ResolveBranchLockJoinRequest(ctx context.Context, arg db.ResolveBranchLockJoinRequestParams) (db.BranchLockJoinRequest, error) {
	return m.resolveJoinFn(ctx, arg)
}
func (m *mockBranchLockQuerier) GetUsernameByID(ctx context.Context, id int64) (string, error) {
	if m.getUsernameFn != nil {
		return m.getUsernameFn(ctx, id)
	}
	return "user-" + string(rune('0'+id)), nil
}

type mockBranchLockAuthorizer struct {
	err error
}

func (m mockBranchLockAuthorizer) AuthorizeBranchLockJoin(ctx context.Context, userID int64) error {
	return m.err
}

type mockBranchLockNotifier struct {
	created []db.CreateNotificationParams
	err     error
}

func (m *mockBranchLockNotifier) Create(ctx context.Context, arg db.CreateNotificationParams) (NotificationResponse, error) {
	if m.err != nil {
		return NotificationResponse{}, m.err
	}
	m.created = append(m.created, arg)
	return NotificationResponse{}, nil
}

func uniqueViolation() error {
	return &pgconn.PgError{Code: "23505"}
}

func liveLock(userID int64) db.BranchLock {
	return db.BranchLock{RepositoryID: 1, Branch: "landing/app/main", UserID: userID, HeartbeatAt: time.Now(), Generation: testLockGeneration}
}

const testLockGeneration = "11111111-1111-1111-1111-111111111111"

func TestAcquireBranchLock_FreeBranch(t *testing.T) {
	q := &mockBranchLockQuerier{
		acquireInsertFn: func(ctx context.Context, arg db.AcquireBranchLockInsertParams) (db.BranchLock, error) {
			return db.BranchLock{RepositoryID: arg.RepositoryID, Branch: arg.Branch, UserID: arg.UserID}, nil
		},
		getUsernameFn: func(ctx context.Context, id int64) (string, error) { return "alice", nil },
	}
	svc := NewBranchLockService(q)
	resp, err := svc.AcquireBranchLock(context.Background(), AcquireBranchLockInput{RepositoryID: 1, Branch: "landing/app/main", UserID: 7})
	require.NoError(t, err)
	assert.Equal(t, "acquired", resp.Status)
	assert.False(t, resp.Shared)
	assert.Equal(t, "alice", resp.HolderUsername)
}

func TestAcquireBranchLock_OwnLockRenews(t *testing.T) {
	heartbeated := false
	q := &mockBranchLockQuerier{
		acquireInsertFn: func(ctx context.Context, arg db.AcquireBranchLockInsertParams) (db.BranchLock, error) {
			return db.BranchLock{}, uniqueViolation()
		},
		getLockFn: func(ctx context.Context, arg db.GetBranchLockParams) (db.BranchLock, error) {
			return liveLock(7), nil
		},
		heartbeatFn: func(ctx context.Context, arg db.HeartbeatBranchLockParams) (int64, error) {
			heartbeated = true
			return 1, nil
		},
		getUsernameFn: func(ctx context.Context, id int64) (string, error) { return "alice", nil },
	}
	svc := NewBranchLockService(q)
	resp, err := svc.AcquireBranchLock(context.Background(), AcquireBranchLockInput{RepositoryID: 1, Branch: "landing/app/main", UserID: 7})
	require.NoError(t, err)
	assert.Equal(t, "acquired", resp.Status)
	assert.True(t, heartbeated)
}

func TestAcquireBranchLock_StaleLockTakenOver(t *testing.T) {
	q := &mockBranchLockQuerier{
		acquireInsertFn: func(ctx context.Context, arg db.AcquireBranchLockInsertParams) (db.BranchLock, error) {
			return db.BranchLock{}, uniqueViolation()
		},
		getLockFn: func(ctx context.Context, arg db.GetBranchLockParams) (db.BranchLock, error) {
			return liveLock(9), nil
		},
		takeOverFn: func(ctx context.Context, arg db.TakeOverStaleBranchLockParams) (db.BranchLock, error) {
			return db.BranchLock{RepositoryID: arg.RepositoryID, Branch: arg.Branch, UserID: arg.UserID}, nil
		},
		getUsernameFn: func(ctx context.Context, id int64) (string, error) { return "bob", nil },
	}
	svc := NewBranchLockService(q)
	resp, err := svc.AcquireBranchLock(context.Background(), AcquireBranchLockInput{RepositoryID: 1, Branch: "landing/app/main", UserID: 7})
	require.NoError(t, err)
	assert.Equal(t, "took_over", resp.Status)
}

func TestAcquireBranchLock_HeldByOtherConflictDetails(t *testing.T) {
	q := &mockBranchLockQuerier{
		acquireInsertFn: func(ctx context.Context, arg db.AcquireBranchLockInsertParams) (db.BranchLock, error) {
			return db.BranchLock{}, uniqueViolation()
		},
		getLockFn: func(ctx context.Context, arg db.GetBranchLockParams) (db.BranchLock, error) {
			return liveLock(9), nil
		},
		takeOverFn: func(ctx context.Context, arg db.TakeOverStaleBranchLockParams) (db.BranchLock, error) {
			return db.BranchLock{}, pgx.ErrNoRows
		},
		getUsernameFn: func(ctx context.Context, id int64) (string, error) { return "carol", nil },
	}
	svc := NewBranchLockService(q, WithBranchLockJoinAuthorizer(mockBranchLockAuthorizer{}))
	_, err := svc.AcquireBranchLock(context.Background(), AcquireBranchLockInput{RepositoryID: 1, Branch: "landing/app/main", UserID: 7})
	require.Error(t, err)
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok)
	assert.Equal(t, 409, apiErr.Status)
	assert.Equal(t, pkgerrors.CodeBranchLockHeld, apiErr.Code)
	details, ok := apiErr.Details.(BranchLockHeldDetails)
	require.True(t, ok)
	assert.Equal(t, "carol", details.HolderUsername)
	assert.True(t, details.CanRequestJoin)
	assert.False(t, details.PendingRequest)
}

func TestAcquireBranchLock_FreePlanCannotRequestJoin(t *testing.T) {
	q := &mockBranchLockQuerier{
		acquireInsertFn: func(ctx context.Context, arg db.AcquireBranchLockInsertParams) (db.BranchLock, error) {
			return db.BranchLock{}, uniqueViolation()
		},
		getLockFn: func(ctx context.Context, arg db.GetBranchLockParams) (db.BranchLock, error) {
			return liveLock(9), nil
		},
		takeOverFn: func(ctx context.Context, arg db.TakeOverStaleBranchLockParams) (db.BranchLock, error) {
			return db.BranchLock{}, pgx.ErrNoRows
		},
		getUsernameFn: func(ctx context.Context, id int64) (string, error) { return "carol", nil },
	}
	svc := NewBranchLockService(q, WithBranchLockJoinAuthorizer(
		mockBranchLockAuthorizer{err: pkgerrors.Forbidden("joining an occupied branch requires a paid plan (Hobby or above)")},
	))
	_, err := svc.AcquireBranchLock(context.Background(), AcquireBranchLockInput{RepositoryID: 1, Branch: "landing/app/main", UserID: 7})
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok)
	details := apiErr.Details.(BranchLockHeldDetails)
	assert.False(t, details.CanRequestJoin)
}

func TestAcquireBranchLock_ApprovedJoinerShares(t *testing.T) {
	q := &mockBranchLockQuerier{
		acquireInsertFn: func(ctx context.Context, arg db.AcquireBranchLockInsertParams) (db.BranchLock, error) {
			return db.BranchLock{}, uniqueViolation()
		},
		getLockFn: func(ctx context.Context, arg db.GetBranchLockParams) (db.BranchLock, error) {
			return liveLock(9), nil
		},
		takeOverFn: func(ctx context.Context, arg db.TakeOverStaleBranchLockParams) (db.BranchLock, error) {
			return db.BranchLock{}, pgx.ErrNoRows
		},
		hasApprovedFn: func(ctx context.Context, arg db.HasApprovedBranchLockJoinParams) (bool, error) {
			return true, nil
		},
		getUsernameFn: func(ctx context.Context, id int64) (string, error) { return "carol", nil },
	}
	svc := NewBranchLockService(q)
	resp, err := svc.AcquireBranchLock(context.Background(), AcquireBranchLockInput{RepositoryID: 1, Branch: "landing/app/main", UserID: 7})
	require.NoError(t, err)
	assert.Equal(t, "acquired", resp.Status)
	assert.True(t, resp.Shared)
}

func TestHeartbeatBranchLock_NotHeld(t *testing.T) {
	q := &mockBranchLockQuerier{
		heartbeatFn: func(ctx context.Context, arg db.HeartbeatBranchLockParams) (int64, error) { return 0, nil },
	}
	svc := NewBranchLockService(q)
	err := svc.HeartbeatBranchLock(context.Background(), AcquireBranchLockInput{RepositoryID: 1, Branch: "b", UserID: 7})
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok)
	assert.Equal(t, 404, apiErr.Status)
}

func TestRequestBranchLockJoin_FreePlanForbidden(t *testing.T) {
	q := &mockBranchLockQuerier{
		getLockFn: func(ctx context.Context, arg db.GetBranchLockParams) (db.BranchLock, error) {
			return liveLock(9), nil
		},
	}
	notifier := &mockBranchLockNotifier{}
	svc := NewBranchLockService(q,
		WithBranchLockJoinAuthorizer(mockBranchLockAuthorizer{err: pkgerrors.Forbidden("paid plan required")}),
		WithBranchLockNotifier(notifier),
	)
	_, err := svc.RequestBranchLockJoin(context.Background(), RequestBranchLockJoinInput{RepositoryID: 1, Branch: "landing/app/main", UserID: 7, Username: "dave"})
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok)
	assert.Equal(t, 403, apiErr.Status)
	assert.Empty(t, notifier.created)
}

func TestRequestBranchLockJoin_CreatesAndNotifiesHolder(t *testing.T) {
	q := &mockBranchLockQuerier{
		getLockFn: func(ctx context.Context, arg db.GetBranchLockParams) (db.BranchLock, error) {
			return liveLock(9), nil
		},
		createJoinFn: func(ctx context.Context, arg db.CreateBranchLockJoinRequestParams) (db.BranchLockJoinRequest, error) {
			return db.BranchLockJoinRequest{ID: 42, RepositoryID: arg.RepositoryID, Branch: arg.Branch, RequesterID: arg.RequesterID, Status: "pending", CreatedAt: time.Now()}, nil
		},
	}
	notifier := &mockBranchLockNotifier{}
	svc := NewBranchLockService(q,
		WithBranchLockJoinAuthorizer(mockBranchLockAuthorizer{}),
		WithBranchLockNotifier(notifier),
	)
	resp, err := svc.RequestBranchLockJoin(context.Background(), RequestBranchLockJoinInput{RepositoryID: 1, Branch: "landing/app/main", UserID: 7, Username: "dave"})
	require.NoError(t, err)
	assert.Equal(t, int64(42), resp.ID)
	assert.Equal(t, "pending", resp.Status)
	require.Len(t, notifier.created, 1)
	assert.Equal(t, int64(9), notifier.created[0].UserID)
	assert.Equal(t, "branch_lock", notifier.created[0].SourceType)
	assert.Equal(t, int64(42), notifier.created[0].SourceID.Int64)
}

func TestRequestBranchLockJoin_PendingIsIdempotent(t *testing.T) {
	pending := db.BranchLockJoinRequest{ID: 5, RepositoryID: 1, Branch: "landing/app/main", RequesterID: 7, Status: "pending", CreatedAt: time.Now()}
	q := &mockBranchLockQuerier{
		getLockFn: func(ctx context.Context, arg db.GetBranchLockParams) (db.BranchLock, error) {
			return liveLock(9), nil
		},
		getJoinForRequester: func(ctx context.Context, arg db.GetBranchLockJoinRequestForRequesterParams) (db.BranchLockJoinRequest, error) {
			return pending, nil
		},
		createJoinFn: func(ctx context.Context, arg db.CreateBranchLockJoinRequestParams) (db.BranchLockJoinRequest, error) {
			t.Fatal("create must not run while a pending request exists")
			return db.BranchLockJoinRequest{}, nil
		},
	}
	notifier := &mockBranchLockNotifier{}
	svc := NewBranchLockService(q,
		WithBranchLockJoinAuthorizer(mockBranchLockAuthorizer{}),
		WithBranchLockNotifier(notifier),
	)
	resp, err := svc.RequestBranchLockJoin(context.Background(), RequestBranchLockJoinInput{RepositoryID: 1, Branch: "landing/app/main", UserID: 7, Username: "dave"})
	require.NoError(t, err)
	assert.Equal(t, int64(5), resp.ID)
	assert.Empty(t, notifier.created)
}

func TestDecideBranchLockJoin_OnlyHolder(t *testing.T) {
	q := &mockBranchLockQuerier{
		getJoinFn: func(ctx context.Context, id int64) (db.BranchLockJoinRequest, error) {
			return db.BranchLockJoinRequest{ID: id, RepositoryID: 1, Branch: "landing/app/main", RequesterID: 7, Status: "pending", LockGeneration: testLockGeneration}, nil
		},
		getLockFn: func(ctx context.Context, arg db.GetBranchLockParams) (db.BranchLock, error) {
			return liveLock(9), nil
		},
	}
	svc := NewBranchLockService(q)
	_, err := svc.DecideBranchLockJoin(context.Background(), DecideBranchLockJoinInput{RepositoryID: 1, JoinRequestID: 5, ResolverID: 7, Approve: true})
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok)
	assert.Equal(t, 403, apiErr.Status)
}

func TestDecideBranchLockJoin_ApproveNotifiesRequester(t *testing.T) {
	q := &mockBranchLockQuerier{
		getJoinFn: func(ctx context.Context, id int64) (db.BranchLockJoinRequest, error) {
			return db.BranchLockJoinRequest{ID: id, RepositoryID: 1, Branch: "landing/app/main", RequesterID: 7, Status: "pending", LockGeneration: testLockGeneration}, nil
		},
		getLockFn: func(ctx context.Context, arg db.GetBranchLockParams) (db.BranchLock, error) {
			return liveLock(9), nil
		},
		resolveJoinFn: func(ctx context.Context, arg db.ResolveBranchLockJoinRequestParams) (db.BranchLockJoinRequest, error) {
			return db.BranchLockJoinRequest{ID: arg.ID, RepositoryID: 1, Branch: "landing/app/main", RequesterID: 7, Status: arg.Status, CreatedAt: time.Now()}, nil
		},
		getUsernameFn: func(ctx context.Context, id int64) (string, error) { return "dave", nil },
	}
	notifier := &mockBranchLockNotifier{}
	svc := NewBranchLockService(q, WithBranchLockNotifier(notifier))
	resp, err := svc.DecideBranchLockJoin(context.Background(), DecideBranchLockJoinInput{RepositoryID: 1, JoinRequestID: 5, ResolverID: 9, Approve: true})
	require.NoError(t, err)
	assert.Equal(t, "approved", resp.Status)
	require.Len(t, notifier.created, 1)
	assert.Equal(t, int64(7), notifier.created[0].UserID)
}

func TestListPendingBranchLockJoinRequests_HolderOnly(t *testing.T) {
	q := &mockBranchLockQuerier{
		getLockFn: func(ctx context.Context, arg db.GetBranchLockParams) (db.BranchLock, error) {
			return liveLock(9), nil
		},
	}
	svc := NewBranchLockService(q)
	_, err := svc.ListPendingBranchLockJoinRequests(context.Background(), AcquireBranchLockInput{RepositoryID: 1, Branch: "landing/app/main", UserID: 7})
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok)
	assert.Equal(t, 403, apiErr.Status)
}

// An approval belongs to the lock generation it was granted under. After Alice
// releases and Carol acquires, Bob's old approval must not share Carol's lock.
func TestAcquireBranchLock_ApprovalFromEarlierHolderDoesNotShare(t *testing.T) {
	approvedUnder := "00000000-0000-0000-0000-00000000a11c"
	q := &mockBranchLockQuerier{
		acquireInsertFn: func(ctx context.Context, arg db.AcquireBranchLockInsertParams) (db.BranchLock, error) {
			return db.BranchLock{}, uniqueViolation()
		},
		getLockFn: func(ctx context.Context, arg db.GetBranchLockParams) (db.BranchLock, error) {
			return liveLock(9), nil
		},
		takeOverFn: func(ctx context.Context, arg db.TakeOverStaleBranchLockParams) (db.BranchLock, error) {
			return db.BranchLock{}, pgx.ErrNoRows
		},
		hasApprovedFn: func(ctx context.Context, arg db.HasApprovedBranchLockJoinParams) (bool, error) {
			return arg.LockGeneration == approvedUnder, nil
		},
		getJoinForRequester: func(ctx context.Context, arg db.GetBranchLockJoinRequestForRequesterParams) (db.BranchLockJoinRequest, error) {
			assert.Equal(t, testLockGeneration, arg.LockGeneration)
			return db.BranchLockJoinRequest{}, pgx.ErrNoRows
		},
	}
	svc := NewBranchLockService(q)
	_, err := svc.AcquireBranchLock(context.Background(), AcquireBranchLockInput{RepositoryID: 1, Branch: "landing/app/main", UserID: 7})
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok)
	assert.Equal(t, 409, apiErr.Status)
	assert.Equal(t, pkgerrors.CodeBranchLockHeld, apiErr.Code)
}

func TestRequestBranchLockJoin_BindsRequestToLockGeneration(t *testing.T) {
	var created db.CreateBranchLockJoinRequestParams
	q := &mockBranchLockQuerier{
		getLockFn: func(ctx context.Context, arg db.GetBranchLockParams) (db.BranchLock, error) {
			return liveLock(9), nil
		},
		getJoinForRequester: func(ctx context.Context, arg db.GetBranchLockJoinRequestForRequesterParams) (db.BranchLockJoinRequest, error) {
			assert.Equal(t, testLockGeneration, arg.LockGeneration, "an approval from an earlier holder must not block a new ask")
			return db.BranchLockJoinRequest{}, pgx.ErrNoRows
		},
		createJoinFn: func(ctx context.Context, arg db.CreateBranchLockJoinRequestParams) (db.BranchLockJoinRequest, error) {
			created = arg
			return db.BranchLockJoinRequest{ID: 42, RepositoryID: arg.RepositoryID, Branch: arg.Branch, RequesterID: arg.RequesterID, Status: "pending", CreatedAt: time.Now(), LockGeneration: arg.LockGeneration}, nil
		},
	}
	svc := NewBranchLockService(q, WithBranchLockJoinAuthorizer(mockBranchLockAuthorizer{}))
	_, err := svc.RequestBranchLockJoin(context.Background(), RequestBranchLockJoinInput{RepositoryID: 1, Branch: "landing/app/main", UserID: 7, Username: "bob"})
	require.NoError(t, err)
	assert.Equal(t, testLockGeneration, created.LockGeneration)
}

func TestDecideBranchLockJoin_RequestToEarlierHolderIsMoot(t *testing.T) {
	q := &mockBranchLockQuerier{
		getJoinFn: func(ctx context.Context, id int64) (db.BranchLockJoinRequest, error) {
			return db.BranchLockJoinRequest{ID: id, RepositoryID: 1, Branch: "landing/app/main", RequesterID: 7, Status: "pending", LockGeneration: "00000000-0000-0000-0000-00000000a11c"}, nil
		},
		getLockFn: func(ctx context.Context, arg db.GetBranchLockParams) (db.BranchLock, error) {
			return liveLock(9), nil
		},
		resolveJoinFn: func(ctx context.Context, arg db.ResolveBranchLockJoinRequestParams) (db.BranchLockJoinRequest, error) {
			t.Fatal("a request made to an earlier holder must not be resolved into the current lock")
			return db.BranchLockJoinRequest{}, nil
		},
	}
	svc := NewBranchLockService(q)
	_, err := svc.DecideBranchLockJoin(context.Background(), DecideBranchLockJoinInput{RepositoryID: 1, JoinRequestID: 5, ResolverID: 9, Approve: true})
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok)
	assert.Equal(t, 409, apiErr.Status)
}

func TestListPendingBranchLockJoinRequests_ScopedToLockGeneration(t *testing.T) {
	q := &mockBranchLockQuerier{
		getLockFn: func(ctx context.Context, arg db.GetBranchLockParams) (db.BranchLock, error) {
			return liveLock(9), nil
		},
		listPendingFn: func(ctx context.Context, arg db.ListPendingBranchLockJoinRequestsParams) ([]db.BranchLockJoinRequest, error) {
			assert.Equal(t, testLockGeneration, arg.LockGeneration)
			return []db.BranchLockJoinRequest{}, nil
		},
	}
	svc := NewBranchLockService(q)
	_, err := svc.ListPendingBranchLockJoinRequests(context.Background(), AcquireBranchLockInput{RepositoryID: 1, Branch: "landing/app/main", UserID: 9})
	require.NoError(t, err)
}
