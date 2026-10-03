package services

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type fakeGitHubUserReposDB struct {
	mu       sync.Mutex
	accounts []db.OauthAccount
	row      *db.GithubRepoListing
	upserts  []db.UpsertGitHubRepoListingParams
	syncErrs []db.SetGitHubRepoListingSyncErrorParams
	claims   int
	deletes  int
	getErr   error // non-ErrNoRows infrastructure failure injected into Get
	now      func() time.Time
}

func newFakeGitHubUserReposDB() *fakeGitHubUserReposDB {
	return &fakeGitHubUserReposDB{
		accounts: []db.OauthAccount{{
			Provider:             "workos",
			AccessTokenEncrypted: []byte("encrypted"),
		}},
		now: time.Now,
	}
}

func (f *fakeGitHubUserReposDB) ListUserOAuthAccounts(ctx context.Context, userID int64) ([]db.OauthAccount, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.accounts, nil
}

func (f *fakeGitHubUserReposDB) GetGitHubRepoListing(ctx context.Context, userID int64) (db.GithubRepoListing, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.getErr != nil {
		return db.GithubRepoListing{}, f.getErr
	}
	if f.row == nil {
		return db.GithubRepoListing{}, pgx.ErrNoRows
	}
	return *f.row, nil
}

func (f *fakeGitHubUserReposDB) DeleteGitHubRepoListing(ctx context.Context, userID int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deletes++
	f.row = nil
	return nil
}

func (f *fakeGitHubUserReposDB) deleteCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.deletes
}

func (f *fakeGitHubUserReposDB) UpsertGitHubRepoListing(ctx context.Context, arg db.UpsertGitHubRepoListingParams) (db.GithubRepoListing, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.upserts = append(f.upserts, arg)
	f.row = &db.GithubRepoListing{
		UserID:   arg.UserID,
		Payload:  arg.Payload,
		SyncedAt: f.now(),
	}
	return *f.row, nil
}

// ClaimGitHubRepoListingSync mirrors the SQL claim: succeeds only when no
// claim is live or the live claim is older than the 2-minute takeover window.
func (f *fakeGitHubUserReposDB) ClaimGitHubRepoListingSync(ctx context.Context, userID int64) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.row == nil {
		return 0, nil
	}
	f.claims++
	now := f.now()
	if f.row.SyncingSince.Valid && now.Sub(f.row.SyncingSince.Time) < 2*time.Minute {
		return 0, nil
	}
	f.row.SyncingSince = pgtype.Timestamptz{Time: now, Valid: true}
	return 1, nil
}

func (f *fakeGitHubUserReposDB) SetGitHubRepoListingSyncError(ctx context.Context, arg db.SetGitHubRepoListingSyncErrorParams) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.syncErrs = append(f.syncErrs, arg)
	if f.row != nil {
		f.row.SyncError = pgtype.Text{String: arg.SyncError, Valid: true}
		f.row.SyncingSince = pgtype.Timestamptz{}
	}
	return nil
}

func (f *fakeGitHubUserReposDB) upsertCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.upserts)
}

func (f *fakeGitHubUserReposDB) claimCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.claims
}

func (f *fakeGitHubUserReposDB) syncErrCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.syncErrs)
}

