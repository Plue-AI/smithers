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

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type githubUserReposHDecrypter struct {
	token string
	err   error
}

func (d githubUserReposHDecrypter) DecryptOAuthAccessToken([]byte) (string, error) {
	if d.err != nil {
		return "", d.err
	}
	return d.token, nil
}

type githubUserReposHDB struct {
	*fakeGitHubUserReposDB
	listErr   error
	claimErr  error
	upsertErr error
	setErr    error
	deleteErr error
}

func githubUserReposHNewDB() *githubUserReposHDB {
	return &githubUserReposHDB{fakeGitHubUserReposDB: newFakeGitHubUserReposDB()}
}

func (d *githubUserReposHDB) ListUserOAuthAccounts(ctx context.Context, userID int64) ([]db.OauthAccount, error) {
	if d.listErr != nil {
		return nil, d.listErr
	}
	return d.fakeGitHubUserReposDB.ListUserOAuthAccounts(ctx, userID)
}

func (d *githubUserReposHDB) ClaimGitHubRepoListingSync(ctx context.Context, userID int64) (int64, error) {
	if d.claimErr != nil {
		return 0, d.claimErr
	}
	return d.fakeGitHubUserReposDB.ClaimGitHubRepoListingSync(ctx, userID)
}

func (d *githubUserReposHDB) UpsertGitHubRepoListing(ctx context.Context, arg db.UpsertGitHubRepoListingParams) (db.GithubRepoListing, error) {
	if d.upsertErr != nil {
		return db.GithubRepoListing{}, d.upsertErr
	}
	return d.fakeGitHubUserReposDB.UpsertGitHubRepoListing(ctx, arg)
}

func (d *githubUserReposHDB) SetGitHubRepoListingSyncError(ctx context.Context, arg db.SetGitHubRepoListingSyncErrorParams) error {
	if d.setErr != nil {
		return d.setErr
	}
	return d.fakeGitHubUserReposDB.SetGitHubRepoListingSyncError(ctx, arg)
}

func (d *githubUserReposHDB) DeleteGitHubRepoListing(ctx context.Context, userID int64) error {
	if d.deleteErr != nil {
		return d.deleteErr
	}
	return d.fakeGitHubUserReposDB.DeleteGitHubRepoListing(ctx, userID)
}

type githubUserReposHRoundTrip func(*http.Request) (*http.Response, error)

