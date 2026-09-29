package compose

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestServerRouter_WorkflowRunLogsSSEPreflightIncludesCORSHeaders(t *testing.T) {
	t.Parallel()

	workflowHandler := &routes.WorkflowHandler{Service: &mockRouterWorkflowService{}}
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
		nil, // agentInternalHandler
		nil, // agentSessionHandler
		nil, // agentSessionStreamHandler
		nil, // pushHookHandler
		workflowHandler,
		nil, // workspaceHandler
		nil, // workspaceInternalHandler
		nil, // workspaceTerminalHandler
		nil, // telemetryHandler
		nil, // featureFlagHandler
		nil, // oauth2Handler
		nil, // smithersMetrics
	)

	req := httptest.NewRequest(http.MethodOptions, "/api/repos/alice/demo/runs/1/logs", nil)
	req.Header.Set("Origin", "https://example.com")
	req.Header.Set("Access-Control-Request-Method", http.MethodGet)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	assert.NotEqual(t, http.StatusNotFound, rec.Code, "workflow logs SSE route should handle CORS preflight")
	assert.Equal(t, "https://example.com", rec.Header().Get("Access-Control-Allow-Origin"), "preflight should include the configured CORS origin header")
	assert.NotEmpty(t, rec.Header().Get("Access-Control-Allow-Methods"), "preflight should include allowed methods")
}

// mockIntegrationWorkflowQuerier is a minimal WorkflowAPIQuerier for integration tests.
// It delegates all methods to zero values so services.NewWorkflowAPIService can be
// constructed without a real database connection.
type mockIntegrationWorkflowQuerier struct{}

func (m *mockIntegrationWorkflowQuerier) ListWorkflowDefinitionsByRepo(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
	return nil, nil
}
func (m *mockIntegrationWorkflowQuerier) GetWorkflowDefinition(_ context.Context, _ db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
	return db.WorkflowDefinition{}, nil
}
func (m *mockIntegrationWorkflowQuerier) ListWorkflowRunsByRepo(_ context.Context, _ db.ListWorkflowRunsByRepoParams) ([]db.WorkflowRun, error) {
	return nil, nil
}
func (m *mockIntegrationWorkflowQuerier) ListWorkflowRunsByDefinition(_ context.Context, _ db.ListWorkflowRunsByDefinitionParams) ([]db.WorkflowRun, error) {
	return nil, nil
}
func (m *mockIntegrationWorkflowQuerier) GetWorkflowRun(_ context.Context, _ db.GetWorkflowRunParams) (db.WorkflowRun, error) {
	return db.WorkflowRun{}, nil
}
func (m *mockIntegrationWorkflowQuerier) CreateWorkflowRun(_ context.Context, _ db.CreateWorkflowRunParams) (db.WorkflowRun, error) {
	return db.WorkflowRun{}, nil
}
func (m *mockIntegrationWorkflowQuerier) ListWorkflowStepsByRunID(_ context.Context, _ int64) ([]db.WorkflowStep, error) {
	return nil, nil
}
func (m *mockIntegrationWorkflowQuerier) ListWorkflowLogsSince(_ context.Context, _ db.ListWorkflowLogsSinceParams) ([]db.WorkflowLog, error) {
	return nil, nil
}

// mockIntegrationWorkflowRunService is a minimal WorkflowRunService for integration tests.
type mockIntegrationWorkflowRunService struct{}

func (m *mockIntegrationWorkflowRunService) DispatchForEvent(_ context.Context, _ services.DispatchForEventInput) ([]services.WorkflowRunResult, error) {
	return nil, nil
}
func (m *mockIntegrationWorkflowRunService) CancelRun(_ context.Context, _, _ int64) error {
	return nil
}
func (m *mockIntegrationWorkflowRunService) RerunRun(_ context.Context, _ services.RerunInput) (*services.WorkflowRunResult, error) {
	return nil, nil
}
func (m *mockIntegrationWorkflowRunService) ResumeRun(_ context.Context, _, _ int64) error {
	return nil
}

type mockIntegrationGitHubImportService struct {
	getFn           func(context.Context, int64, string) (services.ImportJob, error)
	startFn         func(context.Context, services.ImportGitHubRepoInput) (services.ImportJob, error)
	startTemplateFn func(context.Context, services.ImportTemplateRepoInput) (services.ImportJob, error)
	retryFn         func(context.Context, int64, string) (services.ImportJob, error)
}