func (f *fakeGitHubUserReposDB) setRow(items []GitHubRepoListItem, syncedAt time.Time) {
	payload, err := json.Marshal(items)
	if err != nil {
		panic(err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.row = &db.GithubRepoListing{
		UserID:   42,
		Payload:  payload,
		SyncedAt: syncedAt,
	}
}

func mustParseQuery(t *testing.T, raw string) url.Values {
	t.Helper()
	values, err := url.ParseQuery(raw)
	require.NoError(t, err)
	return values
}

type fakeOAuthTokenDecrypter struct {
	token string
}

func (f fakeOAuthTokenDecrypter) DecryptOAuthAccessToken(ciphertext []byte) (string, error) {
	return f.token, nil
}

// fakeGitHubTokenRefresher is a test double for GitHubUserTokenRefresher, shared
// by the user-repos and import service tests (same package).
type fakeGitHubTokenRefresher struct {
	mu          sync.Mutex
	newToken    string
	err         error
	calls       int
	lastAccount db.OauthAccount
}

func (f *fakeGitHubTokenRefresher) RefreshUserGitHubToken(ctx context.Context, account db.OauthAccount) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	f.lastAccount = account
	if f.err != nil {
		return "", f.err
	}
	return f.newToken, nil
}

func (f *fakeGitHubTokenRefresher) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func (f *fakeGitHubTokenRefresher) account() db.OauthAccount {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lastAccount
}

func testRepoItems(n int) []GitHubRepoListItem {
	items := make([]GitHubRepoListItem, 0, n)
	for i := 0; i < n; i++ {
		items = append(items, GitHubRepoListItem{
			ID:       float64(i + 1),
			FullName: fmt.Sprintf("octo/repo-%d", i+1),
			Owner:    GitHubRepoOwner{Login: "octo"},
			Name:     fmt.Sprintf("repo-%d", i+1),
		})
	}
	return items
}

// countingRepoServer serves GET /user/repos pages from items, tracking hits.
type countingRepoServer struct {
	mu    sync.Mutex
	items []GitHubRepoListItem
	hits  int
	fail  int // HTTP status to force, 0 for success
}

func (c *countingRepoServer) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c.mu.Lock()
		c.hits++
		fail := c.fail
		items := c.items
		c.mu.Unlock()
		if fail != 0 {
			w.WriteHeader(fail)
			return
		}
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		if page < 1 {
			page = 1
		}
		perPage, _ := strconv.Atoi(r.URL.Query().Get("per_page"))
		if perPage < 1 {
			perPage = 30
		}
		start := (page - 1) * perPage
		if start > len(items) {
			start = len(items)
		}
		end := start + perPage
		if end > len(items) {
			end = len(items)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(items[start:end])
	}
}

func (c *countingRepoServer) hitCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.hits
}

func TestGitHubUserReposService_NonCanonicalQueryProxiesLive(t *testing.T) {
	var seenPath string
	var seenQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		seenQuery = r.URL.RawQuery
		assert.Equal(t, "Bearer gho_test_token", r.Header.Get("Authorization"))
		assert.Equal(t, "application/vnd.github+json", r.Header.Get("Accept"))
		assert.Equal(t, "smithers-server", r.Header.Get("User-Agent"))
		w.Header().Set("Link", `<https://api.github.test/user/repos?page=2>; rel="next"`)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode([]GitHubRepoListItem{{
			ID:            float64(123),
			FullName:      "octo/private-repo",
			Owner:         GitHubRepoOwner{Login: "octo"},
			Name:          "private-repo",
			Private:       true,
			DefaultBranch: "main",
			HTMLURL:       "https://github.com/octo/private-repo",
		}})
	}))
	defer srv.Close()
	t.Setenv(envGitHubAppAPIBaseURL, srv.URL)

	queries := newFakeGitHubUserReposDB()
	service := NewGitHubUserReposService(queries, fakeOAuthTokenDecrypter{token: "gho_test_token"})

	// affiliation/sort=updated don't match the canonical cached shape, so the
	// request passes straight through to GitHub with the Link echoed verbatim.
	result, err := service.ListAuthenticatedUserGitHubRepos(context.Background(), 42, mustParseQuery(t, "visibility=all&affiliation=owner&sort=updated&cursor=2&ignored=yes"))
	require.NoError(t, err)
	require.Len(t, result.Repos, 1)
	assert.Equal(t, "octo/private-repo", result.Repos[0].FullName)
	assert.Equal(t, `<https://api.github.test/user/repos?page=2>; rel="next"`, result.Link)
	assert.Equal(t, "/user/repos", seenPath)
	assert.Equal(t, "affiliation=owner&page=2&sort=updated&visibility=all", seenQuery)
	assert.Nil(t, result.CacheSyncedAt, "live passthrough carries no cache metadata")
	assert.Equal(t, 0, queries.upsertCount(), "live passthrough must not write the cache")
}

