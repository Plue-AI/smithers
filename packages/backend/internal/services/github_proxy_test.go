package services

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type fakeGitHubProxyTokenIssuer struct {
	createFn    func(ctx context.Context, userID int64, owner string, repo string) (GitHubInstallationToken, error)
	calls       []fakeGitHubProxyTokenIssuerCall
	permissions []map[string]string
}

type fakeGitHubProxyTokenIssuerCall struct {
	userID int64
	owner  string
	repo   string
}

type fakeGitHubProxyImportedSourceTokenIssuer struct {
	fakeGitHubProxyTokenIssuer
	createImportedFn func(ctx context.Context, userID int64, repositoryID int64, owner string, repo string) (GitHubInstallationToken, error)
	importedCalls    []fakeGitHubProxyImportedSourceTokenIssuerCall
	importedScopes   []map[string]string
}

type fakeGitHubProxyImportedSourceTokenIssuerCall struct {
	userID       int64
	repositoryID int64
	owner        string
	repo         string
}

func (f *fakeGitHubProxyImportedSourceTokenIssuer) CreateGitHubInstallationTokenForImportedSource(ctx context.Context, userID int64, repositoryID int64, owner string, repo string, permissions map[string]string) (GitHubInstallationToken, error) {
	f.importedScopes = append(f.importedScopes, permissions)
	f.importedCalls = append(f.importedCalls, fakeGitHubProxyImportedSourceTokenIssuerCall{
		userID:       userID,
		repositoryID: repositoryID,
		owner:        owner,
		repo:         repo,
	})
	if f.createImportedFn != nil {
		return f.createImportedFn(ctx, userID, repositoryID, owner, repo)
	}
	return GitHubInstallationToken{InstallationID: 1888, Token: "imported-source-install-token"}, nil
}

func (f *fakeGitHubProxyTokenIssuer) CreateGitHubInstallationTokenForUserRepo(ctx context.Context, userID int64, owner string, repo string, permissions map[string]string) (GitHubInstallationToken, error) {
	f.permissions = append(f.permissions, permissions)
	f.calls = append(f.calls, fakeGitHubProxyTokenIssuerCall{
		userID: userID,
		owner:  owner,
		repo:   repo,
	})
	if f.createFn != nil {
		return f.createFn(ctx, userID, owner, repo)
	}
	return GitHubInstallationToken{InstallationID: 123, Token: "install-token"}, nil
}

