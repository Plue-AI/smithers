package services

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestGitHubInboundCloseReopenProductionPoll(t *testing.T) {
	f := newPublicationFixture(t, false)
	first := f.todo("First", "first", f.main, "FIRST.txt", "first\n")
	f.wake()
	second := f.todo("Second", "second", first.CandidateHead, "SECOND.txt", "second\n")
	f.wake()
	pool := f.pool.(*pgxpool.Pool)
	ctx := context.Background()
	require.NoError(t, f.credentials.SetInstallation(ctx, f.installation))
	synced := NewGitHubSyncedRepoService(db.New(pool))
	require.NoError(t, synced.ConfigureInstallSync(pool))
	synced.BindInstallAuthority(f.credentials, true)
	client := NewGitHubUserReposService(db.New(pool), nil)
	synced.SetConditionalFetcherFactory(client.SyncedRepoConditionalFetcherFactory(f.connections))
	f.service.UseInstallGitHubPolling(synced)
	row, err := db.New(pool).EnrollGitHubSyncedRepo(ctx, db.EnrollGitHubSyncedRepoParams{OwnerLogin: "rehearsal-owner", RepoName: "app", InstallationID: pgtype.Int8{Int64: f.installation, Valid: true}, GithubRepositoryID: pgtype.Int8{Int64: 100, Valid: true}, SyncMetadata: true, EnrolledVia: GitHubSyncedRepoEnrolledViaInstallation})
	require.NoError(t, err)
	stop := runFetchedFixture(t, synced)
	defer stop()
	token, err := f.connections.CreateGitHubInstallationTokenForRepositoryOwner(ctx, f.userID, 0, "rehearsal-owner", "app", map[string]string{"pull_requests": "write"})
	require.NoError(t, err)
	patch := func(state string) {
		req, err := http.NewRequest(http.MethodPatch, f.fake.URL+"/repos/rehearsal-owner/app/pulls/2", strings.NewReader(`{"state":"`+state+`"}`))
		require.NoError(t, err)
		req.Header.Set("Authorization", "Bearer "+token.Token)
		resp, err := f.fake.Client().Do(req)
		require.NoError(t, err)
		require.Equal(t, 200, resp.StatusCode)
		require.NoError(t, resp.Body.Close())
	}
	patch("closed")
	require.NoError(t, synced.pollInstallPull(ctx, row, 2))
	require.Eventually(t, func() bool { return f.item(second.Number.Int64).State == "rejected" }, 10*time.Second, 20*time.Millisecond)
	dropped := f.item(second.Number.Int64)
	require.Equal(t, "closed on GitHub", dropped.Reason)
	require.NotNil(t, mythicalChecksOf(dropped).GitHubClosedAt)
	require.NoError(t, synced.pollInstallPull(ctx, row, 2))
	require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM product_job_events WHERE event_type='todo.github_dropped'`))
	writes := len(f.writes())
	patch("open")
	require.NoError(t, synced.pollInstallPull(ctx, row, 2))
	require.Eventually(t, func() bool { return f.item(second.Number.Int64).State == "proposed" }, 10*time.Second, 20*time.Millisecond)
	reopened := f.item(second.Number.Int64)
	require.Equal(t, second.StackPosition.Int64, reopened.StackPosition.Int64)
	require.Equal(t, second.Attempt, reopened.Attempt)
	require.Equal(t, second.CandidateHead, reopened.CandidateHead)
	require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM product_job_events WHERE event_type='todo.github_in_review'`))
	require.Len(t, f.writes(), writes+1, "only the person's reopen, no consumer write")
	require.NoError(t, synced.pollInstallPull(ctx, row, 2))
	require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM product_job_events WHERE event_type='todo.github_in_review'`))
}
