package services

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/stretchr/testify/require"
)

func TestGitHubInboundCloseReopenProductionPoll(t *testing.T) {
	for _, mode := range []string{"GitHub close", "Smithers drop", "free position", "lost close response", "occupied position", "legacy drop", "expired drop"} {
		t.Run(mode, func(t *testing.T) { testGitHubInboundCloseReopen(t, mode) })
	}
}

func testGitHubInboundCloseReopen(t *testing.T, mode string) {
	localDrop := mode != "GitHub close"
	h := newMergeHarness(t)
	f := h.publicationFixture
	base := f.main
	if mode != "lost close response" {
		first := f.todo("First", "first", base, "FIRST.txt", "first\n")
		f.wake()
		base = first.CandidateHead
	}
	second := f.todo("Second", "second", base, "SECOND.txt", "second\n")
	f.wake()
	var third db.MythicalItem
	if mode != "lost close response" && mode != "free position" {
		third = f.todo("Third", "third", second.CandidateHead, "THIRD.txt", "third\n")
		f.wake()
	}
	for range 4 {
		if len(f.item(second.Number.Int64).PendingOp) == 0 {
			break
		}
		h.pass()
	}
	require.Empty(t, f.item(second.Number.Int64).PendingOp, "settle publication before Drop")
	second = f.item(second.Number.Int64)
	if third.Number.Valid {
		third = f.item(third.Number.Int64)
	}
	if localDrop {
		_, err := h.drop(second.Number.Int64, "drop-for-reopen")
		require.NoError(t, err)
		if mode == "lost close response" {
			h.fake.LoseNextResponses(fmt.Sprintf("/repos/rehearsal-owner/app/pulls/%d", second.PRNumber.Int64), 1)
		}
		h.pass()
		if mode == "lost close response" {
			require.Equal(t, "close", h.operation(second.Number.Int64).Kind)
			require.Equal(t, "unknown", h.operation(second.Number.Int64).State)
			require.Equal(t, "closed", h.pull(second.PRNumber.Int64).State)
		}
		if mode != "lost close response" {
			h.pass()
		}
		if mode != "lost close response" {
			require.Empty(t, f.item(second.Number.Int64).PendingOp)
			require.Equal(t, "closed", f.item(second.Number.Int64).PRState)
		}
		require.Equal(t, "cancelled", f.item(second.Number.Int64).State, "following a closed PR must not rebuild a dropped TODO")
		if mode == "occupied position" {
			_, err = h.q.PlaceMythicalItem(h.ctx, third.ID, second.StackPosition.Int64)
			require.NoError(t, err)
		}
	}
	if mode == "legacy drop" || mode == "expired drop" {
		dropped := f.item(second.Number.Int64)
		checks := mythicalChecksOf(dropped)
		checks.GitHubClosedAt = nil
		checks.GitHubClosedPosition = 0
		if mode == "expired drop" {
			checks.Dropped.At = time.Now().Add(-8 * 24 * time.Hour)
		}
		dropped.Checks = checks.encode()
		_, err := h.q.SaveMythicalItem(h.ctx, dropped)
		require.NoError(t, err)
		if mode == "legacy drop" {
			// Pre-upgrade Drop retained its old position, which the next
			// live TODO now occupies. Reopening must append atomically.
			_, err = h.q.PlaceMythicalItem(h.ctx, dropped.ID, second.StackPosition.Int64)
			require.NoError(t, err)
		}
	}
	pool := f.pool.(*pgxpool.Pool)
	ctx := context.Background()
	synced, row := configureInboundPullPolling(t, f)
	stop := runFetchedFixture(t, synced)
	defer stop()
	token, err := f.connections.CreateGitHubInstallationTokenForRepositoryOwner(ctx, f.userID, 0, "rehearsal-owner", "app", map[string]string{"pull_requests": "write"})
	require.NoError(t, err)
	patch := func(state string) {
		req, err := http.NewRequest(http.MethodPatch, f.fake.URL+fmt.Sprintf("/repos/rehearsal-owner/app/pulls/%d", second.PRNumber.Int64), strings.NewReader(`{"state":"`+state+`"}`))
		require.NoError(t, err)
		req.Header.Set("Authorization", "Bearer "+token.Token)
		resp, err := f.fake.Client().Do(req)
		require.NoError(t, err)
		require.Equal(t, 200, resp.StatusCode)
		require.NoError(t, resp.Body.Close())
	}
	if !localDrop {
		patch("closed")
		require.NoError(t, synced.pollInstallPull(ctx, row, second.PRNumber.Int64))
		require.Eventually(t, func() bool { return f.item(second.Number.Int64).State == "rejected" }, 10*time.Second, 20*time.Millisecond)
		dropped := f.item(second.Number.Int64)
		require.Equal(t, "closed on GitHub", dropped.Reason)
		require.NotNil(t, mythicalChecksOf(dropped).GitHubClosedAt)
		require.NoError(t, synced.pollInstallPull(ctx, row, second.PRNumber.Int64))
		require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM product_job_events WHERE event_type='todo.github_dropped'`))
	}
	if mode == "lost close response" {
		stop()
		patch("open")
		require.Equal(t, "open", h.pull(second.PRNumber.Int64).State)
		require.NoError(t, synced.pollInstallPull(ctx, row, second.PRNumber.Int64))
		var raw []byte
		require.NoError(t, pool.QueryRow(ctx, `SELECT payload FROM product_job_requests WHERE operation='github.fetched.consume'`).Scan(&raw))
		var fact gitHubFetchedObject
		require.NoError(t, json.Unmarshal(raw, &fact))
		tx, err := pool.Begin(ctx)
		require.NoError(t, err)
		_, consumeErr := f.service.consumeGitHubPullTodos(ctx, tx, fact)
		require.NoError(t, tx.Rollback(ctx))
		require.Error(t, consumeErr, "reopen must wait for the uncertain close to settle")
		require.Equal(t, "unknown", h.operation(second.Number.Int64).State)
		require.Equal(t, "cancelled", h.item(second.Number.Int64).State)
		require.Equal(t, 0, fetchedCount(t, pool, `SELECT count(*) FROM product_job_events WHERE event_type='todo.github_in_review'`))
		// Reconciliation proves the App close but observes the person's later
		// reopen. It must leave the open PR followed, without another close.
		h.pass()
		require.Empty(t, f.item(second.Number.Int64).PendingOp)
		require.Equal(t, "open", f.item(second.Number.Int64).PRState)
	}
	// Webhook hints and scheduled polling must retain the dropped PR.
	followed, err := db.New(pool).ListMythicalOpenPullItems(ctx, f.repoID)
	require.NoError(t, err)
	found := false
	for _, item := range followed {
		if item.ID == second.ID {
			found = true
		}
	}
	if mode == "expired drop" {
		require.False(t, found, "row updates must not renew an expired drop")
		patch("open")
		require.NoError(t, synced.pollInstallPull(ctx, row, second.PRNumber.Int64))
		require.Eventually(t, func() bool {
			return fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE operation='github.fetched.consume' AND state='completed'`) > 0
		}, 10*time.Second, 20*time.Millisecond)
		require.Equal(t, "cancelled", f.item(second.Number.Int64).State)
		require.Equal(t, 0, fetchedCount(t, pool, `SELECT count(*) FROM product_job_events WHERE event_type='todo.github_in_review'`))
		return
	}
	require.True(t, found, "dropped PR must remain in the polling selection")
	require.True(t, mythicalReopenFollowed(f.item(second.Number.Int64), time.Now()))
	writes := len(f.writes())
	if mode == "lost close response" {
		defer runFetchedFixture(t, synced)()
	} else {
		patch("open")
	}
	// Drive the existing stack worker's scheduled read as well as delivery.
	f.wake()
	require.Eventually(t, func() bool { return f.item(second.Number.Int64).State == "proposed" }, 10*time.Second, 20*time.Millisecond)
	reopened := f.item(second.Number.Int64)
	if localDrop && third.Number.Valid {
		require.Equal(t, second.StackPosition.Int64+1, reopened.StackPosition.Int64)
	} else {
		require.Equal(t, second.StackPosition.Int64, reopened.StackPosition.Int64)
	}
	require.Equal(t, second.Attempt, reopened.Attempt)
	require.Equal(t, second.CandidateHead, reopened.CandidateHead)
	require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM product_job_events WHERE event_type='todo.github_in_review'`))
	expectedWrites := writes + 1
	if mode == "lost close response" {
		expectedWrites = writes
	}
	require.Len(t, f.writes(), expectedWrites, "only the person's reopen, no consumer write")
	require.Equal(t, second.Generation, reopened.Generation)
	require.Equal(t, second.CandidateBase, reopened.CandidateBase)
	require.Nil(t, mythicalChecksOf(reopened).GitHubClosedAt)
	if localDrop {
		require.NotNil(t, mythicalChecksOf(reopened).Dropped, "retain the original drop receipt")
		_, err := h.drop(second.Number.Int64, "drop-for-reopen")
		require.NoError(t, err, "replayed drop cannot drop the reopened TODO again")
		require.Equal(t, "proposed", f.item(second.Number.Int64).State)
	}
	require.NoError(t, synced.pollInstallPull(ctx, row, second.PRNumber.Int64))
	require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM product_job_events WHERE event_type='todo.github_in_review'`))
}