func TestGitHubProxyService_ProxyRepoRequest_RewritesHeadersWithServerInstallationToken(t *testing.T) {
	var upstreamCalled bool
	var gotMethod string
	var gotPath string
	var gotHeaders http.Header
	var gotHost string
	var gotBody map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalled = true
		gotMethod = r.Method
		gotPath = r.URL.RequestURI()
		gotHeaders = r.Header.Clone()
		gotHost = r.Host
		require.NoError(t, json.NewDecoder(r.Body).Decode(&gotBody))

		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-GitHub-Request-Id", "request-123")
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"queued":true}`))
	}))
	defer upstream.Close()
	t.Setenv(envGitHubAppAPIBaseURL, upstream.URL)

	tokenIssuer := &fakeGitHubProxyTokenIssuer{
		createFn: func(ctx context.Context, userID int64, owner string, repo string) (GitHubInstallationToken, error) {
			return GitHubInstallationToken{InstallationID: 88, Token: "server-install-token"}, nil
		},
	}
	service := NewGitHubProxyService(tokenIssuer)

	resp, err := service.ProxyRepoRequest(context.Background(), &db.User{ID: 77}, "acme", "demo", GitHubProxyRequest{
		Method: "POST",
		Path:   "/repos/acme/demo/issues/1/comments?per_page=1",
		Headers: map[string]string{
			"Accept":               "application/vnd.github+json",
			"Authorization":        "Bearer user-token",
			"Connection":           "upgrade",
			"Cookie":               "session=secret",
			"Host":                 "evil.example",
			"Proxy-Authorization":  "Basic secret",
			"TE":                   "trailers",
			"Upgrade":              "websocket",
			"User-Agent":           "custom-smithers-client",
			"X-GitHub-Api-Version": "2022-11-28",
			"X-Smithers-Trace":     "trace-123",
		},
		Body: json.RawMessage(`{"name":"smithers/checks","head_sha":"deadbeef"}`),
	})
	require.NoError(t, err)
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	assert.True(t, upstreamCalled)
	assert.Equal(t, http.StatusAccepted, resp.StatusCode)
	assert.Equal(t, "request-123", resp.Headers.Get("X-GitHub-Request-Id"))
	assert.JSONEq(t, `{"queued":true}`, string(body))

	assert.Equal(t, http.MethodPost, gotMethod)
	assert.Equal(t, "/repos/acme/demo/issues/1/comments?per_page=1", gotPath)
	assert.Equal(t, "smithers/checks", gotBody["name"])
	assert.Equal(t, "deadbeef", gotBody["head_sha"])
	assert.Equal(t, "Bearer server-install-token", gotHeaders.Get("Authorization"))
	assert.Equal(t, "application/vnd.github+json", gotHeaders.Get("Accept"))
	assert.Equal(t, "custom-smithers-client", gotHeaders.Get("User-Agent"))
	assert.Equal(t, "2022-11-28", gotHeaders.Get("X-GitHub-Api-Version"))
	assert.Equal(t, "trace-123", gotHeaders.Get("X-Smithers-Trace"))
	assert.Empty(t, gotHeaders.Get("Cookie"))
	assert.Empty(t, gotHeaders.Get("Connection"))
	assert.Empty(t, gotHeaders.Get("Proxy-Authorization"))
	assert.Empty(t, gotHeaders.Get("TE"))
	assert.Empty(t, gotHeaders.Get("Upgrade"))
	assert.NotEqual(t, "evil.example", gotHost)

	require.Len(t, tokenIssuer.calls, 1)
	assert.Equal(t, fakeGitHubProxyTokenIssuerCall{userID: 77, owner: "acme", repo: "demo"}, tokenIssuer.calls[0])
}

func TestGitHubProxyService_Proxy_Evicts401ButNot403(t *testing.T) {
	for _, tc := range []struct {
		name    string
		status  int
		instID  int64
		evicted bool
	}{
		{name: "401 evicts", status: http.StatusUnauthorized, instID: 5501, evicted: true},
		{name: "403 survives", status: http.StatusForbidden, instID: 5502, evicted: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			storeCachedInstallationToken(testTokenKey(tc.instID), tc.instID, "ghs_cached", time.Now().Add(time.Hour))
			t.Cleanup(func() { invalidateCachedInstallationToken(tc.instID) })

			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(`{"message":"denied"}`))
			}))
			defer upstream.Close()
			t.Setenv(envGitHubAppAPIBaseURL, upstream.URL)

			tokenIssuer := &fakeGitHubProxyTokenIssuer{
				createFn: func(_ context.Context, _ int64, _ string, _ string) (GitHubInstallationToken, error) {
					return GitHubInstallationToken{InstallationID: tc.instID, Token: "install-token"}, nil
				},
			}
			service := NewGitHubProxyService(tokenIssuer)

			resp, err := service.ProxyRepoRequest(context.Background(), &db.User{ID: 77}, "acme", "demo", GitHubProxyRequest{
				Method:  "GET",
				Path:    "/repos/acme/demo/contents/README.md",
				Headers: map[string]string{"Accept": "application/vnd.github+json"},
			})
			require.NoError(t, err)
			resp.Body.Close()
			require.Equal(t, tc.status, resp.StatusCode)

			_, ok := getCachedInstallationToken(testTokenKey(tc.instID))
			assert.Equal(t, !tc.evicted, ok, "cache eviction on %d mismatch", tc.status)
		})
	}
}

func TestGitHubProxyService_ProxyRepoRequest_BudgetTrackerReturnsStructuredRateLimit(t *testing.T) {
	var upstreamCalls int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls++
		w.WriteHeader(http.StatusTeapot)
	}))
	defer upstream.Close()
	t.Setenv(envGitHubAppAPIBaseURL, upstream.URL)

	const installationID = int64(556)
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	tracker := NewBudgetTrackerWithLimits(1, time.Hour)
	tracker.now = func() time.Time { return now }
	allowed, _ := tracker.Allow(installationID)
	require.True(t, allowed)

	tokenIssuer := &fakeGitHubProxyTokenIssuer{
		createFn: func(ctx context.Context, userID int64, owner string, repo string) (GitHubInstallationToken, error) {
			return GitHubInstallationToken{InstallationID: installationID, Token: "unused-install-token"}, nil
		},
	}
	service := NewGitHubProxyService(tokenIssuer, WithGitHubProxyBudgetTracker(tracker))

	resp, err := service.ProxyRepoRequest(context.Background(), &db.User{ID: 77}, "acme", "demo", GitHubProxyRequest{
		Method: http.MethodGet,
		Path:   "/repos/acme/demo/issues",
	})
	require.Nil(t, resp)
	require.Error(t, err)

	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, http.StatusTooManyRequests, apiErr.Status)
	assert.Equal(t, pkgerrors.CodeGitHubRateLimited, apiErr.Code)
	require.NotNil(t, apiErr.Limit)
	assert.Equal(t, 1, *apiErr.Limit)
	require.NotNil(t, apiErr.Remaining)
	assert.Equal(t, 0, *apiErr.Remaining)
	require.NotNil(t, apiErr.ResetAt)
	assert.Equal(t, now.Add(time.Hour), *apiErr.ResetAt)
	assert.Zero(t, upstreamCalls)
}

func TestGitHubProxyService_ProxyRepoRequest_UsesAuthenticatedActorForInstallationLookup(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "Bearer repo-install-token", r.Header.Get("Authorization"))
		assert.Equal(t, "/repos/acme/demo/pulls", r.URL.Path)
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"number":77}`))
	}))
	defer upstream.Close()
	t.Setenv(envGitHubAppAPIBaseURL, upstream.URL)

	tokenIssuer := &fakeGitHubProxyTokenIssuer{
		createFn: func(ctx context.Context, userID int64, owner string, repo string) (GitHubInstallationToken, error) {
			return GitHubInstallationToken{InstallationID: 77, Token: "repo-install-token"}, nil
		},
	}
	service := NewGitHubProxyService(tokenIssuer)

	resp, err := service.ProxyRepoRequest(context.Background(), &db.User{ID: 42, Username: "alice"}, " acme ", " demo ", GitHubProxyRequest{
		Method: "POST",
		Path:   "/repos/acme/demo/pulls",
		Body:   json.RawMessage(`{"title":"Sandbox change","head":"smithers/change","base":"main"}`),
	})
	require.NoError(t, err)
	defer resp.Body.Close()

	assert.Equal(t, http.StatusCreated, resp.StatusCode)
	require.Len(t, tokenIssuer.calls, 1)
	assert.Equal(t, fakeGitHubProxyTokenIssuerCall{userID: 42, owner: "acme", repo: "demo"}, tokenIssuer.calls[0])
}

