package services

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

// mockLandingWorkerQuerier implements LandingWorkerQuerier for unit tests.
type mockLandingWorkerQuerier struct {
	claimPendingLandingTaskFn   func(ctx context.Context) (db.LandingTask, error)
	getLandingRequestByIDFn     func(ctx context.Context, id int64) (db.LandingRequest, error)
	listLandingRequestChangesFn func(ctx context.Context, arg db.ListLandingRequestChangesParams) ([]db.LandingRequestChange, error)
	getRepoByIDFn               func(ctx context.Context, id int64) (db.Repository, error)
	getUserByIDFn               func(ctx context.Context, id int64) (db.User, error)
	getOrgByIDFn                func(ctx context.Context, id int64) (db.Organization, error)
	listAllProtectedBookmarksFn func(ctx context.Context, repositoryID int64) ([]db.ProtectedBookmark, error)
	getRepositoryCiPolicyFn     func(ctx context.Context, repositoryID int64) (db.GetRepositoryCiLandingPolicyRow, error)
	getLatestCommitStatusesFn   func(ctx context.Context, arg db.GetLatestCommitStatusesByChangeIDsAndContextsParams) ([]db.GetLatestCommitStatusesByChangeIDsAndContextsRow, error)
	countUnresolvedThreadsFn    func(ctx context.Context, landingRequestID int64) (int64, error)
	markLandingStartedFn        func(ctx context.Context, id int64) (db.LandingRequest, error)
	mergeLandingRequestFn       func(ctx context.Context, id int64) (db.LandingRequest, error)
	markLandingTaskDoneFn       func(ctx context.Context, id int64) (db.LandingTask, error)
	markLandingRequestFailedFn  func(ctx context.Context, id int64) (db.LandingRequest, error)
	failLandingTaskFn           func(ctx context.Context, arg db.FailLandingTaskParams) (db.LandingTask, error)

	claimCalled                    bool
	markLandingStartedCalled       bool
	mergeCalled                    bool
	markTaskDoneCalled             bool
	markLandingRequestFailedCalled bool
	failTaskCalled                 bool
	lastFailTaskArg                db.FailLandingTaskParams
}

type issueFixingLandingWorkerQuerier struct {
	*mockLandingWorkerQuerier
	fixCalls []db.FixIssuesForLandingParams
	fixErr   error
}

func (q *issueFixingLandingWorkerQuerier) FixIssuesForLanding(_ context.Context, arg db.FixIssuesForLandingParams) ([]int64, error) {
	q.fixCalls = append(q.fixCalls, arg)
	return []int64{41}, q.fixErr
}

type mockAutoLandProcessor struct {
	called bool
	err    error
}

func (m *mockAutoLandProcessor) ProcessNextAutoLand(context.Context) error {
	m.called = true
	return m.err
}

func (m *mockLandingWorkerQuerier) ClaimPendingLandingTask(ctx context.Context) (db.LandingTask, error) {
	m.claimCalled = true
	if m.claimPendingLandingTaskFn != nil {
		return m.claimPendingLandingTaskFn(ctx)
	}
	return db.LandingTask{}, pgx.ErrNoRows
}

func (m *mockLandingWorkerQuerier) GetLandingRequestByID(ctx context.Context, id int64) (db.LandingRequest, error) {
	if m.getLandingRequestByIDFn != nil {
		return m.getLandingRequestByIDFn(ctx, id)
	}
	return db.LandingRequest{}, pgx.ErrNoRows
}

func (m *mockLandingWorkerQuerier) ListLandingRequestChanges(ctx context.Context, arg db.ListLandingRequestChangesParams) ([]db.LandingRequestChange, error) {
	if m.listLandingRequestChangesFn != nil {
		return m.listLandingRequestChangesFn(ctx, arg)
	}
	return nil, nil
}

func (m *mockLandingWorkerQuerier) GetRepoByID(ctx context.Context, id int64) (db.Repository, error) {
	if m.getRepoByIDFn != nil {
		return m.getRepoByIDFn(ctx, id)
	}
	return db.Repository{}, pgx.ErrNoRows
}

func (m *mockLandingWorkerQuerier) GetUserByID(ctx context.Context, id int64) (db.User, error) {
	if m.getUserByIDFn != nil {
		return m.getUserByIDFn(ctx, id)
	}
	return db.User{ID: id, Username: fmt.Sprintf("user-%d", id)}, nil
}

