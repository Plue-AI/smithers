package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/stretchr/testify/require"
)

func TestGitHubConversationCursorEditsRollbackAndRestart(t *testing.T) {
	f := newInstallPollFixture(t)
	stamp := time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC)
	issue := f.upstream.OpenIssue("acme/app", "acme", "First", "body")
	other := f.upstream.OpenIssue("acme/app", "acme", "Second", "body")
	first := f.upstream.CommentIssue("acme/app", issue, "acme", "first")
	second := f.upstream.CommentIssue("acme/app", other, "acme", "second")
	require.True(t, f.upstream.UpdateComment("acme/app", first, "first", stamp.Add(-time.Hour)))
	require.True(t, f.upstream.UpdateComment("acme/app", second, "second", stamp))
	read := func() error { return f.service.backfillResource(t.Context(), f.row, gitHubConversationComments, nil) }
	require.NoError(t, read())
	require.NoError(t, read())
	require.NoError(t, read())
	require.Equal(t, 2, fetchedCount(t, f.pool, `SELECT count(*) FROM github_synced_issue_comments`))
	require.Equal(t, 2, fetchedCount(t, f.pool, `SELECT count(*) FROM product_job_requests WHERE principal_id='issues/comments'`))
	var order []int64
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT array_agg((payload->'object'->>'id')::bigint ORDER BY created_at,id) FROM product_job_requests`).Scan(&order))
	require.Equal(t, []int64{first, second}, order, "initial comment versions are delivered oldest first")
	reads := f.upstream.Reads()
	require.Len(t, reads, 3)
	require.NotContains(t, reads[0].Path, "since=")
	u, err := url.Parse(reads[1].Path)
	require.NoError(t, err)
	require.Equal(t, "2026-10-05T11:59:59Z", u.Query().Get("since"))
	require.Equal(t, "updated", u.Query().Get("sort"))
	require.Equal(t, "desc", u.Query().Get("direction"))
	require.Equal(t, reads[1].Path, reads[2].Path)
	require.Equal(t, 304, reads[2].Status)
	require.True(t, f.upstream.UpdateComment("acme/app", first, "equal second edit", stamp))
	require.NoError(t, read())
	require.Equal(t, 3, fetchedCount(t, f.pool, `SELECT count(*) FROM product_job_requests`))
	require.Equal(t, stamp, f.service.fetchedUpdatedCursor(f.row, gitHubConversationComments))
	require.True(t, f.upstream.UpdateComment("acme/app", second, "later edit", stamp.Add(5*time.Second)))
	_, err = f.pool.Exec(t.Context(), `CREATE FUNCTION reject_comment_delivery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'comment delivery refused'; END $$; CREATE TRIGGER reject_comment_delivery BEFORE INSERT ON product_job_requests FOR EACH ROW EXECUTE FUNCTION reject_comment_delivery()`)
	require.NoError(t, err)
	require.ErrorContains(t, read(), "comment delivery refused")
	require.Equal(t, stamp, f.service.fetchedUpdatedCursor(f.row, gitHubConversationComments))
	var body string
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT payload->>'body' FROM github_synced_issue_comments WHERE github_id=$1`, second).Scan(&body))
	require.Equal(t, "second", body)
	_, err = f.pool.Exec(t.Context(), `DROP TRIGGER reject_comment_delivery ON product_job_requests`)
	require.NoError(t, err)
	require.NoError(t, read())
	reads = f.upstream.Reads()
	require.Equal(t, 200, reads[4].Status)
	require.Equal(t, 200, reads[5].Status)
	require.Equal(t, reads[4].IfNoneMatch, reads[5].IfNoneMatch)
	require.Equal(t, stamp.Add(5*time.Second), f.service.fetchedUpdatedCursor(f.row, gitHubConversationComments))
	require.Equal(t, 4, fetchedCount(t, f.pool, `SELECT count(*) FROM product_job_requests`))
	fresh := NewGitHubSyncedRepoService(db.New(f.pool))
	require.NoError(t, fresh.ConfigureInstallSync(f.pool))
	allowFetched(fresh)
	fresh.SetConditionalFetcherFactory(f.service.conditionalFetcherFactory)
	require.NoError(t, fresh.backfillResource(t.Context(), f.row, gitHubConversationComments, nil))
	require.Equal(t, 4, fetchedCount(t, f.pool, `SELECT count(*) FROM product_job_requests`))
	// A missing consumer must retain every version after a worker/restart.
	stop := runFetchedFixture(t, fresh)
	require.Eventually(t, func() bool {
		return fetchedCount(t, f.pool, `SELECT count(*) FROM product_job_dispatches WHERE attempt>0 AND last_error<>''`) > 0
	}, 5*time.Second, 10*time.Millisecond)
	stop()
	require.Zero(t, fetchedCount(t, f.pool, `SELECT count(*) FROM product_job_requests WHERE state='completed'`))
}

