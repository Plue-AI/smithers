package services

import (
	"context"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

// The refs receipt is written by the production poll using real PostgreSQL,
// real Git and githubfake. Stop polling and recreate the service over that
// database: the health watcher must recover its boundary without another read.
// The composed J10 journey separately proves the HTTP and live Home doors.
// The refs-only admission fixture does not qualify machine isolation or the
// separate required-stream providers.
func TestGitHubSyncHealthPersistedBoundaryWithoutPolling(t *testing.T) {
	h := newMergeHarness(t)
	q := db.New(h.pool)
	newService := func() *GitHubMainPullService {
		s := NewGitHubMainPullService(q, h.host, h.connections, h.connections)
		qualifyMainPullFixture(s)
		return s
	}
	s := newService()
	s.Sweep(t.Context())
	require.NoError(t, s.PollOnce(t.Context()))
	row, err := q.GetGithubMainPull(t.Context(), h.repoID)
	require.NoError(t, err)
	require.Equal(t, "synced", row.State, row.LastError)
	require.True(t, row.LastSyncedAt.Valid)
	require.Equal(t, h.main, h.hostRef("refs/heads/main"))
	upstreamRequests := len(h.fake.Writes())

	for _, restart := range []bool{false, true} {
		t.Run(map[bool]string{false: "boundary", true: "restart-before-boundary"}[restart], func(t *testing.T) {
			// Age only the real persisted receipt, so this test runs quickly. Health
			// still uses its production wall clock and ordinary 120-second boundary.
			success := time.Now().UTC().Add(-119 * time.Second)
			h.exec(`UPDATE github_main_pulls SET last_synced_at=$2 WHERE repository_id=$1`, h.repoID, success)
			frames := make(chan GitHubSyncHealth, 8)
			changes := make(chan struct{}, 1)
			start := func() (context.CancelFunc, <-chan error) {
				ctx, cancel := context.WithCancel(t.Context())
				done := make(chan error, 1)
				go func() { done <- s.WatchSyncHealth(ctx, changes, func(health GitHubSyncHealth) { frames <- health }) }()
				return cancel, done
			}
			receive := func() GitHubSyncHealth {
				select {
				case health := <-frames:
					return health
				case <-time.After(3 * time.Second):
					t.Fatal("persisted health boundary did not publish")
					return GitHubSyncHealth{}
				}
			}
			cancel, done := start()
			require.Equal(t, "fresh", receive().State)
			if restart {
				cancel()
				require.ErrorIs(t, <-done, context.Canceled)
				s = newService()
				cancel, done = start()
				require.Equal(t, "fresh", receive().State)
			}
			defer cancel()
			stale := receive()
			require.Equal(t, "stale", stale.State)
			require.WithinDuration(t, success, *stale.LastSuccessAt, time.Microsecond)
			require.Greater(t, time.Since(success), 120*time.Second)
			changes <- struct{}{}
			close(changes)
			require.NoError(t, <-done)
			require.Empty(t, frames, "unchanged receipt must publish no extra stale frame")
			after, err := q.GetGithubMainPull(t.Context(), h.repoID)
			require.NoError(t, err)
			require.Equal(t, row.SyncedGeneration, after.SyncedGeneration, "watching health must not poll")
			require.Equal(t, h.main, h.hostRef("refs/heads/main"))
			require.Len(t, h.fake.Writes(), upstreamRequests, "health recovery must contact no upstream")
		})
	}
}

// All repository stream observations must survive service reconstruction;
// successful refs alone cannot hide a missing repository-stream receipt.

func TestGitHubSyncRepositoryReceiptsSurviveRestart(t *testing.T) {
	f := newInstallPollFixture(t)
	f.poll(0, "issues", "pulls", "issues/events", "issues/comments")
	restore := func() *GitHubSyncedRepoService {
		fresh := NewGitHubSyncedRepoService(db.New(f.pool))
		require.NoError(t, fresh.ConfigureInstallSync(f.pool))
		fresh.now = f.service.now
		allowFetched(fresh)
		fresh.SetConditionalFetcherFactory(f.service.conditionalFetcherFactory)
		return fresh
	}
	fresh := restore()
	for _, resource := range []string{"issues", "pulls", "issues/events", "issues/comments"} {
		before := f.service.syncStreamObservation(f.row, resource, metadataBudgetStream(resource))
		require.NotNil(t, before.LastSuccessAt, resource)
		require.Equal(t, before, fresh.syncStreamObservation(f.row, resource, metadataBudgetStream(resource)), resource)
	}
	// Refusal and retry pause survive as inputs; failures never replace success.
	f.refuseIssue.Store(403)
	f.refuseComments.Store(429)
	f.clock.Store(1120)
	f.service.reconcileOnce(t.Context())
	fresh = restore()
	for _, cell := range []struct{ resource, cause string }{{"issues", ""}, {"issues/comments", ""}} {
		before := f.service.syncStreamObservation(f.row, cell.resource, metadataBudgetStream(cell.resource))
		require.Equal(t, cell.cause, before.Cause)
		require.NotNil(t, before.LastSuccessAt)
		require.Equal(t, time.Unix(1000, 0).UTC(), *before.LastSuccessAt)
		require.Equal(t, before, fresh.syncStreamObservation(f.row, cell.resource, metadataBudgetStream(cell.resource)))
	}
	require.NotNil(t, fresh.syncStreamObservation(f.row, "issues/comments", "conversation-comments").RetryAt)
	f.mu.Lock()
	requests := len(f.paths)
	f.mu.Unlock()
	require.Error(t, fresh.backfillInstallStreams(t.Context(), f.row, nil, []gitHubStreamPlan{{resource: "issues/comments", scheduled: true}}))
	f.mu.Lock()
	require.Len(t, f.paths, requests, "restored pause sends zero upstream requests")
	f.mu.Unlock()
	// The fixture's 403 with Retry-After is a secondary limit. A real
	// suspended fake installation instead supplies the permission refusal.
	f.refuseIssue.Store(0)
	f.refuseComments.Store(0)
	f.upstream.SetInstallationSuspended(91, true)
	f.clock.Store(1300)
	f.service.reconcileOnce(t.Context())
	refused := f.service.syncStreamObservation(f.row, "pulls", "pulls")
	require.Equal(t, "permission", refused.Cause)
	require.NotNil(t, refused.LastSuccessAt)
	fresh = restore()
	require.Equal(t, refused, fresh.syncStreamObservation(f.row, "pulls", "pulls"))
	// Rebinding excludes every receipt of the old installation.
	_, err := f.pool.Exec(t.Context(), `UPDATE github_synced_repos SET installation_id=92 WHERE id=$1`, f.row.ID)
	require.NoError(t, err)
	fresh = restore()
	require.Nil(t, fresh.syncStreamObservation(f.row, "pulls", "pulls").LastSuccessAt)
}

func TestGitHubSyncFailedReceiptWriteCannotPublishSuccess(t *testing.T) {
	f := newInstallPollFixture(t)
	f.poll(0, "issues", "pulls", "issues/events", "issues/comments")
	before := f.service.syncStreamObservation(f.row, "pulls", "pulls")
	_, err := f.pool.Exec(t.Context(), `CREATE FUNCTION reject_health_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.key LIKE 'github.stream.health.%' THEN RAISE EXCEPTION 'receipt write refused'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_health_receipt BEFORE INSERT OR UPDATE ON install_settings FOR EACH ROW EXECUTE FUNCTION reject_health_receipt()`)
	require.NoError(t, err)
	f.clock.Store(1001)
	require.ErrorContains(t, f.service.backfillInstallStreams(t.Context(), f.row, nil, []gitHubStreamPlan{{resource: "pulls", scheduled: true}}), "receipt write refused")
	require.Equal(t, before.LastSuccessAt, f.service.syncStreamObservation(f.row, "pulls", "pulls").LastSuccessAt)
}

func TestGitHubSyncExhaustedQuotaSurvivesRestart(t *testing.T) {
	f := newInstallPollFixture(t)
	f.exhausted.Store(true)
	f.poll(0) // Token mint consumes the final headroom before metadata can read.
	fresh := NewGitHubSyncedRepoService(db.New(f.pool))
	require.NoError(t, fresh.ConfigureInstallSync(f.pool))
	fresh.now = f.service.now
	allowFetched(fresh)
	fresh.SetConditionalFetcherFactory(f.service.conditionalFetcherFactory)
	require.True(t, fresh.budget.StreamRetryAt(91, "pulls").IsZero(), "new tracker has no upstream observation")
	for _, resource := range []string{"issues", "pulls", "issues/events", "issues/comments"} {
		receipt := fresh.syncStreamObservation(f.row, resource, metadataBudgetStream(resource))
		require.NotNil(t, receipt.RetryAt, resource)
		require.Equal(t, time.Unix(1300, 0).UTC(), *receipt.RetryAt)
	}
	require.Empty(t, fresh.dueInstallStreams(f.row), "persisted quota pause admits no stream")
	f.mu.Lock()
	requests := len(f.paths)
	f.mu.Unlock()
	fresh.reconcileOnce(t.Context())
	f.mu.Lock()
	require.Len(t, f.paths, requests, "restart sends no requests during exhausted headroom")
	f.mu.Unlock()
	f.exhausted.Store(false)
	f.service = fresh
	f.poll(301, "issues", "pulls", "issues/events", "issues/comments")
	require.Nil(t, fresh.syncStreamObservation(f.row, "pulls", "pulls").RetryAt)
}