func TestGitHubUserReposService_FirstSyncBlocksStoresAndReturns(t *testing.T) {
	upstream := &countingRepoServer{items: testRepoItems(2)}
	srv := httptest.NewServer(upstream.handler())
	defer srv.Close()
	t.Setenv(envGitHubAppAPIBaseURL, srv.URL)

	queries := newFakeGitHubUserReposDB()
	service := NewGitHubUserReposService(queries, fakeOAuthTokenDecrypter{token: "gho_test_token"})

	result, err := service.ListAuthenticatedUserGitHubRepos(context.Background(), 42, mustParseQuery(t, "per_page=100&page=1&sort=pushed"))
	require.NoError(t, err)
	require.Len(t, result.Repos, 2)
	assert.Equal(t, "octo/repo-1", result.Repos[0].FullName)
	assert.Empty(t, result.Link, "short listing has no next page")
	require.NotNil(t, result.CacheSyncedAt, "first sync reports its sync time")
	assert.Equal(t, 1, queries.upsertCount(), "first sync stores the listing")
	assert.Equal(t, 1, upstream.hitCount(), "short first page ends pagination")
}

func TestGitHubUserReposService_FirstSyncPaginatesFullListing(t *testing.T) {
	upstream := &countingRepoServer{items: testRepoItems(130)}
	srv := httptest.NewServer(upstream.handler())
	defer srv.Close()
	t.Setenv(envGitHubAppAPIBaseURL, srv.URL)

	queries := newFakeGitHubUserReposDB()
	service := NewGitHubUserReposService(queries, fakeOAuthTokenDecrypter{token: "gho_test_token"})

	// First request: blocking sync pulls BOTH GitHub pages, stores 130 repos,
	// serves the requested first page with a synthesized cursor Link.
	result, err := service.ListAuthenticatedUserGitHubRepos(context.Background(), 42, mustParseQuery(t, "per_page=100&page=1&sort=pushed"))
	require.NoError(t, err)
	require.Len(t, result.Repos, 100)
	assert.Equal(t, `</api/user/github-repos?cursor=2&per_page=100>; rel="next"`, result.Link)
	assert.Equal(t, 2, upstream.hitCount())

	var stored []GitHubRepoListItem
	require.NoError(t, json.Unmarshal(queries.upserts[0].Payload, &stored))
	assert.Len(t, stored, 130, "the full merged listing is cached")

	// Second request: fresh cache serves page 2 without touching GitHub.
	result, err = service.ListAuthenticatedUserGitHubRepos(context.Background(), 42, mustParseQuery(t, "per_page=100&cursor=2&sort=pushed"))
	require.NoError(t, err)
	require.Len(t, result.Repos, 30)
	assert.Equal(t, "octo/repo-101", result.Repos[0].FullName)
	assert.Empty(t, result.Link)
	assert.Equal(t, 2, upstream.hitCount(), "cache hit must not call GitHub")
	assert.Equal(t, 0, queries.claimCount(), "fresh cache schedules no refresh")
}

