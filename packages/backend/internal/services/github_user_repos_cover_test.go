package services

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type githubUserReposCovFailingDecrypter struct {
	err error
}

func (d githubUserReposCovFailingDecrypter) DecryptOAuthAccessToken([]byte) (string, error) {
	return "", d.err
}

func TestGitHubUserRepos_Cov_OptionsAndCacheHelpers(t *testing.T) {
	customClient := &http.Client{Timeout: time.Second}
	fixedNow := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	service := NewGitHubUserReposService(
		newFakeGitHubUserReposDB(),
		fakeOAuthTokenDecrypter{token: "gho"},
		WithGitHubUserReposHTTPClient(customClient),
		WithGitHubUserReposHTTPClient(nil),
		WithGitHubUserReposNow(func() time.Time { return fixedNow }),
		WithGitHubUserReposNow(nil),
	)
	assert.Same(t, customClient, service.httpClient)
	assert.Equal(t, fixedNow, service.now())

	assert.True(t, cacheableGitHubRepoListQuery(url.Values{"visibility": []string{"all"}, "sort": []string{"pushed"}}))
	assert.False(t, cacheableGitHubRepoListQuery(url.Values{"visibility": []string{"private"}}))
	assert.False(t, cacheableGitHubRepoListQuery(url.Values{"affiliation": []string{"owner"}}))
	assert.False(t, cacheableGitHubRepoListQuery(url.Values{"direction": []string{"asc"}}))
	assert.False(t, cacheableGitHubRepoListQuery(url.Values{"sort": []string{"updated"}}))

	paged := pageGitHubRepoListing(testRepoItems(3), mustParseQuery(t, "per_page=2&page=bad&cursor=2"), fixedNow, "stale")
	require.Len(t, paged.Repos, 1)
	assert.Equal(t, "octo/repo-3", paged.Repos[0].FullName)
	assert.Equal(t, "stale", paged.CacheSyncError)
	require.NotNil(t, paged.CacheSyncedAt)
	assert.Equal(t, fixedNow, *paged.CacheSyncedAt)
}

func TestGitHubUserRepos_Cov_SanitizedSyncErrorForRawFailure(t *testing.T) {
	queries := newFakeGitHubUserReposDB()
	service := NewGitHubUserReposService(queries, githubUserReposCovFailingDecrypter{err: errors.New("dial tcp 10.0.0.1: secret")})

	err := service.syncGitHubRepoListing(context.Background(), 42)
	require.Error(t, err)
	require.Equal(t, 1, queries.syncErrCount())
	assert.Equal(t, "repo listing refresh failed", queries.syncErrs[0].SyncError)
	assert.Equal(t, "repo listing refresh failed", sanitizedSyncErrorMessage(errors.New("raw driver error")))
}

func TestGitHubUserRepos_Cov_ResolveAndRequestErrors(t *testing.T) {
	queries := newFakeGitHubUserReposDB()
	queries.accounts = []db.OauthAccount{{Provider: "gitlab", AccessTokenEncrypted: []byte("ignored")}}
	service := NewGitHubUserReposService(queries, fakeOAuthTokenDecrypter{token: "gho"})
	_, _, err := service.resolveUserGitHubAccessToken(context.Background(), 42)
	require.Error(t, err)
	assert.Equal(t, 401, apiStatus(t, err))

	queries = newFakeGitHubUserReposDB()
	service = NewGitHubUserReposService(queries, fakeOAuthTokenDecrypter{token: "   "})
	_, _, err = service.resolveUserGitHubAccessToken(context.Background(), 42)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	service = NewGitHubUserReposService(newFakeGitHubUserReposDB(), fakeOAuthTokenDecrypter{token: "gho"})
	_, err = service.refreshUserGitHubToken(context.Background(), db.OauthAccount{})
	require.Error(t, err)
	assert.Equal(t, 401, apiStatus(t, err))

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/user/repos", r.URL.Path)
		assert.Equal(t, "Bearer gho", r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`not-json`))
	}))
	defer upstream.Close()
	t.Setenv(envGitHubAppAPIBaseURL, upstream.URL)
	_, _, err = service.requestGitHubUserRepos(context.Background(), "gho", url.Values{"page": []string{"1"}})
	require.Error(t, err)
	assert.Equal(t, 502, apiStatus(t, err))
}

func TestGitHubUserRepos_Cov_WarmInvalidInputsAndPanicRecovery(t *testing.T) {
	done := make(chan struct{}, 1)
	service := NewGitHubUserReposService(nil, nil, WithGitHubUserReposSyncNotify(func(int64, error) {
		done <- struct{}{}
	}))
	service.WarmGitHubRepoListing(42)
	select {
	case <-done:
		t.Fatal("invalid warm call must return before scheduling work")
	case <-time.After(25 * time.Millisecond):
	}

	func() {
		defer recoverGitHubRepoListingPanic(42)
		panic("covered panic")
	}()
	assert.True(t, true)
}

func TestGitHubUserRepos_Cov_CorruptCacheResyncs(t *testing.T) {
	upstream := &countingRepoServer{items: testRepoItems(1)}
	srv := httptest.NewServer(upstream.handler())
	defer srv.Close()
	t.Setenv(envGitHubAppAPIBaseURL, srv.URL)

	queries := newFakeGitHubUserReposDB()
	queries.row = &db.GithubRepoListing{
		UserID:   42,
		Payload:  []byte(`{bad json`),
		SyncedAt: time.Now(),
	}
	service := NewGitHubUserReposService(queries, fakeOAuthTokenDecrypter{token: "gho"})

	result, err := service.ListAuthenticatedUserGitHubRepos(context.Background(), 42, url.Values{})
	require.NoError(t, err)
	require.Len(t, result.Repos, 1)
	assert.Equal(t, 1, queries.upsertCount())

	var stored []GitHubRepoListItem
	require.NoError(t, json.Unmarshal(queries.upserts[0].Payload, &stored))
	assert.Equal(t, "octo/repo-1", stored[0].FullName)
}
