package compose

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// TestServerRouter_InternalAgentCallbackRouteRegistered verifies that the
// /internal/agent/sessions/{session_id}/events route is registered when an
// agentInternalHandler is provided.
func TestServerRouter_InternalAgentCallbackRouteRegistered(t *testing.T) {
	t.Parallel()

	svc := &mockAgentInternalRouteService{}
	agentInternalHandler := &routes.AgentInternalHandler{Service: svc}

	router := buildRouterCompat(
		&config.Config{},
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
		nil, // adminRunnerHandler
		nil, // adminUserHandler
		nil, // adminOrgHandler
		nil, // adminSystemHealthHandler
		nil, // adminGitHubAppHandler
		nil, // adminAuditHandler
		nil, // webhookHandler
		nil, // secretHandler
		nil, // variableHandler
		nil, // commitStatusHandler
		nil, // lfsHandler
		nil, // jjVCSHandler
		agentInternalHandler,
		nil, // agentSessionHandler
		nil, // agentSessionStreamHandler
		nil, // pushHookHandler
		nil, // workflowHandler
		nil, // workspaceHandler
		nil, // workspaceInternalHandler
		nil, // workspaceTerminalHandler
		nil, // telemetryHandler
		nil, // featureFlagHandler
		nil, // oauth2Handler
		nil, // smithersMetrics
	)

	// POST to the internal agent events endpoint — should not return 404/405.
	// Without a valid agent token, the RequireAgentToken middleware will reject,
	// but 401 proves the route is registered and the middleware is active.
	body := bytes.NewBufferString(`{"event_type":"text","content":{"value":"hello"}}`)
	req := httptest.NewRequest(http.MethodPost, "/internal/agent/sessions/test-session/events", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	// 401 (missing/invalid agent token) means the route is registered behind RequireAgentToken.
	assert.Equal(t, http.StatusUnauthorized, rec.Code,
		"POST /internal/agent/sessions/{session_id}/events should be registered and require agent token auth")
}

// mockAgentInternalRouteService implements routes.AgentInternalRouteService for router tests.
type mockAgentInternalRouteService struct{}

func (m *mockAgentInternalRouteService) IngestRunnerEvent(_ context.Context, _ services.IngestRunnerEventInput) error {
	return nil
}

// TestServerRouter_WikiRoutesRegistered verifies that the ticketed wiki CRUD
// endpoints are registered when wikiService is provided to buildRouter.
func TestServerRouter_WikiRoutesRegistered(t *testing.T) {
	t.Parallel()

	wikiSvc := &mockRouterWikiService{}
	router := defaultRouterWithWiki(wikiSvc)

	// All wiki routes require auth, so they return 401 (not 404) when
	// registered. A 404 would indicate the route was never mounted.
	wikiRoutes := []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/repos/alice/demo/wiki"},
		{http.MethodGet, "/api/repos/alice/demo/wiki/Home"},
		{http.MethodPost, "/api/repos/alice/demo/wiki"},
		{http.MethodPatch, "/api/repos/alice/demo/wiki/Home"},
		{http.MethodDelete, "/api/repos/alice/demo/wiki/Home"},
	}

	for _, tc := range wikiRoutes {
		req := httptest.NewRequest(tc.method, tc.path, nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		assert.NotEqual(t, http.StatusNotFound, rec.Code,
			"%s %s should be registered (got 404)", tc.method, tc.path)
	}
}

func TestServerRouter_AdminScopeEnforcement(t *testing.T) {
	t.Parallel()

	adminUserHandler := &routes.AdminUserHandler{Service: &mockAdminUserRouteService{}}
	router := routerWithAdminUserHandler(adminUserHandler)

	readReq := httptest.NewRequest(http.MethodGet, "/api/admin/users", nil)
	readReq = withRouterAdminTokenAuth(readReq, true, middleware.TokenSourcePersonalAccessToken, middleware.ScopeReadAdmin)
	readRec := httptest.NewRecorder()
	router.ServeHTTP(readRec, readReq)
	assert.Equal(t, http.StatusOK, readRec.Code)

	writeBody := bytes.NewBufferString(`{"is_admin":true}`)
	writeReq := httptest.NewRequest(http.MethodPatch, "/api/admin/users/alice/admin", writeBody)
	writeReq.Header.Set("Content-Type", "application/json")
	writeReq = withRouterAdminTokenAuth(writeReq, true, middleware.TokenSourcePersonalAccessToken, middleware.ScopeReadAdmin)
	writeRec := httptest.NewRecorder()
	router.ServeHTTP(writeRec, writeReq)
	assert.Equal(t, http.StatusForbidden, writeRec.Code)

	allowBody := bytes.NewBufferString(`{"is_admin":true}`)
	allowReq := httptest.NewRequest(http.MethodPatch, "/api/admin/users/alice/admin", allowBody)
	allowReq.Header.Set("Content-Type", "application/json")
	allowReq = withRouterAdminTokenAuth(allowReq, true, middleware.TokenSourcePersonalAccessToken, middleware.ScopeWriteAdmin)
	allowRec := httptest.NewRecorder()
	router.ServeHTTP(allowRec, allowReq)
	assert.Equal(t, http.StatusOK, allowRec.Code)
}

func TestServerRouter_SelfhostDoesNotMountAdminUserProvisioning(t *testing.T) {
	t.Parallel()

	service := &mockAdminUserRouteService{}
	router := routerWithAdminUserHandler(&routes.AdminUserHandler{Service: service}, config.AuthModeSelfHosted)
	req := httptest.NewRequest(http.MethodPost, "/api/admin/users", bytes.NewBufferString(`{"username":"second-owner"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusNotFound, rec.Code)
	assert.Zero(t, service.createUserCalls)
}

func routerWithAdminUserHandler(adminUserHandler *routes.AdminUserHandler, authModes ...string) http.Handler {
	cfg := &config.Config{}
	if len(authModes) > 0 {
		cfg.Auth.Mode = authModes[0]
	}
	return buildRouterCompat(
		cfg,
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
		adminUserHandler,
		nil, // adminOrgHandler
		nil, // adminSystemHealthHandler
		nil, // adminGitHubAppHandler
		nil, // adminAuditHandler
		nil, // webhookHandler
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
		nil, // workspaceHandler
		nil, // workspaceInternalHandler
		nil, // workspaceTerminalHandler
		nil, // telemetryHandler
		nil, // featureFlagHandler
		nil, // oauth2Handler
		nil, // smithersMetrics
	)
}

// The app asks GET /api/user/orgs on every backend to classify repository
// owners (apps/app RepositoriesSeam). Single-owner mode keeps the read and
// answers it like the hosted backend does; only tenant provisioning is gone.
func TestServerRouter_SelfhostServesTheUsersOwnOrgListWithoutProvisioning(t *testing.T) {
	t.Parallel()

	router := routerWithAdminUserHandler(&routes.AdminUserHandler{Service: &mockAdminUserRouteService{}}, config.AuthModeSelfHosted)

	read := httptest.NewRecorder()
	router.ServeHTTP(read, httptest.NewRequest(http.MethodGet, "/api/user/orgs", nil))
	assert.Equal(t, http.StatusUnauthorized, read.Code, "the membership read is mounted and reaches auth: %s", read.Body.String())

	for _, path := range []string{"/api/orgs", "/api/admin/orgs"} {
		req := httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(`{"name":"acme"}`))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		assert.Equal(t, http.StatusNotFound, rec.Code, path)
	}
}