func (f githubUserReposHRoundTrip) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestGitHubUserRepos_H_OptionsCachePagingAndWarmBranches(t *testing.T) {
	customClient := &http.Client{Timeout: time.Millisecond}
	svc := NewGitHubUserReposService(
		newFakeGitHubUserReposDB(),
		fakeOAuthTokenDecrypter{token: "tok"},
		WithGitHubUserReposHTTPClient(nil),
		WithGitHubUserReposHTTPClient(customClient),
		WithGitHubUserReposNow(nil),
		WithGitHubUserReposNow(func() time.Time { return time.Unix(10, 0) }),
	)
	assert.Same(t, customClient, svc.httpClient)
	assert.Equal(t, time.Unix(10, 0), svc.now())

	_, err := (*GitHubUserReposService)(nil).ListAuthenticatedUserGitHubRepos(context.Background(), 1, url.Values{})
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
	_, err = svc.ListAuthenticatedUserGitHubRepos(context.Background(), 0, url.Values{})
	require.Error(t, err)
	assert.Equal(t, http.StatusUnauthorized, apiStatus(t, err))

	for _, raw := range []string{"visibility=private", "affiliation=owner", "direction=asc", "sort=updated"} {
		values := mustParseQuery(t, raw)
		assert.False(t, cacheableGitHubRepoListQuery(values), raw)
	}

	page := pageGitHubRepoListing(nil, mustParseQuery(t, "page=bad&cursor=4&per_page=500"), time.Unix(1, 0), "sync failed")
	assert.Empty(t, page.Repos)
	assert.Equal(t, "sync failed", page.CacheSyncError)

	upstream := &countingRepoServer{items: testRepoItems(1)}
	server := httptest.NewServer(upstream.handler())
	defer server.Close()
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)

	corrupt := githubUserReposHNewDB()
	corrupt.row = &db.GithubRepoListing{UserID: 42, Payload: []byte(`{bad json`), SyncedAt: time.Now()}
	svc = NewGitHubUserReposService(corrupt, fakeOAuthTokenDecrypter{token: "tok"})
	result, err := svc.ListAuthenticatedUserGitHubRepos(context.Background(), 42, mustParseQuery(t, "sort=pushed"))
	require.NoError(t, err)
	require.Len(t, result.Repos, 1)
	assert.Equal(t, 1, corrupt.upsertCount())

	done := make(chan error, 3)
	fresh := githubUserReposHNewDB()
	fresh.setRow(testRepoItems(1), time.Now())
	svc = NewGitHubUserReposService(fresh, fakeOAuthTokenDecrypter{token: "tok"}, WithGitHubUserReposSyncNotify(func(_ int64, err error) {
		done <- err
	}))
	svc.WarmGitHubRepoListing(42)
	select {
	case err := <-done:
		require.NoError(t, err)
	case <-time.After(time.Second):
		t.Fatal("warm fresh callback not called")
	}
	assert.Equal(t, 0, fresh.claimCount())

	staleClaimed := githubUserReposHNewDB()
	staleClaimed.setRow(testRepoItems(1), time.Now().Add(-time.Hour))
	staleClaimed.row.SyncingSince = pgtype.Timestamptz{Time: time.Now(), Valid: true}
	svc = NewGitHubUserReposService(staleClaimed, fakeOAuthTokenDecrypter{token: "tok"}, WithGitHubUserReposSyncNotify(func(_ int64, err error) {
		done <- err
	}))
	svc.WarmGitHubRepoListing(42)
	select {
	case err := <-done:
		require.NoError(t, err)
	case <-time.After(time.Second):
		t.Fatal("warm claimed callback not called")
	}

	svc.WarmGitHubRepoListing(0)
}

