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

func linearRouterForTest() http.Handler {
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
		nil,
		nil, // buildCacheHandler
		nil, // stackHandler
		&routes.SearchHandler{Service: &mockRouterSearchService{}},
		&routes.IssueHandler{},
		nil, // wikiService
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil,                                // notificationHandler
		nil,                                // hosted composition marker
		nil,                                // adminUserHandler
		nil,                                // adminOrgHandler
		nil,                                // adminSystemMetricsHandler
		nil,                                // adminGitHubAppHandler
		nil,                                // adminAuditHandler
		nil,                                // webhookHandler
		nil,                                // secretHandler
		nil,                                // providerConnectionHandler
		nil,                                // variableHandler
		nil,                                // billingHandler
		nil,                                // protectedBookmarkHandler
		nil,                                // commitStatusHandler
		nil,                                // lfsHandler
		nil,                                // jjVCSHandler
		nil,                                // agentInternalHandler
		nil,                                // agentSessionHandler
		nil,                                // agentSessionStreamHandler
		nil,                                // approvalsHandler
		nil,                                // branchLockHandler
		nil,                                // canaryReportHandler
		nil,                                // workflowHandler
		nil,                                // workflowCacheHandler
		nil,                                // workflowArtifactHandler
		nil,                                // issueEventHandler
		nil,                                // workspaceHandler
		nil,                                // workspaceInternalHandler
		nil,                                // repositoryJobHandler
		nil,                                // gitHubProxyHandler
		nil,                                // gitHubRepoListHandler
		nil,                                // gitHubUserReposHandler
		nil,                                // gitHubSyncedReposHandler
		nil,                                // gitHubImportHandler
		nil,                                // workspaceTerminalHandler
		nil,                                // telemetryHandler
		nil,                                // featureFlagHandler
		nil,                                // oauth2Handler
		&routes.LinearIntegrationHandler{}, // linearHandler != nil -> /auth/linear routes
		nil,                                // gitHubWebhookHandler
		nil,                                // smithersMetrics
	)
}

func TestBuildRouter_F_IntegrationMutationsRequireWriteRepositoryScope(t *testing.T) {
	router := linearRouterForTest()

	requests := []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/api/linear"},
		{http.MethodPost, "/api/integrations/linear"},
		{http.MethodDelete, "/api/integrations/linear/1"},
		{http.MethodPost, "/api/integrations/linear/1/sync"},
		{http.MethodPost, "/api/linear/1/sync"},
		{http.MethodPost, "/api/linear/1/ops/2/retry"},
		{http.MethodPost, "/api/repos/alice/demo/github/mirror/refs/refs%2Fheads%2Fmain/retry"},
	}

	for _, r := range requests {
		req := httptest.NewRequest(r.method, r.path, strings.NewReader(`{}`))
		req.Header.Set("Content-Type", "application/json")
		req = withRouterTokenAuth(req, middleware.ScopeReadRepository, middleware.ScopeReadUser)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		require.Equal(t, http.StatusForbidden, rec.Code, "%s %s with read-only token must be rejected", r.method, r.path)
	}
}
