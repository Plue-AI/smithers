package services

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestGitHubProxy_H_ServiceErrors(t *testing.T) {
	_, err := (&GitHubProxyService{}).ProxyRepoRequest(context.Background(), &db.User{ID: 1}, "a", "b", GitHubProxyRequest{})
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
	_, err = NewGitHubProxyService(&fakeGitHubProxyTokenIssuer{}).ProxyRepoRequest(context.Background(), &db.User{ID: -1}, "a", "b", GitHubProxyRequest{})
	require.Error(t, err)
	assert.Equal(t, http.StatusUnauthorized, apiStatus(t, err))
}

func TestGitHubProxy_H_ProxyRequestDenialsAndUpstreamFailures(t *testing.T) {
	svc := NewGitHubProxyService(&fakeGitHubProxyTokenIssuer{})
	_, err := svc.proxyRequest(context.Background(), gitHubProxyResolvedContext{
		ActorUserID: 1,
		Owner:       "acme",
		Repo:        "demo",
	}, GitHubProxyRequest{Method: "POST", Path: "/repos/acme/demo/issues/1/comments", Body: json.RawMessage(`{"bad"`)}, GitHubProxyPolicyInput{})
	require.Error(t, err)
	assert.Equal(t, http.StatusBadRequest, statusCodeFromError(err))

	_, err = svc.proxyRequest(context.Background(), gitHubProxyResolvedContext{
		ActorUserID: 1,
		Owner:       "acme",
		Repo:        "demo",
	}, GitHubProxyRequest{Method: "DELETE", Path: "/repos/acme/demo/git/refs/heads/main"}, GitHubProxyPolicyInput{})
	require.Error(t, err)
	assert.Equal(t, http.StatusForbidden, apiStatus(t, err))

	t.Setenv(envGitHubAppAPIBaseURL, "http://[::1")
	svc = NewGitHubProxyService(&fakeGitHubProxyTokenIssuer{})
	_, err = svc.ProxyRepoRequest(context.Background(), &db.User{ID: 1}, "acme", "demo", GitHubProxyRequest{
		Method: "GET",
		Path:   "/repos/acme/demo/issues",
	})
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	t.Setenv(envGitHubAppAPIBaseURL, "https://api.github.test")
	svc = NewGitHubProxyService(&fakeGitHubProxyTokenIssuer{}, WithGitHubProxyHTTPClient(&http.Client{
		Transport: githubUserReposHRoundTrip(func(*http.Request) (*http.Response, error) {
			return nil, errors.New("upstream dial failed")
		}),
	}))
	_, err = svc.ProxyRepoRequest(context.Background(), &db.User{ID: 1}, "acme", "demo", GitHubProxyRequest{
		Method: "GET",
		Path:   "/repos/acme/demo/issues",
	})
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
}

func TestGitHubProxy_H_NormalizeBranches(t *testing.T) {
	svc := NewGitHubProxyService(&fakeGitHubProxyTokenIssuer{})
	for _, raw := range []string{"", "https://api.github.com/repos/a/b", "://bad"} {
		_, _, err := normalizeGitHubProxyMethodAndPath("GET", raw)
		require.Error(t, err, raw)
		assert.Equal(t, http.StatusBadRequest, statusCodeFromError(err))
	}

	req, err := svc.buildUpstreamRequest(context.Background(), http.MethodGet, "/repos/a/b", map[string]string{
		"Host":       "evil",
		"Connection": "close",
		"X-Trace":    " keep ",
	}, nil, false, "tok")
	require.NoError(t, err)
	assert.Equal(t, "keep", req.Header.Get("X-Trace"))
	assert.Empty(t, req.Header.Get("Host"))
	assert.Empty(t, req.Header.Get("Connection"))
	assert.Empty(t, req.Header.Get("Content-Type"))
}
