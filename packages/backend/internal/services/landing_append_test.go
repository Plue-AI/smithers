package services

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

func appendFixture() repohost.LandRequest {
	base := strings.Repeat("a", 40)
	tip := strings.Repeat("b", 40)
	return repohost.LandRequest{ChangeIDs: []string{tip}, TargetBookmark: "main", ExpectedCommitID: &base, OperationKey: "landing/77/88/append/test", Append: &repohost.LandAppend{SourceCommitID: tip, SourceBaseCommitID: base, Description: "✨ feat: delivery"}}
}

func TestLandingAppendBoundsDurableStack(t *testing.T) {
	t.Parallel()
	request := appendFixture()
	request.ChangeIDs = make([]string, maxLandingStackChanges)
	for i := range request.ChangeIDs {
		request.ChangeIDs[i] = fmt.Sprintf("%040x", i+1)
	}
	request.Append.SourceCommitID = request.ChangeIDs[len(request.ChangeIDs)-1]
	require.NoError(t, validateLandingAppend(request))
	request.ChangeIDs = append([]string{strings.Repeat("f", 40)}, request.ChangeIDs...)
	require.Error(t, validateLandingAppend(request))
}

func TestLandingAppendAdmissionPinsStackForWorkerPolicyInspection(t *testing.T) {
	t.Parallel()
	request := appendFixture()
	first := strings.Repeat("c", 40)
	repository := landingRepo(nil)
	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repository, nil
		},
		getLandingRequestWithChangeIDsByNumberFn: func(context.Context, db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
			return landingDBRequestWithChangeIDs(88, repository.ID, 1, 1, []string{"k0", "k1"}), nil
		},
		listAllProtectedBookmarksByRepoFn: func(context.Context, int64) ([]db.ProtectedBookmark, error) {
			return []db.ProtectedBookmark{{Pattern: "main", RequireReview: true, RequireHumanApprovals: 1}}, nil
		},
	}
	rh := &mockLandingRepoHostClient{
		getChangeFn: func(_ context.Context, _, _, id string) (repohost.Change, error) {
			commit := request.Append.SourceCommitID
			if id == "k0" {
				commit = first
			}
			return repohost.Change{ChangeID: id, CommitID: commit}, nil
		},
		getChangeFilesFn: func(context.Context, string, string, string) ([]repohost.ChangeFile, error) {
			t.Fatal("append file inspection belongs to the existing durable worker")
			return nil, nil
		},
	}
	service := NewLandingService(q, rh)
	accepted, err := service.LandLandingRequest(context.Background(), landingTestUser(1, "alice"), "alice", "demo", 1,
		LandLandingRequestInput{CommitID: request.Append.SourceCommitID, ExpectedCommitID: request.ExpectedCommitID, Append: request.Append})
	require.NoError(t, err)
	require.Equal(t, "queued", accepted.State)
	var pinned repohost.LandRequest
	require.NoError(t, json.Unmarshal(q.lastCreateLandingTaskArg.AppendRequest, &pinned))
	require.Equal(t, []string{first, request.Append.SourceCommitID}, pinned.ChangeIDs)
	require.NoError(t, validateLandingAppend(pinned))
}

func TestLandingAppendPinsImmutableStackAndScopesReceipt(t *testing.T) {
	t.Parallel()
	request := appendFixture()
	originalTip := request.Append.SourceCommitID
	rh := &mockLandingRepoHostClient{getChangeFn: func(_ context.Context, _, _, id string) (repohost.Change, error) {
		return repohost.Change{ChangeID: id, CommitID: originalTip}, nil
	}}
	service := NewLandingService(&mockLandingQuerier{}, rh)
	row := landingDBRequestWithChangeIDs(88, 77, 1, 10, []string{"stable-change"})
	input := LandLandingRequestInput{CommitID: request.Append.SourceCommitID, ExpectedCommitID: request.ExpectedCommitID, Append: request.Append}
	first, err := service.prepareLandingAppend(context.Background(), workerRepo(77), "alice", "demo", row, input)
	require.NoError(t, err)
	again, err := service.prepareLandingAppend(context.Background(), workerRepo(77), "alice", "demo", row, input)
	require.NoError(t, err)
	require.JSONEq(t, string(first), string(again))
	var stored repohost.LandRequest
	require.NoError(t, json.Unmarshal(first, &stored))
	require.Equal(t, request.ChangeIDs, stored.ChangeIDs)
	require.Contains(t, stored.OperationKey, "landing/77/88/append/")
	other, err := service.prepareLandingAppend(context.Background(), workerRepo(78), "alice", "demo", row, input)
	require.NoError(t, err)
	require.NotEqual(t, string(first), string(other))
	input.Append.SourceCommitID = strings.Repeat("c", 40)
	_, err = service.prepareLandingAppend(context.Background(), workerRepo(77), "alice", "demo", row, input)
	require.ErrorContains(t, err, "append source must match")
}

