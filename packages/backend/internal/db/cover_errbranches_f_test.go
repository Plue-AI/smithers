package db

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

// TestFCov_ManyErrorBranches drives every previously-uncovered :many query
// through its Query-error, Scan-error, and rows.Err-error branches.
func TestFCov_ManyErrorBranches(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		name string
		call func(*Queries) error
	}{

		{"ListAllProtectedBookmarksByRepo", func(q *Queries) error { _, err := q.ListAllProtectedBookmarksByRepo(ctx, 1); return err }},
		{"ListAllRepos", func(q *Queries) error { _, err := q.ListAllRepos(ctx, ListAllReposParams{}); return err }},
		{"ListAPNSDevicesForUser", func(q *Queries) error { _, err := q.ListAPNSDevicesForUser(ctx, 1); return err }},
		{"ListBookmarksByRepo", func(q *Queries) error { _, err := q.ListBookmarksByRepo(ctx, ListBookmarksByRepoParams{}); return err }},
		{"ListChangesByRepo", func(q *Queries) error { _, err := q.ListChangesByRepo(ctx, ListChangesByRepoParams{}); return err }},
		{"ListCollaboratorsByRepo", func(q *Queries) error { _, err := q.ListCollaboratorsByRepo(ctx, 1); return err }},
		{"ListConflictsByChangeID", func(q *Queries) error {
			_, err := q.ListConflictsByChangeID(ctx, ListConflictsByChangeIDParams{})
			return err
		}},
		{"ListDevtoolsSnapshotsBySession", func(q *Queries) error {
			_, err := q.ListDevtoolsSnapshotsBySession(ctx, ListDevtoolsSnapshotsBySessionParams{})
			return err
		}},

		{"ListJjOperationsByRepo", func(q *Queries) error {
			_, err := q.ListJjOperationsByRepo(ctx, ListJjOperationsByRepoParams{})
			return err
		}},
		{"ListLandingRequestChanges", func(q *Queries) error {
			_, err := q.ListLandingRequestChanges(ctx, ListLandingRequestChangesParams{})
			return err
		}},
		{"ListLandingRequestComments", func(q *Queries) error {
			_, err := q.ListLandingRequestComments(ctx, ListLandingRequestCommentsParams{})
			return err
		}},
		{"ListLandingRequestReviews", func(q *Queries) error {
			_, err := q.ListLandingRequestReviews(ctx, ListLandingRequestReviewsParams{})
			return err
		}},
		{"ListLandingRequestsByRepoFilteredKeyset", func(q *Queries) error {
			_, err := q.ListLandingRequestsByRepoFilteredKeyset(ctx, ListLandingRequestsByRepoFilteredKeysetParams{})
			return err
		}},
		{"ListLandingRequestsWithChangeIDsByRepoFiltered", func(q *Queries) error {
			_, err := q.ListLandingRequestsWithChangeIDsByRepoFiltered(ctx, ListLandingRequestsWithChangeIDsByRepoFilteredParams{})
			return err
		}},
		{"ListMilestonesByRepo", func(q *Queries) error {
			_, err := q.ListMilestonesByRepo(ctx, ListMilestonesByRepoParams{})
			return err
		}},
		{"ListOAuth2AccessTokensByUser", func(q *Queries) error { _, err := q.ListOAuth2AccessTokensByUser(ctx, 1); return err }},
		{"ListOAuth2ApplicationsByOwner", func(q *Queries) error { _, err := q.ListOAuth2ApplicationsByOwner(ctx, 1); return err }},
		{"ListOrgRepos", func(q *Queries) error { _, err := q.ListOrgRepos(ctx, ListOrgReposParams{}); return err }},
		{"ListProtectedBookmarksByRepo", func(q *Queries) error {
			_, err := q.ListProtectedBookmarksByRepo(ctx, ListProtectedBookmarksByRepoParams{})
			return err
		}},
		{"ListPublicOrgRepos", func(q *Queries) error { _, err := q.ListPublicOrgRepos(ctx, ListPublicOrgReposParams{}); return err }},
		{"ListPublicUserRepos", func(q *Queries) error { _, err := q.ListPublicUserRepos(ctx, ListPublicUserReposParams{}); return err }},
		{"ListReadableReposForUser", func(q *Queries) error {
			_, err := q.ListReadableReposForUser(ctx, ListReadableReposForUserParams{})
			return err
		}},
		{"ListRepoForks", func(q *Queries) error { _, err := q.ListRepoForks(ctx, ListRepoForksParams{}); return err }},
		{"ListTeamReposByRepo", func(q *Queries) error { _, err := q.ListTeamReposByRepo(ctx, 1); return err }},
		{"ListUserRepos", func(q *Queries) error { _, err := q.ListUserRepos(ctx, ListUserReposParams{}); return err }},
		{"ListUserSessions", func(q *Queries) error { _, err := q.ListUserSessions(ctx, 1); return err }},
		{"ListUserSSHKeys", func(q *Queries) error { _, err := q.ListUserSSHKeys(ctx, 1); return err }},
		{"ListWikiPagesByRepo", func(q *Queries) error { _, err := q.ListWikiPagesByRepo(ctx, ListWikiPagesByRepoParams{}); return err }},
		{"SearchWikiPagesByRepo", func(q *Queries) error {
			_, err := q.SearchWikiPagesByRepo(ctx, SearchWikiPagesByRepoParams{})
			return err
		}},
		{"ListWorkflowTriggersByRepository", func(q *Queries) error { _, err := q.ListWorkflowTriggersByRepository(ctx, 1); return err }},
	}

	modes := []string{"query", "scan", "rows_err"}
	for _, tc := range cases {
		dbs := fcovManyDBs()
		for i, mode := range modes {
			t.Run(tc.name+"_"+mode, func(t *testing.T) {
				err := tc.call(New(dbs[i]))
				require.ErrorIs(t, err, fcovSentinel)
			})
		}
	}
}

