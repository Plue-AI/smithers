package compose

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/stretchr/testify/require"
)

// The real bus provides subscription semantics; the counter observes admission
// without authenticating or allowing either socket handler to run.
type workspaceSocketSubscriptionObserver struct {
	*revocation.Bus
	subscriptions atomic.Int64
}

func (s *workspaceSocketSubscriptionObserver) Subscribe(fn func(revocation.Event)) func() {
	s.subscriptions.Add(1)
	return s.Bus.Subscribe(fn)
}

func TestBuildRouter_WorkspaceSocketsSubscribeBeforeRequireAuth(t *testing.T) {
	source := &workspaceSocketSubscriptionObserver{Bus: revocation.NewBus(nil, nil)}
	routes.SetRevocationSource(source)
	t.Cleanup(func() { routes.SetRevocationSource(nil) })
	// SetRevocationSource subscribes the process relay registry itself.
	source.subscriptions.Store(0)
	router := buildRouterCompat(
		testCORSConfig(),
		nil,
		nil,
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
		nil,                                // notificationHandler
		nil,                                // adminUserHandler
		nil,                                // adminOrgHandler
		nil,                                // adminRepoHandler
		nil,                                // adminGitHubAppHandler
		nil,                                // adminAuditHandler
		nil,                                // webhookHandler
		nil,                                // secretHandler
		nil,                                // variableHandler
		nil,                                // commitStatusHandler
		nil,                                // lfsHandler
		nil,                                // jjVCSHandler
		nil,                                // agentInternalHandler
		nil,                                // agentSessionHandler
		nil,                                // agentSessionStreamHandler
		nil,                                // pushHookHandler
		nil,                                // workflowHandler
		nil,                                // workspaceHandler
		nil,                                // workspaceInternalHandler
		&routes.WorkspaceTerminalHandler{}, // workspaceTerminalHandler
		nil,                                // telemetryHandler
		nil,                                // featureFlagHandler
		nil,                                // oauth2Handler
		nil,                                // smithersMetrics
	)
	for _, endpoint := range []string{"terminal", "lsp"} {
		t.Run(endpoint, func(t *testing.T) {
			source.subscriptions.Store(0)
			request := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workspace/sessions/session-1/"+endpoint, nil)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			require.Equal(t, http.StatusUnauthorized, response.Code)
			require.EqualValues(t, 1, source.subscriptions.Load(), "socket admission must subscribe before RequireAuth rejects the request")
		})
	}
}
