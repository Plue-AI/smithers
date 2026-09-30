package services

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestGitHubRepoMetadata_ListsVisibleRepoWithoutImport(t *testing.T) {
	type capturedRequest struct {
		path    string
		query   url.Values
		auth    string
		accept  string
		version string
	}
	var mu sync.Mutex
	var captured capturedRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		captured = capturedRequest{
			path:    r.URL.Path,
			query:   r.URL.Query(),
			auth:    r.Header.Get("Authorization"),
			accept:  r.Header.Get("Accept"),
			version: r.Header.Get("X-GitHub-Api-Version"),
		}
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Link", `<https://api.github.test/repos/octo/widget/issues?page=2>; rel="next"`)
		_, _ = w.Write([]byte(`[{"number":17,"title":"Visible issue","pull_request":{"url":"ignored by API"}}]`))
	}))
	defer srv.Close()
	t.Setenv(envGitHubAppAPIBaseURL, srv.URL)

	service := NewGitHubUserReposService(newFakeGitHubUserReposDB(), fakeOAuthTokenDecrypter{token: "gho_user"})
	result, err := service.ListAuthenticatedUserGitHubRepoMetadata(
		context.Background(),
		42,
		"octo",
		"widget",
		GitHubRepoMetadataIssues,
		mustParseQuery(t, "state=open&sort=updated&direction=desc&labels=bug%2Cpriority&per_page=50&page=2"),
	)
	require.NoError(t, err)
	assert.JSONEq(t, `[{"number":17,"title":"Visible issue","pull_request":{"url":"ignored by API"}}]`, string(result.Body))
	assert.Equal(t, `<https://api.github.test/repos/octo/widget/issues?page=2>; rel="next"`, result.Link)

	mu.Lock()
	got := captured
	mu.Unlock()
	assert.Equal(t, "/repos/octo/widget/issues", got.path)
	assert.Equal(t, "open", got.query.Get("state"))
	assert.Equal(t, "updated", got.query.Get("sort"))
	assert.Equal(t, "desc", got.query.Get("direction"))
	assert.Equal(t, "bug,priority", got.query.Get("labels"))
	assert.Equal(t, "50", got.query.Get("per_page"))
	assert.Equal(t, "2", got.query.Get("page"))
	assert.Equal(t, "Bearer gho_user", got.auth)
	assert.Equal(t, "application/vnd.github+json", got.accept)
	assert.Equal(t, "2022-11-28", got.version)
}