func TestGitHubUserReposService_StaleCacheServesImmediatelyAndRefreshesOnce(t *testing.T) {
	upstream := &countingRepoServer{items: testRepoItems(3)}
	srv := httptest.NewServer(upstream.handler())
	defer srv.Close()
	t.Setenv(envGitHubAppAPIBaseURL, srv.URL)

	queries := newFakeGitHubUserReposDB()
	oldItems := []GitHubRepoListItem{{ID: float64(9), FullName: "octo/old-repo", Owner: GitHubRepoOwner{Login: "octo"}, Name: "old-repo"}}
	queries.setRow(oldItems, time.Now().Add(-10*time.Minute))

	syncDone := make(chan error, 16)
	service := NewGitHubUserReposService(
		queries,
		fakeOAuthTokenDecrypter{token: "gho_test_token"},
		WithGitHubUserReposSyncNotify(func(userID int64, err error) { syncDone <- err }),
	)

	// Hammer the stale cache concurrently: every request is served the
	// last-good payload immediately, and exactly ONE background refresh runs.
	const concurrency = 8
	var wg sync.WaitGroup
	results := make([]GitHubRepoListResult, concurrency)
	listErrs := make([]error, concurrency)
	for i := 0; i < concurrency; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], listErrs[i] = service.ListAuthenticatedUserGitHubRepos(context.Background(), 42, mustParseQuery(t, "per_page=100&page=1&sort=pushed"))
		}(i)
	}
	wg.Wait()

	for _, err := range listErrs {
		require.NoError(t, err)
	}
	for _, result := range results {
		require.Len(t, result.Repos, 1, "stale cache is served immediately")
		assert.Equal(t, "octo/old-repo", result.Repos[0].FullName)
		require.NotNil(t, result.CacheSyncedAt)
	}

	select {
	case err := <-syncDone:
		require.NoError(t, err)
	case <-time.After(5 * time.Second):
		t.Fatal("background refresh never completed")
	}
	select {
	case <-syncDone:
		t.Fatal("more than one background refresh ran")
	case <-time.After(50 * time.Millisecond):
	}

	assert.Equal(t, 1, queries.upsertCount(), "exactly one refresh stored the new listing")
	assert.Equal(t, 1, upstream.hitCount(), "exactly one refresh hit GitHub")

	// The next request is served the refreshed listing.
	result, err := service.ListAuthenticatedUserGitHubRepos(context.Background(), 42, mustParseQuery(t, "per_page=100&page=1&sort=pushed"))
	require.NoError(t, err)
	require.Len(t, result.Repos, 3)
	assert.Equal(t, "octo/repo-1", result.Repos[0].FullName)
}

func TestGitHubUserReposService_BackgroundFailurePreservesLastGood(t *testing.T) {
	upstream := &countingRepoServer{items: testRepoItems(3), fail: http.StatusInternalServerError}
	srv := httptest.NewServer(upstream.handler())
	defer srv.Close()
	t.Setenv(envGitHubAppAPIBaseURL, srv.URL)

	queries := newFakeGitHubUserReposDB()
	oldItems := []GitHubRepoListItem{{ID: float64(9), FullName: "octo/old-repo", Owner: GitHubRepoOwner{Login: "octo"}, Name: "old-repo"}}
	queries.setRow(oldItems, time.Now().Add(-10*time.Minute))

	syncDone := make(chan error, 1)
	service := NewGitHubUserReposService(
		queries,
		fakeOAuthTokenDecrypter{token: "gho_test_token"},
		WithGitHubUserReposSyncNotify(func(userID int64, err error) { syncDone <- err }),
	)

	result, err := service.ListAuthenticatedUserGitHubRepos(context.Background(), 42, mustParseQuery(t, "per_page=100&page=1&sort=pushed"))
	require.NoError(t, err)
	require.Len(t, result.Repos, 1, "stale cache served despite upstream being down")

	select {
	case err := <-syncDone:
		require.Error(t, err, "the background refresh must report the failure")
	case <-time.After(5 * time.Second):
		t.Fatal("background refresh never completed")
	}

	assert.Equal(t, 0, queries.upsertCount(), "a failed refresh must not touch the payload")
	require.Equal(t, 1, queries.syncErrCount())
	assert.Equal(t, "github user repositories request was rejected", queries.syncErrs[0].SyncError)

	// The last-good payload keeps being served, now with the error surfaced.
	result, err = service.ListAuthenticatedUserGitHubRepos(context.Background(), 42, mustParseQuery(t, "per_page=100&page=1&sort=pushed"))
	require.NoError(t, err)
	require.Len(t, result.Repos, 1)
	assert.Equal(t, "octo/old-repo", result.Repos[0].FullName)
	assert.Equal(t, "github user repositories request was rejected", result.CacheSyncError)
}

