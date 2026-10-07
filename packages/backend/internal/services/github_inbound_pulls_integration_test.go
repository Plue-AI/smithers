package services

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
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
		require.NoError(t, pool.QueryRow(ctx, `SELECT payload FROM product_job_requests WHERE operation='github.fetched.consume' AND principal_id='pulls'`).Scan(&raw))
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
	followed, err := db.New(pool).ListMythicalOpenPullItems(ctx, f.repoID, f.service.now())
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
			return fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE operation='github.fetched.consume' AND principal_id='pulls' AND state='completed'`) > 0
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
				return fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE operation='github.fetched.consume' AND principal_id='pulls' AND state<>'completed'`) == 0
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
		return fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE operation='github.fetched.consume' AND principal_id='pulls' AND state='completed'`) == 1
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
	require.Equal(t, 2, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE operation='github.fetched.consume' AND principal_id='pulls'`))
	require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM product_job_events WHERE event_type='todo.github_in_review'`))
	require.Equal(t, before.Attempt, h.item(n).Attempt)
	require.Equal(t, before.CandidateHead, h.item(n).CandidateHead)
	require.Len(t, h.writes(), writes, "fresh evidence performs no GitHub write")
}

// A failure when the jobs receipt is inserted must roll back the real pull
// consumer's TODO transition as well. Restart reads the retained delivery;
// duplicate polling after commit must create no second transition or intent.
func TestGitHubInboundCloseReopenCommitRecovery(t *testing.T) {
	h := newMergeHarness(t)
	f := h.publicationFixture
	n, _, pr := h.first("Atomic lifecycle")
	synced, row := configureInboundPullPolling(t, f)
	pool := f.pool.(*pgxpool.Pool)
	ctx := t.Context()
	token, err := f.connections.CreateGitHubInstallationTokenForRepositoryOwner(ctx, f.userID, 0, "rehearsal-owner", "app", map[string]string{"pull_requests": "write"})
	require.NoError(t, err)
	var attempts atomic.Int32
	consumer := synced.install.consumers[GitHubRepoMetadataPulls]
	synced.RegisterFetchedConsumer(GitHubRepoMetadataPulls, func(ctx context.Context, tx pgx.Tx, fact gitHubFetchedObject) (json.RawMessage, error) {
		attempts.Add(1)
		return consumer(ctx, tx, fact)
	})
	for _, step := range []struct{ remote, before, after, event string }{
		{"closed", "proposed", "rejected", "todo.github_dropped"},
		{"open", "rejected", "proposed", "todo.github_in_review"},
	} {
		t.Run(step.remote, func(t *testing.T) {
			before := f.item(n)
			calls := attempts.Load()
			_, err := pool.Exec(ctx, `CREATE FUNCTION reject_pull_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='operation.completed' THEN RAISE EXCEPTION 'injected precommit crash'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_pull_receipt BEFORE INSERT ON product_job_events FOR EACH ROW EXECUTE FUNCTION reject_pull_receipt()`)
			require.NoError(t, err)
			req, err := http.NewRequest("PATCH", f.fake.URL+fmt.Sprintf("/repos/rehearsal-owner/app/pulls/%d", pr), strings.NewReader(fmt.Sprintf(`{"state":%q}`, step.remote)))
			require.NoError(t, err)
			req.Header.Set("Authorization", "Bearer "+token.Token)
			resp, err := f.fake.Client().Do(req)
			require.NoError(t, err)
			require.Equal(t, 200, resp.StatusCode)
			require.NoError(t, resp.Body.Close())
			writes := len(f.writes())
			require.NoError(t, synced.pollInstallPull(ctx, row, pr))
			stop := runFetchedFixture(t, synced)
			require.Eventually(t, func() bool { return attempts.Load() > calls+1 }, 10*time.Second, 20*time.Millisecond)
			stop()
			require.Equal(t, before, f.item(n), "failed receipt rolls back all item fields")
			require.Equal(t, step.before, f.item(n).State)
			require.Zero(t, fetchedCount(t, pool, `SELECT count(*) FROM product_job_events WHERE event_type='`+step.event+`'`))
			require.Len(t, f.writes(), writes, "ingestion emits no GitHub write")
			_, err = pool.Exec(ctx, `DROP TRIGGER reject_pull_receipt ON product_job_events; DROP FUNCTION reject_pull_receipt()`)
			require.NoError(t, err)
			stop = runFetchedFixture(t, synced)
			require.Eventually(t, func() bool { return f.item(n).State == step.after }, 10*time.Second, 20*time.Millisecond)
			stop()
			require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM product_job_events WHERE event_type='`+step.event+`'`))
			committed := f.item(n)
			require.NoError(t, synced.pollInstallPull(ctx, row, pr))
			stop = runFetchedFixture(t, synced)
			stop()
			require.Equal(t, committed, f.item(n), "postcommit redelivery changes nothing")
			require.Len(t, f.writes(), writes)
			require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM product_job_events WHERE event_type='`+step.event+`'`))
		})
	}
}

// Selection and ingestion must agree at the inclusive boundary, even when the
// scheduler's clock differs from PostgreSQL's wall clock. A fresh row update
// cannot extend the original close's lifetime.
func TestGitHubInboundReopenWindowProductionPoll(t *testing.T) {
	for _, tc := range []struct {
		name    string
		age     time.Duration
		reopens bool
	}{
		{"day 6", 6 * 24 * time.Hour, true},
		{"day 7 inclusive", 7 * 24 * time.Hour, true},
		{"day 7 plus microsecond", 7*24*time.Hour + time.Microsecond, false},
		{"day 8", 8 * 24 * time.Hour, false},
		{"before close", -time.Microsecond, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newMergeHarness(t)
			f := h.publicationFixture
			n, _, pr := h.first("Reopen boundary")
			synced, row := configureInboundPullPolling(t, f)
			ctx := t.Context()
			pool := f.pool.(*pgxpool.Pool)
			// Deliberately far from the database clock; no wall-clock sleeps.
			closed := time.Date(2030, 3, 9, 12, 0, 0, 0, time.UTC)
			f.service.now = func() time.Time { return closed }
			token, err := f.connections.CreateGitHubInstallationTokenForRepositoryOwner(ctx, f.userID, 0, "rehearsal-owner", "app", map[string]string{"pull_requests": "write"})
			require.NoError(t, err)
			patch := func(state string) {
				req, err := http.NewRequest("PATCH", f.fake.URL+fmt.Sprintf("/repos/rehearsal-owner/app/pulls/%d", pr), strings.NewReader(fmt.Sprintf(`{"state":%q}`, state)))
				require.NoError(t, err)
				req.Header.Set("Authorization", "Bearer "+token.Token)
				resp, err := f.fake.Client().Do(req)
				require.NoError(t, err)
				require.Equal(t, 200, resp.StatusCode)
				require.NoError(t, resp.Body.Close())
			}
			patch("closed")
			require.NoError(t, synced.pollInstallPull(ctx, row, pr))
			stop := runFetchedFixture(t, synced)
			require.Eventually(t, func() bool { return f.item(n).State == "rejected" }, 10*time.Second, 20*time.Millisecond)
			stop()
			dropped := f.item(n)
			// GitHub's closed_at, when supplied, is the authoritative instant.
			closed = mythicalGitHubClosedAt(dropped)
			now := closed.Add(tc.age)
			f.service.now = func() time.Time { return now }
			_, err = pool.Exec(ctx, `UPDATE mythical_items SET updated_at=clock_timestamp() WHERE id=$1`, dropped.ID)
			require.NoError(t, err)
			followed, err := f.service.queries().ListMythicalOpenPullItems(ctx, f.repoID, now)
			require.NoError(t, err)
			require.Equal(t, tc.reopens, len(followed) == 1, "polling selection uses the lifecycle clock")
			// Seven days means 168 elapsed hours, including across a database
			// timezone's daylight-saving change.
			tx, err := pool.Begin(ctx)
			require.NoError(t, err)
			_, err = tx.Exec(ctx, `SET LOCAL TIME ZONE 'America/Los_Angeles'`)
			require.NoError(t, err)
			zoned, err := db.New(tx).ListMythicalOpenPullItems(ctx, f.repoID, now)
			require.NoError(t, err)
			require.NoError(t, tx.Rollback(ctx))
			require.Equal(t, len(followed), len(zoned), "database timezone cannot change the elapsed-hour window")
			streams, err := f.service.requiredInstallPulls(ctx, row)
			require.NoError(t, err)
			require.Equal(t, len(followed), len(streams), "freshness projection follows the same window")
			require.Equal(t, tc.reopens, mythicalReopenFollowed(dropped, now))
			patch("open")
			writes := len(f.writes())
			require.NoError(t, synced.pollInstallPull(ctx, row, pr))
			stop = runFetchedFixture(t, synced)
			require.Eventually(t, func() bool {
				return fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE operation='github.fetched.consume' AND state <> 'completed'`) == 0
			}, 10*time.Second, 20*time.Millisecond)
			stop()
			got := f.item(n)
			state, events := "rejected", 0
			if tc.reopens {
				state, events = "proposed", 1
			}
			require.Equal(t, state, got.State)
			require.Equal(t, events, fetchedCount(t, pool, `SELECT count(*) FROM product_job_events WHERE event_type='todo.github_in_review'`))
			require.Equal(t, dropped.Attempt, got.Attempt)
			require.Equal(t, dropped.CandidateHead, got.CandidateHead)
			require.Len(t, f.writes(), writes, "fact ingestion performs no GitHub write")
		})
	}
}

