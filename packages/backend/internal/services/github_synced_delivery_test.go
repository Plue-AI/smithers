package services

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

const fetchedFirst = `{"id":1001,"number":1,"state":"open","title":"First","updated_at":"2026-10-05T10:00:00Z"}`
const fetchedSecond = `{"id":1002,"number":2,"state":"open","title":"Second","updated_at":"2026-10-05T10:00:00Z"}`

func newFetchedFixture(t *testing.T) (*GitHubSyncedRepoService, *pgxpool.Pool, db.GithubSyncedRepo) {
	t.Helper()
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	row, err := q.EnrollGitHubSyncedRepo(context.Background(), db.EnrollGitHubSyncedRepoParams{OwnerLogin: "factory", RepoName: "app", InstallationID: pgtype.Int8{Int64: 12, Valid: true}, GithubRepositoryID: pgtype.Int8{Int64: 99, Valid: true}, SyncMetadata: true, EnrolledVia: GitHubSyncedRepoEnrolledViaInstallation})
	require.NoError(t, err)
	service := NewGitHubSyncedRepoService(q)
	require.NoError(t, service.ConfigureInstallSync(pool))
	return service, pool, row
}

func allowFetched(service *GitHubSyncedRepoService) {
	service.install.authorize = func(context.Context, db.GithubSyncedRepo) error { return nil }
}

func fetchedCount(t *testing.T, pool *pgxpool.Pool, query string) int {
	t.Helper()
	var count int
	require.NoError(t, pool.QueryRow(context.Background(), query).Scan(&count))
	return count
}

func runFetchedFixture(t *testing.T, service *GitHubSyncedRepoService) func() {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- service.install.jobs.RunWorker(ctx, jobs.WorkerConfig{WorkerID: "fetched-test", Capacity: 1, Lease: 2 * time.Second, HeartbeatInterval: 100 * time.Millisecond, PollInterval: 10 * time.Millisecond, RetryDelay: 10 * time.Millisecond, MaxRetryDelay: 20 * time.Millisecond, Operations: []string{githubFetchedOperation}}, service.consumeFetched)
	}()
	stopped := false
	stop := func() {
		if stopped {
			return
		}
		stopped = true
		cancel()
		select {
		case err := <-done:
			require.NoError(t, err)
		case <-time.After(5 * time.Second):
			t.Fatal("delivery worker did not stop")
		}
	}
	t.Cleanup(stop)
	return stop
}