func TestGitHubUserReposService_CacheInfraFailureServesLive(t *testing.T) {
	// A cache INFRASTRUCTURE failure (missing table, DB blip) must degrade to
	// the live passthrough, never 500 the boot-path listing.
	upstream := &countingRepoServer{items: testRepoItems(2)}
	srv := httptest.NewServer(upstream.handler())
	defer srv.Close()
	t.Setenv(envGitHubAppAPIBaseURL, srv.URL)

	queries := newFakeGitHubUserReposDB()
	queries.getErr = fmt.Errorf(`relation "github_repo_listings" does not exist`)

	service := NewGitHubUserReposService(queries, fakeOAuthTokenDecrypter{token: "gho_test_token"})

	result, err := service.ListAuthenticatedUserGitHubRepos(context.Background(), 42, mustParseQuery(t, "per_page=100&page=1&sort=pushed"))
	require.NoError(t, err, "cache infra failure must fall back to the live listing")
	require.Len(t, result.Repos, 2)
	assert.Equal(t, 0, queries.upsertCount(), "the degraded live path must not write through the broken cache")
}

func TestGitHubUserReposService_CredentialGoneInvalidatesCache(t *testing.T) {
	// A background refresh that fails with the definitive 401 class (account
	// unlinked / token revoked) must DROP the cache row: serving last-good
	// repos forever would mask the explicit 401 the reconnect CTA keys off.
	upstream := &countingRepoServer{items: testRepoItems(3), fail: http.StatusUnauthorized}
	srv := httptest.NewServer(upstream.handler())
	defer srv.Close()
	t.Setenv(envGitHubAppAPIBaseURL, srv.URL)

	queries := newFakeGitHubUserReposDB()
	queries.setRow(testRepoItems(1), time.Now().Add(-10*time.Minute))

	syncDone := make(chan error, 1)
	service := NewGitHubUserReposService(
		queries,
		fakeOAuthTokenDecrypter{token: "gho_revoked_token"},
		WithGitHubUserReposSyncNotify(func(userID int64, err error) { syncDone <- err }),
	)

	// The stale cache is still served on THIS request (the refresh is async)...
	result, err := service.ListAuthenticatedUserGitHubRepos(context.Background(), 42, mustParseQuery(t, "per_page=100&page=1&sort=pushed"))
	require.NoError(t, err)
	require.Len(t, result.Repos, 1)

	select {
	case refreshErr := <-syncDone:
		require.Error(t, refreshErr)
	case <-time.After(5 * time.Second):
		t.Fatal("background refresh never completed")
	}

	// ...but the 401 refresh invalidated the row instead of recording a
	// sync_error over last-good data.
	require.Equal(t, 1, queries.deleteCount(), "credential-gone must invalidate the cache")
	assert.Equal(t, 0, queries.syncErrCount(), "invalidation replaces the sync-error record")

	// The next request misses the cache, blocks on the live path, and
	// surfaces the honest 401 taxonomy clients key their reconnect CTA off.
	_, err = service.ListAuthenticatedUserGitHubRepos(context.Background(), 42, mustParseQuery(t, "per_page=100&page=1&sort=pushed"))
	require.Error(t, err)
}

func TestGitHubUserReposService_FirstSyncKeepsHonestErrors(t *testing.T) {
	t.Run("token rejected", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusUnauthorized)
		}))
		defer srv.Close()
		t.Setenv(envGitHubAppAPIBaseURL, srv.URL)

		queries := newFakeGitHubUserReposDB()
		service := NewGitHubUserReposService(queries, fakeOAuthTokenDecrypter{token: "gho_test_token"})

		_, err := service.ListAuthenticatedUserGitHubRepos(context.Background(), 42, url.Values{})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "github oauth token was rejected")
		assert.Equal(t, 0, queries.upsertCount(), "failed first sync stores nothing")
	})

	t.Run("not connected", func(t *testing.T) {
		queries := newFakeGitHubUserReposDB()
		queries.accounts = nil
		service := NewGitHubUserReposService(queries, fakeOAuthTokenDecrypter{token: "gho_test_token"})

		_, err := service.ListAuthenticatedUserGitHubRepos(context.Background(), 42, url.Values{})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "github oauth account is not connected")
	})
}

