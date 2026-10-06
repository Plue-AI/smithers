package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func fetchedEvent(id int64, kind string) json.RawMessage {
	return json.RawMessage(fmt.Sprintf(`{"id":%d,"event":%q,"actor":{"id":7,"login":"alice","type":"User"},"label":{"name":"todo"},"issue":%s}`, id, kind, fetchedFirst))
}

func TestGitHubFetchedIssueEventsAtomicRecovery(t *testing.T) {
	s, pool, row := newFetchedFixture(t)
	ctx := context.Background()
	events := []json.RawMessage{fetchedEvent(13, "renamed"), fetchedEvent(12, "labeled"), fetchedEvent(11, "unlabeled")}
	allowFetched(s)
	// Failure of the final cursor write must roll back the cache and deliveries.
	_, err := pool.Exec(ctx, `CREATE FUNCTION reject_event_cursor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'cursor unavailable'; END $$; CREATE TRIGGER reject_event_cursor BEFORE INSERT ON install_settings FOR EACH ROW EXECUTE FUNCTION reject_event_cursor()`)
	require.NoError(t, err)
	require.ErrorContains(t, s.commitIssueEvents(ctx, row, events), "cursor unavailable")
	require.Zero(t, fetchedCount(t, pool, `SELECT count(*) FROM github_synced_issues`))
	require.Zero(t, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests`))
	_, err = pool.Exec(ctx, `DROP TRIGGER reject_event_cursor ON install_settings`)
	require.NoError(t, err)
	require.NoError(t, s.commitIssueEvents(ctx, row, events))
	cursor, err := readIssueEventCursor(ctx, pool, row)
	require.NoError(t, err)
	require.EqualValues(t, 13, cursor)
	require.Equal(t, 3, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE principal_id='issues/events'`))
	// A replay may carry a changed embedded issue; event identity is still its id.
	require.NoError(t, s.commitIssueEvents(ctx, row, []json.RawMessage{json.RawMessage(`{"id":12,"event":"labeled","issue":{"number":99}}`)}))
	require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM github_synced_issues`))
	stop := runFetchedFixture(t, s)
	require.Eventually(t, func() bool {
		return fetchedCount(t, pool, `SELECT count(*) FROM product_job_dispatches d JOIN product_job_requests r ON r.id=d.operation_id WHERE r.principal_id='issues/events' AND d.attempt>0`) == 3
	}, 5*time.Second, 10*time.Millisecond)
	stop()
	// Reverse request timestamps to prove event order does not use arrival time.
	_, err = pool.Exec(ctx, `UPDATE product_job_requests SET created_at='2026-01-01'::timestamptz - (payload->>'event_id')::int * interval '1 second' WHERE principal_id='issues/events'`)
	require.NoError(t, err)
	fresh := NewGitHubSyncedRepoService(db.New(pool))
	require.NoError(t, fresh.ConfigureInstallSync(pool))
	allowFetched(fresh)
	fresh.install.consumers[gitHubIssueEvents] = func(ctx context.Context, tx pgx.Tx, fact gitHubFetchedObject) (json.RawMessage, error) {
		_, err := tx.Exec(ctx, `INSERT INTO install_settings(key,value) VALUES('event-effects',jsonb_build_array($1::bigint)) ON CONFLICT(key) DO UPDATE SET value=install_settings.value || excluded.value`, fact.EventID)
		return json.RawMessage(`{"consumed":true}`), err
	}
	_, err = pool.Exec(ctx, `CREATE FUNCTION reject_event_ack() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='operation.completed' THEN RAISE EXCEPTION 'ack unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_event_ack BEFORE INSERT ON product_job_events FOR EACH ROW EXECUTE FUNCTION reject_event_ack()`)
	require.NoError(t, err)
	stop = runFetchedFixture(t, fresh)
	require.Eventually(t, func() bool {
		return fetchedCount(t, pool, `SELECT count(*) FROM product_job_dispatches d JOIN product_job_requests r ON r.id=d.operation_id WHERE r.principal_id='issues/events' AND r.request_id='11' AND d.attempt>1`) == 1
	}, 5*time.Second, 10*time.Millisecond)
	stop()
	require.Zero(t, fetchedCount(t, pool, `SELECT count(*) FROM install_settings WHERE key='event-effects'`))
	_, err = pool.Exec(ctx, `DROP TRIGGER reject_event_ack ON product_job_events`)
	require.NoError(t, err)
	stop = runFetchedFixture(t, fresh)
	require.Eventually(t, func() bool {
		return fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE principal_id='issues/events' AND state='completed'`) == 3
	}, 5*time.Second, 10*time.Millisecond)
	stop()
	var effects []byte
	require.NoError(t, pool.QueryRow(ctx, `SELECT value FROM install_settings WHERE key='event-effects'`).Scan(&effects))
	require.JSONEq(t, `[11,12,13]`, string(effects))
	require.NoError(t, fresh.commitIssueEvents(ctx, row, events))
	require.Equal(t, 3, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE principal_id='issues/events'`))
}