func TestGitHubFetchedBatchCommitsCacheAndDeliveryTogether(t *testing.T) {
	s, pool, row := newFetchedFixture(t)
	ctx := context.Background()
	calls := 0
	fetch := func(context.Context, string, url.Values) (json.RawMessage, error) {
		calls++
		return json.RawMessage("[" + fetchedFirst + "," + fetchedSecond + "]"), nil
	}
	require.Error(t, s.backfillResource(ctx, row, "issues", fetch))
	require.Zero(t, calls, "missing providers refuse before fetching")
	for range 16 {
		require.Error(t, s.backfill(ctx, row, fetch))
	}
	current, err := db.New(pool).GetGitHubSyncedRepoByGitHubID(ctx, row.GithubRepositoryID)
	require.NoError(t, err)
	require.Equal(t, "error", current.SyncState)
	require.Zero(t, current.ConsecutiveFailures)
	allowFetched(s)
	_, err = pool.Exec(ctx, `CREATE FUNCTION reject_fetched() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operation='github.fetched.consume' AND NEW.payload->>'number'='2' THEN RAISE EXCEPTION 'test delivery write refused'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER reject_fetched BEFORE INSERT ON product_job_requests FOR EACH ROW EXECUTE FUNCTION reject_fetched()`)
	require.NoError(t, err)
	require.ErrorContains(t, s.backfillResource(ctx, row, "issues", fetch), "test delivery write refused")
	require.Zero(t, fetchedCount(t, pool, `SELECT count(*) FROM github_synced_issues`))
	require.Zero(t, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests`))
	_, err = pool.Exec(ctx, `DROP TRIGGER reject_fetched ON product_job_requests`)
	require.NoError(t, err)
	require.NoError(t, s.backfillResource(ctx, row, "issues", fetch))
	require.Equal(t, 2, fetchedCount(t, pool, `SELECT count(*) FROM github_synced_issues`))
	require.Equal(t, 2, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests`))
	// Poll retry and equivalent object-key order preserve both delivery ids.
	require.NoError(t, s.backfillResource(ctx, row, "issues", fetch))
	reordered := json.RawMessage(`{"updated_at":"2026-10-05T10:00:00Z","title":"First","state":"open","number":1,"id":1001}`)
	require.NoError(t, s.commitFetched(ctx, row, "issues", []json.RawMessage{reordered}))
	require.Equal(t, 2, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests`))
	newer := json.RawMessage(`{"id":1001,"number":1,"state":"open","title":"Edited","updated_at":"2026-10-05T10:01:00Z"}`)
	require.NoError(t, s.commitFetched(ctx, row, "issues", []json.RawMessage{newer}))
	require.NoError(t, s.commitFetched(ctx, row, "issues", []json.RawMessage{json.RawMessage(fetchedFirst)}))
	require.Equal(t, 3, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests`))
	var title string
	require.NoError(t, pool.QueryRow(ctx, `SELECT title FROM github_synced_issues WHERE number=1`).Scan(&title))
	require.Equal(t, "Edited", title)
	// Malformed later input aborts the complete batch, including earlier writes.
	newest := json.RawMessage(`{"id":1001,"number":1,"state":"open","title":"Must roll back","updated_at":"2026-10-05T10:02:00Z"}`)
	require.ErrorContains(t, s.commitFetched(ctx, row, "issues", []json.RawMessage{newest, json.RawMessage(`{"id":4}`)}), "invalid fetched")
	require.NoError(t, pool.QueryRow(ctx, `SELECT title FROM github_synced_issues WHERE number=1`).Scan(&title))
	require.Equal(t, "Edited", title)
	require.Equal(t, 3, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests`))
}

func TestGitHubFetchedConsumerRecoveryIsAtomicAndOrdered(t *testing.T) {
	s, pool, row := newFetchedFixture(t)
	allowFetched(s)
	ctx := context.Background()
	require.NoError(t, s.commitFetched(ctx, row, "issues", []json.RawMessage{json.RawMessage(fetchedFirst), json.RawMessage(fetchedSecond)}))
	stop := runFetchedFixture(t, s)
	require.Eventually(t, func() bool {
		return fetchedCount(t, pool, `SELECT count(*) FROM product_job_dispatches WHERE attempt>0`) > 0
	}, 5*time.Second, 10*time.Millisecond)
	stop()
	require.Equal(t, 2, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE state='accepted'`), "unregistered consumers retain both versions")
	// A fresh service simulates process restart; it reconstructs all pending work
	// from the shared jobs store without a private delivery ledger.
	fresh := NewGitHubSyncedRepoService(db.New(pool))
	require.NoError(t, fresh.ConfigureInstallSync(pool))
	allowFetched(fresh)
	var attempts atomic.Int32
	fresh.install.consumers["issues"] = func(ctx context.Context, tx pgx.Tx, fact gitHubFetchedObject) (json.RawMessage, error) {
		attempts.Add(1)
		var object struct {
			Title string `json:"title"`
		}
		if err := json.Unmarshal(fact.Object, &object); err != nil {
			return nil, err
		}
		_, err := tx.Exec(ctx, `INSERT INTO install_settings(key,value) VALUES('fetched-test',jsonb_build_array($1::text)) ON CONFLICT(key) DO UPDATE SET value=install_settings.value || excluded.value`, object.Title)
		return json.RawMessage(`{"state":"consumed"}`), err
	}
	_, err := pool.Exec(ctx, `CREATE FUNCTION reject_fetched_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='operation.completed' THEN RAISE EXCEPTION 'test acknowledgement failed'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER reject_fetched_completion BEFORE INSERT ON product_job_events FOR EACH ROW EXECUTE FUNCTION reject_fetched_completion()`)
	require.NoError(t, err)
	stop = runFetchedFixture(t, fresh)
	require.Eventually(t, func() bool { return attempts.Load() > 1 }, 5*time.Second, 10*time.Millisecond)
	stop()
	require.Zero(t, fetchedCount(t, pool, `SELECT count(*) FROM install_settings WHERE key='fetched-test'`), "failed acknowledgement rolls back consumer effects")
	require.Zero(t, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE state='completed'`))
	_, err = pool.Exec(ctx, `DROP TRIGGER reject_fetched_completion ON product_job_events`)
	require.NoError(t, err)
	stop = runFetchedFixture(t, fresh)
	require.Eventually(t, func() bool {
		return fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE state='completed'`) == 2
	}, 5*time.Second, 10*time.Millisecond)
	stop()
	var effects []byte
	require.NoError(t, pool.QueryRow(ctx, `SELECT value FROM install_settings WHERE key='fetched-test'`).Scan(&effects))
	require.JSONEq(t, `["First","Second"]`, string(effects))
	before := attempts.Load()
	require.NoError(t, fresh.commitFetched(ctx, row, "issues", []json.RawMessage{json.RawMessage(fetchedFirst), json.RawMessage(fetchedSecond)}))
	stop = runFetchedFixture(t, fresh)
	// With no remaining claim, the same store immediately proves replay cannot run.
	_, err = fresh.install.jobs.ClaimForOperations(ctx, "probe", time.Second, []string{githubFetchedOperation})
	require.ErrorIs(t, err, jobs.ErrNoWork)
	stop()
	require.Equal(t, before, attempts.Load())
}

