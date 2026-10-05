package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestGitHubConditionalCommitRetryAndRestart(t *testing.T) {
	s, pool, _ := newFetchedFixture(t)
	minter, upstream := newScopedTokenMinter(t)
	ctx := context.Background()
	row, err := db.New(pool).EnrollGitHubSyncedRepo(ctx, db.EnrollGitHubSyncedRepoParams{OwnerLogin: "acme", RepoName: "app", InstallationID: pgtype.Int8{Int64: 91, Valid: true}, GithubRepositoryID: pgtype.Int8{Int64: 100, Valid: true}, SyncMetadata: true, EnrolledVia: GitHubSyncedRepoEnrolledViaInstallation})
	require.NoError(t, err)
	number := upstream.OpenIssue("acme/app", "acme", "From GitHub", "Issue body")
	upstream.LabelIssue("acme/app", number, "acme", "todo")
	client := NewGitHubUserReposService(db.New(pool), nil)
	s.SetConditionalFetcherFactory(client.SyncedRepoConditionalFetcherFactory(minter))
	require.Error(t, s.backfill(ctx, row, nil))
	require.Empty(t, upstream.Reads())
	require.Empty(t, upstream.Writes(), "missing providers refuse before token minting")
	allowFetched(s)
	require.NoError(t, s.backfill(ctx, row, nil))
	require.NoError(t, s.backfill(ctx, row, nil))
	reads := upstream.Reads()
	require.Len(t, reads, 6)
	for i := range 3 {
		require.Equal(t, 200, reads[i].Status)
		require.Empty(t, reads[i].IfNoneMatch)
		if i == 0 {
			require.Contains(t, reads[i+3].Path, "since=", "first issue cursor changes the URL once")
			require.Equal(t, 200, reads[i+3].Status)
		} else {
			require.Equal(t, reads[i].Path, reads[i+3].Path, "idle polls keep their URL")
			require.Equal(t, 304, reads[i+3].Status)
			require.NotEmpty(t, reads[i+3].IfNoneMatch)
		}
	}
	require.Len(t, upstream.Writes(), 1, "all streams reuse the scoped token")
	upstream.LabelIssue("acme/app", number, "acme", "ready")
	_, err = pool.Exec(ctx, `CREATE FUNCTION reject_conditional_cursor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'cursor refused'; END $$; CREATE TRIGGER reject_conditional_cursor BEFORE UPDATE ON install_settings FOR EACH ROW EXECUTE FUNCTION reject_conditional_cursor()`)
	require.NoError(t, err)
	require.ErrorContains(t, s.backfillIssueEvents(ctx, row, nil), "cursor refused")
	require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE principal_id='issues/events'`))
	_, err = pool.Exec(ctx, `DROP TRIGGER reject_conditional_cursor ON install_settings`)
	require.NoError(t, err)
	require.NoError(t, s.backfillIssueEvents(ctx, row, nil))
	require.NoError(t, s.backfillIssueEvents(ctx, row, nil))
	reads = upstream.Reads()
	require.Equal(t, 200, reads[6].Status)
	require.Equal(t, 200, reads[7].Status, "failed commit must fetch the body again")
	require.Equal(t, reads[6].IfNoneMatch, reads[7].IfNoneMatch)
	require.Equal(t, 304, reads[8].Status)
	require.Equal(t, 2, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE principal_id='issues/events'`))
	fresh := NewGitHubSyncedRepoService(db.New(pool))
	require.NoError(t, fresh.ConfigureInstallSync(pool))
	allowFetched(fresh)
	fresh.SetConditionalFetcherFactory(client.SyncedRepoConditionalFetcherFactory(minter))
	require.NoError(t, fresh.backfillIssueEvents(ctx, row, nil))
	reads = upstream.Reads()
	require.Empty(t, reads[9].IfNoneMatch)
	require.Equal(t, 200, reads[9].Status)
	require.Equal(t, 2, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE principal_id='issues/events'`), "durable cursor prevents replay after ETags are lost")
}

func TestGitHubConditionalPullPagingFailureAndUnchangedTail(t *testing.T) {
	s, pool, row := newFetchedFixture(t)
	allowFetched(s)
	ctx := context.Background()
	var mu sync.Mutex
	fail, changed := true, false
	var paths, validators []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		paths = append(paths, r.URL.RequestURI())
		validators = append(validators, r.Header.Get("If-None-Match"))
		require.Equal(t, "Bearer minted-token", r.Header.Get("Authorization"))
		require.Equal(t, "/repos/factory/app/pulls", r.URL.Path)
		require.Equal(t, "50", r.URL.Query().Get("per_page"))
		page, err := strconv.Atoi(r.URL.Query().Get("page"))
		require.NoError(t, err)
		if fail && page == 11 {
			w.WriteHeader(503)
			return
		}
		etag := fmt.Sprintf(`"page-%d"`, page)
		if changed && page == 1 {
			etag = `"page-1-new"`
		}
		w.Header().Set("ETag", etag)
		if r.Header.Get("If-None-Match") == etag {
			w.WriteHeader(304)
			return
		}
		batch := make([]json.RawMessage, 0)
		for n := (page-1)*50 + 1; n <= page*50 && n <= 1101; n++ {
			title := "original"
			if changed && n == 1 {
				title = "changed"
			}
			batch = append(batch, json.RawMessage(fmt.Sprintf(`{"id":%d,"number":%d,"title":%q,"state":"open","updated_at":"2026-10-05T10:00:00Z"}`, n, n, title)))
		}
		_ = json.NewEncoder(w).Encode(batch)
	}))
	defer server.Close()
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)
	minter := &recordingMinter{}
	client := NewGitHubUserReposService(db.New(pool), nil)
	s.SetConditionalFetcherFactory(client.SyncedRepoConditionalFetcherFactory(minter))
	require.Error(t, s.backfillResource(ctx, row, "pulls", nil))
	require.Zero(t, fetchedCount(t, pool, `SELECT count(*) FROM github_synced_issues`))
	require.Zero(t, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests`))
	mu.Lock()
	require.Len(t, paths, 11)
	fail = false
	paths, validators = nil, nil
	mu.Unlock()
	require.NoError(t, s.backfillResource(ctx, row, "pulls", nil))
	mu.Lock()
	require.Len(t, paths, 23, "install paging continues beyond the former ten-page cap")
	for _, validator := range validators {
		require.Empty(t, validator, "failed walk retained no candidate ETags")
	}
	paths, validators = nil, nil
	mu.Unlock()
	require.Equal(t, 1101, fetchedCount(t, pool, `SELECT count(*) FROM github_synced_issues`))
	require.NoError(t, s.backfillResource(ctx, row, "pulls", nil))
	mu.Lock()
	require.Len(t, paths, 23, "equal timestamps keep later pages inside the overlap window")
	for page, validator := range validators {
		require.Equal(t, fmt.Sprintf(`"page-%d"`, page+1), validator)
	}
	changed = true
	paths, validators = nil, nil
	mu.Unlock()
	require.NoError(t, s.backfillResource(ctx, row, "pulls", nil))
	mu.Lock()
	require.Len(t, paths, 23, "unchanged full pages must not hide equal-timestamp edits later")
	for page, validator := range validators {
		require.Equal(t, fmt.Sprintf(`"page-%d"`, page+1), validator)
	}
	mu.Unlock()
	var title string
	require.NoError(t, pool.QueryRow(ctx, `SELECT title FROM github_synced_issues WHERE number=1`).Scan(&title))
	require.Equal(t, "changed", title)
	require.Equal(t, 1102, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests`))
	for _, scope := range minter.scopes {
		require.Equal(t, GitHubTokenScope{RepositoryIDs: []int64{99}, Permissions: map[string]string{"issues": "read", "pull_requests": "read"}}, scope)
	}
}

func TestGitHubConditionalRefusesUncommittedAndMalformedPages(t *testing.T) {
	for _, kind := range []string{"unsolicited-304", "null", "object", "cancelled", "revoked"} {
		t.Run(kind, func(t *testing.T) {
			s, pool, row := newFetchedFixture(t)
			allowFetched(s)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			s.SetConditionalFetcherFactory(func(db.GithubSyncedRepo) GitHubSyncedRepoConditionalFetcher {
				return func(context.Context, string, url.Values, string) (GitHubSyncedRepoConditionalPage, error) {
					page := GitHubSyncedRepoConditionalPage{ETag: `"uncommitted"`, Body: json.RawMessage("[" + fetchedFirst + "]")}
					switch kind {
					case "unsolicited-304":
						page.NotModified = true
					case "null":
						page.Body = json.RawMessage(`null`)
					case "object":
						page.Body = json.RawMessage(`{}`)
					case "cancelled":
						cancel()
					case "revoked":
						s.install.authorize = func(context.Context, db.GithubSyncedRepo) error { return errors.New("revoked") }
					}
					return page, nil
				}
			})
			require.Error(t, s.backfillResource(ctx, row, "issues", nil))
			require.Empty(t, s.install.etags)
			require.Zero(t, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests`))
			require.Zero(t, fetchedCount(t, pool, `SELECT count(*) FROM github_synced_issues`))
		})
	}
}