func (m *mockIntegrationGitHubImportService) StartImport(ctx context.Context, input services.ImportGitHubRepoInput) (services.ImportJob, error) {
	if m.startFn != nil {
		return m.startFn(ctx, input)
	}
	return services.ImportJob{}, nil
}

func (m *mockIntegrationGitHubImportService) StartTemplateImport(ctx context.Context, input services.ImportTemplateRepoInput) (services.ImportJob, error) {
	if m.startTemplateFn != nil {
		return m.startTemplateFn(ctx, input)
	}
	return services.ImportJob{}, nil
}

func (m *mockIntegrationGitHubImportService) GetImportJob(ctx context.Context, userID int64, id string) (services.ImportJob, error) {
	if m.getFn != nil {
		return m.getFn(ctx, userID, id)
	}
	return services.ImportJob{}, nil
}

func (m *mockIntegrationGitHubImportService) RetryImportJob(ctx context.Context, userID int64, id string) (services.ImportJob, error) {
	if m.retryFn != nil {
		return m.retryFn(ctx, userID, id)
	}
	return services.ImportJob{}, nil
}

// mockIntegrationWorkspaceService is a minimal WorkspaceRouteService for integration tests.
type mockIntegrationWorkspaceService struct {
	snapshotDeadline chan time.Duration
}

