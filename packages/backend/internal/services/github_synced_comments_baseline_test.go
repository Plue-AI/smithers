package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type commentBaselineResult struct {
	repoID, issue int64
	err           error
}

// syncedCommentsFixture is an enrolled, reconciled, webhook-fed repo whose
// issue 7 advertises two comments GitHub holds as ids 1 and 2.
type syncedCommentsFixture struct {
	store   *fakeSyncedRepoStore
	service *GitHubSyncedRepoService
	row     db.GithubSyncedRepo
	done    chan commentBaselineResult
	mu      sync.Mutex
	fetches []string
	pages   map[string]string // "resource?query" -> body
	fail    error
	gate    chan struct{}
}

func newSyncedCommentsFixture(t *testing.T) *syncedCommentsFixture {
	t.Helper()
	f := &syncedCommentsFixture{
		store: newFakeSyncedRepoStore(),
		done:  make(chan commentBaselineResult, 8),
		pages: map[string]string{
			"issues/7/comments?page=1&per_page=100": `[{"id":1,"body":"historical 1"},{"id":2,"body":"historical 2"}]`,
		},
	}
	f.service = NewGitHubSyncedRepoService(f.store, WithGitHubSyncedRepoCommentBaselineNotify(func(repoID, issue int64, err error) {
		f.done <- commentBaselineResult{repoID, issue, err}
	}))
	row, err := f.service.EnrollGitHubRepo(context.Background(), EnrollGitHubRepoInput{Owner: "octo", Repo: "widget"})
	require.NoError(t, err)
	require.NoError(t, f.store.MarkGitHubSyncedRepoSynced(context.Background(), row.ID))
	require.NoError(t, f.store.TouchGitHubSyncedRepoWebhook(context.Background(), row.ID))
	seedSyncedIssueComments(t, f.store, row.ID, 7, 2)
	f.row = row
	return f
}

func (f *syncedCommentsFixture) fetch(ctx context.Context, resource string, query url.Values) (json.RawMessage, error) {
	key := resource + "?" + query.Encode()
	f.mu.Lock()
	f.fetches = append(f.fetches, key)
	gate, fail := f.gate, f.fail
	body, ok := f.pages[key]
	f.mu.Unlock()
	if gate != nil {
		select {
		case <-gate:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if fail != nil {
		return nil, fail
	}
	if !ok {
		return nil, fmt.Errorf("unexpected fetch %s", key)
	}
	return json.RawMessage(body), nil
}

func (f *syncedCommentsFixture) fetchCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.fetches)
}

func (f *syncedCommentsFixture) serve(issue int64) (GitHubSyncedMetadataPage, bool) {
	return f.service.ServeComments(context.Background(), testReadGrant("octo", "widget"), issue, url.Values{}, f.fetch)
}

func (f *syncedCommentsFixture) awaitBaseline(t *testing.T) commentBaselineResult {
	t.Helper()
	select {
	case result := <-f.done:
		return result
	case <-time.After(5 * time.Second):
		t.Fatal("comment baseline load never finished")
		return commentBaselineResult{}
	}
}

// #2405: an unrelated delivery heartbeats the repo, but the issue's historical
// comments were never stored. The store must not answer with an empty list.
func TestSyncedRepos_HeartbeatWithoutIssueBaselineServesLiveThenLoadsBaseline(t *testing.T) {
	f := newSyncedCommentsFixture(t)
	require.NoError(t, f.service.TouchWebhook(context.Background(), "octo", "widget", 0))

	_, served := f.serve(7)
	require.False(t, served, "a repository heartbeat is not a comment baseline for issue 7")
	result := f.awaitBaseline(t)
	require.NoError(t, result.err)
	assert.Equal(t, commentBaselineResult{repoID: f.row.ID, issue: 7}, result)
	assert.Equal(t, []string{"issues/7/comments?page=1&per_page=100"}, f.fetches)

	page, served := f.serve(7)
	require.True(t, served)
	assert.JSONEq(t, `[{"id":1,"body":"historical 1"},{"id":2,"body":"historical 2"}]`, string(page.Body))
	assert.False(t, page.Stale)
	assert.Equal(t, 1, f.fetchCount(), "a complete baseline serves from the store without another fetch")
}

func TestSyncedRepos_CommentBaselinePrunesCommentsGitHubNoLongerHas(t *testing.T) {
	f := newSyncedCommentsFixture(t)
	for _, id := range []int64{1, 2, 3} {
		require.NoError(t, f.store.UpsertGitHubSyncedIssueComment(context.Background(), db.UpsertGitHubSyncedIssueCommentParams{
			SyncedRepoID: f.row.ID, IssueNumber: 7, GithubID: id, Payload: json.RawMessage(fmt.Sprintf(`{"id":%d,"body":"stale"}`, id)),
		}))
	}
	// Three stored against two advertised: a missed delete. Not served.
	_, served := f.serve(7)
	require.False(t, served)
	require.NoError(t, f.awaitBaseline(t).err)

	page, served := f.serve(7)
	require.True(t, served)
	assert.JSONEq(t, `[{"id":1,"body":"historical 1"},{"id":2,"body":"historical 2"}]`, string(page.Body),
		"the reload refreshes kept comments and drops the deleted one")
}

