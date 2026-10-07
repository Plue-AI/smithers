package services

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestGitHubUpdatedIssueCursorOverlapRetryAndIdleURL(t *testing.T) {
	f := newInstallPollFixture(t)
	ctx := context.Background()
	stamp := time.Date(2026, 10, 5, 10, 0, 0, 0, time.UTC)
	first := f.upstream.OpenIssue("acme/app", "acme", "old", "body")
	second := f.upstream.OpenIssue("acme/app", "acme", "new", "body")
	f.upstream.SetIssueUpdatedAt("acme/app", first, stamp.Add(-time.Hour))
	f.upstream.SetIssueUpdatedAt("acme/app", second, stamp)
	read := func() error { return f.service.backfillResource(ctx, f.row, "issues", nil) }
	require.NoError(t, read())
	require.Equal(t, stamp, f.service.fetchedUpdatedCursor(f.row, "issues"))
	require.NoError(t, read()) // Establish the validator for the new since URL.
	require.NoError(t, read())
	reads := f.upstream.Reads()
	require.Len(t, reads, 3)
	require.NotContains(t, reads[0].Path, "since=")
	u, err := url.Parse(reads[1].Path)
	require.NoError(t, err)
	require.Equal(t, "2026-10-05T09:59:59Z", u.Query().Get("since"))
	require.Equal(t, reads[1].Path, reads[2].Path)
	require.Equal(t, 304, reads[2].Status)
	// A later edit can share the newest timestamp, so since must overlap it.
	f.upstream.LabelIssue("acme/app", first, "acme", "same-second")
	f.upstream.SetIssueUpdatedAt("acme/app", first, stamp)
	require.NoError(t, read())
	require.Equal(t, stamp, f.service.fetchedUpdatedCursor(f.row, "issues"))
	var payload []byte
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT payload FROM github_synced_issues WHERE synced_repo_id=$1 AND number=$2`, f.row.ID, first).Scan(&payload))
	require.Contains(t, string(payload), "same-second")
	// A failed delivery write cannot advance the timestamp or its validators.
	f.upstream.LabelIssue("acme/app", second, "acme", "later")
	f.upstream.SetIssueUpdatedAt("acme/app", second, stamp.Add(5*time.Second))
	_, err = f.pool.Exec(ctx, `CREATE FUNCTION reject_cursor_delivery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'delivery refused'; END $$; CREATE TRIGGER reject_cursor_delivery BEFORE INSERT ON product_job_requests FOR EACH ROW EXECUTE FUNCTION reject_cursor_delivery()`)
	require.NoError(t, err)
	require.ErrorContains(t, read(), "delivery refused")
	require.Equal(t, stamp, f.service.fetchedUpdatedCursor(f.row, "issues"))
	_, err = f.pool.Exec(ctx, `DROP TRIGGER reject_cursor_delivery ON product_job_requests`)
	require.NoError(t, err)
	require.NoError(t, read())
	require.Equal(t, stamp.Add(5*time.Second), f.service.fetchedUpdatedCursor(f.row, "issues"))
	reads = f.upstream.Reads()
	require.Equal(t, 200, reads[4].Status)
	require.Equal(t, 200, reads[5].Status)
	require.Equal(t, reads[4].IfNoneMatch, reads[5].IfNoneMatch)
	require.NoError(t, read())
	require.NoError(t, read())
	reads = f.upstream.Reads()
	u, err = url.Parse(reads[6].Path)
	require.NoError(t, err)
	require.Equal(t, "2026-10-05T10:00:04Z", u.Query().Get("since"))
	require.Equal(t, reads[6].Path, reads[7].Path)
	require.Equal(t, 304, reads[7].Status)
	f.service.install.mu.Lock()
	for page := range f.service.install.etags {
		if page.resource == "issues" {
			q, _ := url.ParseQuery(page.query)
			require.Equal(t, "2026-10-05T10:00:04Z", q.Get("since"))
		}
	}
	f.service.install.mu.Unlock()
	count := fetchedCount(t, f.pool, `SELECT count(*) FROM product_job_requests`)
	fresh := NewGitHubSyncedRepoService(db.New(f.pool))
	require.NoError(t, fresh.ConfigureInstallSync(f.pool))
	allowFetched(fresh)
	fresh.SetConditionalFetcherFactory(f.service.conditionalFetcherFactory)
	require.NoError(t, fresh.backfillResource(ctx, f.row, "issues", nil))
	reads = f.upstream.Reads()
	require.NotContains(t, reads[len(reads)-1].Path, "since=")
	require.Equal(t, count, fetchedCount(t, f.pool, `SELECT count(*) FROM product_job_requests`))
	other := f.row
	other.InstallationID.Int64++
	require.True(t, fresh.fetchedUpdatedCursor(other, "issues").IsZero())
}

func TestGitHubUpdatedPullCursorReadsTiesBehindUnchangedFirstPage(t *testing.T) {
	s, pool, row := newFetchedFixture(t)
	allowFetched(s)
	ctx := context.Background()
	var mu sync.Mutex
	changed := false
	var statuses []int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		require.Empty(t, r.URL.Query().Get("since"), "GitHub pulls do not accept since")
		require.Equal(t, "50", r.URL.Query().Get("per_page"))
		page, err := strconv.Atoi(r.URL.Query().Get("page"))
		require.NoError(t, err)
		batch := make([]json.RawMessage, 0)
		for n := (page-1)*50 + 1; n <= page*50 && n <= 130; n++ {
			title := "original"
			if changed && n == 75 {
				title = "same-second edit on page two"
			}
			batch = append(batch, json.RawMessage(fmt.Sprintf(`{"id":%d,"number":%d,"state":"open","title":%q,"updated_at":"2026-10-05T10:00:00Z"}`, n, n, title)))
		}
		body, err := json.Marshal(batch)
		require.NoError(t, err)
		etag := fmt.Sprintf(`"%x"`, sha256.Sum256(body))
		w.Header().Set("ETag", etag)
		if r.Header.Get("If-None-Match") == etag {
			statuses = append(statuses, 304)
			w.WriteHeader(304)
			return
		}
		statuses = append(statuses, 200)
		_, _ = w.Write(body)
	}))
	defer server.Close()
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)
	client := NewGitHubUserReposService(db.New(pool), nil)
	s.SetConditionalFetcherFactory(client.SyncedRepoConditionalFetcherFactory(&recordingMinter{}))
	require.NoError(t, s.backfillResource(ctx, row, "pulls", nil))
	mu.Lock()
	require.Equal(t, []int{200, 200, 200}, statuses)
	statuses = nil
	changed = true
	mu.Unlock()
	require.NoError(t, s.backfillResource(ctx, row, "pulls", nil))
	mu.Lock()
	require.Equal(t, []int{304, 200, 304}, statuses)
	statuses = nil
	mu.Unlock()
	var title string
	require.NoError(t, pool.QueryRow(ctx, `SELECT title FROM github_synced_issues WHERE number=75`).Scan(&title))
	require.Equal(t, "same-second edit on page two", title)
	require.Equal(t, 131, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests`))
	require.NoError(t, s.backfillResource(ctx, row, "pulls", nil))
	mu.Lock()
	require.Equal(t, []int{304, 304, 304}, statuses)
	mu.Unlock()
}