func (m *mockLandingWorkerQuerier) GetOrgByID(ctx context.Context, id int64) (db.Organization, error) {
	if m.getOrgByIDFn != nil {
		return m.getOrgByIDFn(ctx, id)
	}
	return db.Organization{ID: id, Name: fmt.Sprintf("org-%d", id)}, nil
}

func (m *mockLandingWorkerQuerier) ListAllProtectedBookmarksByRepo(ctx context.Context, repositoryID int64) ([]db.ProtectedBookmark, error) {
	if m.listAllProtectedBookmarksFn != nil {
		return m.listAllProtectedBookmarksFn(ctx, repositoryID)
	}
	return nil, nil
}

func (m *mockLandingWorkerQuerier) GetRepositoryCiLandingPolicy(ctx context.Context, repositoryID int64) (db.GetRepositoryCiLandingPolicyRow, error) {
	if m.getRepositoryCiPolicyFn != nil {
		return m.getRepositoryCiPolicyFn(ctx, repositoryID)
	}
	return db.GetRepositoryCiLandingPolicyRow{}, pgx.ErrNoRows
}

func (m *mockLandingWorkerQuerier) GetLatestCommitStatusesByChangeIDsAndContexts(ctx context.Context, arg db.GetLatestCommitStatusesByChangeIDsAndContextsParams) ([]db.GetLatestCommitStatusesByChangeIDsAndContextsRow, error) {
	if m.getLatestCommitStatusesFn != nil {
		return m.getLatestCommitStatusesFn(ctx, arg)
	}
	return nil, nil
}

func (m *mockLandingWorkerQuerier) CountUnresolvedLandingRequestThreads(ctx context.Context, landingRequestID int64) (int64, error) {
	if m.countUnresolvedThreadsFn != nil {
		return m.countUnresolvedThreadsFn(ctx, landingRequestID)
	}
	return 0, nil
}

func (m *mockLandingWorkerQuerier) MarkLandingStarted(ctx context.Context, id int64) (db.LandingRequest, error) {
	m.markLandingStartedCalled = true
	if m.markLandingStartedFn != nil {
		return m.markLandingStartedFn(ctx, id)
	}
	return db.LandingRequest{ID: id, State: "landing"}, nil
}

func (m *mockLandingWorkerQuerier) MergeLandingRequest(ctx context.Context, id int64) (db.LandingRequest, error) {
	m.mergeCalled = true
	if m.mergeLandingRequestFn != nil {
		return m.mergeLandingRequestFn(ctx, id)
	}
	return db.LandingRequest{ID: id, State: "merged"}, nil
}

func (m *mockLandingWorkerQuerier) MarkLandingTaskDone(ctx context.Context, id int64) (db.LandingTask, error) {
	m.markTaskDoneCalled = true
	if m.markLandingTaskDoneFn != nil {
		return m.markLandingTaskDoneFn(ctx, id)
	}
	return db.LandingTask{ID: id, Status: "done"}, nil
}

func (m *mockLandingWorkerQuerier) MarkLandingRequestFailed(ctx context.Context, id int64) (db.LandingRequest, error) {
	m.markLandingRequestFailedCalled = true
	if m.markLandingRequestFailedFn != nil {
		return m.markLandingRequestFailedFn(ctx, id)
	}
	return db.LandingRequest{ID: id, State: "failed"}, nil
}

func (m *mockLandingWorkerQuerier) FailLandingTask(ctx context.Context, arg db.FailLandingTaskParams) (db.LandingTask, error) {
	m.failTaskCalled = true
	m.lastFailTaskArg = arg
	if m.failLandingTaskFn != nil {
		return m.failLandingTaskFn(ctx, arg)
	}
	return db.LandingTask{ID: arg.ID, Status: "failed"}, nil
}

// mockWorkerRepoHostClient implements LandingWorkerRepoHostClient for unit tests.
type mockWorkerRepoHostClient struct {
	landChangesFn   func(ctx context.Context, owner, repo string, req repohost.LandRequest) (repohost.LandResult, error)
	lastLandOwner   string
	lastLandRepo    string
	lastLandRequest repohost.LandRequest
	landCalled      bool
}

func (m *mockWorkerRepoHostClient) LandChanges(ctx context.Context, owner, repo string, req repohost.LandRequest) (repohost.LandResult, error) {
	m.landCalled = true
	m.lastLandOwner = owner
	m.lastLandRepo = repo
	m.lastLandRequest = req
	if m.landChangesFn != nil {
		return m.landChangesFn(ctx, owner, repo, req)
	}
	return repohost.LandResult{
		LandedCount:    len(req.ChangeIDs),
		TargetBookmark: req.TargetBookmark,
		TargetCommitID: "c-main",
	}, nil
}

