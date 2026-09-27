package compose

import (
	"net/http"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/routes"
)

// The npm smithers CLI (packages/smithers) calls these routes. Its HTTP contract tests
// use fakes that accept any path, so this walk is what catches the CLI and the
// server drifting apart.
func TestServerRouter_ServesSmithersCLIRoutes(t *testing.T) {
	t.Parallel()

	router, ok := smithersCLIRoutesRouter().(chi.Routes)
	require.True(t, ok)
	mounted := map[string]bool{}
	require.NoError(t, chi.Walk(router, func(method, path string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		mounted[method+" "+strings.TrimSuffix(path, "/")] = true
		return nil
	}))

	for _, route := range []string{
		// smithers webhook deliveries ID --replay D
		"POST /api/repos/{owner}/{repo}/hooks/{id}/deliveries/{delivery_id}/redeliver",
		// smithers workspace snapshots ID
		"GET /api/repos/{owner}/{repo}/workspace-snapshots",
	} {
		require.True(t, mounted[route], "CLI route %q is not mounted", route)
	}
}

// smithersCLIRoutesRouter is defaultRouter with the webhook and workspace
// handlers the CLI routes need.
func smithersCLIRoutesRouter() http.Handler {
	return buildRouterCompat(
		testConfigAllFlagsOn(),
		nil,
		nil, // pool
		&routes.RepoHandler{},
		&routes.AuthHandler{},
		&routes.UserHandler{},
		&routes.SSHKeyHandler{},
		&routes.LabelHandler{},

		&routes.OrgHandler{},
		&routes.LandingHandler{},
		&routes.SearchHandler{Service: &mockRouterSearchService{}},
		&routes.IssueHandler{},
		nil, // wikiService
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, // adminRunnerHandler
		nil, // adminUserHandler
		nil, // adminOrgHandler
		nil, // adminSystemHealthHandler
		nil, // adminGitHubAppHandler
		nil, // adminAuditHandler
		&routes.WebhookHandler{},
		nil, // secretHandler
		nil, // variableHandler
		nil, // commitStatusHandler
		nil, // lfsHandler
		nil, // jjVCSHandler
		nil, // agentInternalHandler
		nil, // agentSessionHandler
		nil, // agentSessionStreamHandler
		nil, // pushHookHandler
		nil, // workflowHandler
		&routes.WorkspaceHandler{},
		nil, // workspaceInternalHandler
		nil, // workspaceTerminalHandler
		nil, // telemetryHandler
		nil, // featureFlagHandler
		nil, // oauth2Handler
		nil, // smithersMetrics
	)
}