func TestGitHubProxyService_ProxyRepoRequest_ImportedPublicSourceUsesProvenanceScopedInstallation(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "Bearer imported-source-install-token", r.Header.Get("Authorization"))
		assert.Equal(t, "/repos/smithersai/smithers/pulls", r.URL.Path)
		assert.Equal(t, "page=1&per_page=100", r.URL.RawQuery)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`[]`))
	}))
	defer upstream.Close()
	t.Setenv(envGitHubAppAPIBaseURL, upstream.URL)

	tokenIssuer := &fakeGitHubProxyImportedSourceTokenIssuer{
		fakeGitHubProxyTokenIssuer: fakeGitHubProxyTokenIssuer{
			createFn: func(context.Context, int64, string, string) (GitHubInstallationToken, error) {
				return GitHubInstallationToken{}, pkgerrors.BadRequest("github app is not installed for this repository")
			},
		},
	}
	service := NewGitHubProxyService(tokenIssuer)
	ctx := middleware.ContextWithRepoContext(context.Background(), &middleware.RepoContext{
		Owner: "roninjin10",
		Repository: &db.Repository{
			ID:        333,
			Name:      "smithers",
			LowerName: "smithers",
			IsPublic:  false,
			UserID:    pgtype.Int8{Int64: 8, Valid: true},
		},
	}, middleware.PermissionOwner)

	resp, err := service.ProxyRepoRequest(ctx, &db.User{ID: 8, Username: "roninjin10"}, "smithersai", "smithers", GitHubProxyRequest{
		Method: "GET",
		Path:   "/repos/smithersai/smithers/pulls?page=1&per_page=100",
	})
	require.NoError(t, err)
	defer resp.Body.Close()

	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Empty(t, tokenIssuer.calls, "imported source requests must not require an actor repo_connections row for the source owner")
	require.Len(t, tokenIssuer.importedCalls, 1)
	assert.Equal(t, fakeGitHubProxyImportedSourceTokenIssuerCall{
		userID:       8,
		repositoryID: 333,
		owner:        "smithersai",
		repo:         "smithers",
	}, tokenIssuer.importedCalls[0])
}

