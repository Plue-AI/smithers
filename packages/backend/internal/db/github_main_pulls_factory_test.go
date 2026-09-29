package db

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestGithubMainPullFactoryOutcomePersistsIndependently(t *testing.T) {
	ctx := context.Background()
	q, tx := newQueries(t)
	userID := mustCreateUser(t, tx, "factory-pull-owner")
	repoID := mustCreateRepo(t, tx, userID, "factory-pull-repo")

	requested, err := q.RequestGithubMainPull(ctx, repoID)
	require.NoError(t, err)
	require.Equal(t, "pending", requested.State)
	require.Empty(t, requested.FactoryState)
	require.Empty(t, requested.FactoryError)

	claims, err := q.ClaimGithubMainPulls(ctx, 1, 60)
	require.NoError(t, err)
	require.Len(t, claims, 1)
	require.Equal(t, repoID, claims[0].RepositoryID)
	require.Equal(t, "running", claims[0].State)

	finished, err := q.FinishGithubMainPull(ctx, FinishGithubMainPullParams{
		RepositoryID: repoID,
		Claim:        claims[0].Claim,
		State:        "synced",
		FactoryState: "failed",
		FactoryError: "factory launch unavailable",
	})
	require.NoError(t, err)
	require.Equal(t, int64(1), finished)

	row, err := q.GetGithubMainPull(ctx, repoID)
	require.NoError(t, err)
	require.Equal(t, "synced", row.State)
	require.Equal(t, row.RequestedGeneration, row.SyncedGeneration)
	require.Empty(t, row.LastError)
	require.Equal(t, "failed", row.FactoryState)
	require.Equal(t, "factory launch unavailable", row.FactoryError)

	_, err = q.RequestGithubMainPull(ctx, repoID)
	require.NoError(t, err)
	claims, err = q.ClaimGithubMainPulls(ctx, 1, 60)
	require.NoError(t, err)
	require.Len(t, claims, 1)
	require.Equal(t, "failed", claims[0].FactoryState)
	require.Equal(t, "factory launch unavailable", claims[0].FactoryError)

	finished, err = q.FinishGithubMainPull(ctx, FinishGithubMainPullParams{
		RepositoryID: repoID,
		Claim:        claims[0].Claim,
		State:        "failed",
		Error:        "GitHub temporarily unavailable",
	})
	require.NoError(t, err)
	require.Equal(t, int64(1), finished)

	row, err = q.GetGithubMainPull(ctx, repoID)
	require.NoError(t, err)
	require.Equal(t, "failed", row.State)
	require.Equal(t, "GitHub temporarily unavailable", row.LastError)
	require.Equal(t, "failed", row.FactoryState)
	require.Equal(t, "factory launch unavailable", row.FactoryError)
	require.Less(t, row.SyncedGeneration, row.RequestedGeneration)

	claims, err = q.ClaimGithubMainPulls(ctx, 1, 60)
	require.NoError(t, err)
	require.Len(t, claims, 1)
	require.Equal(t, "failed", claims[0].FactoryState)
	require.Equal(t, "factory launch unavailable", claims[0].FactoryError)
	finished, err = q.FinishGithubMainPull(ctx, FinishGithubMainPullParams{
		RepositoryID: repoID,
		Claim:        claims[0].Claim,
		State:        "synced",
		FactoryState: "reconciled",
	})
	require.NoError(t, err)
	require.Equal(t, int64(1), finished)
	row, err = q.GetGithubMainPull(ctx, repoID)
	require.NoError(t, err)
	require.Equal(t, "synced", row.State)
	require.Equal(t, "reconciled", row.FactoryState)
	require.Empty(t, row.FactoryError)

	_, err = q.RequestGithubMainPull(ctx, repoID)
	require.NoError(t, err)
	claims, err = q.ClaimGithubMainPulls(ctx, 1, 60)
	require.NoError(t, err)
	require.Len(t, claims, 1)
	finished, err = q.FinishGithubMainPull(ctx, FinishGithubMainPullParams{
		RepositoryID: repoID,
		Claim:        claims[0].Claim,
		State:        "skipped",
		ResetPolicy:  true,
	})
	require.NoError(t, err)
	require.Equal(t, int64(1), finished)
	row, err = q.GetGithubMainPull(ctx, repoID)
	require.NoError(t, err)
	require.Equal(t, "skipped", row.State)
	require.Empty(t, row.FactoryState)
	require.Empty(t, row.FactoryError)
}

func TestGithubMainPullFactoryReceiptClearsWhenSourceOrPolicyChanges(t *testing.T) {
	for _, tc := range []struct {
		name             string
		githubRepository string
		policy           string
	}{
		{name: "new GitHub source", githubRepository: "other/repo"},
		{name: "policy is no longer pull", policy: "push"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			q, tx := newQueries(t)
			userID := mustCreateUser(t, tx, "factory-source-owner")
			repoID := mustCreateRepo(t, tx, userID, "factory-source-repo")
			_, err := q.RequestGithubMainPull(ctx, repoID)
			require.NoError(t, err)
			claims, err := q.ClaimGithubMainPulls(ctx, 1, 60)
			require.NoError(t, err)
			require.Len(t, claims, 1)
			finished, err := q.FinishGithubMainPull(ctx, FinishGithubMainPullParams{
				RepositoryID:     repoID,
				Claim:            claims[0].Claim,
				State:            "synced",
				GithubRepository: "owner/repo",
				Policy:           "pull",
				FactoryState:     "failed",
				FactoryError:     "old source failed",
			})
			require.NoError(t, err)
			require.Equal(t, int64(1), finished)
			_, err = q.RequestGithubMainPull(ctx, repoID)
			require.NoError(t, err)
			claims, err = q.ClaimGithubMainPulls(ctx, 1, 60)
			require.NoError(t, err)
			require.Len(t, claims, 1)
			finished, err = q.FinishGithubMainPull(ctx, FinishGithubMainPullParams{
				RepositoryID:     repoID,
				Claim:            claims[0].Claim,
				State:            "skipped",
				GithubRepository: tc.githubRepository,
				Policy:           tc.policy,
			})
			require.NoError(t, err)
			require.Equal(t, int64(1), finished)
			row, err := q.GetGithubMainPull(ctx, repoID)
			require.NoError(t, err)
			require.Empty(t, row.FactoryState)
			require.Empty(t, row.FactoryError)
		})
	}
}