func (m *mockIntegrationWorkspaceService) CreateWorkspace(_ context.Context, input services.CreateWorkspaceInput) (services.WorkspaceResponse, error) {
	return services.WorkspaceResponse{
		ID:                 "00000000-0000-0000-0000-000000000010",
		RepositoryID:       input.RepositoryID,
		UserID:             input.UserID,
		Status:             "running",
		VMID:               "vm-test-123",
		Persistence:        "persistent",
		IdleTimeoutSeconds: 1800,
	}, nil
}
func (m *mockIntegrationWorkspaceService) GetWorkspace(_ context.Context, workspaceID string, _ int64, _ int64) (services.WorkspaceResponse, error) {
	return services.WorkspaceResponse{
		ID:                 workspaceID,
		RepositoryID:       1,
		UserID:             1,
		Status:             "running",
		VMID:               "vm-test-123",
		Persistence:        "persistent",
		IdleTimeoutSeconds: 1800,
	}, nil
}
func (m *mockIntegrationWorkspaceService) ListWorkspaces(_ context.Context, _ int64, _ int64, _, _ int) ([]services.WorkspaceResponse, int64, error) {
	return []services.WorkspaceResponse{{
		ID:                 "00000000-0000-0000-0000-000000000010",
		RepositoryID:       1,
		UserID:             1,
		Status:             "running",
		VMID:               "vm-test-123",
		Persistence:        "persistent",
		IdleTimeoutSeconds: 1800,
	}}, 1, nil
}
func (m *mockIntegrationWorkspaceService) ListUserWorkspacesAcrossRepos(_ context.Context, _ int64, _, _ int) (services.UserWorkspaceListResult, error) {
	return services.UserWorkspaceListResult{}, nil
}
func (m *mockIntegrationWorkspaceService) ListWorkspaceFiles(context.Context, string, int64, int64, string) ([]services.WorkspaceFileEntry, error) {
	return nil, nil
}
func (m *mockIntegrationWorkspaceService) ReadWorkspaceFile(context.Context, string, int64, int64, string) (services.WorkspaceFileContent, error) {
	return services.WorkspaceFileContent{}, nil
}
func (m *mockIntegrationWorkspaceService) WriteWorkspaceFile(context.Context, string, int64, int64, string, string) (services.WorkspaceFileContent, error) {
	return services.WorkspaceFileContent{}, nil
}
func (m *mockIntegrationWorkspaceService) ListWorkspaceServices(context.Context, string, int64, int64) ([]services.WorkspaceManagedService, error) {
	return nil, nil
}
func (m *mockIntegrationWorkspaceService) ManageWorkspaceService(context.Context, string, int64, int64, string, string) (services.WorkspaceManagedService, error) {
	return services.WorkspaceManagedService{}, nil
}
func (m *mockIntegrationWorkspaceService) GetWorkspaceSSHConnectionInfo(_ context.Context, workspaceID string, _ int64, _ int64) (services.WorkspaceSSHConnectionInfo, error) {
	return services.WorkspaceSSHConnectionInfo{WorkspaceID: workspaceID, VMID: "vm-test-123", Host: "vm-ssh.smithers.sh"}, nil
}
func (m *mockIntegrationWorkspaceService) SuspendWorkspace(_ context.Context, workspaceID string, _ int64, _ int64) (services.WorkspaceResponse, error) {
	return services.WorkspaceResponse{ID: workspaceID, RepositoryID: 1, UserID: 1, Status: "suspended"}, nil
}
func (m *mockIntegrationWorkspaceService) ResumeWorkspace(_ context.Context, workspaceID string, _ int64, _ int64) (services.WorkspaceResponse, error) {
	return services.WorkspaceResponse{ID: workspaceID, RepositoryID: 1, UserID: 1, Status: "running"}, nil
}
func (m *mockIntegrationWorkspaceService) DeleteWorkspace(_ context.Context, _ string, _ int64, _ int64) error {
	return nil
}
func (m *mockIntegrationWorkspaceService) ForkWorkspace(_ context.Context, input services.ForkWorkspaceInput) (services.WorkspaceResponse, error) {
	return services.WorkspaceResponse{ID: "00000000-0000-0000-0000-000000000011", RepositoryID: 1, UserID: 1, Status: "running", IsFork: true, ParentWorkspaceID: input.WorkspaceID}, nil
}
func (m *mockIntegrationWorkspaceService) CreateWorkspaceSnapshot(ctx context.Context, input services.CreateWorkspaceSnapshotInput) (services.WorkspaceSnapshotResponse, error) {
	if m.snapshotDeadline != nil {
		remaining := time.Duration(-1)
		if deadline, ok := ctx.Deadline(); ok {
			remaining = time.Until(deadline)
		}
		m.snapshotDeadline <- remaining
	}
	return services.WorkspaceSnapshotResponse{ID: "00000000-0000-0000-0000-000000000020", RepositoryID: 1, UserID: 1, WorkspaceID: input.WorkspaceID, Name: input.Name, SnapshotID: "snap-test-123"}, nil
}
func (m *mockIntegrationWorkspaceService) GetWorkspaceSnapshot(_ context.Context, snapshotID string, _ int64, _ int64) (services.WorkspaceSnapshotResponse, error) {
	return services.WorkspaceSnapshotResponse{ID: snapshotID, RepositoryID: 1, UserID: 1, WorkspaceID: "00000000-0000-0000-0000-000000000010", Name: "snapshot", SnapshotID: "snap-test-123"}, nil
}
func (m *mockIntegrationWorkspaceService) ListWorkspaceSnapshots(_ context.Context, _ int64, _ int64, _, _ int) ([]services.WorkspaceSnapshotResponse, int64, error) {
	return []services.WorkspaceSnapshotResponse{{ID: "00000000-0000-0000-0000-000000000020", RepositoryID: 1, UserID: 1, WorkspaceID: "00000000-0000-0000-0000-000000000010", Name: "snapshot", SnapshotID: "snap-test-123"}}, 1, nil
}
func (m *mockIntegrationWorkspaceService) DeleteWorkspaceSnapshot(_ context.Context, _ string, _ int64, _ int64) error {
	return nil
}
func (m *mockIntegrationWorkspaceService) CreateSession(_ context.Context, _ services.CreateWorkspaceSessionInput) (services.WorkspaceSessionResponse, error) {
	return services.WorkspaceSessionResponse{
		ID:     "00000000-0000-0000-0000-000000000001",
		Status: "pending",
		Cols:   80,
		Rows:   24,
	}, nil
}
func (m *mockIntegrationWorkspaceService) GetSession(_ context.Context, _ string, _ int64, _ int64) (services.WorkspaceSessionResponse, error) {
	return services.WorkspaceSessionResponse{}, nil
}
func (m *mockIntegrationWorkspaceService) ListSessions(_ context.Context, _ int64, _ int64, _, _ int) ([]services.WorkspaceSessionResponse, int64, error) {
	return nil, 0, nil
}
func (m *mockIntegrationWorkspaceService) GetSSHConnectionInfo(_ context.Context, _ string, _ int64, _ int64) (services.WorkspaceSSHConnectionInfo, error) {
	return services.WorkspaceSSHConnectionInfo{}, nil
}
func (m *mockIntegrationWorkspaceService) DestroySession(_ context.Context, _ string, _ int64, _ int64) error {
	return nil
}

