package services

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// approvedWorkerQueries answers a count of current person approvals.
type approvedWorkerQueries struct {
	*appendWorkerQueries
	current int64
}

func (q *approvedWorkerQueries) CountCurrentApprovedLandingRequestReviews(context.Context, db.CountCurrentApprovedLandingRequestReviewsParams) (int64, error) {
	return q.current, nil
}

// releaseWorkerHost also serves a release bookmark.
type releaseWorkerHost struct{ *appendWorkerHost }

func (releaseWorkerHost) ListBookmarks(context.Context, string, string, string, int) ([]repohost.Bookmark, string, error) {
	return []repohost.Bookmark{{Name: "main", TargetChangeID: "main-change"}, {Name: "release", TargetChangeID: "release-change"}}, "", nil
}

// The worker re-checks, right before it writes the default bookmark, that
// an agent's landing carries a person's current approval (D-23), whatever
// the pre-enqueue gate saw. A person's own landing and an agent's landing
// onto another bookmark need none.
func TestLandingWorkerRefusesAnAgentsLandingOntoMainWithoutAPersonsApproval(t *testing.T) {
	for _, tc := range []struct {
		name     string
		agent    bool
		target   string
		approved int64
		lands    bool
	}{
		{name: "agent onto main", agent: true, target: "main", lands: false},
		{name: "agent onto main, approved", agent: true, target: "main", approved: 1, lands: true},
		{name: "person onto main", target: "main", lands: true},
		{name: "agent onto a branch", agent: true, target: "release", lands: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			landing := workerLandingRequest(88, 77)
			landing.AgentAuthored, landing.TargetBookmark = tc.agent, tc.target
			q := &approvedWorkerQueries{current: tc.approved, appendWorkerQueries: &appendWorkerQueries{mockLandingWorkerQuerier: &mockLandingWorkerQuerier{
				claimPendingLandingTaskFn: func(context.Context) (db.LandingTask, error) { return workerTask(100, 88, 77), nil },
				getLandingRequestByIDFn:   func(context.Context, int64) (db.LandingRequest, error) { return landing, nil },
				getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
					repository := workerRepo(77)
					repository.DefaultBookmark = "main"
					return repository, nil
				},
				listLandingRequestChangesFn: func(context.Context, db.ListLandingRequestChangesParams) ([]db.LandingRequestChange, error) {
					return []db.LandingRequestChange{{ChangeID: "stable-change"}}, nil
				},
			}}}
			rh := &appendWorkerHost{mockWorkerRepoHostClient: &mockWorkerRepoHostClient{}, tip: "tip-commit"}
			require.NoError(t, NewLandingWorker(q, releaseWorkerHost{rh}).PollOnce(context.Background()))
			assert.Equal(t, tc.lands, rh.landCalled)
			if !tc.lands {
				assert.Contains(t, q.lastFailTaskArg.LastError.String, agentLandingApprovalReason)
			}
		})
	}
}