func TestGitHubUserReposService_WarmGitHubRepoListing(t *testing.T) {
	upstream := &countingRepoServer{items: testRepoItems(2)}
	srv := httptest.NewServer(upstream.handler())
	defer srv.Close()
	t.Setenv(envGitHubAppAPIBaseURL, srv.URL)

	queries := newFakeGitHubUserReposDB()
	syncDone := make(chan error, 2)
	service := NewGitHubUserReposService(
		queries,
		fakeOAuthTokenDecrypter{token: "gho_test_token"},
		WithGitHubUserReposSyncNotify(func(userID int64, err error) { syncDone <- err }),
	)

	// No cache row: the warm performs the first sync in the background.
	service.WarmGitHubRepoListing(42)
	select {
	case err := <-syncDone:
		require.NoError(t, err)
	case <-time.After(5 * time.Second):
		t.Fatal("warm never completed")
	}
	assert.Equal(t, 1, queries.upsertCount())
	assert.Equal(t, 1, upstream.hitCount())

	// Fresh cache row: warming again is a no-op (no GitHub call, no upsert).
	service.WarmGitHubRepoListing(42)
	select {
	case err := <-syncDone:
		require.NoError(t, err)
	case <-time.After(5 * time.Second):
		t.Fatal("second warm never completed")
	}
	assert.Equal(t, 1, queries.upsertCount(), "fresh cache must not be re-synced")
	assert.Equal(t, 1, upstream.hitCount())
}

func TestGitHubUserReposService_CachePagingDefaults(t *testing.T) {
	queries := newFakeGitHubUserReposDB()
	queries.setRow(testRepoItems(150), time.Now())
	service := NewGitHubUserReposService(queries, fakeOAuthTokenDecrypter{token: "gho_test_token"})

	// Default page size mirrors GitHub's (30) and pages via cursor Links.
	result, err := service.ListAuthenticatedUserGitHubRepos(context.Background(), 42, url.Values{})
	require.NoError(t, err)
	require.Len(t, result.Repos, 30)
	assert.Equal(t, "octo/repo-1", result.Repos[0].FullName)
	assert.Equal(t, `</api/user/github-repos?cursor=2&per_page=30>; rel="next"`, result.Link)

	// per_page above GitHub's max clamps to 100.
	result, err = service.ListAuthenticatedUserGitHubRepos(context.Background(), 42, mustParseQuery(t, "per_page=500"))
	require.NoError(t, err)
	require.Len(t, result.Repos, 100)

	// Pages past the end return an empty array, never an error.
	result, err = service.ListAuthenticatedUserGitHubRepos(context.Background(), 42, mustParseQuery(t, "per_page=100&page=9"))
	require.NoError(t, err)
	assert.NotNil(t, result.Repos)
	assert.Len(t, result.Repos, 0)
	assert.Empty(t, result.Link)

	// An adversarial page (or cursor) must not overflow back into an in-range
	// slice and return cached data.
	for _, q := range []string{
		"per_page=100&page=4611686018427387905",
		"per_page=100&cursor=4611686018427387905",
		"per_page=100&page=9223372036854775807",
		"per_page=100&cursor=9223372036854775807",
	} {
		result, err = service.ListAuthenticatedUserGitHubRepos(context.Background(), 42, mustParseQuery(t, q))
		require.NoError(t, err, q)
		assert.NotNil(t, result.Repos, q)
		assert.Len(t, result.Repos, 0, q)
		assert.Empty(t, result.Link, q)
	}
}

// TestGitHubUserReposService_RefreshesExpiredTokenOnce covers the core bug fix:
// a stored user token rejected with 401 is refreshed once, and the request is
// retried with the rotated token — turning the ~8h-post-connect outage into a
// silent renewal.
func TestGitHubUserReposService_RefreshesExpiredTokenOnce(t *testing.T) {
	// The upstream 401s the expired "gho_old" token and 200s the rotated
	// "gho_new" token, keying off the Authorization header.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "Bearer gho_new" {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(testRepoItems(2))
			return
		}
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()
	t.Setenv(envGitHubAppAPIBaseURL, srv.URL)

	queries := newFakeGitHubUserReposDB()
	refresher := &fakeGitHubTokenRefresher{newToken: "gho_new"}
	service := NewGitHubUserReposService(
		queries,
		fakeOAuthTokenDecrypter{token: "gho_old"},
		WithGitHubUserReposTokenRefresher(refresher),
	)

	result, err := service.ListAuthenticatedUserGitHubRepos(context.Background(), 42, mustParseQuery(t, "per_page=100&page=1&sort=pushed"))
	require.NoError(t, err)
	require.Len(t, result.Repos, 2, "the retry with the rotated token returns the listing")
	assert.Equal(t, 1, refresher.callCount(), "the expired token is refreshed exactly once")
	assert.Equal(t, "workos", refresher.account().Provider, "the selected oauth account is handed to the refresher")
	assert.Equal(t, 1, queries.upsertCount(), "the refreshed listing is cached")
}