func TestSyncedRepos_CommentBaselineWalksEveryPage(t *testing.T) {
	f := newSyncedCommentsFixture(t)
	first := make([]map[string]int64, githubSyncedRepoBackfillPageSize)
	for i := range first {
		first[i] = map[string]int64{"id": int64(i + 1)}
	}
	body, err := json.Marshal(first)
	require.NoError(t, err)
	f.pages["issues/7/comments?page=1&per_page=100"] = string(body)
	f.pages["issues/7/comments?page=2&per_page=100"] = `[{"id":101},{"id":102}]`
	seedSyncedIssueComments(t, f.store, f.row.ID, 7, 102)

	_, served := f.serve(7)
	require.False(t, served)
	require.NoError(t, f.awaitBaseline(t).err)
	assert.Equal(t, []string{"issues/7/comments?page=1&per_page=100", "issues/7/comments?page=2&per_page=100"}, f.fetches)

	page, served := f.serve(7)
	require.True(t, served)
	var rows []map[string]int64
	require.NoError(t, json.Unmarshal(page.Body, &rows))
	assert.Len(t, rows, githubSyncedRepoDefaultPerPage)
	assert.NotEmpty(t, page.Link, "the stored 102 comments page like GitHub's")
}

func TestSyncedRepos_CommentBaselineOverThePageCeilingKeepsStoredComments(t *testing.T) {
	f := newSyncedCommentsFixture(t)
	full := make([]map[string]int64, githubSyncedRepoBackfillPageSize)
	for page := 1; page <= githubSyncedRepoBackfillMaxPages; page++ {
		for i := range full {
			full[i] = map[string]int64{"id": int64((page-1)*githubSyncedRepoBackfillPageSize + i + 1)}
		}
		body, err := json.Marshal(full)
		require.NoError(t, err)
		f.pages[fmt.Sprintf("issues/7/comments?page=%d&per_page=100", page)] = string(body)
	}
	require.NoError(t, f.store.UpsertGitHubSyncedIssueComment(context.Background(), db.UpsertGitHubSyncedIssueCommentParams{
		SyncedRepoID: f.row.ID, IssueNumber: 7, GithubID: 99999, Payload: json.RawMessage(`{"id":99999}`),
	}))

	_, served := f.serve(7)
	require.False(t, served)
	require.NoError(t, f.awaitBaseline(t).err)
	assert.Len(t, f.fetches, githubSyncedRepoBackfillMaxPages)
	coverage, err := f.store.GetGitHubSyncedIssueCommentCoverage(context.Background(),
		db.GetGitHubSyncedIssueCommentCoverageParams{SyncedRepoID: f.row.ID, IssueNumber: 7})
	require.NoError(t, err)
	assert.Equal(t, int64(githubSyncedRepoBackfillPageSize*githubSyncedRepoBackfillMaxPages+1), coverage.Stored,
		"an unfinished walk never prunes")
}

func TestSyncedRepos_CommentBaselineFailureKeepsServingLive(t *testing.T) {
	f := newSyncedCommentsFixture(t)
	f.fail = errors.New("github unavailable")

	_, served := f.serve(7)
	require.False(t, served)
	assert.ErrorContains(t, f.awaitBaseline(t).err, "github unavailable")

	f.fail = nil
	_, served = f.serve(7)
	require.False(t, served, "a failed load leaves no baseline, so the next read retries it")
	require.NoError(t, f.awaitBaseline(t).err)
	_, served = f.serve(7)
	assert.True(t, served)
}

func TestSyncedRepos_CommentBaselineRejectsMalformedPages(t *testing.T) {
	f := newSyncedCommentsFixture(t)
	f.pages["issues/7/comments?page=1&per_page=100"] = `{"message":"not a list"}`
	_, served := f.serve(7)
	require.False(t, served)
	assert.ErrorContains(t, f.awaitBaseline(t).err, "decode github issue comments page")

	// Objects without a usable id are skipped, not stored.
	f.pages["issues/7/comments?page=1&per_page=100"] = `[{"id":1},{"body":"no id"},"junk",{"id":2}]`
	_, served = f.serve(7)
	require.False(t, served)
	require.NoError(t, f.awaitBaseline(t).err)
	page, served := f.serve(7)
	require.True(t, served)
	assert.JSONEq(t, `[{"id":1},{"id":2}]`, string(page.Body))
}