func TestGitHubInboundContainmentProductionPoll(t *testing.T) {
	for _, mode := range []string{"full", "partial", "missing manifest", "retained superseded", "dropped contained", "before commit crash", "after commit restart", "close response lost", "missing head read", "unknown outbound"} {
		t.Run(mode, func(t *testing.T) {
			h := newMergeHarness(t)
			f := h.publicationFixture
			first := f.todo("First", "first", f.main, "FIRST.txt", "first\n")
			f.wake()
			first = f.item(first.Number.Int64)
			second := f.todo("Second", "second", first.CandidateHead, "SECOND.txt", "second\n")
			f.wake()
			second = f.item(second.Number.Int64)
			third := f.todo("Third", "third", second.CandidateHead, "THIRD.txt", "third\n")
			f.wake()
			third = f.item(third.Number.Int64)
			// Linked issues are independent of containment: only fixes_issue closes.
			fixes := f.fake.OpenIssue("rehearsal-owner/app", "rehearsal-owner", "Fixed first", "first")
			references := f.fake.OpenIssue("rehearsal-owner/app", "rehearsal-owner", "Referenced second", "second")
			h.exec(`UPDATE mythical_items SET issue_number=$2,fixes_issue=true WHERE id=$1`, first.ID, fixes)
			h.exec(`UPDATE mythical_items SET issue_number=$2,fixes_issue=false WHERE id=$1`, second.ID, references)
			// Complete publication before a person edits GitHub's draft.
			for range 4 {
				h.pass()
			}
			first, second, third = f.item(first.Number.Int64), f.item(second.Number.Int64), f.item(third.Number.Int64)
			var retainedUnknown json.RawMessage
			if mode == "unknown outbound" {
				retainedUnknown, _ = json.Marshal(MythicalOutboundOp{Kind: "push", Target: mythicalChecksOf(first).Branch, Desired: first.PRHead, Precondition: first.PRHead, State: "unknown"})
				first.PendingOp = retainedUnknown
				_, err := h.q.SaveMythicalItem(h.ctx, first)
				require.NoError(t, err)
			}
			checks := mythicalChecksOf(third)
			require.NotNil(t, checks.retainedManifest(third.PRHead))
			if mode == "partial" {
				for i := range checks.PRManifests {
					if checks.PRManifests[i].Head == third.PRHead {
						checks.PRManifests[i].Included = checks.PRManifests[i].Included[:1]
					}
				}
			}
			if mode == "missing manifest" {
				checks.PRManifests = nil
			}
			third.Checks = checks.encode()
			_, err := h.q.SaveMythicalItem(h.ctx, third)
			require.NoError(t, err)
			if mode == "dropped contained" {
				_, err := h.drop(second.Number.Int64, "drop-contained")
				require.NoError(t, err)
				h.pass()
				h.pass()
				f.git(f.github, "update-ref", "refs/heads/"+checks.Branch, third.PRHead)
			}
			if mode == "retained superseded" {
				updated := f.item(third.Number.Int64)
				updated.Generation++
				updated.CandidateHead = first.CandidateHead
				_, err = h.q.SaveMythicalItem(h.ctx, updated)
				require.NoError(t, err)
			}
			h.fake.UpdatePull("rehearsal-owner/app", third.PRNumber.Int64, func(p *githubfake.Pull) { p.Draft = false })
			request, err := http.NewRequest("POST", h.fake.URL+"/_fake/merge", strings.NewReader(fmt.Sprintf(`{"repo":"rehearsal-owner/app","number":%d}`, third.PRNumber.Int64)))
			require.NoError(t, err)
			request.Header.Set("Authorization", "Bearer ghu_githubfake_owner")
			request.Header.Set("Content-Type", "application/json")
			response, err := h.fake.Client().Do(request)
			require.NoError(t, err)
			response.Body.Close()
			require.Equal(t, 200, response.StatusCode)
			merged := h.pull(third.PRNumber.Int64)
			// GitHub sync has mirrored main before the fetched consumer may settle.
			f.git(f.hostDir, "fetch", "-q", f.github, "refs/heads/main:refs/heads/main")
			require.NoError(t, f.host.ImportRefs(h.ctx, "smithers-canary", "smithers"))
			synced, row := configureInboundPullPolling(t, f)
			pool := f.pool.(*pgxpool.Pool)
			var attempts atomic.Int32
			if mode == "before commit crash" {
				consumer := synced.install.consumers[GitHubRepoMetadataPulls]
				synced.install.consumers[GitHubRepoMetadataPulls] = func(ctx context.Context, tx pgx.Tx, fact gitHubFetchedObject) (json.RawMessage, error) {
					receipt, err := consumer(ctx, tx, fact)
					attempts.Add(1)
					return receipt, err
				}
			}
			if mode == "before commit crash" {
				_, err := pool.Exec(h.ctx, `CREATE FUNCTION reject_fold_ack() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='operation.completed' THEN RAISE EXCEPTION 'crash before fold commit'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_fold_ack BEFORE INSERT ON product_job_events FOR EACH ROW EXECUTE FUNCTION reject_fold_ack()`)
				require.NoError(t, err)
			}
			if mode == "missing head read" {
				f.fake.UpdatePull("rehearsal-owner/app", third.PRNumber.Int64, func(p *githubfake.Pull) { p.Head.SHA = "" })
			}
			stop := runFetchedFixture(t, synced)
			pollErr := synced.pollInstallPull(h.ctx, row, third.PRNumber.Int64)
			if mode == "missing head read" {
				require.ErrorContains(t, pollErr, "GitHub returned an invalid pull request")
			} else {
				require.NoError(t, pollErr)
			}
			if mode == "missing head read" {
				stop()
				require.Equal(t, "proposed", f.item(first.Number.Int64).State)
				require.Equal(t, "proposed", f.item(third.Number.Int64).State)
				rows, err := h.service.StackAttention(h.ctx, h.repoID, h.userID)
				require.NoError(t, err)
				require.Empty(t, rows)
				f.fake.UpdatePull("rehearsal-owner/app", third.PRNumber.Int64, func(p *githubfake.Pull) { p.Head.SHA = third.PRHead })
				require.NoError(t, synced.pollInstallPull(h.ctx, row, third.PRNumber.Int64))
				stop = runFetchedFixture(t, synced)
			}
			if mode == "before commit crash" {
				require.Eventually(t, func() bool { return attempts.Load() > 1 }, 5*time.Second, 10*time.Millisecond)
				stop()
				require.Equal(t, "proposed", f.item(first.Number.Int64).State)
				require.Equal(t, "proposed", f.item(third.Number.Int64).State)
				require.Zero(t, fetchedCount(t, pool, `SELECT count(*) FROM product_job_events WHERE event_type='todo.github_merged'`))
				rows, err := h.service.StackAttention(h.ctx, h.repoID, h.userID)
				require.NoError(t, err)
				require.Empty(t, rows)
				_, err = pool.Exec(h.ctx, `DROP TRIGGER reject_fold_ack ON product_job_events`)
				require.NoError(t, err)
				synced, row = configureInboundPullPolling(t, f)
				stop = runFetchedFixture(t, synced)
			}
			defer stop()
			require.Eventually(t, func() bool { return f.item(third.Number.Int64).State == "landed" }, 5*time.Second, 10*time.Millisecond)
			attention, err := h.service.StackAttention(h.ctx, h.repoID, h.userID)
			require.NoError(t, err)
			require.Len(t, attention, 1)
			require.Equal(t, int64(1), attention[0].Revision)
			require.Len(t, attention[0].Entries, 1)
			expectedFirst, expectedSecond := "landed", "landed"
			if mode == "partial" {
				expectedSecond = "proposed"
			}
			if mode == "missing manifest" {
				expectedFirst, expectedSecond = "proposed", "proposed"
			}
			require.Equal(t, expectedFirst, f.item(first.Number.Int64).State)
			if mode == "unknown outbound" {
				require.JSONEq(t, string(retainedUnknown), string(f.item(first.Number.Int64).PendingOp), "fold retains the unknown operation until lookup acknowledges it")
			}
			require.Equal(t, expectedSecond, f.item(second.Number.Int64).State)
			if expectedSecond == "landed" {
				folded := f.item(second.Number.Int64)
				via := mythicalChecksOf(folded).MergedVia
				require.NotNil(t, via)
				require.Equal(t, "T3 merged before T2; T2's change is in T3's commit", folded.Reason)
				require.Equal(t, third.PRNumber.Int64, via.Pull)
				require.Equal(t, merged.MergeCommitSHA, via.Commit)
			} else {
				require.Nil(t, mythicalChecksOf(f.item(second.Number.Int64)).MergedVia)
			}
			eventCount := fetchedCount(t, pool, `SELECT count(*) FROM product_job_events WHERE event_type='todo.github_merged'`)
			if mode == "after commit restart" {
				stop()
				synced, row = configureInboundPullPolling(t, f)
				stop = runFetchedFixture(t, synced)
				defer stop()
			}
			require.NoError(t, synced.pollInstallPull(h.ctx, row, third.PRNumber.Int64))
			require.Equal(t, eventCount, fetchedCount(t, pool, `SELECT count(*) FROM product_job_events WHERE event_type='todo.github_merged'`))
			require.Empty(t, h.merges(), "the person merged externally; no product PUT")
			attention, err = h.service.StackAttention(h.ctx, h.repoID, h.userID)
			require.NoError(t, err)
			require.Equal(t, int64(1), attention[0].Revision)
			if mode == "close response lost" {
				path := fmt.Sprintf("/repos/rehearsal-owner/app/pulls/%d", first.PRNumber.Int64)
				f.fake.OnNextRequest("PATCH", path, func() { f.fake.LoseNextResponses(path, 1) })
			}
			for range 5 {
				h.pass()
			}
			if mode == "close response lost" {
				closes := 0
				for _, write := range f.fake.Writes() {
					if write.Path != fmt.Sprintf("/repos/rehearsal-owner/app/pulls/%d", first.PRNumber.Int64) || write.Method != "PATCH" {
						continue
					}
					var body struct {
						State string `json:"state"`
					}
					require.NoError(t, json.Unmarshal(write.Body, &body))
					if body.State == "closed" {
						closes++
					}
				}
				require.Equal(t, 1, closes, "canonical close receipt recovers the lost response")
			}

			if expectedFirst == "landed" {
				require.Equal(t, "closed", h.pull(first.PRNumber.Int64).State)
			} else {
				require.Equal(t, "open", h.pull(first.PRNumber.Int64).State)
			}
			fixed, ok := f.fake.Issue("rehearsal-owner/app", fixes)
			require.True(t, ok)
			if expectedFirst == "landed" {
				require.Equal(t, "closed", fixed.State)
			} else {
				require.Equal(t, "open", fixed.State)
			}
			referenced, ok := f.fake.Issue("rehearsal-owner/app", references)
			require.True(t, ok)
			require.Equal(t, "open", referenced.State, "a linked issue without fixes_issue stays open")
			if expectedSecond == "landed" {
				require.Equal(t, "closed", h.pull(second.PRNumber.Int64).State)
			} else {
				require.Equal(t, "open", h.pull(second.PRNumber.Int64).State)
			}
		})
	}
}