func TestGitHubProxyService_ProxyRepoRequest_ImportedPublicSourceUsesProvenanceWhenLocalCoordsMatch(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "Bearer imported-source-install-token", r.Header.Get("Authorization"))
		assert.Equal(t, "/repos/roninjin10/smithers/issues", r.URL.Path)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`[]`))
	}))
	defer upstream.Close()
	t.Setenv(envGitHubAppAPIBaseURL, upstream.URL)

	tokenIssuer := &fakeGitHubProxyImportedSourceTokenIssuer{
		fakeGitHubProxyTokenIssuer: fakeGitHubProxyTokenIssuer{
			createFn: func(context.Context, int64, string, string) (GitHubInstallationToken, error) {
				return GitHubInstallationToken{}, pkgerrors.BadRequest("github app is not installed for this repository")
			},
		},
	}
	service := NewGitHubProxyService(tokenIssuer)
	ctx := middleware.ContextWithRepoContext(context.Background(), &middleware.RepoContext{
		Owner: "roninjin10",
		Repository: &db.Repository{
			ID:        334,
			Name:      "smithers",
			LowerName: "smithers",
			IsPublic:  false,
			UserID:    pgtype.Int8{Int64: 8, Valid: true},
		},
	}, middleware.PermissionOwner)

	resp, err := service.ProxyRepoRequest(ctx, &db.User{ID: 8, Username: "roninjin10"}, "roninjin10", "smithers", GitHubProxyRequest{
		Method: "GET",
		Path:   "/repos/roninjin10/smithers/issues",
	})
	require.NoError(t, err)
	defer resp.Body.Close()

	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Empty(t, tokenIssuer.calls, "imported source requests must not fall back to actor repo_connections just because local and source coordinates match")
	require.Len(t, tokenIssuer.importedCalls, 1)
	assert.Equal(t, fakeGitHubProxyImportedSourceTokenIssuerCall{
		userID:       8,
		repositoryID: 334,
		owner:        "roninjin10",
		repo:         "smithers",
	}, tokenIssuer.importedCalls[0])
}

func TestGitHubProxyService_ProxyRepoRequest_LocalRepoFallsBackWhenImportedProvenanceAbsent(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "Bearer install-token", r.Header.Get("Authorization"))
		assert.Equal(t, "/repos/acme/demo/issues", r.URL.Path)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`[]`))
	}))
	defer upstream.Close()
	t.Setenv(envGitHubAppAPIBaseURL, upstream.URL)

	tokenIssuer := &fakeGitHubProxyImportedSourceTokenIssuer{
		createImportedFn: func(context.Context, int64, int64, string, string) (GitHubInstallationToken, error) {
			return GitHubInstallationToken{}, errGitHubImportedSourceProvenanceNotFound
		},
	}
	service := NewGitHubProxyService(tokenIssuer)
	ctx := middleware.ContextWithRepoContext(context.Background(), &middleware.RepoContext{
		Owner: "acme",
		Repository: &db.Repository{
			ID:        335,
			Name:      "demo",
			LowerName: "demo",
			IsPublic:  false,
			UserID:    pgtype.Int8{Int64: 42, Valid: true},
		},
	}, middleware.PermissionOwner)

	resp, err := service.ProxyRepoRequest(ctx, &db.User{ID: 42, Username: "alice"}, "acme", "demo", GitHubProxyRequest{
		Method: "GET",
		Path:   "/repos/acme/demo/issues",
	})
	require.NoError(t, err)
	defer resp.Body.Close()

	assert.Equal(t, http.StatusOK, resp.StatusCode)
	require.Len(t, tokenIssuer.importedCalls, 1)
	assert.Equal(t, fakeGitHubProxyImportedSourceTokenIssuerCall{
		userID:       42,
		repositoryID: 335,
		owner:        "acme",
		repo:         "demo",
	}, tokenIssuer.importedCalls[0])
	require.Len(t, tokenIssuer.calls, 1)
	assert.Equal(t, fakeGitHubProxyTokenIssuerCall{userID: 42, owner: "acme", repo: "demo"}, tokenIssuer.calls[0])
}