func TestGitHubConversationConsumerEffectsAndReceiptAreAtomic(t *testing.T) {
	s, pool, row := newFetchedFixture(t)
	allowFetched(s)
	raw := json.RawMessage(`{"id":19,"body":"hello","issue_url":"https://api.github.com/repos/factory/app/issues/7","created_at":"2026-10-05T10:00:00Z","updated_at":"2026-10-05T10:00:00Z"}`)
	require.NoError(t, s.commitFetched(t.Context(), row, gitHubConversationComments, []json.RawMessage{raw}))
	var fail atomic.Bool
	fail.Store(true)
	var calls atomic.Int32
	s.install.consumers[gitHubConversationComments] = func(ctx context.Context, tx pgx.Tx, fact gitHubFetchedObject) (json.RawMessage, error) {
		calls.Add(1)
		require.EqualValues(t, 7, fact.Number)
		_, err := tx.Exec(ctx, `INSERT INTO install_settings(key,value) VALUES('comment-consumer','1') ON CONFLICT(key) DO UPDATE SET value=to_jsonb((install_settings.value #>> '{}')::int+1)`)
		if err != nil {
			return nil, err
		}
		if fail.Load() {
			return nil, errors.New("rollback consumer")
		}
		return json.RawMessage(`{"applied":true}`), nil
	}
	stop := runFetchedFixture(t, s)
	require.Eventually(t, func() bool { return calls.Load() > 0 }, 5*time.Second, 10*time.Millisecond)
	stop()
	require.Zero(t, fetchedCount(t, pool, `SELECT count(*) FROM install_settings WHERE key='comment-consumer'`))
	require.Zero(t, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE state='completed'`))
	fail.Store(false)
	stop = runFetchedFixture(t, s)
	require.Eventually(t, func() bool {
		return fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE state='completed'`) == 1
	}, 5*time.Second, 10*time.Millisecond)
	stop()
	var value int
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT (value #>> '{}')::int FROM install_settings WHERE key='comment-consumer'`).Scan(&value))
	require.Equal(t, 1, value)
	require.NoError(t, s.commitFetched(t.Context(), row, gitHubConversationComments, []json.RawMessage{raw}))
	require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests`))
}

func TestGitHubConversationMalformedPagesRetainCursorAndCache(t *testing.T) {
	valid := `{"id":19,"body":"hello","issue_url":"https://api.github.com/repos/factory/app/issues/7","created_at":"2026-10-05T10:00:00Z","updated_at":"2026-10-05T10:00:00Z"}`
	for _, kind := range []string{"wrong-repository", "wrong-origin", "query", "fragment", "noncanonical-number", "missing-body", "invalid-created", "invalid-updated", "invalid-id"} {
		t.Run(kind, func(t *testing.T) {
			s, pool, row := newFetchedFixture(t)
			allowFetched(s)
			bad := valid
			switch kind {
			case "wrong-repository":
				bad = strings.Replace(bad, "factory/app", "other/app", 1)
			case "wrong-origin":
				bad = strings.Replace(bad, "api.github.com", "example.test", 1)
			case "query":
				bad = strings.Replace(bad, "issues/7", "issues/7?x=1", 1)
			case "fragment":
				bad = strings.Replace(bad, "issues/7", "issues/7#fragment", 1)
			case "noncanonical-number":
				bad = strings.Replace(bad, "issues/7", "issues/07", 1)
			case "missing-body":
				bad = strings.Replace(bad, `"body":"hello"`, `"body":null`, 1)
			case "invalid-created":
				bad = strings.Replace(bad, `"created_at":"2026-10-05T10:00:00Z"`, `"created_at":"bad"`, 1)
			case "invalid-updated":
				bad = strings.Replace(bad, `"updated_at":"2026-10-05T10:00:00Z"`, `"updated_at":"bad"`, 1)
			case "invalid-id":
				bad = strings.Replace(bad, `"id":19`, `"id":0`, 1)
			}
			s.SetConditionalFetcherFactory(func(db.GithubSyncedRepo) GitHubSyncedRepoConditionalFetcher {
				return func(_ context.Context, _ string, _ url.Values, etag string) (GitHubSyncedRepoConditionalPage, error) {
					require.Empty(t, etag)
					return GitHubSyncedRepoConditionalPage{Body: json.RawMessage("[" + bad + "]"), ETag: `"bad"`}, nil
				}
			})
			for range 2 {
				var apiErr *pkgerrors.APIError
				require.ErrorAs(t, s.backfillResource(t.Context(), row, gitHubConversationComments, nil), &apiErr)
				require.Equal(t, pkgerrors.CodeGitHubUnavailable, apiErr.Code)
			}
			require.True(t, s.fetchedUpdatedCursor(row, gitHubConversationComments).IsZero())
			require.Zero(t, fetchedCount(t, pool, `SELECT count(*) FROM github_synced_issue_comments`))
			require.Zero(t, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests`))
		})
	}
}