type appendWorkerQueries struct {
	*mockLandingWorkerQuerier
	outsider bool
}

func (*appendWorkerQueries) RecordLandingSourceWorkspace(context.Context, int64, string) error {
	return nil
}
func (q *appendWorkerQueries) IsOutsiderLanding(context.Context, int64) (bool, error) {
	return q.outsider, nil
}

func (*appendWorkerQueries) ListSubmittedLandingApprovals(context.Context, int64) ([]db.LandingRequestReview, error) {
	return nil, nil
}
func (*appendWorkerQueries) ListTeamNamesForUserByRepository(context.Context, db.ListTeamNamesForUserByRepositoryParams) ([]string, error) {
	return nil, nil
}
func (*appendWorkerQueries) UpsertChange(_ context.Context, p db.UpsertChangeParams) (db.Change, error) {
	return db.Change{ChangeID: p.ChangeID, CommitID: p.CommitID, RevisionSeq: 1}, nil
}
func (*appendWorkerQueries) CountApprovedLandingRequestReviews(context.Context, int64) (int64, error) {
	return 0, nil
}
func (*appendWorkerQueries) CountCurrentApprovedLandingRequestReviews(context.Context, db.CountCurrentApprovedLandingRequestReviewsParams) (int64, error) {
	return 0, nil
}
func (*appendWorkerQueries) CountCurrentAgentLandingReviewCommits(context.Context, db.CountCurrentAgentLandingReviewCommitsParams) (int64, error) {
	return 0, nil
}

type appendWorkerHost struct {
	*mockWorkerRepoHostClient
	tip   string
	files []repohost.ChangeFile
}

func (h *appendWorkerHost) GetChange(_ context.Context, _, _, id string) (repohost.Change, error) {
	return repohost.Change{ChangeID: "stable-change", CommitID: h.tip}, nil
}
func (h *appendWorkerHost) GetChangeFiles(context.Context, string, string, string) ([]repohost.ChangeFile, error) {
	return h.files, nil
}
func (*appendWorkerHost) GetFileAtChange(context.Context, string, string, string, string) (repohost.FileContent, error) {
	return repohost.FileContent{}, &repohost.StatusError{StatusCode: 404}
}
func (*appendWorkerHost) ListDirectory(context.Context, string, string, string, string, string, int) ([]repohost.TreeEntry, error) {
	return nil, &repohost.StatusError{StatusCode: 404}
}
func (*appendWorkerHost) ListBookmarks(context.Context, string, string, string, int) ([]repohost.Bookmark, string, error) {
	return []repohost.Bookmark{{Name: "main", TargetChangeID: "main-change"}}, "", nil
}