// mockWorkerWebhookDispatcher records webhook dispatch calls for testing.
type mockWorkerWebhookDispatcher struct {
	calls []workerDispatchCall
}

type workerDispatchCall struct {
	repoID    int64
	eventType webhooks.EventType
	payload   any
}

func (m *mockWorkerWebhookDispatcher) DispatchEvent(ctx context.Context, repoID int64, eventType webhooks.EventType, payload any) error {
	m.calls = append(m.calls, workerDispatchCall{
		repoID:    repoID,
		eventType: eventType,
		payload:   payload,
	})
	return nil
}

func (m *mockWorkerWebhookDispatcher) DispatchOrgEvent(_ context.Context, _ int64, _ webhooks.EventType, _ any) error {
	return nil
}

func workerTask(id, landingRequestID, repositoryID int64) db.LandingTask {
	now := time.Now().UTC()
	return db.LandingTask{
		ID:               id,
		LandingRequestID: landingRequestID,
		RepositoryID:     repositoryID,
		Status:           "running",
		Priority:         1,
		Attempt:          1,
		AvailableAt:      now,
		StartedAt:        pgtype.Timestamptz{Time: now, Valid: true},
		CreatedAt:        now,
		UpdatedAt:        now,
	}
}

func workerLandingRequest(id, repositoryID int64) db.LandingRequest {
	now := time.Now().UTC()
	return db.LandingRequest{
		ID:             id,
		RepositoryID:   repositoryID,
		Number:         5,
		Title:          "land me",
		Body:           "please",
		State:          "queued",
		AuthorID:       10,
		TargetBookmark: "main",
		SourceBookmark: "feature",
		ConflictStatus: "clean",
		StackSize:      2,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
}

func workerRepo(id int64) db.Repository {
	return db.Repository{
		ID:        id,
		UserID:    pgtype.Int8{Int64: 1, Valid: true},
		Name:      "demo",
		LowerName: "demo",
		IsPublic:  true,
	}
}

func TestLandingWorker_PollOnce_NoTaskAvailable(t *testing.T) {
	t.Parallel()

	q := &mockLandingWorkerQuerier{}
	rh := &mockWorkerRepoHostClient{}
	w := NewLandingWorker(q, rh)

	err := w.PollOnce(context.Background())
	require.NoError(t, err)
	assert.True(t, q.claimCalled)
	assert.False(t, rh.landCalled)
}

func TestLandingWorker_PollOnce_ProcessesAutoLandBeforeClaim(t *testing.T) {
	t.Parallel()
	q := &mockLandingWorkerQuerier{}
	processor := &mockAutoLandProcessor{err: fmt.Errorf("temporary gate lookup failure")}
	w := NewLandingWorker(q, &mockWorkerRepoHostClient{}, WithLandingWorkerAutoLandProcessor(processor))

	require.NoError(t, w.PollOnce(context.Background()))
	assert.True(t, processor.called)
	assert.True(t, q.claimCalled, "an auto-land evaluation error must not block already queued tasks")
}

func TestLandingWorker_PollOnce_ClaimsTaskAndLandsSuccessfully(t *testing.T) {
	t.Parallel()

	taskID := int64(100)
	lrID := int64(88)
	repoID := int64(77)

	q := &mockLandingWorkerQuerier{
		claimPendingLandingTaskFn: func(ctx context.Context) (db.LandingTask, error) {
			return workerTask(taskID, lrID, repoID), nil
		},
		getLandingRequestByIDFn: func(ctx context.Context, id int64) (db.LandingRequest, error) {
			assert.Equal(t, lrID, id)
			return workerLandingRequest(lrID, repoID), nil
		},
		listLandingRequestChangesFn: func(ctx context.Context, arg db.ListLandingRequestChangesParams) ([]db.LandingRequestChange, error) {
			assert.Equal(t, lrID, arg.LandingRequestID)
			return []db.LandingRequestChange{
				{ID: 1, LandingRequestID: lrID, ChangeID: "k-a", PositionInStack: 1},
				{ID: 2, LandingRequestID: lrID, ChangeID: "k-b", PositionInStack: 2},
			}, nil
		},
		getRepoByIDFn: func(ctx context.Context, id int64) (db.Repository, error) {
			assert.Equal(t, repoID, id)
			return workerRepo(repoID), nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			return db.User{ID: id, Username: "alice", LowerUsername: "alice"}, nil
		},
	}
	rh := &mockWorkerRepoHostClient{}
	m := newObserveV2Metrics()
	w := NewLandingWorker(q, rh, WithLandingWorkerMetrics(m))

	err := w.PollOnce(context.Background())
	require.NoError(t, err)

	// Verify the full happy path executed.
	assert.True(t, q.claimCalled)
	assert.True(t, q.markLandingStartedCalled)
	assert.True(t, rh.landCalled)
	assert.Equal(t, "alice", rh.lastLandOwner)
	assert.Equal(t, "demo", rh.lastLandRepo)
	assert.Equal(t, []string{"k-a", "k-b"}, rh.lastLandRequest.ChangeIDs)
	assert.Equal(t, "main", rh.lastLandRequest.TargetBookmark)
	assert.True(t, q.mergeCalled)
	assert.True(t, q.markTaskDoneCalled)
	assert.False(t, q.markLandingRequestFailedCalled)
	assert.False(t, q.failTaskCalled)
	require.Equal(t, 1.0, testutil.ToFloat64(m.landing.WithLabelValues("merge")))
}

func TestLandingWorker_FixesTrailerLinkedIssuesAfterLanding(t *testing.T) {
	t.Parallel()
	taskID, lrID, repoID := int64(100), int64(88), int64(77)
	base := &mockLandingWorkerQuerier{
		claimPendingLandingTaskFn: func(context.Context) (db.LandingTask, error) { return workerTask(taskID, lrID, repoID), nil },
		getLandingRequestByIDFn: func(context.Context, int64) (db.LandingRequest, error) {
			landing := workerLandingRequest(lrID, repoID)
			landing.AuthorAgentSessionID = pgtype.UUID{Bytes: uuid.MustParse("11111111-1111-4111-8111-111111111111"), Valid: true}
			return landing, nil
		},
		listLandingRequestChangesFn: func(context.Context, db.ListLandingRequestChangesParams) ([]db.LandingRequestChange, error) {
			return []db.LandingRequestChange{{LandingRequestID: lrID, ChangeID: "change-1", PositionInStack: 1}}, nil
		},
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) { return workerRepo(repoID), nil },
		mergeLandingRequestFn: func(context.Context, int64) (db.LandingRequest, error) {
			landing := workerLandingRequest(lrID, repoID)
			landing.State = landingStateMerged
			landing.AuthorAgentSessionID = pgtype.UUID{Bytes: uuid.MustParse("11111111-1111-4111-8111-111111111111"), Valid: true}
			return landing, nil
		},
	}
	q := &issueFixingLandingWorkerQuerier{mockLandingWorkerQuerier: base}

	require.NoError(t, NewLandingWorker(q, &mockWorkerRepoHostClient{}).PollOnce(context.Background()))
	require.Len(t, q.fixCalls, 1)
	assert.Equal(t, lrID, q.fixCalls[0].LandingRequestID)
	assert.Equal(t, int64(10), q.fixCalls[0].FixedByID.Int64)
	assert.Equal(t, "11111111-1111-4111-8111-111111111111", q.fixCalls[0].FixedByAgentSessionID)
}