// TestFCov_ExecRowsErrorBranches drives every previously-uncovered :execrows
// query through its Exec-error branch.
func TestFCov_ExecRowsErrorBranches(t *testing.T) {
	ctx := context.Background()
	q := New(fcovDB{execErr: fcovSentinel})
	cases := []struct {
		name string
		call func() error
	}{
		{"ConsumeOAuthState", func() error { _, err := q.ConsumeOAuthState(ctx, ConsumeOAuthStateParams{}); return err }},
		{"DeleteAccessTokenByIDAndUserID", func() error {
			_, err := q.DeleteAccessTokenByIDAndUserID(ctx, DeleteAccessTokenByIDAndUserIDParams{})
			return err
		}},
		{"DeleteBookmarkByName", func() error { _, err := q.DeleteBookmarkByName(ctx, DeleteBookmarkByNameParams{}); return err }},
		{"DeleteChangesByRepo", func() error { _, err := q.DeleteChangesByRepo(ctx, 1); return err }},
		{"DeleteConflictsByChangeID", func() error {
			_, err := q.DeleteConflictsByChangeID(ctx, DeleteConflictsByChangeIDParams{})
			return err
		}},
		{"DeleteExpiredAccessTokens", func() error { _, err := q.DeleteExpiredAccessTokens(ctx); return err }},
		{"DeleteOAuth2AccessTokenByHash", func() error { _, err := q.DeleteOAuth2AccessTokenByHash(ctx, "h"); return err }},
		{"DeleteOAuth2Application", func() error { _, err := q.DeleteOAuth2Application(ctx, DeleteOAuth2ApplicationParams{}); return err }},
		{"DeleteOAuth2RefreshTokenByHash", func() error { _, err := q.DeleteOAuth2RefreshTokenByHash(ctx, "h"); return err }},
		{"DeleteProtectedBookmarkByPattern", func() error {
			_, err := q.DeleteProtectedBookmarkByPattern(ctx, DeleteProtectedBookmarkByPatternParams{})
			return err
		}},
		{"MarkConflictResolved", func() error { _, err := q.MarkConflictResolved(ctx, MarkConflictResolvedParams{}); return err }},
		{"RotateOAuthAccountTokensCAS", func() error {
			_, err := q.RotateOAuthAccountTokensCAS(ctx, RotateOAuthAccountTokensCASParams{})
			return err
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			require.ErrorIs(t, tc.call(), fcovSentinel)
		})
	}
}