func configureInboundPullPolling(t *testing.T, f *publicationFixture) (*GitHubSyncedRepoService, db.GithubSyncedRepo) {
	t.Helper()
	ctx := context.Background()
	pool := f.pool.(*pgxpool.Pool)
	require.NoError(t, f.credentials.SetInstallation(ctx, f.installation))
	synced := NewGitHubSyncedRepoService(db.New(pool))
	require.NoError(t, synced.ConfigureInstallSync(pool))
	synced.BindInstallAuthority(f.credentials, true)
	client := NewGitHubUserReposService(db.New(pool), nil)
	synced.SetConditionalFetcherFactory(client.SyncedRepoConditionalFetcherFactory(f.connections))
	f.service.UseInstallGitHubPolling(synced)
	row, err := db.New(pool).EnrollGitHubSyncedRepo(ctx, db.EnrollGitHubSyncedRepoParams{OwnerLogin: "rehearsal-owner", RepoName: "app", InstallationID: pgtype.Int8{Int64: f.installation, Valid: true}, GithubRepositoryID: pgtype.Int8{Int64: 100, Valid: true}, SyncMetadata: true, EnrolledVia: GitHubSyncedRepoEnrolledViaInstallation})
	require.NoError(t, err)
	return synced, row
}

func TestGitHubInboundQueuedOpenCannotUndoDrop(t *testing.T) {
	for _, timing := range []string{"before drop", "after drop before close"} {
		t.Run(timing, func(t *testing.T) {
			h := newMergeHarness(t)
			n, _, pr := h.first("Keep dropped")
			synced, row := configureInboundPullPolling(t, h.publicationFixture)
			ctx := context.Background()
			if timing == "before drop" {
				require.NoError(t, synced.pollInstallPull(ctx, row, pr))
			}
			_, err := h.drop(n, "drop-stale-open")
			require.NoError(t, err)
			if timing == "after drop before close" {
				require.NoError(t, synced.pollInstallPull(ctx, row, pr))
			}
			h.pass()
			h.pass()
			require.Empty(t, h.item(n).PendingOp)
			require.Equal(t, "closed", h.pull(pr).State)
			writes := len(h.writes())
			defer runFetchedFixture(t, synced)()
			h.pass() // the first scheduled read after close settlement
			pool := h.pool.(*pgxpool.Pool)
			require.Eventually(t, func() bool {
				return fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE operation='github.fetched.consume' AND state<>'completed'`) == 0
			}, 10*time.Second, 20*time.Millisecond)
			require.Equal(t, "cancelled", h.item(n).State, "an old open snapshot is not a person's reopen")
			require.Equal(t, 0, fetchedCount(t, pool, `SELECT count(*) FROM product_job_events WHERE event_type='todo.github_in_review'`))
			require.Len(t, h.writes(), writes)
		})
	}
}

func TestGitHubInboundReopenWithSamePayloadAfterDrop(t *testing.T) {
	h := newMergeHarness(t)
	n, _, pr := h.first("Rapid reopen")
	before := h.item(n)
	original := h.pull(pr)
	synced, row := configureInboundPullPolling(t, h.publicationFixture)
	ctx := context.Background()
	pool := h.pool.(*pgxpool.Pool)
	defer runFetchedFixture(t, synced)()
	require.NoError(t, synced.pollInstallPull(ctx, row, pr))
	require.Eventually(t, func() bool {
		return fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE operation='github.fetched.consume' AND state='completed'`) == 1
	}, 5*time.Second, 10*time.Millisecond)
	originalVersion, err := synced.cachedPullVersion(ctx, pool, row.ID, pr)
	require.NoError(t, err)
	_, err = h.drop(n, "drop-rapid")
	require.NoError(t, err)
	h.fake.LoseNextResponses(fmt.Sprintf("/repos/rehearsal-owner/app/pulls/%d", pr), 1)
	h.pass()
	require.Equal(t, "unknown", h.operation(n).State)
	require.Equal(t, "closed", h.pull(pr).State)
	h.fake.UpdatePull("rehearsal-owner/app", pr, func(p *githubfake.Pull) {
		p.State = "open"
		p.UpdatedAt = original.UpdatedAt // same-second source payload returns exactly
	})
	h.pass()
	require.Empty(t, h.item(n).PendingOp)
	require.Equal(t, "open", h.item(n).PRState)
	writes := len(h.writes())
	h.pass()
	require.Eventually(t, func() bool { return h.item(n).State == "proposed" }, 5*time.Second, 10*time.Millisecond)
	currentVersion, err := synced.cachedPullVersion(ctx, pool, row.ID, pr)
	require.NoError(t, err)
	require.Equal(t, originalVersion, currentVersion, "exercise the identical-payload case")
	require.Equal(t, 2, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE operation='github.fetched.consume'`))
	require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM product_job_events WHERE event_type='todo.github_in_review'`))
	require.Equal(t, before.Attempt, h.item(n).Attempt)
	require.Equal(t, before.CandidateHead, h.item(n).CandidateHead)
	require.Len(t, h.writes(), writes, "fresh evidence performs no GitHub write")
}
