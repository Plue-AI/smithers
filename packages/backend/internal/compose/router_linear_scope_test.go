package compose

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// stubLinearIntegrationQuerier answers the one query the integration listing
// needs; every other method panics if reached, which no test here does.
type stubLinearIntegrationQuerier struct {
	services.LinearIntegrationQuerier
}

func (stubLinearIntegrationQuerier) ListLinearIntegrationsByUser(context.Context, int64) ([]db.LinearIntegration, error) {
	return nil, nil
}

// stubLinearRepoChecker answers the repository picker with no repositories
// and no organizations, so a request that reaches the handler returns 200 [].
type stubLinearRepoChecker struct {
	routes.LinearRepoChecker
}

func (stubLinearRepoChecker) ListUserRepos(context.Context, db.ListUserReposParams) ([]db.Repository, error) {
	return nil, nil
}

func (stubLinearRepoChecker) ListUserOrgs(context.Context, db.ListUserOrgsParams) ([]db.Organization, error) {
	return nil, nil
}

// linearScopeRouter builds the production router with a Linear handler whose
// account-wide listings succeed for any authenticated caller that reaches them,
// so the tests below observe exactly what the route middleware decides.
func linearScopeRouter() http.Handler {
	linearHandler := &routes.LinearIntegrationHandler{
		Service: services.NewLinearIntegrationService(stubLinearIntegrationQuerier{}, nil, "router-test-session-secret"),
		Repos:   stubLinearRepoChecker{},
	}
	return buildRouter(
		testConfigAllFlagsOn(),
		nil,
		nil, // pool
		&routes.RepoHandler{},
		nil, // mirrorSyncHandler
		&routes.AuthHandler{},
		&routes.UserHandler{},
		&routes.SSHKeyHandler{},
		nil, // deployKeyHandler
		&routes.LabelHandler{},

		&routes.OrgHandler{},
		&routes.LandingHandler{},
		nil,
		nil, // buildCacheHandler
		nil, // stackHandler
		&routes.SearchHandler{Service: &mockRouterSearchService{}},
		&routes.IssueHandler{},
		nil, // wikiService
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, // notificationHandler
		nil, // adminRunnerHandler
		nil, // adminUserHandler
		nil, // adminOrgHandler
		nil, // adminSystemMetricsHandler
		nil, // adminGitHubAppHandler
		nil, // adminAuditHandler
		nil, // webhookHandler
		nil, // secretHandler
		nil, // providerConnectionHandler
		nil, // variableHandler
		nil, // billingHandler
		nil, // protectedBookmarkHandler
		nil, // commitStatusHandler
		nil, // lfsHandler
		nil, // jjVCSHandler
		nil, // agentInternalHandler
		nil, // agentSessionHandler
		nil, // agentSessionStreamHandler
		nil, // approvalsHandler
		nil, // branchLockHandler
		nil, // canaryReportHandler
		nil, // workflowHandler
		nil, // workflowCacheHandler
		nil, // workflowArtifactHandler
		nil, // issueEventHandler
		nil, // workspaceHandler
		nil, // workspaceInternalHandler
		nil, // repositoryJobHandler
		nil, // gitHubProxyHandler
		nil, // gitHubRepoListHandler
		nil, // gitHubUserReposHandler
		nil, // gitHubSyncedReposHandler
		nil, // gitHubImportHandler
		nil, // workspaceTerminalHandler
		nil, // telemetryHandler
		nil, // featureFlagHandler
		nil, // oauth2Handler
		linearHandler,
		nil, // gitHubWebhookHandler
		nil, // smithersMetrics
	)
}

var linearAccountListingRoutes = []string{
	"/api/integrations/linear",
	"/api/integrations/linear/repositories",
}

func withRouterRepositoryBoundToken(req *http.Request, repositoryID int64, scope middleware.TokenScope) *http.Request {
	req = withRouterTokenAuth(req, scope)
	authInfo := middleware.AuthInfoFromContext(req.Context())
	authInfo.RawScopes = string(scope) + "," + middleware.RepositoryRestrictionScope(repositoryID)
	return req
}

// TestServerRouter_LinearListingsEnforceRepositoryReadScope: the Linear
// integration and repository-picker listings expose private repository and
// integration metadata for the whole account, so they are gated like every
// other account-wide repository enumeration: read:repository is required and
// repository-bound tokens are refused. Session auth and a read:repository
// token remain the controls.
func TestServerRouter_LinearListingsEnforceRepositoryReadScope(t *testing.T) {
	t.Parallel()

	router := linearScopeRouter()

	for _, path := range linearAccountListingRoutes {
		path := path
		t.Run(path, func(t *testing.T) {
			t.Parallel()

			cases := []struct {
				name string
				req  func() *http.Request
				want int
			}{
				{
					name: "read:user token only",
					req: func() *http.Request {
						return withRouterTokenAuth(httptest.NewRequest(http.MethodGet, path, nil), middleware.ScopeReadUser)
					},
					want: http.StatusForbidden,
				},
				{
					name: "repository-bound read:repository token",
					req: func() *http.Request {
						return withRouterRepositoryBoundToken(httptest.NewRequest(http.MethodGet, path, nil), 999, middleware.ScopeReadRepository)
					},
					want: http.StatusForbidden,
				},
				{
					name: "session",
					req: func() *http.Request {
						return withRouterSessionAuth(httptest.NewRequest(http.MethodGet, path, nil))
					},
					want: http.StatusOK,
				},
				{
					name: "read:repository token",
					req: func() *http.Request {
						return withRouterTokenAuth(httptest.NewRequest(http.MethodGet, path, nil), middleware.ScopeReadRepository)
					},
					want: http.StatusOK,
				},
			}
			for _, tc := range cases {
				rec := httptest.NewRecorder()
				router.ServeHTTP(rec, tc.req())
				assert.Equal(t, tc.want, rec.Code, "%s: %s -> %s", tc.name, path, rec.Body.String())
			}
		})
	}
}

// TestServerRouter_LinearRoutesCarryScopeGate walks the production router and
// requires every route under /api/integrations/linear* and /api/linear* to
// carry a RequireScope middleware, so a new Linear route cannot ship as an
// account-wide surface that ignores token restrictions.
func TestServerRouter_LinearRoutesCarryScopeGate(t *testing.T) {
	t.Parallel()

	chiRoutes, ok := linearScopeRouter().(chi.Routes)
	require.True(t, ok, "router must expose chi routes for the walk")

	seen := map[string]bool{}
	var missing []string
	err := chi.Walk(chiRoutes, func(method, route string, _ http.Handler, middlewares ...func(http.Handler) http.Handler) error {
		if !strings.HasPrefix(route, "/api/integrations/linear") && !strings.HasPrefix(route, "/api/linear") {
			return nil
		}
		key := method + " " + route
		seen[key] = true
		// Inlining can attribute the closure to buildRouter rather than the
		// middleware package; RequireScope remains in the function name.
		for _, mw := range middlewares {
			if strings.Contains(middlewareFuncName(mw), ".RequireScope.") {
				return nil
			}
		}
		missing = append(missing, key)
		return nil
	})
	require.NoError(t, err)
	assert.Empty(t, missing, "every Linear route must carry RequireScope; missing: %v", missing)

	for _, key := range []string{
		"GET /api/integrations/linear",
		"GET /api/integrations/linear/repositories",
		"POST /api/integrations/linear",
		"GET /api/linear/{id}/ops",
	} {
		assert.True(t, seen[key], "expected the walk to visit %s", key)
	}
}