func TestGitHubFetchedIssueEventsPageToCursor(t *testing.T) {
	s, pool, row := newFetchedFixture(t)
	ctx := context.Background()
	calls := 0
	fetch := func(_ context.Context, resource string, query url.Values) (json.RawMessage, error) {
		calls++
		require.Equal(t, "issues/events", resource)
		require.Equal(t, "100", query.Get("per_page"))
		page, err := strconv.Atoi(query.Get("page"))
		require.NoError(t, err)
		batch := make([]json.RawMessage, 0)
		for id := 1110 - (page-1)*100; id > 1110-page*100 && id > 0; id-- {
			batch = append(batch, fetchedEvent(int64(id), "labeled"))
		}
		body, err := json.Marshal(batch)
		return body, err
	}
	require.Error(t, s.backfillIssueEvents(ctx, row, fetch))
	require.Zero(t, calls)
	allowFetched(s)
	require.NoError(t, s.backfillIssueEvents(ctx, row, fetch))
	require.Equal(t, 12, calls)
	require.Equal(t, 1110, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE principal_id='issues/events'`))
	calls = 0
	require.NoError(t, s.backfillIssueEvents(ctx, row, fetch))
	require.Equal(t, 1, calls, "saved cursor prevents a historical page walk")
	// A stale concurrent batch cannot regress the cursor or replace old facts.
	require.NoError(t, s.commitIssueEvents(ctx, row, []json.RawMessage{fetchedEvent(109, "renamed")}))
	cursor, err := readIssueEventCursor(ctx, pool, row)
	require.NoError(t, err)
	require.EqualValues(t, 1110, cursor)
}

func TestGitHubFetchedIssueEventsFailedWalkPreservesCursor(t *testing.T) {
	for _, failure := range []string{"network", "malformed", "unordered", "cancelled"} {
		t.Run(failure, func(t *testing.T) {
			s, pool, row := newFetchedFixture(t)
			allowFetched(s)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			calls := 0
			fetch := func(_ context.Context, _ string, _ url.Values) (json.RawMessage, error) {
				calls++
				if failure == "cancelled" && calls == 11 {
					cancel()
				}
				if failure == "malformed" {
					return json.RawMessage(`null`), nil
				}
				if failure == "unordered" {
					return json.RawMessage(`[{"id":1,"event":"labeled"},{"id":2,"event":"labeled"}]`), nil
				}
				if calls == 2 && failure == "network" {
					return nil, errors.New("network interrupted")
				}
				batch := make([]json.RawMessage, 100)
				for i := range batch {
					batch[i] = fetchedEvent(int64(100000-calls*100-i), "labeled")
				}
				body, err := json.Marshal(batch)
				return body, err
			}
			require.Error(t, s.backfillIssueEvents(ctx, row, fetch))
			require.Zero(t, fetchedCount(t, pool, `SELECT count(*) FROM install_settings`))
			require.Zero(t, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests`))
			require.Zero(t, fetchedCount(t, pool, `SELECT count(*) FROM github_synced_issues`))
		})
	}
}

