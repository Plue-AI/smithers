package db

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGitMirrorFailedRunReplacesEarlierSyncedHealth(t *testing.T) {
	ctx := context.Background()
	q, tx := newQueries(t)
	user := mustCreateUser(t, tx, uniqueTestUsername(t))
	repo := mustCreateRepo(t, tx, user, uniqueTestRepoName(t))
	requester := pgtype.Int8{Int64: user, Valid: true}

	success, err := q.CreateGithubMirrorSyncRun(ctx, CreateGithubMirrorSyncRunParams{RepositoryID: repo, RequestedBy: requester})
	require.NoError(t, err)
	_, err = q.MarkGithubMirrorSyncRunRunning(ctx, success.ID)
	require.NoError(t, err)
	_, err = q.FinishSuccessfulGithubMirrorSyncRun(ctx, FinishSuccessfulGithubMirrorSyncRunParams{
		ID: success.ID, VerifiedRefs: []byte(`{"refs/heads/main":"old-head"}`),
	})
	require.NoError(t, err)

	failure, err := q.CreateGithubMirrorSyncRun(ctx, CreateGithubMirrorSyncRunParams{RepositoryID: repo, RequestedBy: requester})
	require.NoError(t, err)
	_, err = q.MarkGithubMirrorSyncRunRunning(ctx, failure.ID)
	require.NoError(t, err)
	require.NoError(t, q.UpsertGithubMirrorSyncRefResult(ctx, UpsertGithubMirrorSyncRefResultParams{
		RunID: failure.ID, Name: "refs/heads/main", FromRevision: "old-head", ToRevision: "source-head",
		Status: "failed", Error: "non-fast-forward target",
	}))
	require.NoError(t, q.UpsertGithubMirrorSyncRefResult(ctx, UpsertGithubMirrorSyncRefResultParams{
		RunID: failure.ID, Name: "refs/heads/feature", ToRevision: "new-feature", Status: "pending",
	}))
	require.NoError(t, q.FinishGithubMirrorSyncRun(ctx, FinishGithubMirrorSyncRunParams{ID: failure.ID, State: "failed"}))

	var status string
	var behind, failed int32
	var lastError pgtype.Text
	var lastHead pgtype.Text
	require.NoError(t, tx.QueryRow(ctx, `SELECT mirror_status, mirror_behind_refs, mirror_failed_refs,
		last_mirror_error, last_mirror_github_head FROM repositories WHERE id=$1`, repo).
		Scan(&status, &behind, &failed, &lastError, &lastHead))
	assert.Equal(t, "failed", status)
	assert.Equal(t, int32(2), behind)
	assert.Equal(t, int32(1), failed)
	assert.True(t, lastError.Valid)
	assert.Contains(t, lastError.String, "non-fast-forward target")
	assert.Equal(t, "old-head", lastHead.String, "failure must preserve the last verified target head")
}

func TestGitMirrorNoOpResultDoesNotGrantPruneOwnership(t *testing.T) {
	ctx := context.Background()
	q, tx := newQueries(t)
	user := mustCreateUser(t, tx, uniqueTestUsername(t))
	repo := mustCreateRepo(t, tx, user, uniqueTestRepoName(t))
	run, err := q.CreateGithubMirrorSyncRun(ctx, CreateGithubMirrorSyncRunParams{
		RepositoryID: repo, RequestedBy: pgtype.Int8{Int64: user, Valid: true},
	})
	require.NoError(t, err)
	_, err = q.MarkGithubMirrorSyncRunRunning(ctx, run.ID)
	require.NoError(t, err)
	require.NoError(t, q.UpsertGithubMirrorSyncRefResult(ctx, UpsertGithubMirrorSyncRefResultParams{
		RunID: run.ID, Name: "refs/heads/feature", FromRevision: "github-head", ToRevision: "github-head", Status: "succeeded",
	}))
	_, err = q.FinishSuccessfulGithubMirrorSyncRun(ctx, FinishSuccessfulGithubMirrorSyncRunParams{ID: run.ID, VerifiedRefs: []byte(`{"refs/heads/feature":"github-head"}`)})
	require.NoError(t, err)

	_, err = q.GetLatestSucceededGithubMirrorSyncRefResult(ctx, GetLatestSucceededGithubMirrorSyncRefResultParams{
		RepositoryID: repo, Name: "refs/heads/feature",
	})
	require.ErrorIs(t, err, pgx.ErrNoRows, "an observed no-op must not authorize deletion of a GitHub-owned ref")
}

