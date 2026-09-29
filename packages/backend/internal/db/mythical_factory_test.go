package db

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"
)

func TestMythicalFactoryReceiptSurvivesUnrelatedPassesAndRecovers(t *testing.T) {
	ctx := context.Background()
	q, tx := newQueries(t)
	userID := mustCreateUser(t, tx, "mythical-factory-owner")
	repoID := mustCreateRepo(t, tx, userID, "mythical-factory-repo")

	requested, err := q.RequestMythicalBootstrap(ctx, repoID, userID, 1, false)
	require.NoError(t, err)
	require.Empty(t, requested.FactoryState)
	require.Empty(t, requested.FactoryError)

	claim := claimFactoryStack(t, q, repoID)
	generation, err := q.FinishMythicalStack(ctx, FinishMythicalStackParams{
		RepositoryID: repoID, Claim: claim.Claim, State: "active", LandedMain: "main-a",
		FactoryState: "failed", FactoryError: "factory launch unavailable",
	})
	require.NoError(t, err)
	require.Equal(t, requested.Generation, generation)
	row := getFactoryStack(t, q, repoID)
	require.Equal(t, "active", row.State)
	require.Empty(t, row.LastError)
	require.Equal(t, row.RequestedGeneration, row.ProcessedGeneration)
	require.Equal(t, "failed", row.FactoryState)
	require.Equal(t, "factory launch unavailable", row.FactoryError)

	requestFactoryStack(t, q, repoID)
	claim = claimFactoryStack(t, q, repoID)
	require.Equal(t, "failed", claim.FactoryState)
	require.Equal(t, "factory launch unavailable", claim.FactoryError)
	_, err = q.FinishMythicalStack(ctx, FinishMythicalStackParams{
		RepositoryID: repoID, Claim: claim.Claim, State: "active", LandedMain: "main-a",
	})
	require.NoError(t, err)
	row = getFactoryStack(t, q, repoID)
	require.Equal(t, "failed", row.FactoryState)
	require.Equal(t, "factory launch unavailable", row.FactoryError)
	require.Empty(t, row.LastError)

	requestFactoryStack(t, q, repoID)
	claim = claimFactoryStack(t, q, repoID)
	_, err = q.FinishMythicalStack(ctx, FinishMythicalStackParams{
		RepositoryID: repoID, Claim: claim.Claim, Failed: true,
		Error: "stack temporarily unavailable", BackoffSeconds: 0,
	})
	require.NoError(t, err)
	row = getFactoryStack(t, q, repoID)
	require.Equal(t, "stack temporarily unavailable", row.LastError)
	require.Less(t, row.ProcessedGeneration, row.RequestedGeneration)
	require.Equal(t, "failed", row.FactoryState)
	require.Equal(t, "factory launch unavailable", row.FactoryError)

	claim = claimFactoryStack(t, q, repoID)
	_, err = q.FinishMythicalStack(ctx, FinishMythicalStackParams{
		RepositoryID: repoID, Claim: claim.Claim, State: "active", FactoryState: "reconciled",
	})
	require.NoError(t, err)
	row = getFactoryStack(t, q, repoID)
	require.Equal(t, row.RequestedGeneration, row.ProcessedGeneration)
	require.Empty(t, row.LastError)
	require.Equal(t, "reconciled", row.FactoryState)
	require.Empty(t, row.FactoryError)
}

