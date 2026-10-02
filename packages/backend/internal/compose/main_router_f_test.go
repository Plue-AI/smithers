package compose

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
)

func allFlagsRouterForTest() http.Handler {
	cfg := testConfigAllFlagsOn()
	return buildRouter(
		cfg,
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
		nil, // buildCacheHandler
		nil, // stackHandler
		&routes.SearchHandler{Service: &mockRouterSearchService{}},
		&routes.IssueHandler{},
		nil, // wikiService
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, // notificationHandler
		nil, // hosted composition marker
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
		nil, // gitHubWebhookHandler
		nil, // smithersMetrics
	)
}

// D-11 deletes the first-party Linear integration (smithers#1819): none of its
// doors exists, even with every flag on, and the integration catalog never
// lists it.
func TestBuildRouter_F_FirstPartyLinearDoorsAreAbsent(t *testing.T) {
	router := allFlagsRouterForTest()

	doors := []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/webhooks/linear"},
		{http.MethodGet, "/api/auth/linear"},
		{http.MethodGet, "/api/auth/linear/callback"},
		{http.MethodGet, "/api/linear/setup/key"},
		{http.MethodPost, "/api/linear"},
		{http.MethodGet, "/api/integrations/linear"},
		{http.MethodPost, "/api/integrations/linear"},
		{http.MethodGet, "/api/integrations/linear/repositories"},
		{http.MethodGet, "/api/integrations/linear/setup/key"},
		{http.MethodDelete, "/api/integrations/linear/1"},
		{http.MethodPost, "/api/integrations/linear/1/sync"},
		{http.MethodGet, "/api/linear/1/ops"},
		{http.MethodPost, "/api/linear/1/ops/2/retry"},
		{http.MethodPost, "/api/linear/1/sync"},
		{http.MethodGet, "/api/linear/1/sync/run"},
		{http.MethodPost, "/api/repos/alice/demo/issues/1/linear-link"},
		{http.MethodDelete, "/api/repos/alice/demo/issues/1/linear-link"},
	}
	for _, door := range doors {
		req := httptest.NewRequest(door.method, door.path, strings.NewReader(`{}`))
		req.Header.Set("Content-Type", "application/json")
		req = withRouterTokenAuth(req, middleware.ScopeWriteRepository, middleware.ScopeReadRepository, middleware.ScopeReadUser)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		require.Contains(t, []int{http.StatusNotFound, http.StatusMethodNotAllowed}, rec.Code, "%s %s must not be served", door.method, door.path)
	}

	req := withRouterTokenAuth(httptest.NewRequest(http.MethodGet, "/api/integrations/mcp", nil), middleware.ScopeReadUser)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	require.NotContains(t, strings.ToLower(rec.Body.String()), "linear")
}

func TestBuildRouter_F_IntegrationMutationsRequireWriteRepositoryScope(t *testing.T) {
	router := allFlagsRouterForTest()

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/github/mirror/refs/refs%2Fheads%2Fmain/retry", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req = withRouterTokenAuth(req, middleware.ScopeReadRepository, middleware.ScopeReadUser)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	require.Equal(t, http.StatusForbidden, rec.Code, "a mirror retry with a read-only token must be rejected")
}