func TestLandingWorker_RefusesNewUnresolvedThreadBeforeLanding(t *testing.T) {
	t.Parallel()

	const taskID, lrID, repoID int64 = 100, 88, 77
	q := &mockLandingWorkerQuerier{
		claimPendingLandingTaskFn: func(context.Context) (db.LandingTask, error) {
			return workerTask(taskID, lrID, repoID), nil
		},
		getLandingRequestByIDFn: func(context.Context, int64) (db.LandingRequest, error) {
			return workerLandingRequest(lrID, repoID), nil
		},
		listLandingRequestChangesFn: func(context.Context, db.ListLandingRequestChangesParams) ([]db.LandingRequestChange, error) {
			return []db.LandingRequestChange{{ID: 1, LandingRequestID: lrID, ChangeID: "k-a", PositionInStack: 1}}, nil
		},
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return workerRepo(repoID), nil
		},
		countUnresolvedThreadsFn: func(_ context.Context, landingRequestID int64) (int64, error) {
			assert.Equal(t, lrID, landingRequestID)
			return 1, nil
		},
	}
	rh := &mockWorkerRepoHostClient{}

	require.NoError(t, NewLandingWorker(q, rh).PollOnce(context.Background()))
	assert.False(t, rh.landCalled)
	assert.False(t, q.markLandingStartedCalled)
	assert.True(t, q.markLandingRequestFailedCalled)
	assert.True(t, q.failTaskCalled)
	assert.Contains(t, q.lastFailTaskArg.LastError.String, "1 unresolved review comments")
}