func TestMythicalFactoryReceiptClearsOnlyForNewMain(t *testing.T) {
	ctx := context.Background()
	q, tx := newQueries(t)
	userID := mustCreateUser(t, tx, "mythical-main-owner")
	repoID := mustCreateRepo(t, tx, userID, "mythical-main-repo")
	_, err := q.RequestMythicalBootstrap(ctx, repoID, userID, 1, false)
	require.NoError(t, err)

	claim := claimFactoryStack(t, q, repoID)
	_, err = q.FinishMythicalStack(ctx, FinishMythicalStackParams{
		RepositoryID: repoID, Claim: claim.Claim, State: "active", LandedMain: "main-a",
		FactoryState: "failed", FactoryError: "factory failed for main-a",
	})
	require.NoError(t, err)

	for _, landedMain := range []string{"", "main-a", "main-b"} {
		requestFactoryStack(t, q, repoID)
		claim = claimFactoryStack(t, q, repoID)
		_, err = q.FinishMythicalStack(ctx, FinishMythicalStackParams{
			RepositoryID: repoID, Claim: claim.Claim, State: "active", LandedMain: landedMain,
		})
		require.NoError(t, err)
		row := getFactoryStack(t, q, repoID)
		if landedMain == "main-b" {
			require.Equal(t, "main-b", row.LandedMain)
			require.Empty(t, row.FactoryState)
			require.Empty(t, row.FactoryError)
		} else {
			require.Equal(t, "main-a", row.LandedMain)
			require.Equal(t, "failed", row.FactoryState)
			require.Equal(t, "factory failed for main-a", row.FactoryError)
		}
	}
}

func TestMythicalFactoryReceiptRejectsLostClaim(t *testing.T) {
	ctx := context.Background()
	q, tx := newQueries(t)
	userID := mustCreateUser(t, tx, "mythical-claim-owner")
	repoID := mustCreateRepo(t, tx, userID, "mythical-claim-repo")
	_, err := q.RequestMythicalBootstrap(ctx, repoID, userID, 1, false)
	require.NoError(t, err)
	claim := claimFactoryStack(t, q, repoID)
	_, err = q.FinishMythicalStack(ctx, FinishMythicalStackParams{
		RepositoryID: repoID, Claim: claim.Claim, State: "active", LandedMain: "main-a",
		FactoryState: "failed", FactoryError: "original factory failure",
	})
	require.NoError(t, err)

	requestFactoryStack(t, q, repoID)
	oldClaim := claimFactoryStack(t, q, repoID)
	_, err = tx.Exec(ctx, `UPDATE mythical_stacks SET lease_expires_at = NOW() - interval '1 second' WHERE repository_id = $1`, repoID)
	require.NoError(t, err)
	newClaim := claimFactoryStack(t, q, repoID)
	require.Greater(t, newClaim.Claim, oldClaim.Claim)

	_, err = q.FinishMythicalStack(ctx, FinishMythicalStackParams{
		RepositoryID: repoID, Claim: oldClaim.Claim, State: "active", LandedMain: "main-b",
		FactoryState: "reconciled",
	})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	row := getFactoryStack(t, q, repoID)
	require.True(t, row.Running)
	require.Equal(t, "main-a", row.LandedMain)
	require.Equal(t, "failed", row.FactoryState)
	require.Equal(t, "original factory failure", row.FactoryError)

	_, err = q.FinishMythicalStack(ctx, FinishMythicalStackParams{
		RepositoryID: repoID, Claim: newClaim.Claim, State: "active", FactoryState: "reconciled",
	})
	require.NoError(t, err)
	row = getFactoryStack(t, q, repoID)
	require.False(t, row.Running)
	require.Equal(t, "reconciled", row.FactoryState)
	require.Empty(t, row.FactoryError)
}

func claimFactoryStack(t *testing.T, q *Queries, repositoryID int64) MythicalStack {
	t.Helper()
	claims, err := q.ClaimMythicalStacks(context.Background(), 1, 60)
	require.NoError(t, err)
	require.Len(t, claims, 1)
	require.Equal(t, repositoryID, claims[0].RepositoryID)
	return claims[0]
}

func requestFactoryStack(t *testing.T, q *Queries, repositoryID int64) {
	t.Helper()
	affected, err := q.RequestMythicalStack(context.Background(), repositoryID)
	require.NoError(t, err)
	require.Equal(t, int64(1), affected)
}

func getFactoryStack(t *testing.T, q *Queries, repositoryID int64) MythicalStack {
	t.Helper()
	row, err := q.GetMythicalStack(context.Background(), repositoryID)
	require.NoError(t, err)
	return row
}