func TestGitHubUserRepos_H_TokenHTTPAndSyncErrorBranches(t *testing.T) {
	dbWithListErr := githubUserReposHNewDB()
	dbWithListErr.listErr = errors.New("accounts unavailable")
	svc := NewGitHubUserReposService(dbWithListErr, githubUserReposHDecrypter{token: "tok"})
	_, _, err := svc.resolveUserGitHubAccessToken(context.Background(), 42)
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	noAccount := githubUserReposHNewDB()
	noAccount.accounts = []db.OauthAccount{{Provider: "gitlab", AccessTokenEncrypted: []byte("x")}}
	svc = NewGitHubUserReposService(noAccount, githubUserReposHDecrypter{token: "tok"})
	_, _, err = svc.resolveUserGitHubAccessToken(context.Background(), 42)
	require.Error(t, err)
	assert.Equal(t, http.StatusUnauthorized, apiStatus(t, err))

	svc = NewGitHubUserReposService(githubUserReposHNewDB(), githubUserReposHDecrypter{err: errors.New("decrypt failed")})
	_, _, err = svc.resolveUserGitHubAccessToken(context.Background(), 42)
	require.Error(t, err)
	assert.Equal(t, "decrypt failed", err.Error())

	svc = NewGitHubUserReposService(githubUserReposHNewDB(), githubUserReposHDecrypter{token: " \t "})
	_, _, err = svc.resolveUserGitHubAccessToken(context.Background(), 42)
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	_, err = svc.refreshUserGitHubToken(context.Background(), db.OauthAccount{})
	require.Error(t, err)
	assert.Equal(t, http.StatusUnauthorized, apiStatus(t, err))
	svc = NewGitHubUserReposService(githubUserReposHNewDB(), githubUserReposHDecrypter{token: "tok"}, WithGitHubUserReposTokenRefresher(&fakeGitHubTokenRefresher{}))
	_, err = svc.refreshUserGitHubToken(context.Background(), db.OauthAccount{})
	require.Error(t, err)
	assert.Equal(t, http.StatusUnauthorized, apiStatus(t, err))

	t.Setenv(envGitHubAppAPIBaseURL, "http://[::1")
	_, _, err = svc.requestGitHubUserRepos(context.Background(), "tok", url.Values{})
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	t.Setenv(envGitHubAppAPIBaseURL, "https://github.invalid")
	svc = NewGitHubUserReposService(githubUserReposHNewDB(), githubUserReposHDecrypter{token: "tok"}, WithGitHubUserReposHTTPClient(&http.Client{
		Transport: githubUserReposHRoundTrip(func(*http.Request) (*http.Response, error) {
			return nil, errors.New("dial failed")
		}),
	}))
	_, _, err = svc.requestGitHubUserRepos(context.Background(), "tok", url.Values{})
	require.Error(t, err)
	assert.Equal(t, http.StatusBadGateway, apiStatus(t, err))

	for _, tc := range []struct {
		name   string
		status int
		body   string
		want   int
	}{
		{name: "forbidden", status: http.StatusForbidden, want: http.StatusBadGateway},
		{name: "bad json", status: http.StatusOK, body: `not-json`, want: http.StatusBadGateway},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				assert.Equal(t, "Bearer tok", r.Header.Get("Authorization"))
				if tc.status != 0 {
					w.WriteHeader(tc.status)
				}
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			t.Setenv(envGitHubAppAPIBaseURL, server.URL)
			svc := NewGitHubUserReposService(githubUserReposHNewDB(), githubUserReposHDecrypter{token: "tok"})
			_, _, err := svc.requestGitHubUserRepos(context.Background(), "tok", url.Values{})
			require.Error(t, err)
			assert.Equal(t, tc.want, apiStatus(t, err))
		})
	}

	upsertFail := githubUserReposHNewDB()
	upsertFail.upsertErr = errors.New("write failed")
	upsertFail.setErr = errors.New("record failed")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(testRepoItems(1))
	}))
	defer server.Close()
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)
	svc = NewGitHubUserReposService(upsertFail, githubUserReposHDecrypter{token: "tok"})
	err = svc.syncGitHubRepoListing(context.Background(), 42)
	require.Error(t, err)
	assert.Equal(t, "repo listing refresh failed", sanitizedSyncErrorMessage(errors.New("raw pg error")))

	deleteFail := githubUserReposHNewDB()
	deleteFail.deleteErr = errors.New("delete failed")
	authServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer authServer.Close()
	t.Setenv(envGitHubAppAPIBaseURL, authServer.URL)
	svc = NewGitHubUserReposService(deleteFail, githubUserReposHDecrypter{token: "tok"})
	err = svc.syncGitHubRepoListing(context.Background(), 42)
	require.Error(t, err)

	recoverGitHubRepoListingPanic(42)
	func() {
		defer recoverGitHubRepoListingPanic(42)
		panic("boom")
	}()
}

func TestGitHubUserRepos_H_LiveRefreshFailureKeepsUpstreamClass(t *testing.T) {
	hits := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits++
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)

	refresher := &fakeGitHubTokenRefresher{err: errors.New("refresh failed")}
	svc := NewGitHubUserReposService(
		githubUserReposHNewDB(),
		githubUserReposHDecrypter{token: "old"},
		WithGitHubUserReposTokenRefresher(refresher),
	)
	_, err := svc.listLiveGitHubRepos(context.Background(), 42, mustParseQuery(t, "cursor=2"))
	require.Error(t, err)
	assert.Equal(t, http.StatusBadGateway, apiStatus(t, err))
	assert.Equal(t, 1, hits)
	assert.Equal(t, 1, refresher.callCount())
}
