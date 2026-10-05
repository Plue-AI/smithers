package services

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// TestLandingGitHubMergeQueriesOnProductSchema runs the hand-written SQL
// against the real product migrations, including 0035.
// Fixture users start at 1001: migration 0108 seeds the service user
// smithers-machines with the first users id.
func TestLandingGitHubMergeQueriesOnProductSchema(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	q := db.New(pool)
	_, err := pool.Exec(ctx, `INSERT INTO users(id, username, lower_username) VALUES (1001, 'smithers-canary', 'smithers-canary')`)
	require.NoError(t, err)
	var repository, landing int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id, name, lower_name) VALUES (1001, 'smithers', 'smithers') RETURNING id`).Scan(&repository))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO landing_requests(repository_id, number, title, author_id, target_bookmark, stack_size)
		VALUES ($1, 7, 'send upstream', 1001, 'main', 2) RETURNING id`, repository).Scan(&landing))
	_, err = pool.Exec(ctx, `INSERT INTO landing_request_changes(landing_request_id, change_id, position_in_stack) VALUES ($1, 'kbase', 1), ($1, 'ktip', 2)`, landing)
	require.NoError(t, err)
	// The projected changes lag repo-host; the merge records what GitHub merged.
	_, err = pool.Exec(ctx, `INSERT INTO changes(repository_id, change_id, commit_id) VALUES ($1, 'kbase', 'stale-base'), ($1, 'ktip', 'stale-tip')`, repository)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO change_revisions(repository_id, change_id, seq, commit_id, source) VALUES ($1, 'ktip', 5, $2, 'push')`, repository, landingMergeHead)
	require.NoError(t, err)
	var closed int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO landing_requests(repository_id, number, title, author_id, target_bookmark, state)
		VALUES ($1, 8, 'closed', 1001, 'main', 'closed') RETURNING id`, repository).Scan(&closed))
	numbers, err := q.ListOpenLandingNumbers(ctx, repository, 0, 50)
	require.NoError(t, err)
	assert.Equal(t, []int64{7}, numbers)
	numbers, err = q.ListOpenLandingNumbers(ctx, repository, 7, 50)
	require.NoError(t, err)
	assert.Empty(t, numbers)

	params := db.MergeLandingRequestFromGitHubParams{LandingRequestID: landing, GithubRepository: "smithersai/smithers", PullNumber: 41,
		HeadSha: landingMergeHead, MergeCommit: landingMergeCommit,
		// The stack GitHub merged, resolved on repo-host; the changes table may lag.
		Revisions: []byte(`{"kbase":"` + landingMergeCommit + `","ktip":"` + landingMergeHead + `"}`)}
	receipt, err := q.MergeLandingRequestFromGitHub(ctx, params)
	require.NoError(t, err)
	assert.Equal(t, db.LandingGitHubMerge{LandingRequestID: landing, GithubRepository: "smithersai/smithers", PullNumber: 41,
		HeadSha: landingMergeHead, MergeCommit: landingMergeCommit, CreatedAt: receipt.CreatedAt}, receipt)

	var state string
	var mergedAt bool
	var landed map[string]map[string]any
	require.NoError(t, pool.QueryRow(ctx, `SELECT state, merged_at IS NOT NULL, landed_revisions FROM landing_requests WHERE id = $1`, landing).Scan(&state, &mergedAt, &landed))
	assert.Equal(t, "merged", state)
	assert.True(t, mergedAt)
	assert.Equal(t, map[string]map[string]any{"kbase": {"commit_id": landingMergeCommit, "seq": nil},
		"ktip": {"commit_id": landingMergeHead, "seq": float64(5)}}, landed)

	// Only an open landing merges; a replay writes nothing.
	_, err = q.MergeLandingRequestFromGitHub(ctx, params)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	stored, err := q.GetLandingGitHubMerge(ctx, landing)
	require.NoError(t, err)
	assert.Equal(t, receipt, stored)

	// The receipt is part of the landing response.
	response := LandingRequestResponse{}
	service := &LandingService{queries: q}
	require.NoError(t, service.populateLandingGitHubMerge(ctx, db.LandingRequest{ID: landing, State: "merged"}, &response))
	assert.Equal(t, &LandingGitHubMergeReceipt{Repository: "smithersai/smithers", PullNumber: 41, HeadSHA: landingMergeHead, MergeCommit: landingMergeCommit}, response.GitHubMerge)
}