func TestGitHubConversationStaleAndReboundComment(t *testing.T) {
	s, pool, row := newFetchedFixture(t)
	allowFetched(s)
	raw := func(id, issue int, second string) json.RawMessage {
		return json.RawMessage(fmt.Sprintf(`{"id":%d,"body":"%s","issue_url":"https://api.github.com/repos/factory/app/issues/%d","created_at":"2026-10-05T10:00:00Z","updated_at":"2026-10-05T10:00:%sZ"}`, id, second, issue, second))
	}
	require.NoError(t, s.commitFetched(t.Context(), row, gitHubConversationComments, []json.RawMessage{raw(19, 7, "05")}))
	require.NoError(t, s.commitFetched(t.Context(), row, gitHubConversationComments, []json.RawMessage{raw(19, 7, "00")}))
	require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests`))
	require.Error(t, s.commitFetched(t.Context(), row, gitHubConversationComments, []json.RawMessage{raw(20, 8, "06"), raw(19, 8, "07")}))
	require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM github_synced_issue_comments`), "invalid second object rolls back the first")
	var body string
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT payload->>'body' FROM github_synced_issue_comments`).Scan(&body))
	require.Equal(t, "05", body)
}

func TestGitHubConversationCadenceAndScopedWebhookHint(t *testing.T) {
	f := newInstallPollFixture(t)
	f.poll(0, "issues", "pulls", "issues/events", "issues/comments")
	f.clock.Store(1010)
	for range 3 {
		require.NoError(t, f.service.ApplyIssueCommentEvent(t.Context(), "forged", "slug", 100, "edited", nil, json.RawMessage(`{"id":99,"body":"untrusted hint"}`)))
	}
	f.poll(10, "issues/comments")
	f.poll(44)
	f.poll(45, "pulls", "issues/comments")
	f.low.Store(true)
	f.poll(90, "pulls", "issues/comments")
	f.poll(120)
	f.poll(135, "pulls", "issues/comments")
	require.Zero(t, fetchedCount(t, f.pool, `SELECT count(*) FROM github_synced_issue_comments`))
}

func TestGitHubConversationReadsEqualTimestampEditsPastUnchangedPage(t *testing.T) {
	f := newInstallPollFixture(t)
	issue := f.upstream.OpenIssue("acme/app", "acme", "Comments", "body")
	stamp := time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC)
	var edited int64
	for n := 1; n <= 121; n++ {
		id := f.upstream.CommentIssue("acme/app", issue, "acme", fmt.Sprintf("comment %d", n))
		require.True(t, f.upstream.UpdateComment("acme/app", id, fmt.Sprintf("comment %d", n), stamp))
		if n == 10 {
			edited = id
		}
	}
	read := func() error { return f.service.backfillResource(t.Context(), f.row, gitHubConversationComments, nil) }
	require.NoError(t, read())
	require.NoError(t, read()) // Establish since-URL validators.
	require.Equal(t, 121, fetchedCount(t, f.pool, `SELECT count(*) FROM github_synced_issue_comments`))
	require.True(t, f.upstream.UpdateComment("acme/app", edited, "edited on page two", stamp))
	require.NoError(t, read())
	reads := f.upstream.Reads()
	require.Len(t, reads, 6)
	require.Equal(t, 304, reads[4].Status)
	require.Equal(t, 200, reads[5].Status)
	var body string
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT payload->>'body' FROM github_synced_issue_comments WHERE github_id=$1`, edited).Scan(&body))
	require.Equal(t, "edited on page two", body)
	require.Equal(t, 122, fetchedCount(t, f.pool, `SELECT count(*) FROM product_job_requests`))
}

func TestGitHubConversationPauseDoesNotBlockOtherStreams(t *testing.T) {
	for _, status := range []int64{403, 429} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			f := newInstallPollFixture(t)
			f.refuseComments.Store(status)
			f.poll(0, "issues", "pulls", "issues/events", "issues/comments")
			f.clock.Store(1010)
			require.NoError(t, f.service.ApplyIssueCommentEvent(t.Context(), "acme", "app", 100, "created", nil, nil))
			f.poll(10)
			f.poll(45, "pulls")
			f.poll(49)
			f.refuseComments.Store(0)
			f.poll(50, "issues/comments")
			row, err := db.New(f.pool).GetGitHubSyncedRepoByGitHubID(t.Context(), f.row.GithubRepositoryID)
			require.NoError(t, err)
			require.Equal(t, "ready", row.SyncState)
			require.Len(t, f.upstream.Writes(), 1, "pause cannot cause extra token mints")
		})
	}
}