// mockIntegrationWorkspaceInternalService is a minimal WorkspaceInternalRouteService for integration tests.
type mockIntegrationWorkspaceInternalService struct{}

func (m *mockIntegrationWorkspaceInternalService) UpdateWorkspacePodStatus(_ context.Context, _ services.UpdateWorkspacePodStatusInput) error {
	return nil
}

func (m *mockIntegrationWorkspaceInternalService) UpdateWorkspaceHead(_ context.Context, _ services.UpdateWorkspaceHeadInput) error {
	return nil
}

// mockIntegrationAgentSessionService is a minimal AgentSessionRouteService for integration tests.
type mockIntegrationAgentSessionService struct{}

func (m *mockIntegrationAgentSessionService) CreateSession(_ context.Context, _ services.CreateAgentSessionInput) (services.AgentSessionResponse, error) {
	return services.AgentSessionResponse{
		ID:     "00000000-0000-0000-0000-000000000001",
		Status: "active",
	}, nil
}

func (m *mockIntegrationAgentSessionService) GetSession(_ context.Context, sessionID string) (services.AgentSessionResponse, error) {
	return services.AgentSessionResponse{ID: sessionID, Status: "active"}, nil
}

func (m *mockIntegrationAgentSessionService) GetSessionForRepo(_ context.Context, _ string, _ int64) error {
	return nil
}

func (m *mockIntegrationAgentSessionService) ListSessions(_ context.Context, _ int64, _, _ int) ([]services.AgentSessionResponse, int64, error) {
	return []services.AgentSessionResponse{{ID: "sess-1", Status: "active"}}, 1, nil
}

func (m *mockIntegrationAgentSessionService) AppendMessage(_ context.Context, sessionID, role string, _ []db.CreateAgentPartParams) (services.AgentMessageResponse, error) {
	return services.AgentMessageResponse{
		ID:        1,
		SessionID: sessionID,
		Role:      role,
		Sequence:  0,
	}, nil
}

func (m *mockIntegrationAgentSessionService) ListMessages(_ context.Context, sessionID string, _, _ int) ([]services.AgentMessageResponse, error) {
	return []services.AgentMessageResponse{{ID: 1, SessionID: sessionID, Role: "user", Sequence: 0}}, nil
}

func (m *mockIntegrationAgentSessionService) ListMessagesAfterID(_ context.Context, sessionID string, afterID int64, _ int) ([]services.AgentMessageResponse, error) {
	return []services.AgentMessageResponse{{ID: afterID + 1, SessionID: sessionID, Role: "user", Sequence: afterID + 1}}, nil
}

func (m *mockIntegrationAgentSessionService) DeleteSession(_ context.Context, _ string, _ int64) error {
	return nil
}

func (m *mockIntegrationAgentSessionService) AppendMessageAndDispatch(ctx context.Context, input services.DispatchAgentRunInput, parts []db.CreateAgentPartParams) (services.AgentMessageResponse, error) {
	return m.AppendMessage(ctx, input.SessionID, "user", parts)
}

func (m *mockIntegrationAgentSessionService) DispatchAgentRun(_ context.Context, _ services.DispatchAgentRunInput) (services.DispatchAgentRunResult, error) {
	return services.DispatchAgentRunResult{}, nil
}

func (m *mockIntegrationAgentSessionService) EnsureSessionDispatchable(_ context.Context, _ string) error {
	return nil
}

