package db

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type githubRepoListingsSQLHDB = chunk5SQLHDB
type githubRepoListingsSQLHRow = chunk5SQLHRow

func TestGithubRepoListingsSQL_H_ClaimUpsertErrorAndDelete(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, uniqueTestUsername(t))

	listing, err := q.UpsertGitHubRepoListing(ctx, UpsertGitHubRepoListingParams{UserID: userID, Payload: json.RawMessage(`[{"name":"one"}]`)})
	require.NoError(t, err)
	assert.Equal(t, userID, listing.UserID)
	got, err := q.GetGitHubRepoListing(ctx, userID)
	require.NoError(t, err)
	assert.JSONEq(t, `[{"name":"one"}]`, string(got.Payload))

	claimed, err := q.ClaimGitHubRepoListingSync(ctx, userID)
	require.NoError(t, err)
	assert.Zero(t, claimed, "fresh listing cannot be reclaimed by a delayed stale reader")
	_, err = pool.Exec(ctx, "UPDATE github_repo_listings SET synced_at = NOW() - INTERVAL '6 minutes' WHERE user_id = $1", userID)
	require.NoError(t, err)
	claimed, err = q.ClaimGitHubRepoListingSync(ctx, userID)
	require.NoError(t, err)
	assert.Equal(t, int64(1), claimed)
	claimed, err = q.ClaimGitHubRepoListingSync(ctx, userID)
	require.NoError(t, err)
	assert.Zero(t, claimed)
	_, err = pool.Exec(ctx, "UPDATE github_repo_listings SET syncing_since = NOW() - INTERVAL '3 minutes' WHERE user_id = $1", userID)
	require.NoError(t, err)
	claimed, err = q.ClaimGitHubRepoListingSync(ctx, userID)
	require.NoError(t, err)
	assert.Equal(t, int64(1), claimed, "abandoned stale refresh can be taken over")

	require.NoError(t, q.SetGitHubRepoListingSyncError(ctx, SetGitHubRepoListingSyncErrorParams{UserID: userID, SyncError: "rate limited"}))
	got, err = q.GetGitHubRepoListing(ctx, userID)
	require.NoError(t, err)
	assert.Equal(t, "rate limited", got.SyncError.String)
	claimed, err = q.ClaimGitHubRepoListingSync(ctx, userID)
	require.NoError(t, err)
	assert.Equal(t, int64(1), claimed, "failed refresh retains stale payload and permits retry")

	listing, err = q.UpsertGitHubRepoListing(ctx, UpsertGitHubRepoListingParams{UserID: userID, Payload: json.RawMessage(`[{"name":"two"}]`)})
	require.NoError(t, err)
	assert.False(t, listing.SyncError.Valid)
	assert.False(t, listing.SyncingSince.Valid)
	claimed, err = q.ClaimGitHubRepoListingSync(ctx, userID)
	require.NoError(t, err)
	assert.Zero(t, claimed, "completed refresh fences old readers")
	claimed, err = q.ClaimGitHubRepoListingSync(ctx, 999999999)
	require.NoError(t, err)
	assert.Zero(t, claimed)

	require.NoError(t, q.DeleteGitHubRepoListing(ctx, userID))
	_, err = q.GetGitHubRepoListing(ctx, userID)
	require.ErrorIs(t, err, pgx.ErrNoRows)

	_ = mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.UpsertGitHubRepoListing(ctx, UpsertGitHubRepoListingParams{UserID: 999999999, Payload: json.RawMessage(`[]`)})
		return err
	})
}

func TestGithubRepoListingsSQL_H_ErrorBranches(t *testing.T) {
	sentinel := errors.New("github repo listings h failed")
	rowQ := New(githubRepoListingsSQLHDB{row: githubRepoListingsSQLHRow{err: sentinel}})
	_, err := rowQ.GetGitHubRepoListing(context.Background(), 1)
	require.ErrorIs(t, err, sentinel)
	_, err = rowQ.UpsertGitHubRepoListing(context.Background(), UpsertGitHubRepoListingParams{})
	require.ErrorIs(t, err, sentinel)

	execQ := New(githubRepoListingsSQLHDB{execErr: sentinel})
	_, err = execQ.ClaimGitHubRepoListingSync(context.Background(), 1)
	require.ErrorIs(t, err, sentinel)
	require.ErrorIs(t, execQ.DeleteGitHubRepoListing(context.Background(), 1), sentinel)
	require.ErrorIs(t, execQ.SetGitHubRepoListingSyncError(context.Background(), SetGitHubRepoListingSyncErrorParams{}), sentinel)
}