func TestGitHubFetchedDeliveryRechecksRepositoryBinding(t *testing.T) {
	for _, change := range []string{"permission", "installation", "repository"} {
		t.Run(change, func(t *testing.T) {
			s, pool, row := newFetchedFixture(t)
			allowFetched(s)
			ctx := context.Background()
			require.NoError(t, s.commitFetched(ctx, row, "issues", []json.RawMessage{json.RawMessage(fetchedFirst)}))
			var called atomic.Int32
			s.install.consumers["issues"] = func(context.Context, pgx.Tx, gitHubFetchedObject) (json.RawMessage, error) {
				called.Add(1)
				return json.RawMessage(`{}`), nil
			}
			switch change {
			case "permission":
				s.install.authorize = func(context.Context, db.GithubSyncedRepo) error { return errors.New("permission removed") }
			case "installation":
				_, err := pool.Exec(ctx, `UPDATE github_synced_repos SET installation_id=13 WHERE id=$1`, row.ID)
				require.NoError(t, err)
			case "repository":
				_, err := pool.Exec(ctx, `UPDATE github_synced_repos SET github_repository_id=100 WHERE id=$1`, row.ID)
				require.NoError(t, err)
			}
			stop := runFetchedFixture(t, s)
			require.Eventually(t, func() bool {
				return fetchedCount(t, pool, `SELECT count(*) FROM product_job_dispatches WHERE attempt>0`) > 0
			}, 5*time.Second, 10*time.Millisecond)
			stop()
			require.Zero(t, called.Load())
			require.Zero(t, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE state='completed'`))
			if change == "installation" {
				current, err := db.New(pool).GetGitHubSyncedRepoByGitHubID(ctx, row.GithubRepositoryID)
				require.NoError(t, err)
				require.NoError(t, s.commitFetched(ctx, current, "issues", []json.RawMessage{json.RawMessage(fetchedFirst)}))
				stop = runFetchedFixture(t, s)
				require.Eventually(t, func() bool {
					return fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE state='completed'`) == 1
				}, 5*time.Second, 10*time.Millisecond)
				stop()
				require.EqualValues(t, 1, called.Load(), "the replacement installation's delivery has an independent identity")
			}
		})
	}
}

func TestGitHubInstallWebhooksOnlyRequestFetch(t *testing.T) {
	s, pool, row := newFetchedFixture(t)
	ctx := context.Background()
	require.NoError(t, s.ApplyIssueEvent(ctx, "forged", "slug", 99, "issues", "opened", json.RawMessage(fetchedFirst)))
	require.NoError(t, s.ApplyIssueCommentEvent(ctx, "factory", "app", 99, "created", json.RawMessage(fetchedFirst), json.RawMessage(`{"id":2,"body":"webhook text"}`)))
	require.NoError(t, s.TouchWebhook(ctx, "factory", "app", 99))
	require.Zero(t, fetchedCount(t, pool, `SELECT count(*) FROM github_synced_issues`))
	require.Zero(t, fetchedCount(t, pool, `SELECT count(*) FROM github_synced_issue_comments`))
	require.Zero(t, fetchedCount(t, pool, `SELECT count(*) FROM github_synced_repos WHERE last_webhook_at IS NOT NULL`))
	s.install.mu.Lock()
	require.True(t, s.install.requested[syncedStreamKey(row, "issues")])
	require.True(t, s.install.requested[syncedStreamKey(row, "pulls")])
	require.True(t, s.install.requested[syncedStreamKey(row, "issues/events")])
	s.install.mu.Unlock()
	fresh, err := db.New(pool).GetGitHubSyncedRepoByGitHubID(ctx, row.GithubRepositoryID)
	require.NoError(t, err)
	require.Equal(t, "factory", fresh.OwnerLogin)
	fresh.LastWebhookAt = pgtype.Timestamptz{Time: time.Now(), Valid: true}
	require.True(t, s.stale(fresh), "webhooks do not establish fetched freshness")
}