// TestServerRouter_WorkspaceSessionCRUDRoutesRegistered verifies that all workspace
// session CRUD routes are registered when workspaceHandler is provided to buildRouter.
func TestServerRouter_WorkspaceSessionCRUDRoutesRegistered(t *testing.T) {
	t.Parallel()

	snapshotDeadline := make(chan time.Duration, 1)
	workspaceService := &mockIntegrationWorkspaceService{snapshotDeadline: snapshotDeadline}
	workspaceHandler := &routes.WorkspaceHandler{
		Service: workspaceService,
	}
	cfg := testCORSConfig()
	cfg.FeatureFlags.Workspaces = true

	router := buildRouterCompat(
		cfg,
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
		nil, // agentInternalHandler
		nil, // agentSessionHandler
		nil, // agentSessionStreamHandler
		nil, // pushHookHandler
		nil, // workflowHandler
		workspaceHandler,
		nil, // workspaceInternalHandler
		nil, // workspaceTerminalHandler
		nil, // telemetryHandler
		nil, // featureFlagHandler
		nil, // oauth2Handler
		nil, // smithersMetrics
	)

	// Test each workspace route is registered (not 404).
	// Routes require auth so they return 401, not 404.
	routes := []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/api/repos/alice/demo/workspace/sessions"},
		{http.MethodGet, "/api/repos/alice/demo/workspace/sessions"},
		{http.MethodGet, "/api/repos/alice/demo/workspace/sessions/test-id"},
		{http.MethodGet, "/api/repos/alice/demo/workspace/sessions/test-id/ssh"},
		{http.MethodPost, "/api/repos/alice/demo/workspace/sessions/test-id/destroy"},
		{http.MethodPost, "/api/repos/alice/demo/workspaces"},
		{http.MethodGet, "/api/repos/alice/demo/workspaces"},
		{http.MethodGet, "/api/repos/alice/demo/workspaces/test-id"},
		{http.MethodGet, "/api/repos/alice/demo/workspaces/test-id/files"},
		{http.MethodGet, "/api/repos/alice/demo/workspaces/test-id/files/content?path=README.md"},
		{http.MethodPut, "/api/repos/alice/demo/workspaces/test-id/files/content?path=README.md"},
		{http.MethodGet, "/api/repos/alice/demo/workspaces/test-id/services"},
		{http.MethodPost, "/api/repos/alice/demo/workspaces/test-id/services/web/start"},
		{http.MethodPost, "/api/repos/alice/demo/workspaces/test-id/services/web/stop"},
		{http.MethodPost, "/api/repos/alice/demo/workspaces/test-id/services/web/restart"},
		{http.MethodDelete, "/api/repos/alice/demo/workspaces/test-id"},
		{http.MethodPost, "/api/repos/alice/demo/workspaces/test-id/suspend"},
		{http.MethodPost, "/api/repos/alice/demo/workspaces/test-id/resume"},
		{http.MethodPost, "/api/repos/alice/demo/workspaces/test-id/fork"},
		{http.MethodPost, "/api/repos/alice/demo/workspaces/test-id/snapshot"},
		{http.MethodGet, "/api/repos/alice/demo/workspaces/test-id/ssh"},
		{http.MethodGet, "/api/repos/alice/demo/workspace-snapshots"},
		{http.MethodPost, "/api/repos/alice/demo/workspace-snapshots"},
		{http.MethodGet, "/api/repos/alice/demo/workspace-snapshots/test-id"},
		{http.MethodDelete, "/api/repos/alice/demo/workspace-snapshots/test-id"},
	}

	for _, tc := range routes {
		req := httptest.NewRequest(tc.method, tc.path, nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		assert.NotEqual(t, http.StatusNotFound, rec.Code,
			"%s %s should be registered (got 404)", tc.method, tc.path)
	}

	// Snapshotting a real VM includes quiesce, stop, disk persistence, and restart.
	// Its route must use the lifecycle deadline, not the ordinary 30-second API one.
	req := httptest.NewRequest(
		http.MethodPost,
		"/api/repos/alice/demo/workspaces/00000000-0000-0000-0000-000000000010/snapshot",
		strings.NewReader(`{"name":"timeout-contract"}`),
	)
	req.Header.Set("Content-Type", "application/json")
	ctx := middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
		User:        &db.User{ID: 1, Username: "alice", LowerUsername: "alice"},
		Scopes:      middleware.ScopeSet{middleware.ScopeAll: {}},
		IsTokenAuth: true,
	})
	ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{
		Owner:      "alice",
		Repository: &db.Repository{ID: 1, Name: "demo"},
	}, middleware.PermissionWrite)
	req = req.WithContext(ctx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
	remaining := <-snapshotDeadline
	assert.Greater(t, remaining, 9*time.Minute, "workspace snapshot route must use the 10-minute lifecycle timeout")
}