func TestGitHubConditionalValidatorsAreScopedToBindingAndURL(t *testing.T) {
	s, _, row := newFetchedFixture(t)
	allowFetched(s)
	var seen []string
	s.SetConditionalFetcherFactory(func(db.GithubSyncedRepo) GitHubSyncedRepoConditionalFetcher {
		return func(_ context.Context, _ string, _ url.Values, etag string) (GitHubSyncedRepoConditionalPage, error) {
			seen = append(seen, etag)
			return GitHubSyncedRepoConditionalPage{Body: json.RawMessage(`[]`), ETag: `"committed"`}, nil
		}
	})
	ctx := context.Background()
	query := url.Values{"page": {"1"}}
	read, commit := s.conditionalPages(row, nil)
	_, err := read(ctx, "issues", query)
	require.NoError(t, err)
	commit()
	for _, kind := range []string{"same", "installation", "repository", "registry", "owner", "name", "resource", "page"} {
		other, resource, q := row, "issues", query
		switch kind {
		case "installation":
			other.InstallationID.Int64++
		case "repository":
			other.GithubRepositoryID.Int64++
		case "registry":
			other.ID++
		case "owner":
			other.OwnerLogin = "other"
		case "name":
			other.RepoName = "other"
		case "resource":
			resource = "pulls"
		case "page":
			q = url.Values{"page": {"2"}}
		}
		read, _ = s.conditionalPages(other, nil)
		_, err = read(ctx, resource, q)
		require.NoError(t, err)
	}
	require.Equal(t, []string{"", `"committed"`, "", "", "", "", "", "", ""}, seen)
}

