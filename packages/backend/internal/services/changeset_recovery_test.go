package services

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

func reviewChangesetInput() CreateChangesetInput {
	return CreateChangesetInput{Members: []ChangesetMemberInput{{Repo: "api", ChangeID: "aaaa"}, {Repo: "web", ChangeID: "bbbb"}}}
}

func TestChangesetRejectsMemberWithoutRepositoryPermissions(t *testing.T) {
	q, rh, svc := seedChangesetFixture(t)
	actor := &db.User{ID: 1}
	created, err := svc.CreateChangeset(t.Context(), actor, "acme", reviewChangesetInput())
	require.NoError(t, err)
	q.permissions = map[int64]string{}
	_, err = svc.CreateChangeset(t.Context(), actor, "acme", reviewChangesetInput())
	require.Error(t, err)
	_, err = svc.GetChangeset(t.Context(), actor, "acme", created.ID)
	require.Error(t, err)
	_, err = svc.MaterializeChangeset(t.Context(), actor.ID, created.ID)
	require.Error(t, err)
	_, err = svc.LandChangeset(t.Context(), actor, "acme", created.ID)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	require.Equal(t, 403, apiErr.Status)
	listed, err := svc.ListChangesets(t.Context(), actor, "acme", 1, 30)
	require.NoError(t, err)
	require.Empty(t, listed)
	require.Empty(t, rh.landCalls)
}

func TestChangesetRequiresProtectedBookmarkReviews(t *testing.T) {
	q, rh, svc := seedChangesetFixture(t)
	actor := &db.User{ID: 1}
	created, err := svc.CreateChangeset(t.Context(), actor, "acme", reviewChangesetInput())
	require.NoError(t, err)
	q.rules = map[int64][]db.ProtectedBookmark{11: {{Pattern: "main", RequireReview: true, RequireHumanApprovals: 1}}}
	_, err = svc.LandChangeset(t.Context(), actor, "acme", created.ID)
	require.Error(t, err)
	require.Empty(t, rh.landCalls)
}

type lostChangesetResponse struct {
	*fakeChangesetRepoHost
	lost bool
}

func (rh *lostChangesetResponse) LandChanges(ctx context.Context, owner, repo string, req repohost.LandRequest) (repohost.LandResult, error) {
	result, err := rh.fakeChangesetRepoHost.LandChanges(ctx, owner, repo, req)
	if err == nil && !req.LookupOnly && !rh.lost {
		rh.lost = true
		return repohost.LandResult{}, errors.New("connection lost after storage commit")
	}
	return result, err
}
func TestChangesetRecoversLostResponseWithoutLandingTwice(t *testing.T) {
	q, rh, svc := seedChangesetFixture(t)
	actor := &db.User{ID: 1}
	created, err := svc.CreateChangeset(t.Context(), actor, "acme", reviewChangesetInput())
	require.NoError(t, err)
	svc = NewChangesetService(q, &lostChangesetResponse{fakeChangesetRepoHost: rh}, nil, nil)
	_, err = svc.LandChangeset(t.Context(), actor, "acme", created.ID)
	require.Error(t, err)
	require.Equal(t, "landing", q.changesets[created.ID].State)
	landed, err := svc.LandChangeset(t.Context(), actor, "acme", created.ID)
	require.NoError(t, err)
	require.Equal(t, "landed", landed.State)
	require.Len(t, rh.landCalls, 3)
}

// refusedRevert refuses the first revert landing (a definite 409) and
// loses the response of the second after it lands.
type refusedRevert struct {
	*fakeChangesetRepoHost
	reverts int
}