func TestSyncedRepos_ConcurrentReadsStartOneCommentBaseline(t *testing.T) {
	f := newSyncedCommentsFixture(t)
	f.gate = make(chan struct{})
	for range 5 {
		_, served := f.serve(7)
		require.False(t, served)
	}
	require.Eventually(t, func() bool { return f.fetchCount() == 1 }, 5*time.Second, 5*time.Millisecond)
	close(f.gate)
	require.NoError(t, f.awaitBaseline(t).err)
	assert.Equal(t, 1, f.fetchCount(), "reads during an in-flight load never start a second one")
	select {
	case extra := <-f.done:
		t.Fatalf("unexpected second baseline load: %+v", extra)
	default:
	}
}

func TestSyncedRepos_CommentCoverageWithoutBaselineSource(t *testing.T) {
	t.Run("issue not stored", func(t *testing.T) {
		f := newSyncedCommentsFixture(t)
		_, served := f.serve(8)
		assert.False(t, served, "without an advertised count there is never a complete baseline")
		require.NoError(t, f.service.ApplyIssueEvent(context.Background(), "octo", "widget", 0, GitHubRepoMetadataIssues, "opened",
			json.RawMessage(`{"id":110,"number":10,"state":"open","updated_at":"2026-08-01T00:00:00Z"}`)))
		_, served = f.serve(10)
		assert.False(t, served, "an issue payload without a comment count is no baseline either")
		assert.Zero(t, f.fetchCount(), "nothing a load could prove is never fetched")
	})
	t.Run("coverage unreadable", func(t *testing.T) {
		f := newSyncedCommentsFixture(t)
		f.store.coverageErr = errors.New("database down")
		_, served := f.serve(7)
		assert.False(t, served)
		assert.Zero(t, f.fetchCount(), "a store error serves live without loading anything")
	})
	t.Run("no fetcher", func(t *testing.T) {
		f := newSyncedCommentsFixture(t)
		_, served := f.service.ServeComments(context.Background(), testReadGrant("octo", "widget"), 7, url.Values{}, nil)
		assert.False(t, served)
		select {
		case result := <-f.done:
			t.Fatalf("no fetcher must not start a load: %+v", result)
		case <-time.After(50 * time.Millisecond):
		}
	})
	t.Run("budget exhausted", func(t *testing.T) {
		f := newSyncedCommentsFixture(t)
		budget := NewBudgetTrackerWithLimits(1, time.Hour)
		f.service.budget = budget
		f.row.InstallationID.Int64, f.row.InstallationID.Valid = 77, true
		allowed, _ := budget.Allow(77)
		require.True(t, allowed)
		f.service.scheduleCommentBaseline(f.row, 7, f.fetch)
		assert.Zero(t, f.fetchCount())
		_, running := f.service.commentBaselines.Load(fmt.Sprintf("%d|7", f.row.ID))
		assert.False(t, running, "a deferred load releases its in-flight claim")
	})
}

// A comment delivery carries the issue's current comment count, so the store
// keeps serving an issue whose every comment arrived by webhook.
func TestSyncedRepos_CommentDeliveriesKeepIssueBaselineExact(t *testing.T) {
	f := newSyncedCommentsFixture(t)
	ctx := context.Background()
	f.pages["issues/9/comments?page=1&per_page=100"] = `[]`
	require.NoError(t, f.service.ApplyIssueEvent(ctx, "octo", "widget", 0, GitHubRepoMetadataIssues, "opened",
		json.RawMessage(`{"id":109,"number":9,"state":"open","comments":0,"updated_at":"2026-08-01T00:00:00Z"}`)))
	page, served := f.serve(9)
	require.True(t, served)
	assert.JSONEq(t, `[]`, string(page.Body))

	require.NoError(t, f.service.ApplyIssueCommentEvent(ctx, "octo", "widget", 0, "created",
		json.RawMessage(`{"id":109,"number":9,"state":"open","comments":1,"updated_at":"2026-08-01T00:01:00Z"}`),
		json.RawMessage(`{"id":901,"body":"new","updated_at":"2026-08-01T00:01:00Z"}`)))
	page, served = f.serve(9)
	require.True(t, served)
	assert.JSONEq(t, `[{"id":901,"body":"new","updated_at":"2026-08-01T00:01:00Z"}]`, string(page.Body))

	require.NoError(t, f.service.ApplyIssueCommentEvent(ctx, "octo", "widget", 0, "deleted",
		json.RawMessage(`{"id":109,"number":9,"state":"open","comments":0,"updated_at":"2026-08-01T00:02:00Z"}`),
		json.RawMessage(`{"id":901}`)))
	page, served = f.serve(9)
	require.True(t, served)
	assert.JSONEq(t, `[]`, string(page.Body))
	assert.Zero(t, f.fetchCount())

	// A delivery without a usable issue object stores nothing.
	require.NoError(t, f.service.ApplyIssueCommentEvent(ctx, "octo", "widget", 0, "created", nil, json.RawMessage(`{"id":902}`)))
	require.NoError(t, f.service.ApplyIssueCommentEvent(ctx, "octo", "widget", 0, "created", json.RawMessage(`{"number":0}`), json.RawMessage(`{"id":902}`)))
	require.NoError(t, f.service.ApplyIssueCommentEvent(ctx, "octo", "widget", 0, "created", json.RawMessage(`{"id":109,"number":9,"comments":1}`), nil))
	page, served = f.serve(9)
	require.False(t, served, "the issue now advertises a comment the store never received")
	_ = page
}