// TestServerRouter_AgentSessionCRUDRoutesRegistered verifies that all agent session
// CRUD routes are registered when agentSessionHandler is provided to buildRouter.
func TestServerRouter_AgentSessionCRUDRoutesRegistered(t *testing.T) {
	t.Parallel()

	agentSessionHandler := &routes.AgentSessionHandler{
		Service: &mockIntegrationAgentSessionService{},
	}

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
		nil, // agentInternalHandler
		agentSessionHandler,
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

	routesToCheck := []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/api/repos/alice/demo/changes/change-1/conflicts/resolve"},
		{http.MethodPost, "/api/repos/alice/demo/changes/change-1/findings/12/feedback"},
		{http.MethodPost, "/api/repos/alice/demo/changes/change-1/findings/12/dispatch"},
		{http.MethodPost, "/api/repos/alice/demo/agent/sessions"},
		{http.MethodGet, "/api/repos/alice/demo/agent/sessions"},
		{http.MethodGet, "/api/repos/alice/demo/agent/sessions/test-id"},
		{http.MethodDelete, "/api/repos/alice/demo/agent/sessions/test-id"},
		{http.MethodGet, "/api/repos/alice/demo/agent/sessions/test-id/messages"},
		{http.MethodPost, "/api/repos/alice/demo/agent/sessions/test-id/messages"},
	}

	for _, tc := range routesToCheck {
		req := httptest.NewRequest(tc.method, tc.path, nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		assert.NotEqual(t, http.StatusNotFound, rec.Code,
			"%s %s should be registered (got 404)", tc.method, tc.path)
	}
}

// TestServerRouter_AgentSessionStreamRouteRegistered verifies that the agent SSE
// stream route is registered outside the JSON timeout middleware group.
func TestServerRouter_AgentSessionStreamRouteRegistered(t *testing.T) {
	t.Parallel()

	agentSessionStreamHandler := &routes.AgentSessionStreamHandler{
		Service: &mockIntegrationAgentSessionService{},
	}

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
		nil, // agentInternalHandler
		nil, // agentSessionHandler
		agentSessionStreamHandler,
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

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/agent/sessions/test-id/stream", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	assert.NotEqual(t, http.StatusNotFound, rec.Code,
		"agent session SSE stream route must be registered (got 404)")
}

func TestServerRouter_GitHubImportStatusSSEOutsideAPITimeout(t *testing.T) {
	oldTimeout := apiJSONTimeout
	apiJSONTimeout = 25 * time.Millisecond
	t.Cleanup(func() {
		apiJSONTimeout = oldTimeout
	})

	calls := 0
	importHandler := &routes.GitHubImportHandler{Service: &mockIntegrationGitHubImportService{
		getFn: func(ctx context.Context, userID int64, id string) (services.ImportJob, error) {
			assert.Equal(t, int64(7), userID)
			assert.Equal(t, "job-1", id)
			calls++
			status := "cloning"
			if calls > 1 {
				status = "ready"
			}
			return services.ImportJob{ImportJobID: "job-1", RepoOwner: "octo", RepoName: "demo", Status: status}, nil
		},
		startTemplateFn: func(ctx context.Context, input services.ImportTemplateRepoInput) (services.ImportJob, error) {
			assert.Equal(t, int64(7), input.UserID)
			assert.Equal(t, "vite-react", input.TemplateID)
			assert.Equal(t, "my-app", input.Name)
			return services.ImportJob{ImportJobID: "template-job", RepoOwner: "alice", RepoName: "my-app", Status: "cloning"}, nil
		},
		retryFn: func(ctx context.Context, userID int64, id string) (services.ImportJob, error) {
			assert.Equal(t, int64(7), userID)
			assert.Equal(t, "job-1", id)
			return services.ImportJob{ImportJobID: id, RepoOwner: "alice", RepoName: "demo", Status: "cloning", Stage: "importing_refs"}, nil
		},
	}}

	router := buildRouterCompat(
		testConfigAllFlagsOn(),
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
		importHandler,
	)

	req := httptest.NewRequest(http.MethodGet, "/api/github/import/job-1", nil)
	req.Header.Set("Accept", "text/event-stream, application/json")
	req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
		User: &db.User{ID: 7, Username: "alice", LowerUsername: "alice"},
	}))
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Header().Get("Content-Type"), "text/event-stream")
	assert.GreaterOrEqual(t, calls, 2)
	assert.Contains(t, rec.Body.String(), `"status":"cloning"`)
	assert.Contains(t, rec.Body.String(), `"status":"ready"`)

	postReq := httptest.NewRequest(http.MethodPost, "/api/repos/from-template", strings.NewReader(`{"template_id":"vite-react","name":"my-app"}`))
	postReq.Header.Set("Content-Type", "application/json")
	postReq = postReq.WithContext(middleware.ContextWithAuthInfo(postReq.Context(), &middleware.AuthInfo{
		User:        &db.User{ID: 7, Username: "alice", LowerUsername: "alice"},
		IsTokenAuth: true,
		Scopes: middleware.ScopeSet{
			middleware.ScopeWriteRepository: {},
		},
	}))
	postRec := httptest.NewRecorder()
	router.ServeHTTP(postRec, postReq)
	require.Equal(t, http.StatusAccepted, postRec.Code)
	assert.Contains(t, postRec.Body.String(), `"importJobId":"template-job"`)

	retryReq := httptest.NewRequest(http.MethodPost, "/api/github/import/job-1/retry", nil)
	retryReq = retryReq.WithContext(middleware.ContextWithAuthInfo(retryReq.Context(), &middleware.AuthInfo{
		User:        &db.User{ID: 7, Username: "alice", LowerUsername: "alice"},
		IsTokenAuth: true,
		Scopes: middleware.ScopeSet{
			middleware.ScopeWriteRepository: {},
		},
	}))
	retryRec := httptest.NewRecorder()
	router.ServeHTTP(retryRec, retryReq)
	require.Equal(t, http.StatusAccepted, retryRec.Code)
	assert.Contains(t, retryRec.Body.String(), `"stage":"importing_refs"`)
}