func (rh *refusedRevert) LandChanges(ctx context.Context, owner, repo string, req repohost.LandRequest) (repohost.LandResult, error) {
	if strings.Contains(req.OperationKey, "/revert/") && !req.LookupOnly {
		rh.reverts++
		switch rh.reverts {
		case 1:
			return repohost.LandResult{}, &repohost.StatusError{StatusCode: 409, Message: "landing produced merge conflicts"}
		case 2:
			if _, err := rh.fakeChangesetRepoHost.LandChanges(ctx, owner, repo, req); err != nil {
				return repohost.LandResult{}, err
			}
			return repohost.LandResult{}, errors.New("connection lost after storage commit")
		}
	}
	return rh.fakeChangesetRepoHost.LandChanges(ctx, owner, repo, req)
}

func TestChangesetRollbackRetriesARefusedRevertOnce(t *testing.T) {
	q, rh, svc := seedChangesetFixture(t)
	actor := &db.User{ID: 1}
	created, err := svc.CreateChangeset(t.Context(), actor, "acme", reviewChangesetInput())
	require.NoError(t, err)
	rh.landFail["acme/web"] = &repohost.StatusError{StatusCode: 409, Message: "second member conflicts"}
	host := &refusedRevert{fakeChangesetRepoHost: rh}
	svc = NewChangesetService(q, host, nil, nil)

	_, err = svc.LandChangeset(t.Context(), actor, "acme", created.ID)
	require.ErrorContains(t, err, "rollback incomplete")
	_, err = svc.LandChangeset(t.Context(), actor, "acme", created.ID)
	require.ErrorContains(t, err, "rollback incomplete")
	require.Equal(t, 1, strings.Count(q.changesets[created.ID].FailureReason, "rollback incomplete"))

	// The third call recovers the lost revert's receipt instead of landing
	// it again, finishes the rollback, and starts a new attempt.
	_, err = svc.LandChangeset(t.Context(), actor, "acme", created.ID)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	require.Equal(t, 409, apiErr.Status)
	require.NotContains(t, err.Error(), "rollback incomplete")
	require.Equal(t, 2, strings.Count(strings.Join(rh.bookmarkOps, " "), "backout acme/api/aaaa/"), "a refused revert is backed out again; a lost one is not")
	for _, member := range q.csMembers[created.ID] {
		require.Empty(t, member.LandedCommitID)
	}
}

type changesetFinalizeFailure struct {
	*fakeChangesetQueries
	failed bool
}

func (q *changesetFinalizeFailure) MarkChangesetLanded(ctx context.Context, arg db.MarkChangesetLandedParams) (db.Changeset, error) {
	if !q.failed {
		q.failed = true
		return db.Changeset{}, errors.New("database temporarily unavailable")
	}
	return q.fakeChangesetQueries.MarkChangesetLanded(ctx, arg)
}
func TestChangesetRecoversFinalizationWithoutMovingBookmarks(t *testing.T) {
	q, rh, svc := seedChangesetFixture(t)
	actor := &db.User{ID: 1}
	created, err := svc.CreateChangeset(t.Context(), actor, "acme", reviewChangesetInput())
	require.NoError(t, err)
	svc = NewChangesetService(&changesetFinalizeFailure{fakeChangesetQueries: q}, rh, nil, nil)
	_, err = svc.LandChangeset(t.Context(), actor, "acme", created.ID)
	require.Error(t, err)
	landed, err := svc.LandChangeset(t.Context(), actor, "acme", created.ID)
	require.NoError(t, err)
	require.Equal(t, "landed", landed.State)
	require.Len(t, rh.landCalls, 3)
}

func TestChangesetRejectsUnjournaledLegacyLanding(t *testing.T) {
	q, rh, svc := seedChangesetFixture(t)
	actor := &db.User{ID: 1}
	created, err := svc.CreateChangeset(t.Context(), actor, "acme", reviewChangesetInput())
	require.NoError(t, err)
	cs := q.changesets[created.ID]
	cs.State, cs.LandingPlan = "landing", nil
	q.changesets[created.ID] = cs
	_, err = svc.LandChangeset(t.Context(), actor, "acme", created.ID)
	require.ErrorContains(t, err, "no recovery plan")
	require.Empty(t, rh.landCalls)
}
