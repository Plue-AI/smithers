package services

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// Owner review of #3693: token scope follows the authorized operation and the
// repository's immutable id.

func importedSourceProxyContext() context.Context {
	return middleware.ContextWithRepoContext(context.Background(), &middleware.RepoContext{
		Owner:      "roninjin10",
		Repository: &db.Repository{ID: 333, Name: "smithers", LowerName: "smithers", UserID: pgtype.Int8{Int64: 8, Valid: true}},
	}, middleware.PermissionOwner)
}

func proxyUpstream(t *testing.T) {
	t.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`[]`))
	}))
	t.Cleanup(upstream.Close)
	t.Setenv(envGitHubAppAPIBaseURL, upstream.URL)
}

func TestProxyRefusesImportedSourceWriteBeforeMint(t *testing.T) {
	proxyUpstream(t)
	issuer := &fakeGitHubProxyImportedSourceTokenIssuer{}
	_, err := NewGitHubProxyService(issuer).ProxyRepoRequest(importedSourceProxyContext(), &db.User{ID: 8}, "smithersai", "smithers", GitHubProxyRequest{
		Method: "POST", Path: "/repos/smithersai/smithers/issues/1/comments", Body: []byte(`{"body":"hi"}`),
	})
	require.Error(t, err, "an importer holds no write authority over the upstream repository")
	require.Empty(t, issuer.importedCalls)
	require.Empty(t, issuer.calls)
}

func TestProxyImportedSourceReadGetsReadOnlyScope(t *testing.T) {
	proxyUpstream(t)
	issuer := &fakeGitHubProxyImportedSourceTokenIssuer{}
	resp, err := NewGitHubProxyService(issuer).ProxyRepoRequest(importedSourceProxyContext(), &db.User{ID: 8}, "smithersai", "smithers", GitHubProxyRequest{
		Method: "GET", Path: "/repos/smithersai/smithers/pulls",
	})
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, []map[string]string{{"contents": "read", "issues": "read", "pull_requests": "read"}}, issuer.importedScopes)
}

func TestProxyPermissionsFollowTheOperation(t *testing.T) {
	proxyUpstream(t)
	issuer := &fakeGitHubProxyTokenIssuer{}
	service := NewGitHubProxyService(issuer)
	for _, request := range []GitHubProxyRequest{
		{Method: "GET", Path: "/repos/acme/demo/pulls"},
		{Method: "POST", Path: "/repos/acme/demo/issues/1/comments", Body: []byte(`{"body":"hi"}`)},
	} {
		resp, err := service.ProxyRepoRequest(context.Background(), &db.User{ID: 7}, "acme", "demo", request)
		require.NoError(t, err)
		resp.Body.Close()
	}
	require.Equal(t, []map[string]string{
		{"contents": "read", "issues": "read", "pull_requests": "read"},
		{"issues": "write"},
	}, issuer.permissions, "an issue comment gets issues:write only")
}

func scopedTokenServer(t *testing.T, status int, body string) *int {
	t.Helper()
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(server.Close)
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)
	return &calls
}

func TestInstallationTokenRejectsAShortLivedToken(t *testing.T) {
	svc, _ := newScopedTokenMinter(t)
	calls := scopedTokenServer(t, http.StatusCreated, `{"token":"ghs_short","expires_at":"`+time.Now().Add(2*time.Minute).UTC().Format(time.RFC3339)+`"}`)
	for range 2 {
		_, err := svc.CreateGitHubInstallationToken(context.Background(), 91, GitHubTokenScope{RepositoryIDs: []int64{100}, Permissions: map[string]string{"contents": "read"}})
		require.Error(t, err)
	}
	require.Equal(t, 2, *calls, "a short-lived token is never cached")
}

func TestInstallationTokenErrorsCarryNoUpstreamText(t *testing.T) {
	for _, status := range []int{http.StatusForbidden, http.StatusUnprocessableEntity} {
		svc, _ := newScopedTokenMinter(t)
		scopedTokenServer(t, status, `{"message":"upstream says ghs_leaked_value"}`)
		_, err := svc.CreateGitHubInstallationToken(context.Background(), 91, GitHubTokenScope{RepositoryIDs: []int64{100}, Permissions: map[string]string{"contents": "read"}})
		require.Error(t, err)
		require.NotContains(t, err.Error(), "upstream says")
	}
}