// TestServerRouter_WorkspaceSSEStreamRouteRegistered verifies that the workspace
// SSE stream route is registered outside the 30s timeout middleware group.
func TestServerRouter_WorkspaceSSEStreamRouteRegistered(t *testing.T) {
	t.Parallel()

	workspaceHandler := &routes.WorkspaceHandler{
		Service: &mockIntegrationWorkspaceService{},
	}

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
		nil, // agentInternalHandler
		nil, // agentSessionHandler
		nil, // agentSessionStreamHandler
		nil, // pushHookHandler
		nil, // workflowHandler
		workspaceHandler,
		nil, // workspaceInternalHandler
		nil, // workspaceTerminalHandler
		nil, // telemetryHandler
		nil, // featureFlagHandler
		nil, // oauth2Handler
		nil, // smithersMetrics
	)

	// SSE stream requires auth -> 401, not 404.
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workspace/sessions/test-id/stream", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	assert.NotEqual(t, http.StatusNotFound, rec.Code,
		"workspace session SSE stream route must be registered (got 404 -- check that it is outside the timeout group)")

	req = httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workspaces/test-id/stream", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	assert.NotEqual(t, http.StatusNotFound, rec.Code,
		"workspace SSE stream route must be registered (got 404 -- check that it is outside the timeout group)")
}

// TestServerRouter_WorkspaceSSEStreamPreflightIncludesCORSHeaders verifies that
// the workspace SSE stream route handles CORS preflight correctly.
func TestServerRouter_WorkspaceSSEStreamPreflightIncludesCORSHeaders(t *testing.T) {
	t.Parallel()

	workspaceHandler := &routes.WorkspaceHandler{
		Service: &mockIntegrationWorkspaceService{},
	}

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
		nil, // agentInternalHandler
		nil, // agentSessionHandler
		nil, // agentSessionStreamHandler
		nil, // pushHookHandler
		nil, // workflowHandler
		workspaceHandler,
		nil, // workspaceInternalHandler
		nil, // workspaceTerminalHandler
		nil, // telemetryHandler
		nil, // featureFlagHandler
		nil, // oauth2Handler
		nil, // smithersMetrics
	)

	req := httptest.NewRequest(http.MethodOptions, "/api/repos/alice/demo/workspace/sessions/test-id/stream", nil)
	req.Header.Set("Origin", "https://example.com")
	req.Header.Set("Access-Control-Request-Method", http.MethodGet)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	assert.NotEqual(t, http.StatusNotFound, rec.Code,
		"workspace SSE stream route should handle CORS preflight")
	assert.Equal(t, "https://example.com", rec.Header().Get("Access-Control-Allow-Origin"),
		"preflight should include the configured CORS origin header")
	assert.NotEmpty(t, rec.Header().Get("Access-Control-Allow-Methods"),
		"preflight should include allowed methods")

	req = httptest.NewRequest(http.MethodOptions, "/api/repos/alice/demo/workspaces/test-id/stream", nil)
	req.Header.Set("Origin", "https://example.com")
	req.Header.Set("Access-Control-Request-Method", http.MethodGet)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	assert.NotEqual(t, http.StatusNotFound, rec.Code,
		"public workspace SSE stream route should handle CORS preflight")
	assert.Equal(t, "https://example.com", rec.Header().Get("Access-Control-Allow-Origin"),
		"preflight should include the configured CORS origin header")
	assert.NotEmpty(t, rec.Header().Get("Access-Control-Allow-Methods"),
		"preflight should include allowed methods")
}

