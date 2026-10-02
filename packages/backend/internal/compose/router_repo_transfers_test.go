package compose

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
)

func forgeScopeTestRouter() http.Handler {
	return buildRouterCompat(
		testConfigAllFlagsOn(), nil, nil,
		&routes.RepoHandler{Service: &mockRouterRepoService{}, SSHHost: "smithers.test"},
		&routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{},
		&routes.OrgHandler{}, &routes.LandingHandler{},
		&routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{},
		nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
	)
}

func TestServerRouter_RemovedForgeDoors(t *testing.T) {
	router := forgeScopeTestRouter()
	for _, tc := range []struct{ method, path string }{
		{http.MethodPost, "/api/repos/alice/demo/fork"},
		{http.MethodPost, "/api/repos/alice/demo/forks"},
		{http.MethodPost, "/api/repos/alice/demo/transfer"},
		{http.MethodGet, "/api/user/repository-transfers"},
		{http.MethodPost, "/api/user/repository-transfers/17/accept"},
		{http.MethodPost, "/api/user/repository-transfers/17/decline"},
		{http.MethodPost, "/api/user/repository-transfers/17/cancel"},
		{http.MethodGet, "/api/orgs/acme/changesets"},
		{http.MethodPost, "/api/orgs/acme/changesets"},
		{http.MethodGet, "/api/orgs/acme/changesets/17"},
		{http.MethodPost, "/api/orgs/acme/changesets/17/land"},
	} {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			for _, scope := range []middleware.TokenScope{"", middleware.ScopeReadRepository, middleware.ScopeWriteRepository} {
				req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(`{}`))
				req.Header.Set("Content-Type", "application/json")
				if scope != "" {
					req = withRouterTokenAuth(req, scope)
				}
				rec := httptest.NewRecorder()
				router.ServeHTTP(rec, req)
				require.Equal(t, http.StatusNotFound, rec.Code, "scope %s: %s", scope, rec.Body.String())
			}
		})
	}
}

func TestServerRouter_ForgeCutRetainsCoreDoors(t *testing.T) {
	mounted := map[string]bool{}
	err := chi.Walk(forgeScopeTestRouter().(chi.Routes), func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		mounted[method+" "+strings.TrimSuffix(route, "/")] = true
		return nil
	})
	require.NoError(t, err)
	for _, route := range []string{
		"GET /{owner}/{repo}/info/refs", "POST /{owner}/{repo}/git-upload-pack", "POST /{owner}/{repo}/git-receive-pack",
		"POST /api/repos/{owner}/{repo}/sync", "POST /api/repos/{owner}/{repo}/mirror-sync", "POST /api/repos/{owner}/{repo}/github/reconcile",
		"GET /api/repos/{owner}/{repo}/issues", "POST /api/repos/{owner}/{repo}/issues",
		"GET /api/repos/{owner}/{repo}/landings", "POST /api/repos/{owner}/{repo}/landings",
	} {
		require.True(t, mounted[route], "core route disappeared: %s", route)
	}
}
