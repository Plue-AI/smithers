package services

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type repoListZTokenIssuer struct {
	err error
}

func (i repoListZTokenIssuer) CreateGitHubInstallationToken(context.Context, int64, GitHubTokenScope) (GitHubInstallationToken, error) {
	if i.err != nil {
		return GitHubInstallationToken{}, i.err
	}
	return GitHubInstallationToken{InstallationID: 123, Token: "token"}, nil
}

type repoListZRoundTrip func(*http.Request) (*http.Response, error)

func (f repoListZRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func TestGitHubRepoList_Z_ErrorBranches(t *testing.T) {
	_, err := (*GitHubRepoListService)(nil).ListInstallationRepositories(context.Background(), 1, url.Values{})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	svc := NewGitHubRepoListService(fakeRepoListDB{row: fakeRepoListRow{}}, repoListZTokenIssuer{})
	_, err = svc.ListInstallationRepositories(context.Background(), 0, url.Values{})
	require.Error(t, err)
	assert.Equal(t, 401, apiStatus(t, err))

	svc = NewGitHubRepoListService(fakeRepoListDB{row: fakeRepoListRow{err: pgx.ErrNoRows}}, repoListZTokenIssuer{})
	_, err = svc.ListInstallationRepositories(context.Background(), 1, url.Values{})
	require.Error(t, err)
	assert.Equal(t, 401, apiStatus(t, err))

	svc = NewGitHubRepoListService(fakeRepoListDB{row: fakeRepoListRow{err: errors.New("db down")}}, repoListZTokenIssuer{})
	_, err = svc.ListInstallationRepositories(context.Background(), 1, url.Values{})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	svc = NewGitHubRepoListService(fakeRepoListDB{row: fakeRepoListRow{owner: "acme", repo: "demo"}}, repoListZTokenIssuer{err: errors.New("token failed")})
	_, err = svc.ListInstallationRepositories(context.Background(), 1, url.Values{})
	require.ErrorContains(t, err, "token failed")

	t.Setenv(envGitHubAppAPIBaseURL, "http://[::1")
	svc = NewGitHubRepoListService(fakeRepoListDB{row: fakeRepoListRow{owner: "acme", repo: "demo"}}, repoListZTokenIssuer{})
	_, err = svc.ListInstallationRepositories(context.Background(), 1, url.Values{})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	t.Setenv(envGitHubAppAPIBaseURL, "https://api.example.test")
	svc = NewGitHubRepoListService(
		fakeRepoListDB{row: fakeRepoListRow{owner: "acme", repo: "demo"}},
		repoListZTokenIssuer{},
		WithGitHubRepoListHTTPClient(&http.Client{Transport: repoListZRoundTrip(func(*http.Request) (*http.Response, error) {
			return nil, errors.New("network down")
		})}),
	)
	_, err = svc.ListInstallationRepositories(context.Background(), 1, url.Values{})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	assert.Equal(t, "fallback", githubRepoListUpstreamErrorMessage([]byte(`not-json`), "fallback"))
}
