package db

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGithubMirrorSyncRunQueries_RoundTrip(t *testing.T) {
	ctx := context.Background()
	q, tx := newQueries(t)
	userID := mustCreateUser(t, tx, uniqueTestUsername(t))
	repositoryID := mustCreateRepo(t, tx, userID, uniqueTestRepoName(t))
	otherRepositoryID := mustCreateRepo(t, tx, userID, uniqueTestRepoName(t))

	run, err := q.CreateGithubMirrorSyncRun(ctx, CreateGithubMirrorSyncRunParams{
		RepositoryID: repositoryID,
		RequestedBy:  pgtype.Int8{Int64: userID, Valid: true},
	})
	require.NoError(t, err)
	assert.Equal(t, "queued", run.State)
	assert.False(t, run.StartedAt.Valid)
	assert.False(t, run.FinishedAt.Valid)
	_ = mustExpectQueryError(t, tx, func(spQ *Queries) error {
		_, createErr := spQ.CreateGithubMirrorSyncRun(ctx, CreateGithubMirrorSyncRunParams{
			RepositoryID: repositoryID,
			RequestedBy:  pgtype.Int8{Int64: userID, Valid: true},
		})
		return createErr
	})
	_, err = q.CreateGithubMirrorSyncRun(ctx, CreateGithubMirrorSyncRunParams{
		RepositoryID: otherRepositoryID,
		RequestedBy:  pgtype.Int8{Int64: userID, Valid: true},
	})
	require.NoError(t, err, "a different repository has its own active-run slot")

	got, err := q.GetGithubMirrorSyncRun(ctx, GetGithubMirrorSyncRunParams{ID: run.ID, RepositoryID: repositoryID})
	require.NoError(t, err)
	assert.Equal(t, run.ID, got.ID)
	_, err = q.GetGithubMirrorSyncRun(ctx, GetGithubMirrorSyncRunParams{ID: run.ID, RepositoryID: otherRepositoryID})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	claimed, err := q.MarkGithubMirrorSyncRunRunning(ctx, run.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(1), claimed)
	claimed, err = q.MarkGithubMirrorSyncRunRunning(ctx, run.ID)
	require.NoError(t, err)
	assert.Zero(t, claimed)

	ref := UpsertGithubMirrorSyncRefResultParams{
		RunID: run.ID, Name: "refs/heads/main", FromRevision: "old", ToRevision: "new", Status: "pending",
	}
	require.Equal(t, int64(1), upsertMirrorRefResult(t, q, ref))
	ref.Status = "succeeded"
	require.Equal(t, int64(1), upsertMirrorRefResult(t, q, ref))
	refs, err := q.ListGithubMirrorSyncRefResults(ctx, run.ID)
	require.NoError(t, err)
	require.Len(t, refs, 1)
	assert.Equal(t, "old", refs[0].FromRevision)
	assert.Equal(t, "new", refs[0].ToRevision)
	assert.Equal(t, "succeeded", refs[0].Status)

	require.NoError(t, q.FinishGithubMirrorSyncRun(ctx, FinishGithubMirrorSyncRunParams{ID: run.ID, State: "succeeded"}))
	got, err = q.GetGithubMirrorSyncRun(ctx, GetGithubMirrorSyncRunParams{ID: run.ID, RepositoryID: repositoryID})
	require.NoError(t, err)
	assert.Equal(t, "succeeded", got.State)
	assert.True(t, got.StartedAt.Valid)
	assert.True(t, got.FinishedAt.Valid)
	_, err = q.CreateGithubMirrorSyncRun(ctx, CreateGithubMirrorSyncRunParams{
		RepositoryID: repositoryID,
		RequestedBy:  pgtype.Int8{Int64: userID, Valid: true},
	})
	require.NoError(t, err, "a settled run releases the repository active-run slot")

	// A completed run cannot acquire new ref receipts.
	require.Equal(t, int64(0), upsertMirrorRefResult(t, q, UpsertGithubMirrorSyncRefResultParams{
		RunID: run.ID, Name: "refs/heads/empty", Status: "pending",
	}))
	refs, err = q.ListGithubMirrorSyncRefResults(ctx, run.ID)
	require.NoError(t, err)
	require.Len(t, refs, 1)
}

func TestGithubMirrorSyncSuccessUpdatesRepositoryHealth(t *testing.T) {
	ctx := context.Background()
	q, tx := newQueries(t)
	user := mustCreateUser(t, tx, uniqueTestUsername(t))
	repo := mustCreateRepo(t, tx, user, uniqueTestRepoName(t))
	other := mustCreateRepo(t, tx, user, uniqueTestRepoName(t))
	_, err := tx.Exec(ctx, "UPDATE repositories SET mirror_status='behind', mirror_behind_refs=2, mirror_failed_refs=1, default_bookmark='trunk' WHERE id=$1", repo)
	require.NoError(t, err)
	run, err := q.CreateGithubMirrorSyncRun(ctx, CreateGithubMirrorSyncRunParams{RepositoryID: repo, RequestedBy: pgtype.Int8{Int64: user, Valid: true}})
	require.NoError(t, err)
	_, err = q.MarkGithubMirrorSyncRunRunning(ctx, run.ID)
	require.NoError(t, err)
	rows, err := q.FinishSuccessfulGithubMirrorSyncRun(ctx, FinishSuccessfulGithubMirrorSyncRunParams{ID: run.ID, VerifiedRefs: []byte(`{"refs/heads/main":"other-head","refs/heads/trunk":"verified-head"}`)})
	require.NoError(t, err)
	require.Equal(t, int64(1), rows)
	var status, head string
	var behind, failed int
	require.NoError(t, tx.QueryRow(ctx, "SELECT mirror_status, mirror_behind_refs, mirror_failed_refs, last_mirror_github_head FROM repositories WHERE id=$1", repo).Scan(&status, &behind, &failed, &head))
	assert.Equal(t, "synced", status)
	assert.Zero(t, behind)
	assert.Zero(t, failed)
	assert.Equal(t, "verified-head", head)
	receipt, err := q.GetGithubMirrorSyncRun(ctx, GetGithubMirrorSyncRunParams{ID: run.ID, RepositoryID: repo})
	require.NoError(t, err)
	assert.Equal(t, "succeeded", receipt.State)
	require.NoError(t, tx.QueryRow(ctx, "SELECT mirror_status FROM repositories WHERE id=$1", other).Scan(&status))
	assert.NotEqual(t, "synced", status)
	rows, err = q.FinishSuccessfulGithubMirrorSyncRun(ctx, FinishSuccessfulGithubMirrorSyncRunParams{ID: run.ID, VerifiedRefs: []byte(`{}`)})
	require.NoError(t, err)
	assert.Zero(t, rows, "a completed receipt cannot overwrite newer health")
}

func upsertMirrorRefResult(t *testing.T, q *Queries, arg UpsertGithubMirrorSyncRefResultParams) int64 {
	t.Helper()
	rows, err := q.UpsertGithubMirrorSyncRefResult(context.Background(), arg)
	require.NoError(t, err)
	return rows
}