// TestGitHubUserReposService_RefreshFailureSurfacesCredentialGone verifies the
// fallback is unchanged: when the refresh cannot succeed (no refresh token /
// refresh rejected), the honest 401 the reconnect CTA keys off is preserved and
// there is no retry loop.
func TestGitHubUserReposService_RefreshFailureSurfacesCredentialGone(t *testing.T) {
	upstream := &countingRepoServer{items: testRepoItems(3), fail: http.StatusUnauthorized}
	srv := httptest.NewServer(upstream.handler())
	defer srv.Close()
	t.Setenv(envGitHubAppAPIBaseURL, srv.URL)

	queries := newFakeGitHubUserReposDB()
	refresher := &fakeGitHubTokenRefresher{err: fmt.Errorf("no refresh token stored")}
	service := NewGitHubUserReposService(
		queries,
		fakeOAuthTokenDecrypter{token: "gho_old"},
		WithGitHubUserReposTokenRefresher(refresher),
	)

	_, err := service.ListAuthenticatedUserGitHubRepos(context.Background(), 42, url.Values{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "github oauth token was rejected")
	assert.Equal(t, 1, refresher.callCount(), "exactly one refresh is attempted, then the 401 surfaces")
	assert.Equal(t, 0, queries.upsertCount(), "a failed refresh stores nothing")
}

// TestGitHubUserReposService_ValidTokenSkipsRefresh proves a working token never
// triggers the refresh path.
func TestGitHubUserReposService_ValidTokenSkipsRefresh(t *testing.T) {
	upstream := &countingRepoServer{items: testRepoItems(2)}
	srv := httptest.NewServer(upstream.handler())
	defer srv.Close()
	t.Setenv(envGitHubAppAPIBaseURL, srv.URL)

	queries := newFakeGitHubUserReposDB()
	refresher := &fakeGitHubTokenRefresher{newToken: "gho_new"}
	service := NewGitHubUserReposService(
		queries,
		fakeOAuthTokenDecrypter{token: "gho_test_token"},
		WithGitHubUserReposTokenRefresher(refresher),
	)

	result, err := service.ListAuthenticatedUserGitHubRepos(context.Background(), 42, mustParseQuery(t, "per_page=100&page=1&sort=pushed"))
	require.NoError(t, err)
	require.Len(t, result.Repos, 2)
	assert.Equal(t, 0, refresher.callCount(), "a valid token must not trigger a refresh")
}

// TestGitHubUserReposService_ForbiddenDoesNotRefresh verifies a 403 (rate limit /
// SAML-SSO / access denial) does NOT trigger a token refresh — only a genuine 401
// (expired token) does. GitHub App refresh tokens are single-use, so rotating them
// on every 403 during a rate-limit storm caused the 2026-07-04 reconnect cascade.
func TestGitHubUserReposService_ForbiddenDoesNotRefresh(t *testing.T) {
	upstream := &countingRepoServer{items: testRepoItems(3), fail: http.StatusForbidden}
	srv := httptest.NewServer(upstream.handler())
	defer srv.Close()
	t.Setenv(envGitHubAppAPIBaseURL, srv.URL)

	queries := newFakeGitHubUserReposDB()
	refresher := &fakeGitHubTokenRefresher{newToken: "gho_new"}
	service := NewGitHubUserReposService(
		queries,
		fakeOAuthTokenDecrypter{token: "gho_old"},
		WithGitHubUserReposTokenRefresher(refresher),
	)

	_, err := service.ListAuthenticatedUserGitHubRepos(context.Background(), 42, url.Values{})
	require.Error(t, err)
	assert.Equal(t, 0, refresher.callCount(), "a 403 must NOT trigger a refresh (single-use refresh-token protection)")
}

func TestGitHubUserReposService_VerifyUserCanPushToGitHubRepo(t *testing.T) {
	permissions := map[string]any{"push": true}
	var status int
	var seenPath, seenAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		seenAuth = r.Header.Get("Authorization")
		if status != 0 {
			w.WriteHeader(status)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"id": 777, "permissions": permissions})
	}))
	defer srv.Close()
	t.Setenv(envGitHubAppAPIBaseURL, srv.URL)

	service := NewGitHubUserReposService(newFakeGitHubUserReposDB(), fakeOAuthTokenDecrypter{token: "gho_test_token"})

	// Push permission verifies.
	repositoryID, err := service.VerifyUserCanPushToGitHubRepo(context.Background(), 42, "octo", "hello")
	require.NoError(t, err)
	assert.EqualValues(t, 777, repositoryID, "connect records the id GitHub verified")
	assert.Equal(t, "/repos/octo/hello", seenPath)
	assert.Equal(t, "Bearer gho_test_token", seenAuth)

	// Read-only access is rejected.
	permissions = map[string]any{"pull": true}
	_, err = service.VerifyUserCanPushToGitHubRepo(context.Background(), 42, "octo", "hello")
	require.Error(t, err)
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok)
	assert.Equal(t, http.StatusForbidden, apiErr.Status)

	// A repo the user cannot even see (404) is rejected, not an internal error.
	status = http.StatusNotFound
	_, err = service.VerifyUserCanPushToGitHubRepo(context.Background(), 42, "victim-org", "private-repo")
	require.Error(t, err)
	apiErr, ok = err.(*pkgerrors.APIError)
	require.True(t, ok)
	assert.Equal(t, http.StatusForbidden, apiErr.Status)
}