func TestGitHubRepoMetadata_GetsTypedPullWithUserCredential(t *testing.T) {
	var mu sync.Mutex
	var path, auth, accept string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		path, auth, accept = r.URL.Path, r.Header.Get("Authorization"), r.Header.Get("Accept")
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"number":17,"title":"Upstream PR","state":"open"}`))
	}))
	defer srv.Close()
	t.Setenv(envGitHubAppAPIBaseURL, srv.URL)

	service := NewGitHubUserReposService(newFakeGitHubUserReposDB(), fakeOAuthTokenDecrypter{token: "gho_user"})
	result, err := service.GetAuthenticatedUserGitHubPull(context.Background(), 42, "upstream", "project", 17)
	require.NoError(t, err)
	assert.JSONEq(t, `{"number":17,"title":"Upstream PR","state":"open"}`, string(result.Body))
	mu.Lock()
	gotPath, gotAuth, gotAccept := path, auth, accept
	mu.Unlock()
	assert.Equal(t, "/repos/upstream/project/pulls/17", gotPath)
	assert.Equal(t, "Bearer gho_user", gotAuth)
	assert.Equal(t, "application/vnd.github+json", gotAccept)
}

func TestGitHubRepoMetadata_TypedPullDoesNotFallbackAfterNotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()
	t.Setenv(envGitHubAppAPIBaseURL, srv.URL)

	service := NewGitHubUserReposService(newFakeGitHubUserReposDB(), fakeOAuthTokenDecrypter{token: "gho_user"})
	_, err := service.GetAuthenticatedUserGitHubPull(context.Background(), 42, "upstream", "project", 17)
	require.Error(t, err)
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok)
	assert.Equal(t, http.StatusNotFound, apiErr.Status)
	_, err = service.GetAuthenticatedUserGitHubPull(context.Background(), 42, "upstream", "project", 0)
	require.Error(t, err)
	apiErr, ok = err.(*pkgerrors.APIError)
	require.True(t, ok)
	assert.Equal(t, http.StatusBadRequest, apiErr.Status)
}

func TestGitHubRepoMetadata_GetsArbitraryVisibleRepoObjectWithoutImport(t *testing.T) {
	var mu sync.Mutex
	var gotPath, gotAuth string
	payload := []byte(`{"owner":{"login":"smithersai"},"name":"smithers","full_name":"smithersai/smithers","default_branch":"main"}`)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		gotPath, gotAuth = r.URL.Path, r.Header.Get("Authorization")
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(payload)
	}))
	defer srv.Close()
	t.Setenv(envGitHubAppAPIBaseURL, srv.URL)

	service := NewGitHubUserReposService(newFakeGitHubUserReposDB(), fakeOAuthTokenDecrypter{token: "gho_user"})
	result, err := service.GetAuthenticatedUserGitHubRepo(context.Background(), 42, "smithersai", "smithers")
	require.NoError(t, err)
	require.Equal(t, payload, []byte(result.Body))
	mu.Lock()
	path, auth := gotPath, gotAuth
	mu.Unlock()
	assert.Equal(t, "/repos/smithersai/smithers", path)
	assert.Equal(t, "Bearer gho_user", auth)
}

func TestGitHubRepoMetadata_GetRepoRefreshesExpiredTokenOnce(t *testing.T) {
	var mu sync.Mutex
	var authHeaders []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		authHeaders = append(authHeaders, r.Header.Get("Authorization"))
		mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer gho_new" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`{"full_name":"smithersai/smithers"}`))
	}))
	defer srv.Close()
	t.Setenv(envGitHubAppAPIBaseURL, srv.URL)

	refresher := &fakeGitHubTokenRefresher{newToken: "gho_new"}
	service := NewGitHubUserReposService(
		newFakeGitHubUserReposDB(),
		fakeOAuthTokenDecrypter{token: "gho_old"},
		WithGitHubUserReposTokenRefresher(refresher),
	)
	result, err := service.GetAuthenticatedUserGitHubRepo(context.Background(), 42, "smithersai", "smithers")
	require.NoError(t, err)
	assert.JSONEq(t, `{"full_name":"smithersai/smithers"}`, string(result.Body))
	assert.Equal(t, 1, refresher.callCount())
	mu.Lock()
	gotHeaders := append([]string(nil), authHeaders...)
	mu.Unlock()
	assert.Equal(t, []string{"Bearer gho_old", "Bearer gho_new"}, gotHeaders)
}

func TestGitHubRepoMetadata_PullsUseOnlyPullFiltersAndCursorAlias(t *testing.T) {
	var gotPath, gotRawQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotRawQuery = r.URL.RawQuery
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()
	t.Setenv(envGitHubAppAPIBaseURL, srv.URL)

	service := NewGitHubUserReposService(newFakeGitHubUserReposDB(), fakeOAuthTokenDecrypter{token: "gho_user"})
	result, err := service.ListAuthenticatedUserGitHubRepoMetadata(
		context.Background(), 42, "octo", "widget", GitHubRepoMetadataPulls,
		mustParseQuery(t, "state=all&sort=long-running&direction=asc&head=octo%3Afeature&base=main&per_page=100&cursor=3"),
	)
	require.NoError(t, err)
	assert.Equal(t, []byte(`[]`), []byte(result.Body))
	assert.Equal(t, "/repos/octo/widget/pulls", gotPath)
	assert.Equal(t, "base=main&direction=asc&head=octo%3Afeature&page=3&per_page=100&sort=long-running&state=all", gotRawQuery)
}

func TestGitHubRepoMetadata_StrictlyValidatesResourcePathAndQuery(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()
	t.Setenv(envGitHubAppAPIBaseURL, srv.URL)
	service := NewGitHubUserReposService(newFakeGitHubUserReposDB(), fakeOAuthTokenDecrypter{token: "gho_user"})

	tests := []struct {
		name     string
		owner    string
		repo     string
		resource string
		query    url.Values
	}{
		{name: "unknown resource", owner: "octo", repo: "widget", resource: "contents", query: url.Values{}},
		{name: "owner path injection", owner: "octo/other", repo: "widget", resource: GitHubRepoMetadataIssues, query: url.Values{}},
		{name: "repo path injection", owner: "octo", repo: "../private", resource: GitHubRepoMetadataIssues, query: url.Values{}},
		{name: "unknown query", owner: "octo", repo: "widget", resource: GitHubRepoMetadataIssues, query: url.Values{"since": {"now"}}},
		{name: "pull-only filter on issues", owner: "octo", repo: "widget", resource: GitHubRepoMetadataIssues, query: url.Values{"head": {"octo:feature"}}},
		{name: "issue-only filter on pulls", owner: "octo", repo: "widget", resource: GitHubRepoMetadataPulls, query: url.Values{"labels": {"bug"}}},
		{name: "duplicate value", owner: "octo", repo: "widget", resource: GitHubRepoMetadataIssues, query: url.Values{"state": {"open", "closed"}}},
		{name: "invalid state", owner: "octo", repo: "widget", resource: GitHubRepoMetadataIssues, query: url.Values{"state": {"draft"}}},
		{name: "oversize page", owner: "octo", repo: "widget", resource: GitHubRepoMetadataIssues, query: url.Values{"per_page": {"101"}}},
		{name: "page cursor conflict", owner: "octo", repo: "widget", resource: GitHubRepoMetadataIssues, query: url.Values{"page": {"1"}, "cursor": {"2"}}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := service.ListAuthenticatedUserGitHubRepoMetadata(context.Background(), 42, tc.owner, tc.repo, tc.resource, tc.query)
			require.Error(t, err)
			var apiErr *pkgerrors.APIError
			require.ErrorAs(t, err, &apiErr)
			assert.Equal(t, http.StatusBadRequest, apiErr.Status)
		})
	}
	assert.Equal(t, 0, hits, "invalid input must never reach GitHub")
}

func TestGitHubRepoMetadata_RefreshesExpiredTokenOnce(t *testing.T) {
	var mu sync.Mutex
	var authHeaders []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		authHeaders = append(authHeaders, r.Header.Get("Authorization"))
		mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer gho_new" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`[{"number":9}]`))
	}))
	defer srv.Close()
	t.Setenv(envGitHubAppAPIBaseURL, srv.URL)

	refresher := &fakeGitHubTokenRefresher{newToken: "gho_new"}
	service := NewGitHubUserReposService(
		newFakeGitHubUserReposDB(),
		fakeOAuthTokenDecrypter{token: "gho_old"},
		WithGitHubUserReposTokenRefresher(refresher),
	)
	result, err := service.ListAuthenticatedUserGitHubRepoMetadata(context.Background(), 42, "octo", "widget", GitHubRepoMetadataPulls, url.Values{"state": {"open"}})
	require.NoError(t, err)
	assert.JSONEq(t, `[{"number":9}]`, string(result.Body))
	assert.Equal(t, 1, refresher.callCount())
	mu.Lock()
	gotHeaders := append([]string(nil), authHeaders...)
	mu.Unlock()
	assert.Equal(t, []string{"Bearer gho_old", "Bearer gho_new"}, gotHeaders)
}

func TestGitHubRepoMetadata_RetryAfterUsesResetAndStaysPositiveAndBounded(t *testing.T) {
	now := time.Unix(1_000, 0).UTC()
	tests := []struct {
		name   string
		header http.Header
		want   int
	}{
		{name: "reset timestamp", header: http.Header{"X-Ratelimit-Reset": {"1120"}}, want: 120},
		{name: "past reset floors positive", header: http.Header{"X-Ratelimit-Reset": {"900"}}, want: 1},
		{name: "distant reset is bounded", header: http.Header{"X-Ratelimit-Reset": {"10000"}}, want: 3600},
		{name: "explicit retry is bounded", header: http.Header{"Retry-After": {"99999"}}, want: 3600},
		{name: "malformed headers still back off", header: http.Header{"Retry-After": {"nope"}}, want: 1},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, gitHubRepoMetadataRetryAfter(tc.header, now))
		})
	}
}

func TestGitHubRepoMetadata_MapsUpstreamStatusesWithoutRefreshingForbidden(t *testing.T) {
	fixedNow := time.Unix(1_000, 0).UTC()
	tests := []struct {
		name       string
		status     int
		headers    map[string]string
		wantStatus int
		wantRetry  int
	}{
		{name: "forbidden", status: http.StatusForbidden, wantStatus: http.StatusForbidden},
		{name: "forbidden rate limit", status: http.StatusForbidden, headers: map[string]string{"X-RateLimit-Remaining": "0", "Retry-After": "12"}, wantStatus: http.StatusTooManyRequests, wantRetry: 12},
		{name: "primary rate limit reset", status: http.StatusForbidden, headers: map[string]string{"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1120"}, wantStatus: http.StatusTooManyRequests, wantRetry: 120},
		{name: "not found", status: http.StatusNotFound, wantStatus: http.StatusNotFound},
		{name: "unprocessable", status: http.StatusUnprocessableEntity, wantStatus: http.StatusUnprocessableEntity},
		{name: "upstream failure", status: http.StatusInternalServerError, wantStatus: http.StatusBadGateway},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				for key, value := range tc.headers {
					w.Header().Set(key, value)
				}
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(`{"message":"upstream detail"}`))
			}))
			defer srv.Close()
			t.Setenv(envGitHubAppAPIBaseURL, srv.URL)

			refresher := &fakeGitHubTokenRefresher{newToken: "gho_new"}
			service := NewGitHubUserReposService(
				newFakeGitHubUserReposDB(),
				fakeOAuthTokenDecrypter{token: "gho_user"},
				WithGitHubUserReposTokenRefresher(refresher),
				WithGitHubUserReposNow(func() time.Time { return fixedNow }),
			)
			_, err := service.ListAuthenticatedUserGitHubRepoMetadata(context.Background(), 42, "octo", "widget", GitHubRepoMetadataIssues, url.Values{})
			require.Error(t, err)
			var apiErr *pkgerrors.APIError
			require.ErrorAs(t, err, &apiErr)
			assert.Equal(t, tc.wantStatus, apiErr.Status)
			assert.Equal(t, tc.wantRetry, apiErr.RetryAfter)
			assert.Equal(t, 0, refresher.callCount(), "only 401 may rotate the user token")
		})
	}
}

func TestGitHubRepoMetadata_RejectsMalformedAndOversizedSuccessResponses(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{name: "malformed", body: `{"not":"an array"}`},
		{name: "null", body: `null`},
		{name: "oversized", body: strings.Repeat("x", int(githubRepoMetadataMaxResponseBytes)+1)},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer srv.Close()
			t.Setenv(envGitHubAppAPIBaseURL, srv.URL)

			service := NewGitHubUserReposService(newFakeGitHubUserReposDB(), fakeOAuthTokenDecrypter{token: "gho_user"})
			_, err := service.ListAuthenticatedUserGitHubRepoMetadata(context.Background(), 42, "octo", "widget", GitHubRepoMetadataIssues, url.Values{})
			require.Error(t, err)
			var apiErr *pkgerrors.APIError
			require.ErrorAs(t, err, &apiErr)
			assert.Equal(t, http.StatusBadGateway, apiErr.Status)
		})
	}
}

func TestGitHubRepoMetadata_PreservesMaximumSizedRawJSONWithoutExpansion(t *testing.T) {
	payload := append([]byte("[\""), bytes.Repeat([]byte("<"), int(githubRepoMetadataMaxResponseBytes)-4)...)
	payload = append(payload, '"', ']')
	require.Len(t, payload, int(githubRepoMetadataMaxResponseBytes))

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(payload)
	}))
	defer srv.Close()
	t.Setenv(envGitHubAppAPIBaseURL, srv.URL)

	service := NewGitHubUserReposService(newFakeGitHubUserReposDB(), fakeOAuthTokenDecrypter{token: "gho_user"})
	result, err := service.ListAuthenticatedUserGitHubRepoMetadata(context.Background(), 42, "octo", "widget", GitHubRepoMetadataIssues, url.Values{})
	require.NoError(t, err)
	require.Equal(t, payload, []byte(result.Body))
	require.Len(t, result.Body, int(githubRepoMetadataMaxResponseBytes))
}