func TestLandingWorker_CancellationDuringLandStillFinalizesTruthfulSuccess(t *testing.T) {
	t.Parallel()

	const taskID, lrID, repoID int64 = 100, 88, 77
	requestCtx, cancelRequest := context.WithCancel(context.Background())
	q := &mockLandingWorkerQuerier{
		claimPendingLandingTaskFn: func(context.Context) (db.LandingTask, error) {
			return workerTask(taskID, lrID, repoID), nil
		},
		getLandingRequestByIDFn: func(context.Context, int64) (db.LandingRequest, error) {
			return workerLandingRequest(lrID, repoID), nil
		},
		listLandingRequestChangesFn: func(context.Context, db.ListLandingRequestChangesParams) ([]db.LandingRequestChange, error) {
			return []db.LandingRequestChange{{ID: 1, LandingRequestID: lrID, ChangeID: "k-a", PositionInStack: 1}}, nil
		},
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return workerRepo(repoID), nil
		},
		mergeLandingRequestFn: func(ctx context.Context, id int64) (db.LandingRequest, error) {
			require.NoError(t, ctx.Err(), "post-land DB finalization must survive worker cancellation")
			return db.LandingRequest{ID: id, State: landingStateMerged}, nil
		},
		markLandingTaskDoneFn: func(ctx context.Context, id int64) (db.LandingTask, error) {
			require.NoError(t, ctx.Err())
			return db.LandingTask{ID: id, Status: "done"}, nil
		},
	}
	rh := &mockWorkerRepoHostClient{
		landChangesFn: func(ctx context.Context, _, _ string, _ repohost.LandRequest) (repohost.LandResult, error) {
			cancelRequest()
			require.ErrorIs(t, requestCtx.Err(), context.Canceled)
			require.NoError(t, ctx.Err(), "landing already crossed the mutation boundary")
			return repohost.LandResult{LandedCount: 1, TargetBookmark: "main"}, nil
		},
	}

	require.NoError(t, NewLandingWorker(q, rh).PollOnce(requestCtx))
	assert.True(t, q.mergeCalled)
	assert.True(t, q.markTaskDoneCalled)
	assert.False(t, q.markLandingRequestFailedCalled)
	assert.False(t, q.failTaskCalled)
}

func TestLandingWorker_PollOnce_OrgOwnedRepoResolvesOwnerFromOrg(t *testing.T) {
	t.Parallel()

	taskID := int64(100)
	lrID := int64(88)
	repoID := int64(77)
	orgID := int64(33)

	orgRepo := workerRepo(repoID)
	orgRepo.UserID = pgtype.Int8{}
	orgRepo.OrgID = pgtype.Int8{Int64: orgID, Valid: true}

	q := &mockLandingWorkerQuerier{
		claimPendingLandingTaskFn: func(ctx context.Context) (db.LandingTask, error) {
			return workerTask(taskID, lrID, repoID), nil
		},
		getLandingRequestByIDFn: func(ctx context.Context, id int64) (db.LandingRequest, error) {
			return workerLandingRequest(lrID, repoID), nil
		},
		listLandingRequestChangesFn: func(ctx context.Context, arg db.ListLandingRequestChangesParams) ([]db.LandingRequestChange, error) {
			return []db.LandingRequestChange{
				{ID: 1, LandingRequestID: lrID, ChangeID: "k-a", PositionInStack: 1},
			}, nil
		},
		getRepoByIDFn: func(ctx context.Context, id int64) (db.Repository, error) {
			return orgRepo, nil
		},
		getOrgByIDFn: func(ctx context.Context, id int64) (db.Organization, error) {
			assert.Equal(t, orgID, id)
			return db.Organization{ID: orgID, Name: "myorg"}, nil
		},
	}
	rh := &mockWorkerRepoHostClient{}
	w := NewLandingWorker(q, rh)

	err := w.PollOnce(context.Background())
	require.NoError(t, err)
	assert.Equal(t, "myorg", rh.lastLandOwner)
	assert.True(t, q.mergeCalled)
	assert.True(t, q.markTaskDoneCalled)
}