func TestGitMirrorRunAdmissionExpiresOnlyStaleRunForRepository(t *testing.T) {
	for _, oldState := range []string{"queued", "running"} {
		t.Run(oldState, func(t *testing.T) {
			ctx := context.Background()
			q, tx := newQueries(t)
			user := mustCreateUser(t, tx, uniqueTestUsername(t))
			repo := mustCreateRepo(t, tx, user, uniqueTestRepoName(t))
			otherRepo := mustCreateRepo(t, tx, user, uniqueTestRepoName(t))
			requester := pgtype.Int8{Int64: user, Valid: true}
			old, err := q.CreateGithubMirrorSyncRun(ctx, CreateGithubMirrorSyncRunParams{RepositoryID: repo, RequestedBy: requester})
			require.NoError(t, err)
			if oldState == "running" {
				_, err = q.MarkGithubMirrorSyncRunRunning(ctx, old.ID)
				require.NoError(t, err)
			}
			unrelated, err := q.CreateGithubMirrorSyncRun(ctx, CreateGithubMirrorSyncRunParams{RepositoryID: otherRepo, RequestedBy: requester})
			require.NoError(t, err)
			_ = mustExpectQueryError(t, tx, func(spQ *Queries) error {
				_, createErr := spQ.CreateGithubMirrorSyncRun(ctx, CreateGithubMirrorSyncRunParams{
					RepositoryID: repo, RequestedBy: requester,
				})
				return createErr
			})

			// The worker deadline is ten minutes; twelve minutes includes a guard
			// for finalization after its context expires.
			_, err = tx.Exec(ctx, `UPDATE github_mirror_sync_runs
				SET created_at = NOW() - INTERVAL '12 minutes',
				    updated_at = NOW() - INTERVAL '12 minutes'
				WHERE id IN ($1, $2)`, old.ID, unrelated.ID)
			require.NoError(t, err)

			fresh, err := q.CreateGithubMirrorSyncRun(ctx, CreateGithubMirrorSyncRunParams{RepositoryID: repo, RequestedBy: requester})
			require.NoError(t, err, "a worker older than its deadline must not block the repository forever")
			var oldAfter, unrelatedAfter string
			require.NoError(t, tx.QueryRow(ctx, `SELECT state FROM github_mirror_sync_runs WHERE id=$1`, old.ID).Scan(&oldAfter))
			require.NoError(t, tx.QueryRow(ctx, `SELECT state FROM github_mirror_sync_runs WHERE id=$1`, unrelated.ID).Scan(&unrelatedAfter))
			assert.Equal(t, "failed", oldAfter)
			assert.Equal(t, "queued", unrelatedAfter, "admission cannot expire a different repository's run")

			_, err = q.MarkGithubMirrorSyncRunRunning(ctx, fresh.ID)
			require.NoError(t, err)
			rows, err := q.FinishSuccessfulGithubMirrorSyncRun(ctx, FinishSuccessfulGithubMirrorSyncRunParams{
				ID: fresh.ID, VerifiedRefs: []byte(`{"refs/heads/main":"fresh-head"}`),
			})
			require.NoError(t, err)
			require.Equal(t, int64(1), rows)
			require.NoError(t, q.FinishGithubMirrorSyncRun(ctx, FinishGithubMirrorSyncRunParams{ID: old.ID, State: "failed"}))
			rows, err = q.FinishSuccessfulGithubMirrorSyncRun(ctx, FinishSuccessfulGithubMirrorSyncRunParams{
				ID: old.ID, VerifiedRefs: []byte(`{"refs/heads/main":"old-head"}`),
			})
			require.NoError(t, err)
			assert.Zero(t, rows)
			var health, head string
			require.NoError(t, tx.QueryRow(ctx, `SELECT mirror_status, last_mirror_github_head FROM repositories WHERE id=$1`, repo).Scan(&health, &head))
			assert.Equal(t, "synced", health)
			assert.Equal(t, "fresh-head", head)
		})
	}
}
