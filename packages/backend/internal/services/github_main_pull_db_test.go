package services

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// TestGitHubMainPullQueriesOnProductSchema runs the hand-written SQL against
// the real product migrations, including 0024.
// Fixture users start at 1001: migration 0108 seeds the service user
// smithers-machines with the first users id.
func TestGitHubMainPullQueriesOnProductSchema(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	q := db.New(pool)
	_, err := pool.Exec(ctx, `INSERT INTO users(id, username, lower_username) VALUES (1001, 'smithers-canary', 'smithers-canary'), (1002, 'other', 'other')`)
	require.NoError(t, err)
	var canary, stale, unrelated int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id, name, lower_name) VALUES (1001, 'smithers', 'smithers') RETURNING id`).Scan(&canary))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id, name, lower_name) VALUES (1002, 'copy', 'copy') RETURNING id`).Scan(&stale))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id, name, lower_name) VALUES (1002, 'unrelated', 'unrelated') RETURNING id`).Scan(&unrelated))
	// canary: ready import of smithersai/smithers. stale: imported it once,
	// then a newer ready import points elsewhere, so it is not a candidate.
	for _, row := range []struct {
		repo          int64
		user          int64
		owner, source string
		age           string
	}{
		{canary, 1001, "smithers-canary", "smithers", "1 hour"},
		{stale, 1002, "other", "smithers", "2 hours"},
		{stale, 1002, "other", "elsewhere", "1 hour"},
	} {
		_, err = pool.Exec(ctx, `INSERT INTO import_jobs (user_id, github_owner, github_repo, repo_owner, repo_name, branch, status, repository_id, created_at)
			VALUES ($1, CASE WHEN $2 = 'smithers' THEN 'SmithersAI' ELSE 'someone' END, $2, $3, 'x', 'main', 'ready', $4, NOW() - $5::interval)`,
			row.user, row.source, row.owner, row.repo, row.age)
		require.NoError(t, err)
	}

	ids, err := q.ListRepositoryIDsForGitHubSource(ctx, "smithersai", "SMITHERS")
	require.NoError(t, err)
	assert.Equal(t, []int64{canary}, ids)

	// Discovery tracks GitHub-sourced repositories once; unrelated never.
	n, err := q.RequestUntrackedGithubMainPulls(ctx, 50)
	require.NoError(t, err)
	assert.EqualValues(t, 2, n)
	n, err = q.RequestUntrackedGithubMainPulls(ctx, 50)
	require.NoError(t, err)
	assert.Zero(t, n)
	_, err = q.GetGithubMainPull(ctx, unrelated)
	assert.Error(t, err)

	// Coalescing: two more requests before a claim still give one claim.
	for range 2 {
		_, err = q.RequestGithubMainPull(ctx, canary)
		require.NoError(t, err)
	}
	claimed, err := q.ClaimGithubMainPulls(ctx, 10, 900)
	require.NoError(t, err)
	require.Len(t, claimed, 2)
	var first db.GithubMainPull
	for _, row := range claimed {
		if row.RepositoryID == canary {
			first = row
		}
	}
	assert.EqualValues(t, 3, first.ClaimedGeneration)
	again, err := q.ClaimGithubMainPulls(ctx, 10, 900)
	require.NoError(t, err)
	assert.Empty(t, again, "a live lease is not claimed twice")

	// A request during the run keeps the row due after success.
	_, err = q.RequestGithubMainPull(ctx, canary)
	require.NoError(t, err)
	written, err := q.FinishGithubMainPull(ctx, db.FinishGithubMainPullParams{RepositoryID: canary, Claim: first.Claim, State: "synced",
		GithubRepository: "smithersai/smithers", Branch: "main", Policy: "pull", PolicyCommit: "g", GithubHead: "g", SmithersHead: "g"})
	require.NoError(t, err)
	assert.EqualValues(t, 1, written)
	row, err := q.GetGithubMainPull(ctx, canary)
	require.NoError(t, err)
	assert.Equal(t, "pending", row.State)
	assert.EqualValues(t, 3, row.SyncedGeneration)
	assert.EqualValues(t, 4, row.RequestedGeneration)
	assert.Equal(t, "pull", row.Policy)
	assert.True(t, row.LastSyncedAt.Valid)

	// The stale owner's late finish is fenced out.
	written, err = q.FinishGithubMainPull(ctx, db.FinishGithubMainPullParams{RepositoryID: canary, Claim: first.Claim, State: "failed", Error: "late"})
	require.NoError(t, err)
	assert.Zero(t, written)

	// Failure keeps the request and backs off; empty receipt fields keep values.
	claimed, err = q.ClaimGithubMainPulls(ctx, 10, 900)
	require.NoError(t, err)
	require.Len(t, claimed, 1)
	written, err = q.FinishGithubMainPull(ctx, db.FinishGithubMainPullParams{RepositoryID: canary, Claim: claimed[0].Claim, State: "failed",
		Error: "diverged", BackoffSeconds: 3600})
	require.NoError(t, err)
	assert.EqualValues(t, 1, written)
	row, err = q.GetGithubMainPull(ctx, canary)
	require.NoError(t, err)
	assert.Equal(t, "failed", row.State)
	assert.Equal(t, "diverged", row.LastError)
	assert.Equal(t, "pull", row.Policy)
	assert.EqualValues(t, 1, row.Attempts)
	claimed, err = q.ClaimGithubMainPulls(ctx, 10, 900)
	require.NoError(t, err)
	assert.Empty(t, claimed, "a failure waits for its backoff")

	// An expired lease is re-claimed (restart).
	_, err = pool.Exec(ctx, `UPDATE github_main_pulls SET next_attempt_at = NOW() - interval '1 second' WHERE repository_id = $1`, canary)
	require.NoError(t, err)
	claimed, err = q.ClaimGithubMainPulls(ctx, 10, 0)
	require.NoError(t, err)
	require.Len(t, claimed, 1)
	_, err = pool.Exec(ctx, `UPDATE github_main_pulls SET lease_expires_at = NOW() - interval '1 second' WHERE repository_id = $1`, canary)
	require.NoError(t, err)
	reclaimed, err := q.ClaimGithubMainPulls(ctx, 10, 900)
	require.NoError(t, err)
	require.Len(t, reclaimed, 1)
	assert.Greater(t, reclaimed[0].Claim, claimed[0].Claim)
	_, err = q.FinishGithubMainPull(ctx, db.FinishGithubMainPullParams{RepositoryID: canary, Claim: reclaimed[0].Claim, State: "synced"})
	require.NoError(t, err)

	// The poll re-checks stale pull rows only.
	_, err = pool.Exec(ctx, `UPDATE github_main_pulls SET last_checked_at = NOW() - interval '1 hour'`)
	require.NoError(t, err)
	n, err = q.RequestStaleGithubMainPulls(ctx, 300, 6*3600)
	require.NoError(t, err)
	assert.EqualValues(t, 1, n)

	// The install's sync lists every row and its Retry makes every row due
	// now, a failed one's backoff included.
	_, err = pool.Exec(ctx, `UPDATE github_main_pulls SET next_attempt_at = NOW() + interval '1 hour'`)
	require.NoError(t, err)
	listed, err := q.ListGithubMainPulls(ctx)
	require.NoError(t, err)
	require.Len(t, listed, 2)
	assert.Equal(t, []int64{min(canary, stale), max(canary, stale)}, []int64{listed[0].RepositoryID, listed[1].RepositoryID})
	n, err = q.RequestAllGithubMainPulls(ctx)
	require.NoError(t, err)
	assert.EqualValues(t, 2, n)
	for _, before := range listed {
		after, err := q.GetGithubMainPull(ctx, before.RepositoryID)
		require.NoError(t, err)
		assert.Equal(t, before.RequestedGeneration+1, after.RequestedGeneration)
		assert.False(t, after.NextAttemptAt.Time.After(time.Now()), "due now")
	}

	// The ref-push feed check resolves owner/name through owner namespaces.
	pull, err := q.IsGithubMainPullMirror(ctx, "smithers-canary", "smithers")
	require.NoError(t, err)
	assert.True(t, pull)
	pull, err = q.IsGithubMainPullMirror(ctx, "other", "copy")
	require.NoError(t, err)
	assert.False(t, pull)

	// A lost source forgets the whole policy tuple.
	claimed, err = q.ClaimGithubMainPulls(ctx, 1, 900)
	require.NoError(t, err)
	require.Len(t, claimed, 1)
	require.Equal(t, canary, claimed[0].RepositoryID)
	_, err = q.FinishGithubMainPull(ctx, db.FinishGithubMainPullParams{RepositoryID: canary, Claim: claimed[0].Claim, State: "skipped",
		Error: "no GitHub source", ResetPolicy: true})
	require.NoError(t, err)
	row, err = q.GetGithubMainPull(ctx, canary)
	require.NoError(t, err)
	assert.Equal(t, "skipped", row.State)
	assert.Empty(t, row.Policy)
	assert.Empty(t, row.PolicyCommit)
	assert.Empty(t, row.GithubRepository)
	pull, err = q.IsGithubMainPullMirror(ctx, "smithers-canary", "smithers")
	require.NoError(t, err)
	assert.False(t, pull)
}
