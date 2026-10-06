package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// repoBoundAuthInfo builds the AuthInfo a per-run sandbox/agent token produces
// after AuthLoader: write:repository plus a repo:<id> binding.
func repoBoundAuthInfo(repositoryID int64) *AuthInfo {
	raw := string(ScopeWriteRepository) + "," + RepositoryRestrictionScope(repositoryID)
	return &AuthInfo{
		User:        &db.User{ID: 7, Username: "alice", IsActive: true},
		TokenID:     1,
		RawScopes:   raw,
		Scopes:      ParseTokenScopes(raw),
		IsTokenAuth: true,
		TokenSource: TokenSourcePersonalAccessToken,
	}
}

func unrestrictedTokenAuthInfo(scopes string) *AuthInfo {
	return &AuthInfo{
		User:        &db.User{ID: 7, Username: "alice", IsActive: true},
		TokenID:     2,
		RawScopes:   scopes,
		Scopes:      ParseTokenScopes(scopes),
		IsTokenAuth: true,
		TokenSource: TokenSourcePersonalAccessToken,
	}
}

// serveScoped routes the request through a real chi router so {owner}/{repo}
// URL params are resolved exactly as in cmd/server route assembly.
func serveScoped(t *testing.T, authInfo *AuthInfo, method, path string, register func(r chi.Router, next http.HandlerFunc)) *httptest.ResponseRecorder {
	t.Helper()
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	r := chi.NewRouter()
	register(r, next)

	req := httptest.NewRequest(method, path, nil)
	if authInfo != nil {
		req = req.WithContext(ContextWithAuthInfo(req.Context(), authInfo))
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

// TestRequireScope_RepositoryBoundTokenBlockedOnGlobalRoutes verifies that a
// repo:<id>-restricted token is NOT treated as a generic write:repository token
// on global surfaces: repository enumeration, creation, and import must all be
// 403 even though the token's scope set alone would satisfy the gate.
func TestRequireScope_RepositoryBoundTokenBlockedOnGlobalRoutes(t *testing.T) {
	t.Parallel()

	routes := []struct {
		name     string
		method   string
		path     string
		required TokenScope
	}{
		{name: "enumerate user repos", method: http.MethodGet, path: "/user/repos", required: ScopeReadRepository},
		{name: "create repo", method: http.MethodPost, path: "/user/repos", required: ScopeWriteRepository},
		{name: "github import", method: http.MethodPost, path: "/github/import", required: ScopeWriteRepository},
		{name: "repo connection", method: http.MethodPost, path: "/repo-connection", required: ScopeWriteRepository},
		{name: "cross-repo readable repos", method: http.MethodGet, path: "/user/readable-repos", required: ScopeReadRepository},
	}

	for _, rt := range routes {
		rt := rt
		t.Run(rt.name, func(t *testing.T) {
			t.Parallel()
			rec := serveScoped(t, repoBoundAuthInfo(42), rt.method, rt.path, func(r chi.Router, next http.HandlerFunc) {
				r.With(RequireScope(rt.required)).MethodFunc(rt.method, rt.path, next)
			})
			require.Equal(t, http.StatusForbidden, rec.Code, "repo-bound token must not reach global route %s", rt.path)
			assert.Contains(t, rec.Body.String(), "repository-bound token")
		})
	}
}

// TestRequireScope_RepositoryBoundTokenPassesRepoScopedRoutes verifies the gate
// lets repo-addressed routes through: the binding is resolved downstream by
// LoadRepoContext (which treats the token as anonymous on every repository
// other than its own), so the per-run token keeps working against its repo.
func TestRequireScope_RepositoryBoundTokenPassesRepoScopedRoutes(t *testing.T) {
	t.Parallel()

	rec := serveScoped(t, repoBoundAuthInfo(42), http.MethodPost, "/repos/alice/widget/landings", func(r chi.Router, next http.HandlerFunc) {
		r.With(RequireScope(ScopeWriteRepository)).Post("/repos/{owner}/{repo}/landings", next)
	})
	require.Equal(t, http.StatusNoContent, rec.Code)
}

// TestRequireScope_UnrestrictedTokenKeepsGlobalAccess pins the non-regression:
// a normal write:repository PAT without a repo binding still uses global routes.
func TestRequireScope_UnrestrictedTokenKeepsGlobalAccess(t *testing.T) {
	t.Parallel()

	rec := serveScoped(t, unrestrictedTokenAuthInfo(string(ScopeWriteRepository)), http.MethodPost, "/user/repos", func(r chi.Router, next http.HandlerFunc) {
		r.With(RequireScope(ScopeWriteRepository)).Post("/user/repos", next)
	})
	require.Equal(t, http.StatusNoContent, rec.Code)
}

// TestRequireScope_SessionAuthUnaffected pins that session (non-token) auth is
// never subject to the repository restriction gate.
func TestRequireScope_SessionAuthUnaffected(t *testing.T) {
	t.Parallel()

	sessionAuth := &AuthInfo{User: &db.User{ID: 7, IsActive: true}}
	rec := serveScoped(t, sessionAuth, http.MethodGet, "/user/repos", func(r chi.Router, next http.HandlerFunc) {
		r.With(RequireScope(ScopeReadRepository)).Get("/user/repos", next)
	})
	require.Equal(t, http.StatusNoContent, rec.Code)
}

// TestRequireTokenScope_RepositoryBoundTokenBlockedOnSearch verifies the
// token-only gate used by the global search routes also rejects repo-bound
// tokens: /search/* enumerates across repositories.
func TestRequireTokenScope_RepositoryBoundTokenBlockedOnSearch(t *testing.T) {
	t.Parallel()

	rec := serveScoped(t, repoBoundAuthInfo(42), http.MethodGet, "/search/repositories", func(r chi.Router, next http.HandlerFunc) {
		r.With(RequireTokenScope(ScopeReadRepository)).Get("/search/repositories", next)
	})
	require.Equal(t, http.StatusForbidden, rec.Code)
	assert.Contains(t, rec.Body.String(), "repository-bound token")
}

// TestRequireTokenScope_RepositoryBoundTokenPassesRepoScopedRoutes verifies the
// mixed-access public-read gate still admits the token on its repo-addressed
// routes, where LoadRepoContext enforces the binding.
func TestRequireTokenScope_RepositoryBoundTokenPassesRepoScopedRoutes(t *testing.T) {
	t.Parallel()

	rec := serveScoped(t, repoBoundAuthInfo(42), http.MethodGet, "/repos/alice/widget", func(r chi.Router, next http.HandlerFunc) {
		r.With(RequireTokenScope(ScopeReadRepository)).Get("/repos/{owner}/{repo}", next)
	})
	require.Equal(t, http.StatusNoContent, rec.Code)
}

// TestRequireTokenScope_AnonymousUnaffected pins that anonymous requests keep
// flowing through RequireTokenScope (public reads).
func TestRequireTokenScope_AnonymousUnaffected(t *testing.T) {
	t.Parallel()

	rec := serveScoped(t, nil, http.MethodGet, "/search/repositories", func(r chi.Router, next http.HandlerFunc) {
		r.With(RequireTokenScope(ScopeReadRepository)).Get("/search/repositories", next)
	})
	require.Equal(t, http.StatusNoContent, rec.Code)
}

func TestRepositoryBoundBranchReadsReachTheirBindingAuthorizer(t *testing.T) {
	for _, tc := range []struct {
		name, method, path, delegation string
		want                           int
	}{
		{"branch file", "GET", "/api/branches/b/files/src/retry.ts", "via:cli,branch:b", 204},
		{"branch diff", "GET", "/api/branches/b/diff", "via:cli,branch:b", 204},
		{"branch head", "GET", "/api/branches/b", "via:cli,branch:b", 204},
		{"no branch", "GET", "/api/branches/b/files/src/retry.ts", "via:cli", 403},
		{"write", "POST", "/api/branches/b/files/src/retry.ts", "via:cli,branch:b", 403},
		{"global", "GET", "/api/user/repos", "via:cli,branch:b", 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			info := repoBoundAuthInfo(99)
			info.TokenSystemIssued = true
			info.RawScopes += "," + tc.delegation
			info.Scopes = ParseTokenScopes(info.RawScopes)
			response := serveScoped(t, info, tc.method, tc.path, func(r chi.Router, next http.HandlerFunc) {
				r.With(RequireScope(ScopeReadRepository)).Method(tc.method, tc.path, next)
			})
			require.Equal(t, tc.want, response.Code, response.Body.String())
		})
	}
}