func TestLandingAppendWorkerReplaysExactReceiptOrRechecksPolicyAndRevision(t *testing.T) {
	for _, mode := range []string{"new", "recovered", "old-route", "old-abi", "changed-revision", "protected", "lost-ack", "outsider", "outsider-unprotected"} {
		t.Run(mode, func(t *testing.T) {
			request := appendFixture()
			raw, err := json.Marshal(request)
			require.NoError(t, err)
			task := workerTask(100, 88, 77)
			task.AppendRequest = raw
			q := &appendWorkerQueries{mockLandingWorkerQuerier: &mockLandingWorkerQuerier{
				getLandingRequestByIDFn: func(context.Context, int64) (db.LandingRequest, error) { return workerLandingRequest(88, 77), nil },
				getRepoByIDFn:           func(context.Context, int64) (db.Repository, error) { return workerRepo(77), nil },
				getUserByIDFn:           func(context.Context, int64) (db.User, error) { return db.User{ID: 1, Username: "alice"}, nil },
				listLandingRequestChangesFn: func(context.Context, db.ListLandingRequestChangesParams) ([]db.LandingRequestChange, error) {
					return []db.LandingRequestChange{{ChangeID: "stable-change"}}, nil
				},
			}}
			if mode == "recovered" {
				q.countUnresolvedThreadsFn = func(context.Context, int64) (int64, error) {
					t.Fatal("a committed receipt must not rerun mutation gates")
					return 0, nil
				}
			}
			if mode == "protected" {
				q.listAllProtectedBookmarksFn = func(context.Context, int64) ([]db.ProtectedBookmark, error) {
					return []db.ProtectedBookmark{{Pattern: "main", RequireReview: true, RequireHumanApprovals: 1}}, nil
				}
			}
			calls := 0
			rh := &appendWorkerHost{mockWorkerRepoHostClient: &mockWorkerRepoHostClient{landChangesFn: func(_ context.Context, owner, repo string, got repohost.LandRequest) (repohost.LandResult, error) {
				calls++
				require.Equal(t, "alice", owner)
				require.Equal(t, "demo", repo)
				require.Equal(t, request.OperationKey, got.OperationKey)
				require.Equal(t, request.Append, got.Append)
				if got.LookupOnly {
					if mode == "old-route" {
						return repohost.LandResult{}, &repohost.StatusError{StatusCode: 404}
					}
					if mode == "old-abi" {
						return repohost.LandResult{}, fmt.Errorf("symbol unavailable")
					}
					if mode != "recovered" {
						return repohost.LandResult{}, &repohost.StatusError{StatusCode: 404, Code: "landing_receipt_missing"}
					}
				}
				if mode == "lost-ack" {
					return repohost.LandResult{}, fmt.Errorf("connection lost after native commit")
				}
				return repohost.LandResult{LandedCount: 1, TargetBookmark: "main", TargetCommitID: strings.Repeat("d", 40)}, nil
			}}, tip: request.Append.SourceCommitID}
			if mode == "changed-revision" {
				rh.tip = strings.Repeat("e", 40)
			}
			// A landing from a workspace that ran outsider-started work never
			// changes a protected path.
			if strings.HasPrefix(mode, "outsider") {
				q.outsider = true
				rh.files = []repohost.ChangeFile{{Path: "src/fix.ts"}, {Path: ".github/workflows/extra.yml"}}
				if mode == "outsider-unprotected" {
					rh.files = rh.files[:1]
				}
			}
			worker := NewLandingWorker(q, rh)
			err = worker.executeTask(context.Background(), task)
			switch mode {
			case "new", "outsider-unprotected":
				require.NoError(t, err)
				require.Equal(t, 2, calls)
				require.True(t, q.markLandingStartedCalled)
				require.True(t, q.mergeCalled)
			case "lost-ack":
				require.ErrorIs(t, err, errPostLandFinalize)
				require.Equal(t, 2, calls)
				require.True(t, q.markLandingStartedCalled)
				require.False(t, q.mergeCalled)
			case "recovered":
				require.NoError(t, err)
				require.Equal(t, 1, calls)
				require.False(t, q.markLandingStartedCalled)
				require.True(t, q.mergeCalled)
			default:
				require.Error(t, err)
				if mode == "outsider" {
					require.ErrorContains(t, err, "protected paths: .github/workflows/extra.yml")
				}
				require.Equal(t, 1, calls)
				require.False(t, q.markLandingStartedCalled)
				require.False(t, q.mergeCalled)
			}
		})
	}
}

func TestLandingAppendRetryConsultsOldReceiptBeforeAcceptingNewInput(t *testing.T) {
	for _, committed := range []bool{false, true} {
		t.Run(fmt.Sprint(committed), func(t *testing.T) {
			old := appendFixture()
			raw, err := json.Marshal(old)
			require.NoError(t, err)
			q := &mockLandingQuerier{getLandingTaskByLandingRequestIDFn: func(context.Context, int64) (db.LandingTask, error) {
				return db.LandingTask{Status: "failed", AppendRequest: raw}, nil
			}}
			called := false
			rh := &mockLandingRepoHostClient{landChangesFn: func(_ context.Context, _, _ string, request repohost.LandRequest) (repohost.LandResult, error) {
				called = true
				require.True(t, request.LookupOnly)
				require.Equal(t, old.ExpectedCommitID, request.ExpectedCommitID)
				if !committed {
					return repohost.LandResult{}, &repohost.StatusError{StatusCode: 404, Code: "landing_receipt_missing"}
				}
				return repohost.LandResult{LandedCount: 1, TargetBookmark: "main", TargetCommitID: strings.Repeat("f", 40)}, nil
			}}
			service := NewLandingService(q, rh)
			row := landingDBRequestWithChangeIDs(88, 77, 1, 10, []string{"stable-change"})
			expected := strings.Repeat("c", 40)
			_, recovered, err := service.recoverLandingAppend(context.Background(), workerRepo(77), "alice", "demo", row, LandLandingRequestInput{CommitID: old.Append.SourceCommitID, ExpectedCommitID: &expected, Append: old.Append})
			require.True(t, called)
			require.False(t, recovered)
			if committed {
				require.ErrorContains(t, err, "already committed")
			} else {
				require.NoError(t, err)
			}
		})
	}
}