func TestLandingWorker_PollOnce_RepoHostFailure_RevertsAndFailsTask(t *testing.T) {
	t.Parallel()

	taskID := int64(100)
	lrID := int64(88)
	repoID := int64(77)

	q := &mockLandingWorkerQuerier{
		claimPendingLandingTaskFn: func(ctx context.Context) (db.LandingTask, error) {
			return workerTask(taskID, lrID, repoID), nil
		},
		getLandingRequestByIDFn: func(ctx context.Context, id int64) (db.LandingRequest, error) {
			return workerLandingRequest(lrID, repoID), nil
		},
		listLandingRequestChangesFn: func(ctx context.Context, arg db.ListLandingRequestChangesParams) ([]db.LandingRequestChange, error) {
			return []db.LandingRequestChange{
				{ID: 1, LandingRequestID: lrID, ChangeID: "k-a", PositionInStack: 1},
			}, nil
		},
		getRepoByIDFn: func(ctx context.Context, id int64) (db.Repository, error) {
			return workerRepo(repoID), nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			return db.User{ID: id, Username: "alice", LowerUsername: "alice"}, nil
		},
	}
	rh := &mockWorkerRepoHostClient{
		landChangesFn: func(ctx context.Context, owner, repo string, req repohost.LandRequest) (repohost.LandResult, error) {
			return repohost.LandResult{}, fmt.Errorf("rebase conflict")
		},
	}
	m := newObserveV2Metrics()
	w := NewLandingWorker(q, rh, WithLandingWorkerMetrics(m))

	err := w.PollOnce(context.Background())
	require.NoError(t, err)

	// Verify failure path executed.
	assert.True(t, q.claimCalled)
	assert.True(t, q.markLandingStartedCalled)
	assert.True(t, rh.landCalled)
	assert.False(t, q.mergeCalled)
	assert.False(t, q.markTaskDoneCalled)
	assert.True(t, q.markLandingRequestFailedCalled)
	assert.True(t, q.failTaskCalled)
	assert.Equal(t, taskID, q.lastFailTaskArg.ID)
	assert.Contains(t, q.lastFailTaskArg.LastError.String, "rebase conflict")
	require.Equal(t, 1.0, testutil.ToFloat64(m.landing.WithLabelValues("fail")))
}

func TestLandingWorker_PollOnce_ContextCancelled_ReturnsError(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	q := &mockLandingWorkerQuerier{
		claimPendingLandingTaskFn: func(ctx context.Context) (db.LandingTask, error) {
			return db.LandingTask{}, ctx.Err()
		},
	}
	rh := &mockWorkerRepoHostClient{}
	w := NewLandingWorker(q, rh)

	err := w.PollOnce(ctx)
	require.Error(t, err)
	assert.ErrorIs(t, err, context.Canceled)
}

func TestLandingWorker_DispatchesLandedWebhookAfterMerge(t *testing.T) {
	t.Parallel()

	taskID := int64(100)
	lrID := int64(88)
	repoID := int64(77)

	mergedLR := workerLandingRequest(lrID, repoID)
	mergedLR.State = "merged"

	q := &mockLandingWorkerQuerier{
		claimPendingLandingTaskFn: func(ctx context.Context) (db.LandingTask, error) {
			return workerTask(taskID, lrID, repoID), nil
		},
		getLandingRequestByIDFn: func(ctx context.Context, id int64) (db.LandingRequest, error) {
			return workerLandingRequest(lrID, repoID), nil
		},
		listLandingRequestChangesFn: func(ctx context.Context, arg db.ListLandingRequestChangesParams) ([]db.LandingRequestChange, error) {
			return []db.LandingRequestChange{
				{ID: 1, LandingRequestID: lrID, ChangeID: "k-a", PositionInStack: 1},
				{ID: 2, LandingRequestID: lrID, ChangeID: "k-b", PositionInStack: 2},
			}, nil
		},
		getRepoByIDFn: func(ctx context.Context, id int64) (db.Repository, error) {
			return workerRepo(repoID), nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			return db.User{ID: id, Username: "alice", LowerUsername: "alice"}, nil
		},
		mergeLandingRequestFn: func(ctx context.Context, id int64) (db.LandingRequest, error) {
			return mergedLR, nil
		},
	}
	rh := &mockWorkerRepoHostClient{}
	dispatcher := &mockWorkerWebhookDispatcher{}
	w := NewLandingWorker(q, rh, WithLandingWorkerWebhookDispatcher(dispatcher))

	err := w.PollOnce(context.Background())
	require.NoError(t, err)

	// The "landed" webhook fires AFTER the merge completes.
	require.Len(t, dispatcher.calls, 1)
	assert.Equal(t, int64(repoID), dispatcher.calls[0].repoID)
	assert.Equal(t, webhooks.EventTypeLandingRequest, dispatcher.calls[0].eventType)

	payload, ok := dispatcher.calls[0].payload.(webhooks.LandingRequestEventPayload)
	require.True(t, ok)
	assert.Equal(t, "landed", payload.Action)
	assert.Equal(t, "merged", payload.LandingRequest.State)
	assert.Equal(t, int64(5), payload.LandingRequest.Number)
	assert.Equal(t, "main", payload.LandingRequest.TargetBookmark)
	assert.Equal(t, []string{"k-a", "k-b"}, payload.LandingRequest.ChangeIDs)
	assert.Equal(t, "demo", payload.Repository.Name)
	assert.Equal(t, "alice", payload.Sender.Login)
}