type incompleteGitHubBody struct{ sent bool }

func (b *incompleteGitHubBody) Read(p []byte) (int, error) {
	if !b.sent {
		b.sent = true
		return copy(p, `[]`), nil
	}
	return 0, io.ErrUnexpectedEOF
}

func (b *incompleteGitHubBody) Close() error { return nil }

func TestLandingGitHubConditionalRefusesIncompleteBodies(t *testing.T) {
	for _, kind := range []string{"interrupted", "oversized"} {
		t.Run(kind, func(t *testing.T) {
			var body io.ReadCloser = &incompleteGitHubBody{}
			if kind == "oversized" {
				body = io.NopCloser(strings.NewReader(`[]` + strings.Repeat(" ", 8<<20)))
			}
			client := &http.Client{Transport: githubUserReposHRoundTrip(func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: 200, Header: http.Header{"Etag": {`"bad"`}, "X-Ratelimit-Remaining": {"42"}}, Body: body}, nil
			})}
			api := &landingGitHubAPI{client: client, baseURL: func() string { return "https://github.invalid" }}
			out := json.RawMessage(`{"cached":true}`)
			status, headers, err := api.requestHeaders(context.Background(), "token", "GET", "/repos/o/r/issues", "", nil, &out)
			require.ErrorContains(t, err, "incomplete response")
			require.Equal(t, 200, status)
			require.Equal(t, "42", headers.Get("X-RateLimit-Remaining"))
			require.JSONEq(t, `{"cached":true}`, string(out))
		})
	}
}
