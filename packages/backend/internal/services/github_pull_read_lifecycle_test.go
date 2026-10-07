package services

import (
	"context"
	"net/url"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/stretchr/testify/require"
)

func TestGitHubPullReadRaceCannotUndoSettledDrop(t *testing.T) {
	h := newMergeHarness(t)
	n, _, pr := h.first("Stay dropped after late response")
	original := h.pull(pr)
	accepted := h.item(n)
	synced, row := configureInboundPullPolling(t, h.publicationFixture)
	factory := synced.conditionalFetcherFactory
	began := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	defer unblock()
	var delayed atomic.Bool
	synced.SetConditionalFetcherFactory(func(source db.GithubSyncedRepo) GitHubSyncedRepoConditionalFetcher {
		fetch := factory(source)
		return func(ctx context.Context, resource string, query url.Values, etag string) (GitHubSyncedRepoConditionalPage, error) {
			page, err := fetch(ctx, resource, query, etag)
			if err == nil && delayed.CompareAndSwap(false, true) {
				close(began)
				select {
				case <-release:
				case <-ctx.Done():
					return page, ctx.Err()
				}
			}
			return page, err
		}
	})
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- synced.pollInstallPull(ctx, row, pr) }()
	select {
	case <-began:
	case <-time.After(5 * time.Second):
		t.Fatal("old PR read did not start")
	}
	_, err := h.drop(n, "drop-during-read")
	require.NoError(t, err)
	h.pass()
	require.Empty(t, h.item(n).PendingOp)
	require.Equal(t, "closed", h.pull(pr).State)
	// The remote fixture retains its old timestamp after the real App close,
	// while the already-fetched open response remains delayed.
	h.fake.UpdatePull("rehearsal-owner/app", pr, func(p *githubfake.Pull) { p.UpdatedAt = original.UpdatedAt })
	defer runFetchedFixture(t, synced)()
	h.pass()
	require.NotNil(t, mythicalChecksOf(h.item(n)).GitHubDropRead)
	unblock()
	select {
	case err = <-done:
		// Older timestamps are a successful ignored read, not a fetch failure.
		require.NoError(t, err)
	case <-time.After(5 * time.Second):
		t.Fatal("old PR read did not finish")
	}
	pool := h.pool.(*pgxpool.Pool)
	require.Eventually(t, func() bool {
		return fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE operation='github.fetched.consume' AND payload->>'resource'='pulls' AND state<>'completed'`) == 0
	}, 5*time.Second, 10*time.Millisecond)
	require.Equal(t, "cancelled", h.item(n).State)
	require.Equal(t, 0, fetchedCount(t, pool, `SELECT count(*) FROM product_job_events WHERE event_type='todo.github_in_review'`))
	require.Empty(t, h.item(n).PendingOp, "no stale branch restoration intent")
	h.fake.UpdatePull("rehearsal-owner/app", pr, func(p *githubfake.Pull) { p.State = "open" })
	writes := len(h.writes())
	h.pass()
	require.Eventually(t, func() bool { return h.item(n).State == "proposed" }, 5*time.Second, 10*time.Millisecond)
	require.Equal(t, accepted.Attempt, h.item(n).Attempt)
	require.Equal(t, accepted.CandidateHead, h.item(n).CandidateHead)
	require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM product_job_events WHERE event_type='todo.github_in_review'`))
	require.Len(t, h.writes(), writes, "a real reopen resumes review without a GitHub write")
}

func TestGitHubDropFreshReadIgnoresFuturePoll(t *testing.T) {
	h := newMergeHarness(t)
	n, _, pr := h.first("Reopen immediately after close")
	synced, row := configureInboundPullPolling(t, h.publicationFixture)
	defer runFetchedFixture(t, synced)()
	_, err := h.drop(n, "future-poll-drop")
	require.NoError(t, err)
	h.pass()
	require.Empty(t, h.item(n).PendingOp)
	require.Equal(t, "closed", h.pull(pr).State)
	h.exec(`UPDATE mythical_items SET next_attempt_at=clock_timestamp()+interval '1 hour' WHERE id=$1`, h.item(n).ID)
	h.service.MainMoved(h.ctx, h.repoID)
	require.NoError(t, h.service.PollOnce(h.ctx))
	require.NotNil(t, mythicalChecksOf(h.item(n)).GitHubDropRead, "close fencing must not wait an hour")
	require.Equal(t, "cancelled", h.item(n).State)
	h.fake.UpdatePull("rehearsal-owner/app", pr, func(p *githubfake.Pull) { p.State = "open" })
	require.NoError(t, synced.pollInstallPull(h.ctx, row, pr))
	require.Eventually(t, func() bool { return h.item(n).State == "proposed" }, 5*time.Second, 10*time.Millisecond)
	require.Empty(t, h.merges())
}