func TestLandingWorker_DispatchesFailedWebhookOnMergeFailure(t *testing.T) {
	t.Parallel()

	taskID := int64(100)
	lrID := int64(88)
	repoID := int64(77)

	failedLR := workerLandingRequest(lrID, repoID)
	failedLR.State = "failed"

	q := &mockLandingWorkerQuerier{
		claimPendingLandingTaskFn: func(ctx context.Context) (db.LandingTask, error) {
			return workerTask(taskID, lrID, repoID), nil
		},
		getLandingRequestByIDFn: func(ctx context.Context, id int64) (db.LandingRequest, error) {
			return workerLandingRequest(lrID, repoID), nil
		},
		listLandingRequestChangesFn: func(ctx context.Context, arg db.ListLandingRequestChangesParams) ([]db.LandingRequestChange, error) {
			return []db.LandingRequestChange{
				{ID: 1, LandingRequestID: lrID, ChangeID: "k-a", PositionInStack: 1},
			}, nil
		},
		getRepoByIDFn: func(ctx context.Context, id int64) (db.Repository, error) {
			return workerRepo(repoID), nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			return db.User{ID: id, Username: "alice", LowerUsername: "alice"}, nil
		},
		markLandingRequestFailedFn: func(ctx context.Context, id int64) (db.LandingRequest, error) {
			return failedLR, nil
		},
	}
	rh := &mockWorkerRepoHostClient{
		landChangesFn: func(ctx context.Context, owner, repo string, req repohost.LandRequest) (repohost.LandResult, error) {
			return repohost.LandResult{}, fmt.Errorf("rebase conflict")
		},
	}
	dispatcher := &mockWorkerWebhookDispatcher{}
	w := NewLandingWorker(q, rh, WithLandingWorkerWebhookDispatcher(dispatcher))

	err := w.PollOnce(context.Background())
	require.NoError(t, err)

	// The "failed" webhook fires AFTER the failure is recorded.
	require.Len(t, dispatcher.calls, 1)
	assert.Equal(t, int64(repoID), dispatcher.calls[0].repoID)
	assert.Equal(t, webhooks.EventTypeLandingRequest, dispatcher.calls[0].eventType)

	payload, ok := dispatcher.calls[0].payload.(webhooks.LandingRequestEventPayload)
	require.True(t, ok)
	assert.Equal(t, "failed", payload.Action)
	assert.Equal(t, "failed", payload.LandingRequest.State)
	assert.Equal(t, int64(5), payload.LandingRequest.Number)
	assert.Equal(t, []string{"k-a"}, payload.LandingRequest.ChangeIDs)
}

func TestLandingWorker_NoWebhookFiredWithoutDispatcher(t *testing.T) {
	t.Parallel()

	taskID := int64(100)
	lrID := int64(88)
	repoID := int64(77)

	q := &mockLandingWorkerQuerier{
		claimPendingLandingTaskFn: func(ctx context.Context) (db.LandingTask, error) {
			return workerTask(taskID, lrID, repoID), nil
		},
		getLandingRequestByIDFn: func(ctx context.Context, id int64) (db.LandingRequest, error) {
			return workerLandingRequest(lrID, repoID), nil
		},
		listLandingRequestChangesFn: func(ctx context.Context, arg db.ListLandingRequestChangesParams) ([]db.LandingRequestChange, error) {
			return []db.LandingRequestChange{
				{ID: 1, LandingRequestID: lrID, ChangeID: "k-a", PositionInStack: 1},
			}, nil
		},
		getRepoByIDFn: func(ctx context.Context, id int64) (db.Repository, error) {
			return workerRepo(repoID), nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			return db.User{ID: id, Username: "alice", LowerUsername: "alice"}, nil
		},
	}
	rh := &mockWorkerRepoHostClient{}
	// No dispatcher wired — webhook dispatch should be silently skipped.
	w := NewLandingWorker(q, rh)

	err := w.PollOnce(context.Background())
	require.NoError(t, err)
	assert.True(t, q.mergeCalled)
	assert.True(t, q.markTaskDoneCalled)
}