func TestGitHubUserReposService_VerifyUserCanPushRefreshesExpiredTokenOnce(t *testing.T) {
	var authHeaders []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeaders = append(authHeaders, r.Header.Get("Authorization"))
		if r.Header.Get("Authorization") != "Bearer gho_new" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"permissions": map[string]any{"push": true}})
	}))
	defer srv.Close()
	t.Setenv(envGitHubAppAPIBaseURL, srv.URL)

	refresher := &fakeGitHubTokenRefresher{newToken: "gho_new"}
	service := NewGitHubUserReposService(
		newFakeGitHubUserReposDB(),
		fakeOAuthTokenDecrypter{token: "gho_old"},
		WithGitHubUserReposTokenRefresher(refresher),
	)

	token, err := service.GitHubPushToken(context.Background(), 42, "octo", "hello")
	require.NoError(t, err)
	assert.Equal(t, "gho_new", token)
	assert.Equal(t, []string{"Bearer gho_old", "Bearer gho_new"}, authHeaders)
	assert.Equal(t, 1, refresher.callCount())
}

func TestGitHubUserReposService_ResolveTokenPrefersGitHubOverEarlierWorkOS(t *testing.T) {
	t.Parallel()

	queries := newFakeGitHubUserReposDB()
	queries.accounts = []db.OauthAccount{
		{Provider: "workos", AccessTokenEncrypted: []byte("enc-workos")},
		{Provider: "github", AccessTokenEncrypted: []byte("enc-github")},
	}
	service := NewGitHubUserReposService(queries, fakeOAuthTokenDecrypter{token: "gho_token"})

	_, account, err := service.resolveUserGitHubAccessToken(context.Background(), 42)
	require.NoError(t, err)
	assert.Equal(t, "github", account.Provider, "an older workos account must not shadow the connected github account")

	// WorkOS-only users still resolve (plue's WorkOS path is GitHub-backed).
	queries.accounts = []db.OauthAccount{{Provider: "workos", AccessTokenEncrypted: []byte("enc-workos")}}
	_, account, err = service.resolveUserGitHubAccessToken(context.Background(), 42)
	require.NoError(t, err)
	assert.Equal(t, "workos", account.Provider)
}