func TestGitHubUpdatedCursorRejectsBadOrderAndKeepsCommittedBoundary(t *testing.T) {
	for _, kind := range []string{"out-of-order", "invalid-timestamp", "cancelled"} {
		t.Run(kind, func(t *testing.T) {
			s, pool, row := newFetchedFixture(t)
			allowFetched(s)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			good := func(context.Context, string, url.Values) (json.RawMessage, error) {
				return json.RawMessage("[" + fetchedFirst + "]"), nil
			}
			require.NoError(t, s.backfillResource(ctx, row, "issues", good))
			before := s.fetchedUpdatedCursor(row, "issues")
			bad := func(context.Context, string, url.Values) (json.RawMessage, error) {
				if kind == "cancelled" {
					cancel()
					return json.RawMessage("[" + fetchedSecond + "]"), nil
				}
				if kind == "invalid-timestamp" {
					return json.RawMessage(strings.Replace("["+fetchedSecond+"]", "2026-10-05T10:00:00Z", "invalid", 1)), nil
				}
				return json.RawMessage("[" + fetchedSecond + "," + strings.Replace(fetchedFirst, "10:00:00", "10:00:05", 1) + "]"), nil
			}
			require.Error(t, s.backfillResource(ctx, row, "issues", bad))
			require.Equal(t, before, s.fetchedUpdatedCursor(row, "issues"))
			require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests`))
			// A late older completion cannot move a current cursor backwards.
			s.advanceUpdatedCursor(row, "issues", before.Add(-time.Hour))
			require.Equal(t, before, s.fetchedUpdatedCursor(row, "issues"))
		})
	}
}

// Updated PRs can span multiple pages; the first old row bounds the delta,
// while unchanged cached rows beyond it must survive the partial scan.
func TestGitHubUpdatedPullCursorPagesDeltaAndStopsAtOldRows(t *testing.T) {
	s, pool, row := newFetchedFixture(t)
	allowFetched(s)
	ctx := context.Background()
	changed := false
	var pages []int
	fetch := func(_ context.Context, resource string, query url.Values) (json.RawMessage, error) {
		require.Equal(t, "pulls", resource)
		require.Empty(t, query.Get("since"))
		page, err := strconv.Atoi(query.Get("page"))
		require.NoError(t, err)
		pages = append(pages, page)
		batch := make([]json.RawMessage, 0)
		for n := (page-1)*50 + 1; n <= page*50 && n <= 130; n++ {
			stamp, title := "2026-10-05T09:00:00Z", "original"
			if n == 1 {
				stamp = "2026-10-05T10:00:00Z"
			}
			if changed && n <= 65 {
				stamp, title = "2026-10-05T10:00:05Z", "updated"
			}
			batch = append(batch, json.RawMessage(fmt.Sprintf(`{"id":%d,"number":%d,"state":"open","title":%q,"updated_at":%q}`, n, n, title, stamp)))
		}
		body, err := json.Marshal(batch)
		return body, err
	}
	require.NoError(t, s.backfillResource(ctx, row, "pulls", fetch))
	require.Equal(t, []int{1, 2, 3}, pages)
	changed, pages = true, nil
	require.NoError(t, s.backfillResource(ctx, row, "pulls", fetch))
	require.Equal(t, []int{1, 2}, pages)
	var title string
	require.NoError(t, pool.QueryRow(ctx, `SELECT title FROM github_synced_issues WHERE number=65`).Scan(&title))
	require.Equal(t, "updated", title)
	require.Equal(t, 130, fetchedCount(t, pool, `SELECT count(*) FROM github_synced_issues`))
	require.Equal(t, 195, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests`))
	require.Equal(t, time.Date(2026, 10, 5, 10, 0, 5, 0, time.UTC), s.fetchedUpdatedCursor(row, "pulls"))
	pages = nil
	require.NoError(t, s.backfillResource(ctx, row, "pulls", fetch))
	require.Equal(t, []int{1, 2}, pages)
	require.Equal(t, 195, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests`))
}