// The #2405 reproduction on real PostgreSQL: a live read returns two
// historical comments; after the ordinary backfill and an unrelated delivery
// the store must still never answer with an empty list.
func TestGitHubIssueComments_UnrelatedWebhookKeepsHistoricalComments(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	repo := "widget-" + uuid.NewString()
	const historical = `[{"id":71,"body":"historical comment 1","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"},` +
		`{"id":72,"body":"historical comment 2","created_at":"2026-01-02T00:00:00Z","updated_at":"2026-01-02T00:00:00Z"}]`
	var commentReads atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/repos/octo/" + repo + "/issues":
			_, _ = w.Write([]byte(`[{"id":107,"number":7,"state":"open","title":"seven","comments":2,"updated_at":"2026-01-02T00:00:00Z"}]`))
		case "/repos/octo/" + repo + "/pulls":
			_, _ = w.Write([]byte(`[]`))
		case "/repos/octo/" + repo + "/issues/7/comments":
			commentReads.Add(1)
			_, _ = w.Write([]byte(historical))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	t.Setenv(envGitHubAppAPIBaseURL, srv.URL)

	baselines := make(chan error, 4)
	synced := NewGitHubSyncedRepoService(db.New(pool), WithGitHubSyncedRepoCommentBaselineNotify(func(_, _ int64, err error) {
		baselines <- err
	}))
	service := NewGitHubUserReposService(newFakeGitHubUserReposDB(), fakeOAuthTokenDecrypter{token: "gho_user"},
		WithGitHubUserReposSyncedStore(synced))
	userID := fixtureUser(t, pool, "synced-comments")
	row, err := synced.EnrollGitHubRepo(ctx, EnrollGitHubRepoInput{Owner: "octo", Repo: repo, EnrolledVia: GitHubSyncedRepoEnrolledViaLazy})
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM github_synced_repos WHERE id = $1`, row.ID)
	})
	require.NoError(t, synced.backfill(ctx, row, service.syncedRepoBackfillFetcher(userID, "octo", repo)))
	require.NoError(t, synced.RecordReadGrant(ctx, userID, "octo", repo))
	require.NoError(t, synced.TouchWebhook(ctx, "octo", repo, 0))

	read := func() GitHubRepoMetadataResult {
		t.Helper()
		result, err := service.ListAuthenticatedUserGitHubIssueComments(ctx, userID, "octo", repo, 7, url.Values{})
		require.NoError(t, err)
		return result
	}
	result := read()
	assert.Equal(t, GitHubRepoMetadataSourceLive, result.Source, "an unrelated heartbeat is not a comment baseline")
	assert.JSONEq(t, historical, string(result.Body))

	select {
	case err := <-baselines:
		require.NoError(t, err)
	case <-time.After(10 * time.Second):
		t.Fatal("comment baseline load never finished")
	}
	require.NoError(t, synced.TouchWebhook(ctx, "octo", repo, 0))
	result = read()
	assert.Equal(t, GitHubRepoMetadataSourceStore, result.Source)
	assert.False(t, result.Stale)
	assert.JSONEq(t, historical, string(result.Body))
	assert.Equal(t, int32(2), commentReads.Load(), "one live read and one baseline load, then the store serves")

	// A delivery that raises the advertised count without the comment itself
	// (a missed event) sends the issue back to live until the next baseline.
	require.NoError(t, synced.ApplyIssueEvent(ctx, "octo", repo, 0, GitHubRepoMetadataIssues, "edited",
		json.RawMessage(`{"id":107,"number":7,"state":"open","title":"seven","comments":3,"updated_at":"2026-01-03T00:00:00Z"}`)))
	assert.Equal(t, GitHubRepoMetadataSourceLive, read().Source)
	select {
	case err := <-baselines:
		require.NoError(t, err)
	case <-time.After(10 * time.Second):
		t.Fatal("comment baseline reload never finished")
	}
}