func TestLandingAppendCannotBeDowngradedByOrdinaryOrAutoLand(t *testing.T) {
	for _, auto := range []bool{false, true} {
		t.Run(fmt.Sprint(auto), func(t *testing.T) {
			request := appendFixture()
			raw, err := json.Marshal(request)
			require.NoError(t, err)
			q := &mockLandingQuerier{getLandingTaskByLandingRequestIDFn: func(context.Context, int64) (db.LandingTask, error) {
				return db.LandingTask{Status: "failed", AppendRequest: raw}, nil
			}}
			service := NewLandingService(q, &mockLandingRepoHostClient{})
			_, _, err = service.enqueueLanding(context.Background(), landingTestUser(1, "alice"), workerRepo(77), landingDBRequestWithChangeIDs(88, 77, 1, 1, []string{"stable-change"}), auto, nil)
			require.ErrorContains(t, err, "cannot be converted")
			require.False(t, q.enqueueLandingRequestCalled)
			require.False(t, q.createLandingTaskCalled)
		})
	}
}

// An append into a held repository is queued again whether the hold meets
// its receipt lookup or its landing, and lands once the hold clears.
func TestLandingAppendIntoAHeldRepositoryIsQueuedAgain(t *testing.T) {
	request := appendFixture()
	raw, err := json.Marshal(request)
	require.NoError(t, err)
	q := &appendWorkerQueries{mockLandingWorkerQuerier: &mockLandingWorkerQuerier{
		claimPendingLandingTaskFn: func(context.Context) (db.LandingTask, error) {
			task := workerTask(100, 88, 77)
			task.AppendRequest = raw
			return task, nil
		},
		getLandingRequestByIDFn: func(context.Context, int64) (db.LandingRequest, error) { return workerLandingRequest(88, 77), nil },
		getRepoByIDFn:           func(context.Context, int64) (db.Repository, error) { return workerRepo(77), nil },
		getUserByIDFn:           func(context.Context, int64) (db.User, error) { return db.User{ID: 1, Username: "alice"}, nil },
		listLandingRequestChangesFn: func(context.Context, db.ListLandingRequestChangesParams) ([]db.LandingRequestChange, error) {
			return []db.LandingRequestChange{{ChangeID: "stable-change"}}, nil
		},
	}}
	held := &repohost.StatusError{StatusCode: 503, Code: repohost.RepositoryHeldCode, RetryAfter: 5}
	heldAt := "lookup"
	rh := &appendWorkerHost{mockWorkerRepoHostClient: &mockWorkerRepoHostClient{landChangesFn: func(_ context.Context, _, _ string, got repohost.LandRequest) (repohost.LandResult, error) {
		switch {
		case got.LookupOnly && heldAt == "lookup", !got.LookupOnly && heldAt == "land":
			return repohost.LandResult{}, held
		case got.LookupOnly:
			return repohost.LandResult{}, &repohost.StatusError{StatusCode: 404, Code: "landing_receipt_missing"}
		}
		return repohost.LandResult{LandedCount: 1, TargetBookmark: "main", TargetCommitID: strings.Repeat("d", 40)}, nil
	}}, tip: request.Append.SourceCommitID}
	worker := NewLandingWorker(q, rh)

	for i, at := range []string{"lookup", "land"} {
		heldAt = at
		require.NoError(t, worker.PollOnce(context.Background()))
		require.Len(t, q.deferHeldArgs, i+1, "held %s was not queued again", at)
		require.False(t, q.markLandingRequestFailedCalled)
		require.False(t, q.mergeCalled)
	}
	heldAt = ""
	require.NoError(t, worker.PollOnce(context.Background()))
	require.True(t, q.mergeCalled)
	require.False(t, q.markLandingRequestFailedCalled)
}