// A person's external merge is consumed by the install poller. The next
// published TODO rebuilds on the mirrored main and refreshes the same PR.
func TestGitHubInboundMergeRebasesNextPublishedPull(t *testing.T) {
	r := newRebaseFixture(t)
	f := r.publicationFixture
	first := r.candidate("First", f.main, "FIRST.txt", "first\n")
	f.wake()
	first = f.item(first.Number.Int64)
	second := r.candidate("Second", first.CandidateHead, "SECOND.txt", "second\n")
	f.wake()
	second = f.item(second.Number.Int64)
	oldHead, number := second.PRHead, second.PRNumber.Int64
	require.Contains(t, f.pull(number).Body, "Includes [T1]")
	f.fake.UpdatePull("rehearsal-owner/app", first.PRNumber.Int64, func(p *githubfake.Pull) { p.Draft = false })
	request, err := http.NewRequest("POST", f.fake.URL+"/_fake/merge", strings.NewReader(fmt.Sprintf(`{"repo":"rehearsal-owner/app","number":%d}`, first.PRNumber.Int64)))
	require.NoError(t, err)
	response, err := f.fake.Client().Do(request)
	require.NoError(t, err)
	response.Body.Close()
	require.Equal(t, 200, response.StatusCode)
	merged := f.pull(first.PRNumber.Int64)
	f.git(f.hostDir, "fetch", "-q", f.github, "refs/heads/main:refs/heads/main")
	require.NoError(t, f.host.ImportRefs(t.Context(), "smithers-canary", "smithers"))
	synced, row := configureInboundPullPolling(t, f)
	stop := runFetchedFixture(t, synced)
	defer stop()
	require.NoError(t, synced.pollInstallPull(t.Context(), row, first.PRNumber.Int64))
	require.Eventually(t, func() bool { return f.item(first.Number.Int64).State == "landed" }, 5*time.Second, 10*time.Millisecond)
	_, err = f.pool.Exec(t.Context(), `UPDATE mythical_items SET workspace_id='', lane=NULL, lane_started_at=NULL WHERE repository_id=$1`, f.repoID)
	require.NoError(t, err)
	f.service.SetOrchestration(f.service.github, r.launcher, &fakeMythicalLanes{})
	for range 5 {
		if f.item(second.Number.Int64).State == "verifying" {
			break
		}
		f.wake()
	}
	second = f.item(second.Number.Int64)
	require.Equal(t, "verifying", second.State, second.Reason)
	require.Equal(t, merged.MergeCommitSHA, second.CandidateBase)
	r.verify(second)
	for range 5 {
		if f.item(second.Number.Int64).State == "proposed" {
			break
		}
		f.wake()
	}
	second = f.item(second.Number.Int64)
	require.Equal(t, "proposed", second.State, second.Reason)
	require.Equal(t, number, second.PRNumber.Int64, "refresh the existing PR")
	require.NotEqual(t, oldHead, second.PRHead)
	pull := f.pull(number)
	require.Equal(t, second.PRHead, pull.Head.SHA)
	require.False(t, pull.Draft, "the remaining first item becomes ready")
	require.NotContains(t, pull.Body, "Includes [T1]", "accepted body drops the landed prefix")
	require.Equal(t, "ready", f.card(second.Number.Int64)["merge"].(map[string]any)["state"])
}