func TestLandingWorker_WebhookFiredAfterMergeNotBefore(t *testing.T) {
	t.Parallel()

	taskID := int64(100)
	lrID := int64(88)
	repoID := int64(77)

	// Track ordering: the dispatcher must be called AFTER merge and markTaskDone.
	var mergeTime, taskDoneTime, dispatchTime time.Time

	q := &mockLandingWorkerQuerier{
		claimPendingLandingTaskFn: func(ctx context.Context) (db.LandingTask, error) {
			return workerTask(taskID, lrID, repoID), nil
		},
		getLandingRequestByIDFn: func(ctx context.Context, id int64) (db.LandingRequest, error) {
			return workerLandingRequest(lrID, repoID), nil
		},
		listLandingRequestChangesFn: func(ctx context.Context, arg db.ListLandingRequestChangesParams) ([]db.LandingRequestChange, error) {
			return []db.LandingRequestChange{
				{ID: 1, LandingRequestID: lrID, ChangeID: "k-a", PositionInStack: 1},
			}, nil
		},
		getRepoByIDFn: func(ctx context.Context, id int64) (db.Repository, error) {
			return workerRepo(repoID), nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			return db.User{ID: id, Username: "alice", LowerUsername: "alice"}, nil
		},
		mergeLandingRequestFn: func(ctx context.Context, id int64) (db.LandingRequest, error) {
			mergeTime = time.Now()
			lr := workerLandingRequest(lrID, repoID)
			lr.State = "merged"
			return lr, nil
		},
		markLandingTaskDoneFn: func(ctx context.Context, id int64) (db.LandingTask, error) {
			taskDoneTime = time.Now()
			return db.LandingTask{ID: id, Status: "done"}, nil
		},
	}
	rh := &mockWorkerRepoHostClient{}

	dispatcher := &mockWorkerWebhookDispatcher{}
	// Wrap dispatcher to record when it was called.
	timingDispatcher := &timingWebhookDispatcher{inner: dispatcher, onDispatch: func() {
		dispatchTime = time.Now()
	}}
	w := NewLandingWorker(q, rh, WithLandingWorkerWebhookDispatcher(timingDispatcher))

	err := w.PollOnce(context.Background())
	require.NoError(t, err)

	// Verify ordering: merge -> taskDone -> dispatch
	assert.False(t, mergeTime.IsZero(), "merge should have been called")
	assert.False(t, taskDoneTime.IsZero(), "markTaskDone should have been called")
	assert.False(t, dispatchTime.IsZero(), "dispatcher should have been called")
	assert.True(t, dispatchTime.After(mergeTime) || dispatchTime.Equal(mergeTime),
		"webhook dispatch must happen after merge")
	assert.True(t, dispatchTime.After(taskDoneTime) || dispatchTime.Equal(taskDoneTime),
		"webhook dispatch must happen after markTaskDone")
}

// timingWebhookDispatcher wraps a dispatcher and records timing.
type timingWebhookDispatcher struct {
	inner      webhooks.Dispatcher
	onDispatch func()
}

func (d *timingWebhookDispatcher) DispatchEvent(ctx context.Context, repoID int64, eventType webhooks.EventType, payload any) error {
	if d.onDispatch != nil {
		d.onDispatch()
	}
	return d.inner.DispatchEvent(ctx, repoID, eventType, payload)
}

func (d *timingWebhookDispatcher) DispatchOrgEvent(ctx context.Context, orgID int64, eventType webhooks.EventType, payload any) error {
	return d.inner.DispatchOrgEvent(ctx, orgID, eventType, payload)
}

func (m *mockLandingWorkerQuerier) RecordLandingSourceWorkspace(context.Context, int64, string) error {
	return nil
}

func (m *mockLandingWorkerQuerier) IsOutsiderLanding(context.Context, int64) (bool, error) {
	return false, nil
}