// TestServerRouter_WorkspaceInternalRoutesRegistered verifies that internal
// workspace callback routes are registered.
func TestServerRouter_WorkspaceInternalRoutesRegistered(t *testing.T) {
	t.Parallel()

	workspaceInternalHandler := &routes.WorkspaceInternalHandler{
		Service: &mockIntegrationWorkspaceInternalService{},
	}

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
		nil, // agentInternalHandler
		nil, // agentSessionHandler
		nil, // agentSessionStreamHandler
		nil, // pushHookHandler
		nil, // workflowHandler
		nil, // workspaceHandler
		workspaceInternalHandler,
		nil, // workspaceTerminalHandler
		nil, // telemetryHandler
		nil, // featureFlagHandler
		nil, // oauth2Handler
		nil, // smithersMetrics
	)

	internalRoutes := []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/internal/workspace/test-workspace-id/status"},
		{http.MethodPost, "/internal/workspace/test-workspace-id/head"},
	}

	for _, tc := range internalRoutes {
		req := httptest.NewRequest(tc.method, tc.path, nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		assert.NotEqual(t, http.StatusNotFound, rec.Code,
			"%s %s should be registered (got 404)", tc.method, tc.path)
	}
}

// TestServerRouter_WorkflowRunLogsSSEPreflightWithRealWorkflowAPIService verifies that
// the /api/repos/{owner}/{repo}/runs/{id}/logs route is mounted when the router is built
// with a real services.WorkflowAPIService (not a mock). This is the integration-style
// regression test for the silent route-missing bug caused by a runtime type assertion.
//
// Before the fix, WorkflowAPIService lacked ListWorkflowSteps and ListWorkflowLogsSince,
// so the type assertion `workflowHandler.Service.(routes.WorkflowRunRouteService)` failed
// and the route was never registered.
func TestServerRouter_WorkflowRunLogsSSEPreflightWithRealWorkflowAPIService(t *testing.T) {
	t.Parallel()

	// Build a real WorkflowAPIService (production constructor) backed by stub querier.
	realWorkflowAPIService := services.NewWorkflowAPIService(
		&mockIntegrationWorkflowQuerier{},
		&mockIntegrationWorkflowRunService{},
	)
	workflowHandler := &routes.WorkflowHandler{Service: realWorkflowAPIService}

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
		nil, // agentInternalHandler
		nil, // agentSessionHandler
		nil, // agentSessionStreamHandler
		nil, // pushHookHandler
		workflowHandler,
		nil, // workspaceHandler
		nil, // workspaceInternalHandler
		nil, // workspaceTerminalHandler
		nil, // telemetryHandler
		nil, // featureFlagHandler
		nil, // oauth2Handler
		nil, // smithersMetrics
	)

	// Send an OPTIONS preflight to the SSE logs endpoint.
	// A 404 would indicate the route was never registered (the old broken behavior).
	// Any other status (200, 401, 403, 500) proves the route IS registered.
	req := httptest.NewRequest(http.MethodOptions, "/api/repos/alice/demo/runs/1/logs", nil)
	req.Header.Set("Origin", "https://example.com")
	req.Header.Set("Access-Control-Request-Method", http.MethodGet)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	assert.NotEqual(t, http.StatusNotFound, rec.Code,
		"/api/repos/{owner}/{repo}/runs/{id}/logs must be registered when using real WorkflowAPIService — "+
			"a 404 means the route was silently dropped (runtime type assertion failure)")
	assert.Equal(t, "https://example.com", rec.Header().Get("Access-Control-Allow-Origin"),
		"SSE logs route must include the configured CORS origin when using real WorkflowAPIService")
}

func (m *mockIntegrationAgentSessionService) GetAgentMessageStreamHead(context.Context, string) (int64, error) {
	return 0, nil
}