func TestGitHubFetchedIssueEventsRecheckBindingAndPreserveLatestCache(t *testing.T) {
	s, pool, row := newFetchedFixture(t)
	allowFetched(s)
	ctx := context.Background()
	newer := json.RawMessage(`{"id":1001,"number":1,"state":"open","title":"Latest","updated_at":"2026-10-05T11:00:00Z"}`)
	require.NoError(t, s.commitFetched(ctx, row, "issues", []json.RawMessage{newer}))
	require.NoError(t, s.commitIssueEvents(ctx, row, []json.RawMessage{fetchedEvent(1, "labeled")}))
	var title string
	require.NoError(t, pool.QueryRow(ctx, `SELECT title FROM github_synced_issues WHERE number=1`).Scan(&title))
	require.Equal(t, "Latest", title, "old embedded snapshots must not replace newer cached data")
	require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE principal_id='issues/events'`), "stale issue data must not discard the event")
	// A repository rebind during the HTTP request cannot commit under old authority.
	fetch := func(context.Context, string, url.Values) (json.RawMessage, error) {
		_, err := pool.Exec(ctx, `UPDATE github_synced_repos SET installation_id=13 WHERE id=$1`, row.ID)
		require.NoError(t, err)
		return json.RawMessage("[" + string(fetchedEvent(2, "unlabeled")) + "]"), nil
	}
	require.Error(t, s.backfillIssueEvents(ctx, row, fetch))
	cursor, err := readIssueEventCursor(ctx, pool, row)
	require.NoError(t, err)
	require.EqualValues(t, 1, cursor)
	current, err := db.New(pool).GetGitHubSyncedRepoByGitHubID(ctx, row.GithubRepositoryID)
	require.NoError(t, err)
	cursor, err = readIssueEventCursor(ctx, pool, current)
	require.NoError(t, err)
	require.Zero(t, cursor, "a replacement installation never borrows a previous cursor")
	s.install.authorize = func(context.Context, db.GithubSyncedRepo) error { return errors.New("permission removed") }
	require.ErrorContains(t, s.commitIssueEvents(ctx, current, []json.RawMessage{fetchedEvent(2, "unlabeled")}), "permission removed")
}

func TestGitHubFetchedIssueEventsPageOverlapRetainsEveryEvent(t *testing.T) {
	s, pool, row := newFetchedFixture(t)
	allowFetched(s)
	ctx := context.Background()
	calls := 0
	fetch := func(context.Context, string, url.Values) (json.RawMessage, error) {
		calls++
		var batch []json.RawMessage
		if calls == 1 {
			for id := int64(101); id > 1; id-- {
				batch = append(batch, fetchedEvent(id, "labeled"))
			}
		} else {
			batch = []json.RawMessage{fetchedEvent(2, "labeled"), fetchedEvent(1, "unlabeled")}
		}
		body, err := json.Marshal(batch)
		return body, err
	}
	require.NoError(t, s.backfillIssueEvents(ctx, row, fetch))
	require.Equal(t, 2, calls)
	require.Equal(t, 101, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE principal_id='issues/events'`))
	var preserved []byte
	require.NoError(t, pool.QueryRow(ctx, `SELECT payload->'object' FROM product_job_requests WHERE principal_id='issues/events' AND request_id='1'`).Scan(&preserved))
	require.JSONEq(t, string(fetchedEvent(1, "unlabeled")), string(preserved), "actor, issue, label and event id must reach the consumer unchanged")
}

func TestGitHubFetchedIssueEventsThroughInstallationTransport(t *testing.T) {
	s, pool, _ := newFetchedFixture(t)
	minter, upstream := newScopedTokenMinter(t)
	ctx := context.Background()
	row, err := db.New(pool).EnrollGitHubSyncedRepo(ctx, db.EnrollGitHubSyncedRepoParams{OwnerLogin: "acme", RepoName: "app", InstallationID: pgtype.Int8{Int64: 91, Valid: true}, GithubRepositoryID: pgtype.Int8{Int64: 100, Valid: true}, SyncMetadata: true, EnrolledVia: GitHubSyncedRepoEnrolledViaInstallation})
	require.NoError(t, err)
	number := upstream.OpenIssue("acme/app", "acme", "From GitHub", "Issue body")
	upstream.LabelIssue("acme/app", number, "acme", "todo")
	upstream.LabelIssue("acme/app", number, "acme", "triage")
	client := NewGitHubUserReposService(db.New(pool), nil)
	fetch := client.SyncedRepoInstallationFetcherFactory(minter)(row)
	require.NotNil(t, fetch)
	require.Error(t, s.backfill(ctx, row, fetch))
	require.Empty(t, upstream.Writes(), "unqualified fetch must not even mint a token")
	allowFetched(s)
	require.NoError(t, s.backfill(ctx, row, fetch))
	cursor, err := readIssueEventCursor(ctx, pool, row)
	require.NoError(t, err)
	require.EqualValues(t, 1002, cursor)
	var title string
	require.NoError(t, pool.QueryRow(ctx, `SELECT title FROM github_synced_issues WHERE synced_repo_id=$1 AND number=$2`, row.ID, number).Scan(&title))
	require.Equal(t, "From GitHub", title)
	require.Equal(t, 2, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE principal_id='issues/events'`))
	require.NoError(t, s.backfill(ctx, row, fetch))
	require.Equal(t, 2, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE principal_id='issues/events'`))
	writes := upstream.Writes()
	require.Len(t, writes, 1, "repeated stream reads reuse the scoped installation token")
	require.Equal(t, "/app/installations/91/access_tokens", writes[0].Path)
	// A transport failure cannot advance the cursor or lose a subsequent event.
	upstream.LabelIssue("acme/app", number, "acme", "ready")
	upstream.FailNextReads("/repos/acme/app/issues/events", 1)
	require.Error(t, s.backfillIssueEvents(ctx, row, fetch))
	cursor, err = readIssueEventCursor(ctx, pool, row)
	require.NoError(t, err)
	require.EqualValues(t, 1002, cursor)
	require.NoError(t, s.backfillIssueEvents(ctx, row, fetch))
	cursor, err = readIssueEventCursor(ctx, pool, row)
	require.NoError(t, err)
	require.EqualValues(t, 1003, cursor)
}
