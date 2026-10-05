package services

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestGitHubPullDiff_ProxiesDiffMediaType(t *testing.T) {
	var mu sync.Mutex
	var gotPath, gotAuth, gotAccept, gotVersion string
	diff := "diff --git a/main.go b/main.go\nindex 111..222 100644\n--- a/main.go\n+++ b/main.go\n@@ -1 +1 @@\n-old\n+new\n"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		gotPath, gotAuth, gotAccept, gotVersion = r.URL.Path, r.Header.Get("Authorization"), r.Header.Get("Accept"), r.Header.Get("X-GitHub-Api-Version")
		mu.Unlock()
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte(diff))
	}))
	defer srv.Close()
	t.Setenv(envGitHubAppAPIBaseURL, srv.URL)

	service := NewGitHubUserReposService(newFakeGitHubUserReposDB(), fakeOAuthTokenDecrypter{token: "gho_user"})
	result, err := service.GetAuthenticatedUserGitHubPullDiff(context.Background(), 42, "octo", "widget", 7)
	require.NoError(t, err)
	assert.Equal(t, diff, string(result.Body))

	mu.Lock()
	path, auth, accept, version := gotPath, gotAuth, gotAccept, gotVersion
	mu.Unlock()
	assert.Equal(t, "/repos/octo/widget/pulls/7", path)
	assert.Equal(t, "Bearer gho_user", auth)
	assert.Equal(t, "application/vnd.github.diff", accept)
	assert.Equal(t, "2022-11-28", version)
}

func TestGitHubPullDiff_TooLargeIsTypedVerdict(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte(strings.Repeat("a", int(githubPullDiffMaxResponseBytes)+1)))
	}))
	defer srv.Close()
	t.Setenv(envGitHubAppAPIBaseURL, srv.URL)

	service := NewGitHubUserReposService(newFakeGitHubUserReposDB(), fakeOAuthTokenDecrypter{token: "gho_user"})
	_, err := service.GetAuthenticatedUserGitHubPullDiff(context.Background(), 42, "octo", "widget", 7)
	require.Error(t, err)
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok)
	assert.Equal(t, http.StatusBadGateway, apiErr.Status)
	assert.Equal(t, CodeGitHubPullDiffTooLarge, apiErr.Code)
}

func TestGitHubPullDiff_ExactlyAtLimitPasses(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("a", int(githubPullDiffMaxResponseBytes))))
	}))
	defer srv.Close()
	t.Setenv(envGitHubAppAPIBaseURL, srv.URL)

	service := NewGitHubUserReposService(newFakeGitHubUserReposDB(), fakeOAuthTokenDecrypter{token: "gho_user"})
	result, err := service.GetAuthenticatedUserGitHubPullDiff(context.Background(), 42, "octo", "widget", 7)
	require.NoError(t, err)
	assert.Len(t, result.Body, int(githubPullDiffMaxResponseBytes))
}

func TestGitHubPullDiff_NotFoundMaps(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()
	t.Setenv(envGitHubAppAPIBaseURL, srv.URL)

	service := NewGitHubUserReposService(newFakeGitHubUserReposDB(), fakeOAuthTokenDecrypter{token: "gho_user"})
	_, err := service.GetAuthenticatedUserGitHubPullDiff(context.Background(), 42, "octo", "widget", 7)
	require.Error(t, err)
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok)
	assert.Equal(t, http.StatusBadGateway, apiErr.Status)
	assert.Equal(t, pkgerrors.CodeGitHubPermission, apiErr.Code)
}

func TestGitHubPullDiff_RefreshesExpiredTokenOnce(t *testing.T) {
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
		_, _ = w.Write([]byte("diff --git a/x b/x\n"))
	}))
	defer srv.Close()
	t.Setenv(envGitHubAppAPIBaseURL, srv.URL)

	service := NewGitHubUserReposService(newFakeGitHubUserReposDB(), fakeOAuthTokenDecrypter{token: "gho_user"})
	service.refresher = &fakeGitHubTokenRefresher{newToken: "gho_new"}

	result, err := service.GetAuthenticatedUserGitHubPullDiff(context.Background(), 42, "octo", "widget", 7)
	require.NoError(t, err)
	assert.Equal(t, "diff --git a/x b/x\n", string(result.Body))
	mu.Lock()
	got := append([]string(nil), authHeaders...)
	mu.Unlock()
	assert.Equal(t, []string{"Bearer gho_user", "Bearer gho_new"}, got)
}

func TestGitHubPullDiff_RejectsInvalidNumber(t *testing.T) {
	service := NewGitHubUserReposService(newFakeGitHubUserReposDB(), fakeOAuthTokenDecrypter{token: "gho_user"})
	for _, number := range []int64{0, -3} {
		_, err := service.GetAuthenticatedUserGitHubPullDiff(context.Background(), 42, "octo", "widget", number)
		require.Error(t, err, fmt.Sprintf("number %d", number))
		apiErr, ok := err.(*pkgerrors.APIError)
		require.True(t, ok)
		assert.Equal(t, http.StatusBadRequest, apiErr.Status)
	}
}
