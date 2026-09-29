package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type mockWorkspaceRouteService struct {
	createWorkspaceFn         func(ctx context.Context, input services.CreateWorkspaceInput) (services.WorkspaceResponse, error)
	getWorkspaceFn            func(ctx context.Context, workspaceID string, repositoryID, userID int64) (services.WorkspaceResponse, error)
	listWorkspacesFn          func(ctx context.Context, repositoryID, userID int64, page, perPage int) ([]services.WorkspaceResponse, int64, error)
	getWorkspaceSSHFn         func(ctx context.Context, workspaceID string, repositoryID, userID int64) (services.WorkspaceSSHConnectionInfo, error)
	suspendWorkspaceFn        func(ctx context.Context, workspaceID string, repositoryID, userID int64) (services.WorkspaceResponse, error)
	resumeWorkspaceFn         func(ctx context.Context, workspaceID string, repositoryID, userID int64) (services.WorkspaceResponse, error)
	deleteWorkspaceFn         func(ctx context.Context, workspaceID string, repositoryID, userID int64) error
	forkWorkspaceFn           func(ctx context.Context, input services.ForkWorkspaceInput) (services.WorkspaceResponse, error)
	createWorkspaceSnapshotFn func(ctx context.Context, input services.CreateWorkspaceSnapshotInput) (services.WorkspaceSnapshotResponse, error)
	getWorkspaceSnapshotFn    func(ctx context.Context, snapshotID string, repositoryID, userID int64) (services.WorkspaceSnapshotResponse, error)
	listWorkspaceSnapshotsFn  func(ctx context.Context, repositoryID, userID int64, page, perPage int) ([]services.WorkspaceSnapshotResponse, int64, error)
	deleteWorkspaceSnapshotFn func(ctx context.Context, snapshotID string, repositoryID, userID int64) error
	createSessionFn           func(ctx context.Context, input services.CreateWorkspaceSessionInput) (services.WorkspaceSessionResponse, error)
	getSessionFn              func(ctx context.Context, sessionID string, repositoryID, userID int64) (services.WorkspaceSessionResponse, error)
	listSessionsFn            func(ctx context.Context, repositoryID, userID int64, page, perPage int) ([]services.WorkspaceSessionResponse, int64, error)
	getSSHConnectionInfoFn    func(ctx context.Context, sessionID string, repositoryID, userID int64) (services.WorkspaceSSHConnectionInfo, error)
	destroySessionFn          func(ctx context.Context, sessionID string, repositoryID, userID int64) error
	listUserWorkspacesFn      func(ctx context.Context, userID int64, page, perPage int) (services.UserWorkspaceListResult, error)
	listWorkspaceFilesFn      func(ctx context.Context, workspaceID string, repositoryID, userID int64, path string) ([]services.WorkspaceFileEntry, error)
	readWorkspaceFileFn       func(ctx context.Context, workspaceID string, repositoryID, userID int64, path string) (services.WorkspaceFileContent, error)
	writeWorkspaceFileFn      func(ctx context.Context, workspaceID string, repositoryID, userID int64, path, content string) (services.WorkspaceFileContent, error)
	listWorkspaceServicesFn   func(ctx context.Context, workspaceID string, repositoryID, userID int64) ([]services.WorkspaceManagedService, error)
	manageWorkspaceServiceFn  func(ctx context.Context, workspaceID string, repositoryID, userID int64, serviceName, action string) (services.WorkspaceManagedService, error)
}

type mockAsyncWorkspaceRouteService struct {
	mockWorkspaceRouteService
	createWorkspaceAsyncFn func(ctx context.Context, input services.CreateWorkspaceInput) (services.WorkspaceResponse, error)
}

func (m *mockAsyncWorkspaceRouteService) CreateWorkspaceAsync(ctx context.Context, input services.CreateWorkspaceInput) (services.WorkspaceResponse, error) {
	if m.createWorkspaceAsyncFn != nil {
		return m.createWorkspaceAsyncFn(ctx, input)
	}
	return services.WorkspaceResponse{}, nil
}

func (m *mockWorkspaceRouteService) ListUserWorkspacesAcrossRepos(ctx context.Context, userID int64, page, perPage int) (services.UserWorkspaceListResult, error) {
	if m.listUserWorkspacesFn != nil {
		return m.listUserWorkspacesFn(ctx, userID, page, perPage)
	}
	return services.UserWorkspaceListResult{}, nil
}

func (m *mockWorkspaceRouteService) ListWorkspaceFiles(ctx context.Context, workspaceID string, repositoryID, userID int64, path string) ([]services.WorkspaceFileEntry, error) {
	if m.listWorkspaceFilesFn != nil {
		return m.listWorkspaceFilesFn(ctx, workspaceID, repositoryID, userID, path)
	}
	return nil, nil
}

func (m *mockWorkspaceRouteService) ReadWorkspaceFile(ctx context.Context, workspaceID string, repositoryID, userID int64, path string) (services.WorkspaceFileContent, error) {
	if m.readWorkspaceFileFn != nil {
		return m.readWorkspaceFileFn(ctx, workspaceID, repositoryID, userID, path)
	}
	return services.WorkspaceFileContent{}, nil
}

func (m *mockWorkspaceRouteService) WriteWorkspaceFile(ctx context.Context, workspaceID string, repositoryID, userID int64, path, content string) (services.WorkspaceFileContent, error) {
	if m.writeWorkspaceFileFn != nil {
		return m.writeWorkspaceFileFn(ctx, workspaceID, repositoryID, userID, path, content)
	}
	return services.WorkspaceFileContent{}, nil
}

func (m *mockWorkspaceRouteService) ListWorkspaceServices(ctx context.Context, workspaceID string, repositoryID, userID int64) ([]services.WorkspaceManagedService, error) {
	if m.listWorkspaceServicesFn != nil {
		return m.listWorkspaceServicesFn(ctx, workspaceID, repositoryID, userID)
	}
	return nil, nil
}

func (m *mockWorkspaceRouteService) ManageWorkspaceService(ctx context.Context, workspaceID string, repositoryID, userID int64, serviceName, action string) (services.WorkspaceManagedService, error) {
	if m.manageWorkspaceServiceFn != nil {
		return m.manageWorkspaceServiceFn(ctx, workspaceID, repositoryID, userID, serviceName, action)
	}
	return services.WorkspaceManagedService{}, nil
}

func (m *mockWorkspaceRouteService) CreateWorkspace(ctx context.Context, input services.CreateWorkspaceInput) (services.WorkspaceResponse, error) {
	if m.createWorkspaceFn != nil {
		return m.createWorkspaceFn(ctx, input)
	}
	return services.WorkspaceResponse{}, nil
}

func (m *mockWorkspaceRouteService) GetWorkspace(ctx context.Context, workspaceID string, repositoryID, userID int64) (services.WorkspaceResponse, error) {
	if m.getWorkspaceFn != nil {
		return m.getWorkspaceFn(ctx, workspaceID, repositoryID, userID)
	}
	return services.WorkspaceResponse{}, nil
}

func (m *mockWorkspaceRouteService) ListWorkspaces(ctx context.Context, repositoryID, userID int64, page, perPage int) ([]services.WorkspaceResponse, int64, error) {
	if m.listWorkspacesFn != nil {
		return m.listWorkspacesFn(ctx, repositoryID, userID, page, perPage)
	}
	return nil, 0, nil
}

func (m *mockWorkspaceRouteService) GetWorkspaceSSHConnectionInfo(ctx context.Context, workspaceID string, repositoryID, userID int64) (services.WorkspaceSSHConnectionInfo, error) {
	if m.getWorkspaceSSHFn != nil {
		return m.getWorkspaceSSHFn(ctx, workspaceID, repositoryID, userID)
	}
	return services.WorkspaceSSHConnectionInfo{}, nil
}

func (m *mockWorkspaceRouteService) SuspendWorkspace(ctx context.Context, workspaceID string, repositoryID, userID int64) (services.WorkspaceResponse, error) {
	if m.suspendWorkspaceFn != nil {
		return m.suspendWorkspaceFn(ctx, workspaceID, repositoryID, userID)
	}
	return services.WorkspaceResponse{}, nil
}

func (m *mockWorkspaceRouteService) ResumeWorkspace(ctx context.Context, workspaceID string, repositoryID, userID int64) (services.WorkspaceResponse, error) {
	if m.resumeWorkspaceFn != nil {
		return m.resumeWorkspaceFn(ctx, workspaceID, repositoryID, userID)
	}
	return services.WorkspaceResponse{}, nil
}

func (m *mockWorkspaceRouteService) DeleteWorkspace(ctx context.Context, workspaceID string, repositoryID, userID int64) error {
	if m.deleteWorkspaceFn != nil {
		return m.deleteWorkspaceFn(ctx, workspaceID, repositoryID, userID)
	}
	return nil
}

func (m *mockWorkspaceRouteService) ForkWorkspace(ctx context.Context, input services.ForkWorkspaceInput) (services.WorkspaceResponse, error) {
	if m.forkWorkspaceFn != nil {
		return m.forkWorkspaceFn(ctx, input)
	}
	return services.WorkspaceResponse{}, nil
}

func (m *mockWorkspaceRouteService) CreateWorkspaceSnapshot(ctx context.Context, input services.CreateWorkspaceSnapshotInput) (services.WorkspaceSnapshotResponse, error) {
	if m.createWorkspaceSnapshotFn != nil {
		return m.createWorkspaceSnapshotFn(ctx, input)
	}
	return services.WorkspaceSnapshotResponse{}, nil
}

func (m *mockWorkspaceRouteService) GetWorkspaceSnapshot(ctx context.Context, snapshotID string, repositoryID, userID int64) (services.WorkspaceSnapshotResponse, error) {
	if m.getWorkspaceSnapshotFn != nil {
		return m.getWorkspaceSnapshotFn(ctx, snapshotID, repositoryID, userID)
	}
	return services.WorkspaceSnapshotResponse{}, nil
}

func (m *mockWorkspaceRouteService) ListWorkspaceSnapshots(ctx context.Context, repositoryID, userID int64, page, perPage int) ([]services.WorkspaceSnapshotResponse, int64, error) {
	if m.listWorkspaceSnapshotsFn != nil {
		return m.listWorkspaceSnapshotsFn(ctx, repositoryID, userID, page, perPage)
	}
	return nil, 0, nil
}

func (m *mockWorkspaceRouteService) DeleteWorkspaceSnapshot(ctx context.Context, snapshotID string, repositoryID, userID int64) error {
	if m.deleteWorkspaceSnapshotFn != nil {
		return m.deleteWorkspaceSnapshotFn(ctx, snapshotID, repositoryID, userID)
	}
	return nil
}

func (m *mockWorkspaceRouteService) CreateSession(ctx context.Context, input services.CreateWorkspaceSessionInput) (services.WorkspaceSessionResponse, error) {
	if m.createSessionFn != nil {
		return m.createSessionFn(ctx, input)
	}
	return services.WorkspaceSessionResponse{}, nil
}

func (m *mockWorkspaceRouteService) GetSession(ctx context.Context, sessionID string, repositoryID, userID int64) (services.WorkspaceSessionResponse, error) {
	if m.getSessionFn != nil {
		return m.getSessionFn(ctx, sessionID, repositoryID, userID)
	}
	return services.WorkspaceSessionResponse{}, nil
}

func (m *mockWorkspaceRouteService) ListSessions(ctx context.Context, repositoryID, userID int64, page, perPage int) ([]services.WorkspaceSessionResponse, int64, error) {
	if m.listSessionsFn != nil {
		return m.listSessionsFn(ctx, repositoryID, userID, page, perPage)
	}
	return nil, 0, nil
}

func (m *mockWorkspaceRouteService) GetSSHConnectionInfo(ctx context.Context, sessionID string, repositoryID, userID int64) (services.WorkspaceSSHConnectionInfo, error) {
	if m.getSSHConnectionInfoFn != nil {
		return m.getSSHConnectionInfoFn(ctx, sessionID, repositoryID, userID)
	}
	return services.WorkspaceSSHConnectionInfo{}, nil
}

func (m *mockWorkspaceRouteService) DestroySession(ctx context.Context, sessionID string, repositoryID, userID int64) error {
	if m.destroySessionFn != nil {
		return m.destroySessionFn(ctx, sessionID, repositoryID, userID)
	}
	return nil
}

func withWorkspaceRepoCtx(req *http.Request, owner, repo string) *http.Request {
	repository := &db.Repository{ID: 200, Name: repo, LowerName: repo}
	ctx := middleware.ContextWithRepoContext(req.Context(), &middleware.RepoContext{
		Owner:      owner,
		Repository: repository,
	}, middleware.PermissionWrite)
	return req.WithContext(ctx)
}

func TestWorkspaceHandler_CreateWorkspace_RequiresAuth(t *testing.T) {
	t.Parallel()

	h := &WorkspaceHandler{Service: &mockWorkspaceRouteService{}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workspaces", strings.NewReader(`{"name":"dev"}`))
	req.Header.Set("Content-Type", "application/json")
	req = withWorkspaceRepoCtx(req, "alice", "demo")
	rec := httptest.NewRecorder()
	h.CreateWorkspace(rec, req)

	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestWorkspaceHandler_CreateWorkspace_RequiresRepoContext(t *testing.T) {
	t.Parallel()

	h := &WorkspaceHandler{Service: &mockWorkspaceRouteService{}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workspaces", strings.NewReader(`{"name":"dev"}`))
	req.Header.Set("Content-Type", "application/json")
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.CreateWorkspace(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestWorkspaceHandler_CreateWorkspace_Success(t *testing.T) {
	t.Parallel()

	h := &WorkspaceHandler{Service: &mockWorkspaceRouteService{
		createWorkspaceFn: func(ctx context.Context, input services.CreateWorkspaceInput) (services.WorkspaceResponse, error) {
			assert.Equal(t, int64(200), input.RepositoryID)
			assert.Equal(t, int64(1), input.UserID)
			assert.Equal(t, "dev-ws", input.Name)
			assert.Equal(t, "vm", input.Kind)
			assert.Equal(t, ".smithers/environment.nix", input.Environment.Source)
			assert.Equal(t, "b775d9", input.Environment.Revision)
			assert.Equal(t, "sha256-closure", input.Environment.ClosureHash)
			assert.Empty(t, input.SourceBookmark, "the service resolves an omitted repository default")
			return services.WorkspaceResponse{ID: "ws-1", Name: "dev-ws", Status: "creating", TargetBookmark: "trunk"}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workspaces", strings.NewReader(`{"name":"dev-ws","kind":"vm","environment":{"source":".smithers/environment.nix","revision":"b775d9","closure_hash":"sha256-closure"}}`))
	req.Header.Set("Content-Type", "application/json")
	req = withWorkspaceRepoCtx(req, "alice", "demo")
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.CreateWorkspace(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
	var ws services.WorkspaceResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ws))
	assert.Equal(t, "ws-1", ws.ID)
	assert.Equal(t, "trunk", ws.TargetBookmark)
}

func TestWorkspaceHandler_CreateWorkspace_PassesSourceBookmark(t *testing.T) {
	service := &mockWorkspaceRouteService{
		createWorkspaceFn: func(ctx context.Context, input services.CreateWorkspaceInput) (services.WorkspaceResponse, error) {
			assert.Equal(t, "landing/demo-123", input.SourceBookmark)
			return services.WorkspaceResponse{ID: "ws-1", Name: "dev-ws", Status: "starting"}, nil
		},
	}
	handler := &WorkspaceHandler{Service: service}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workspaces", strings.NewReader(`{"name":"dev-ws","source_bookmark":"landing/demo-123"}`))
	req.Header.Set("Content-Type", "application/json")
	req = withWorkspaceRepoCtx(req, "alice", "demo")
	req = withAuth(req, 7, "alice")
	rec := httptest.NewRecorder()

	handler.CreateWorkspace(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
}

func TestWorkspaceHandler_CreateWorkspace_ResponseUsesDesktopKind(t *testing.T) {
	t.Parallel()

	handler := &WorkspaceHandler{Service: &mockWorkspaceRouteService{
		createWorkspaceFn: func(_ context.Context, input services.CreateWorkspaceInput) (services.WorkspaceResponse, error) {
			require.Equal(t, "desktop", input.Kind)
			return services.WorkspaceResponse{ID: "ws-desktop", Name: input.Name, Status: "starting", Kind: input.Kind}, nil
		},
	}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workspaces", strings.NewReader(`{"name":"proof-desktop","kind":"desktop"}`))
	req.Header.Set("Content-Type", "application/json")
	req = withWorkspaceRepoCtx(req, "alice", "demo")
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()

	handler.CreateWorkspace(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
	var workspace services.WorkspaceResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &workspace))
	assert.Equal(t, "ws-desktop", workspace.ID)
	assert.Equal(t, "desktop", workspace.Kind)
}

func TestWorkspaceHandler_CreateWorkspace_UsesAsyncProvisionerWhenAvailable(t *testing.T) {
	service := &mockAsyncWorkspaceRouteService{
		createWorkspaceAsyncFn: func(ctx context.Context, input services.CreateWorkspaceInput) (services.WorkspaceResponse, error) {
			assert.Equal(t, "landing/demo-123", input.SourceBookmark)
			assert.Equal(t, "desktop", input.Kind)
			return services.WorkspaceResponse{
				ID:             "ws-async",
				Name:           "dev-ws",
				Status:         "starting",
				TargetBookmark: "landing/demo-123",
				Kind:           input.Kind,
			}, nil
		},
	}
	handler := &WorkspaceHandler{Service: service}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workspaces", strings.NewReader(`{"name":"dev-ws","source_bookmark":"landing/demo-123","kind":"desktop"}`))
	req.Header.Set("Content-Type", "application/json")
	req = withWorkspaceRepoCtx(req, "alice", "demo")
	req = withAuth(req, 7, "alice")
	rec := httptest.NewRecorder()

	handler.CreateWorkspace(rec, req)

	require.Equal(t, http.StatusAccepted, rec.Code)
	var ws services.WorkspaceResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ws))
	assert.Equal(t, "ws-async", ws.ID)
	assert.Equal(t, "landing/demo-123", ws.TargetBookmark)
	assert.Equal(t, "desktop", ws.Kind)
}

func TestWorkspaceHandler_GetWorkspace_Success(t *testing.T) {
	t.Parallel()

	h := &WorkspaceHandler{Service: &mockWorkspaceRouteService{
		getWorkspaceFn: func(ctx context.Context, workspaceID string, repositoryID, userID int64) (services.WorkspaceResponse, error) {
			assert.Equal(t, "ws-1", workspaceID)
			return services.WorkspaceResponse{ID: "ws-1", Status: "running"}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workspaces/ws-1", nil)
	req = withRouteParams(req, map[string]string{"id": "ws-1"})
	req = withWorkspaceRepoCtx(req, "alice", "demo")
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.GetWorkspace(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
}

func TestWorkspaceHandler_ListWorkspaceFiles(t *testing.T) {
	t.Parallel()
	h := &WorkspaceHandler{Service: &mockWorkspaceRouteService{listWorkspaceFilesFn: func(_ context.Context, workspaceID string, repositoryID, userID int64, filePath string) ([]services.WorkspaceFileEntry, error) {
		assert.Equal(t, "ws-1", workspaceID)
		assert.Equal(t, int64(200), repositoryID)
		assert.Equal(t, int64(7), userID)
		assert.Equal(t, "src/pkg", filePath)
		return []services.WorkspaceFileEntry{{Name: "main.go", Path: "src/pkg/main.go", Type: "file", Size: 12}}, nil
	}}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workspaces/ws-1/files?path=src%2Fpkg", nil)
	req = withRouteParams(req, map[string]string{"id": "ws-1"})
	req = withWorkspaceRepoCtx(req, "alice", "demo")
	req = withAuth(req, 7, "alice")
	rec := httptest.NewRecorder()

	h.ListWorkspaceFiles(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var entries []services.WorkspaceFileEntry
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &entries))
	assert.Equal(t, "src/pkg/main.go", entries[0].Path)
}

func TestWorkspaceHandler_ReadAndWriteWorkspaceFile(t *testing.T) {
	t.Parallel()
	service := &mockWorkspaceRouteService{
		readWorkspaceFileFn: func(_ context.Context, workspaceID string, repositoryID, userID int64, filePath string) (services.WorkspaceFileContent, error) {
			assert.Equal(t, "README.md", filePath)
			return services.WorkspaceFileContent{Name: "README.md", Path: filePath, Type: "file", Encoding: "utf-8", Content: "old", Size: 3}, nil
		},
		writeWorkspaceFileFn: func(_ context.Context, workspaceID string, repositoryID, userID int64, filePath, content string) (services.WorkspaceFileContent, error) {
			assert.Equal(t, "ws-1", workspaceID)
			assert.Equal(t, int64(200), repositoryID)
			assert.Equal(t, int64(7), userID)
			assert.Equal(t, "README.md", filePath)
			assert.Equal(t, "new", content)
			return services.WorkspaceFileContent{Name: "README.md", Path: filePath, Type: "file", Encoding: "utf-8", Content: content, Size: 3}, nil
		},
	}
	h := &WorkspaceHandler{Service: service}

	readReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workspaces/ws-1/files/content?path=README.md", nil)
	readReq = withRouteParams(readReq, map[string]string{"id": "ws-1"})
	readReq = withWorkspaceRepoCtx(readReq, "alice", "demo")
	readReq = withAuth(readReq, 7, "alice")
	readRec := httptest.NewRecorder()
	h.ReadWorkspaceFile(readRec, readReq)
	require.Equal(t, http.StatusOK, readRec.Code)

	writeReq := httptest.NewRequest(http.MethodPut, "/api/repos/alice/demo/workspaces/ws-1/files/content?path=README.md", strings.NewReader(`{"content":"new"}`))
	writeReq = withRouteParams(writeReq, map[string]string{"id": "ws-1"})
	writeReq = withWorkspaceRepoCtx(writeReq, "alice", "demo")
	writeReq = withAuth(writeReq, 7, "alice")
	writeRec := httptest.NewRecorder()
	h.WriteWorkspaceFile(writeRec, writeReq)
	require.Equal(t, http.StatusOK, writeRec.Code)
	var result services.WorkspaceFileContent
	require.NoError(t, json.Unmarshal(writeRec.Body.Bytes(), &result))
	assert.Equal(t, "new", result.Content)
}

func TestWorkspaceHandler_WorkspaceServices(t *testing.T) {
	t.Parallel()
	service := &mockWorkspaceRouteService{
		listWorkspaceServicesFn: func(_ context.Context, workspaceID string, repositoryID, userID int64) ([]services.WorkspaceManagedService, error) {
			return []services.WorkspaceManagedService{
				{Name: "database", State: "stopped"},
				{Name: "web", State: "running", Port: 3000, URL: "https://3000-ws-1.preview.jjhub.tech"},
			}, nil
		},
		manageWorkspaceServiceFn: func(_ context.Context, workspaceID string, repositoryID, userID int64, serviceName, action string) (services.WorkspaceManagedService, error) {
			assert.Equal(t, "ws-1", workspaceID)
			assert.Equal(t, int64(200), repositoryID)
			assert.Equal(t, int64(7), userID)
			assert.Equal(t, "web", serviceName)
			assert.Equal(t, "restart", action)
			return services.WorkspaceManagedService{Name: serviceName, State: "running"}, nil
		},
	}
	h := &WorkspaceHandler{Service: service}

	listReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workspaces/ws-1/services", nil)
	listReq = withRouteParams(listReq, map[string]string{"id": "ws-1"})
	listReq = withWorkspaceRepoCtx(listReq, "alice", "demo")
	listReq = withAuth(listReq, 7, "alice")
	listRec := httptest.NewRecorder()
	h.ListWorkspaceServices(listRec, listReq)
	require.Equal(t, http.StatusOK, listRec.Code)
	assert.JSONEq(t, `[
		{"name":"database","state":"stopped"},
		{"name":"web","state":"running","port":3000,"url":"https://example.com/api/repos/alice/demo/workspaces/ws-1/preview/3000"}
	]`, listRec.Body.String())

	actionReq := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workspaces/ws-1/services/web/restart", nil)
	actionReq = withRouteParams(actionReq, map[string]string{"id": "ws-1", "name": "web", "action": "restart"})
	actionReq = withWorkspaceRepoCtx(actionReq, "alice", "demo")
	actionReq = withAuth(actionReq, 7, "alice")
	actionRec := httptest.NewRecorder()
	h.ManageWorkspaceService(actionRec, actionReq)
	require.Equal(t, http.StatusOK, actionRec.Code)
}

func TestWorkspaceHandler_WorkspaceFacetValidationErrors(t *testing.T) {
	t.Parallel()
	h := &WorkspaceHandler{Service: &mockWorkspaceRouteService{}}

	unauthorized := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workspaces/ws-1/files", nil)
	unauthorized = withRouteParams(unauthorized, map[string]string{"id": "ws-1"})
	unauthorized = withWorkspaceRepoCtx(unauthorized, "alice", "demo")
	unauthorizedRec := httptest.NewRecorder()
	h.ListWorkspaceFiles(unauthorizedRec, unauthorized)
	assert.Equal(t, http.StatusUnauthorized, unauthorizedRec.Code)

	invalidBody := httptest.NewRequest(http.MethodPut, "/api/repos/alice/demo/workspaces/ws-1/files/content?path=a", strings.NewReader("{"))
	invalidBody = withRouteParams(invalidBody, map[string]string{"id": "ws-1"})
	invalidBody = withWorkspaceRepoCtx(invalidBody, "alice", "demo")
	invalidBody = withAuth(invalidBody, 1, "alice")
	invalidBodyRec := httptest.NewRecorder()
	h.WriteWorkspaceFile(invalidBodyRec, invalidBody)
	assert.Equal(t, http.StatusBadRequest, invalidBodyRec.Code)
}

func TestWorkspaceHandler_SuspendWorkspace_Success(t *testing.T) {
	t.Parallel()

	h := &WorkspaceHandler{Service: &mockWorkspaceRouteService{
		suspendWorkspaceFn: func(ctx context.Context, workspaceID string, repositoryID, userID int64) (services.WorkspaceResponse, error) {
			assert.Equal(t, "ws-1", workspaceID)
			return services.WorkspaceResponse{ID: "ws-1", Status: "suspended"}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workspaces/ws-1/suspend", nil)
	req = withRouteParams(req, map[string]string{"id": "ws-1"})
	req = withWorkspaceRepoCtx(req, "alice", "demo")
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.SuspendWorkspace(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var ws services.WorkspaceResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ws))
	assert.Equal(t, "suspended", ws.Status)
}

func TestWorkspaceHandler_DeleteWorkspace_Success(t *testing.T) {
	t.Parallel()

	h := &WorkspaceHandler{Service: &mockWorkspaceRouteService{
		deleteWorkspaceFn: func(ctx context.Context, workspaceID string, repositoryID, userID int64) error {
			assert.Equal(t, "ws-1", workspaceID)
			return nil
		},
	}}

	req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/workspaces/ws-1", nil)
	req = withRouteParams(req, map[string]string{"id": "ws-1"})
	req = withWorkspaceRepoCtx(req, "alice", "demo")
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.DeleteWorkspace(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
}

func TestWorkspaceHandler_DeleteWorkspace_ServiceError(t *testing.T) {
	t.Parallel()

	h := &WorkspaceHandler{Service: &mockWorkspaceRouteService{
		deleteWorkspaceFn: func(ctx context.Context, workspaceID string, repositoryID, userID int64) error {
			return pkgerrors.NotFound("workspace not found")
		},
	}}

	req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/workspaces/ws-gone", nil)
	req = withRouteParams(req, map[string]string{"id": "ws-gone"})
	req = withWorkspaceRepoCtx(req, "alice", "demo")
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.DeleteWorkspace(rec, req)

	require.Equal(t, http.StatusNotFound, rec.Code)
}

func TestWorkspaceHandler_OffsetListsEmitCursorLinks(t *testing.T) {
	t.Parallel()

	h := &WorkspaceHandler{Service: &mockWorkspaceRouteService{
		listWorkspaceSnapshotsFn: func(_ context.Context, _, _ int64, page, perPage int) ([]services.WorkspaceSnapshotResponse, int64, error) {
			assert.Equal(t, 2, page)
			assert.Equal(t, 2, perPage)
			return []services.WorkspaceSnapshotResponse{{ID: "snap-3"}, {ID: "snap-2"}}, 5, nil
		},
		listSessionsFn: func(_ context.Context, _, _ int64, page, perPage int) ([]services.WorkspaceSessionResponse, int64, error) {
			assert.Equal(t, 2, page)
			assert.Equal(t, 2, perPage)
			return []services.WorkspaceSessionResponse{{ID: "sess-3"}, {ID: "sess-2"}}, 5, nil
		},
	}}

	tests := []struct {
		name    string
		path    string
		handler func(http.ResponseWriter, *http.Request)
	}{
		{
			name:    "workspace snapshots",
			path:    "/api/repos/alice/demo/workspace-snapshots?cursor=2&limit=2",
			handler: h.ListWorkspaceSnapshots,
		},
		{
			name:    "workspace sessions",
			path:    "/api/repos/alice/demo/workspace/sessions?cursor=2&limit=2",
			handler: h.ListSessions,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tt.path, nil)
			req = withWorkspaceRepoCtx(req, "alice", "demo")
			req = withAuth(req, 1, "alice")
			rec := httptest.NewRecorder()

			tt.handler(rec, req)

			require.Equal(t, http.StatusOK, rec.Code)
			link := rec.Header().Get("Link")
			assert.Contains(t, link, `rel="prev"`)
			assert.Contains(t, link, `rel="next"`)
			assert.Contains(t, link, "cursor=4")
			assert.Contains(t, link, "limit=2")
			assert.NotContains(t, link, "page=")
			assert.NotContains(t, link, "per_page=")
			assert.Equal(t, "5", rec.Header().Get("X-Total-Count"))
			assert.Equal(t, "2", rec.Header().Get("X-Per-Page"))
		})
	}
}

// Ticket 0105: the 101st POST /api/repos/{owner}/{repo}/workspaces must
// surface the service's quota_exceeded as a structured 429 error body.
// This test pretends the service has already counted and rejected; the
// HTTP handler's job is to translate it into the right wire format.
func TestWorkspaceHandler_CreateWorkspace_QuotaExceededReturns429(t *testing.T) {
	t.Parallel()

	h := &WorkspaceHandler{Service: &mockWorkspaceRouteService{
		createWorkspaceFn: func(ctx context.Context, input services.CreateWorkspaceInput) (services.WorkspaceResponse, error) {
			return services.WorkspaceResponse{}, pkgerrors.QuotaExceeded(
				"sandbox limit reached: 100 of 100 workspaces in use — delete one to continue",
			)
		},
	}}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workspaces", strings.NewReader(`{"name":"dev-101"}`))
	req.Header.Set("Content-Type", "application/json")
	req = withWorkspaceRepoCtx(req, "alice", "demo")
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.CreateWorkspace(rec, req)

	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))

	var body struct {
		Message string         `json:"message"`
		Code    pkgerrors.Code `json:"code"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, pkgerrors.CodeQuotaExceeded, body.Code, "error body must carry a stable machine-readable code")
	assert.Contains(t, body.Message, "sandbox limit")
	assert.Contains(t, body.Message, "delete one to continue", "message is what the client renders to the user")
}

// Fork route at the cap — same 429 contract.
func TestWorkspaceHandler_ForkWorkspace_QuotaExceededReturns429(t *testing.T) {
	t.Parallel()

	h := &WorkspaceHandler{Service: &mockWorkspaceRouteService{
		forkWorkspaceFn: func(ctx context.Context, input services.ForkWorkspaceInput) (services.WorkspaceResponse, error) {
			return services.WorkspaceResponse{}, pkgerrors.QuotaExceeded(
				"sandbox limit reached: 100 of 100 workspaces in use — delete one to continue",
			)
		},
	}}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workspaces/ws-1/fork", strings.NewReader(`{"name":"forked"}`))
	req.Header.Set("Content-Type", "application/json")
	req = withRouteParams(req, map[string]string{"id": "ws-1"})
	req = withWorkspaceRepoCtx(req, "alice", "demo")
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.ForkWorkspace(rec, req)

	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	var body struct {
		Message string         `json:"message"`
		Code    pkgerrors.Code `json:"code"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, pkgerrors.CodeQuotaExceeded, body.Code)
}

// Ticket 0130: the /workspaces/{id}/ssh route must surface the
// gateway's pinned host-key material so the terminal client can verify
// the server before sending credentials. This test asserts the field is
// wired through the JSON response untouched.
func TestWorkspaceHandler_GetWorkspaceSSHConnectionInfo_IncludesHostKeys(t *testing.T) {
	t.Parallel()

	pinned := []services.WorkspaceSSHHostKey{
		{
			Algorithm:         "ssh-ed25519",
			PublicKey:         "AAAAC3NzaC1lZDI1NTE5AAAAIExamplePrimaryKey",
			FingerprintSHA256: "SHA256:primary-fp",
			KnownHostsLine:    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExamplePrimaryKey",
		},
		{
			Algorithm:         "ssh-ed25519",
			PublicKey:         "AAAAC3NzaC1lZDI1NTE5AAAAIExampleNextKey",
			FingerprintSHA256: "SHA256:next-fp",
		},
	}
	h := &WorkspaceHandler{Service: &mockWorkspaceRouteService{
		getWorkspaceSSHFn: func(ctx context.Context, workspaceID string, repositoryID, userID int64) (services.WorkspaceSSHConnectionInfo, error) {
			assert.Equal(t, "ws-1", workspaceID)
			return services.WorkspaceSSHConnectionInfo{
				WorkspaceID: workspaceID,
				VMID:        "vm-1",
				Host:        "vm-ssh.smithers.sh",
				Username:    "root",
				Port:        22,
				AccessToken: "token-xyz",
				HostKeys:    pinned,
			}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workspaces/ws-1/ssh", nil)
	req = withRouteParams(req, map[string]string{"id": "ws-1"})
	req = withWorkspaceRepoCtx(req, "alice", "demo")
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.GetWorkspaceSSHConnectionInfo(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "no-store", rec.Header().Get("Cache-Control"),
		"response embeds a plaintext SSH access token and must never be cached")
	var body services.WorkspaceSSHConnectionInfo
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Len(t, body.HostKeys, 2, "both pinned keys must round-trip through the JSON route")
	assert.Equal(t, "SHA256:primary-fp", body.HostKeys[0].FingerprintSHA256)
	assert.Equal(t, "SHA256:next-fp", body.HostKeys[1].FingerprintSHA256)
	assert.NotEmpty(t, body.HostKeys[0].PublicKey, "raw public_key must be present (fingerprint-only is not a verification primitive)")
}

// Ticket 0130: the session-level /workspace/sessions/{id}/ssh route
// mirrors the workspace-level route — it must also carry host_keys.
func TestWorkspaceHandler_GetSSHConnectionInfo_IncludesHostKeys(t *testing.T) {
	t.Parallel()

	h := &WorkspaceHandler{Service: &mockWorkspaceRouteService{
		getSSHConnectionInfoFn: func(ctx context.Context, sessionID string, repositoryID, userID int64) (services.WorkspaceSSHConnectionInfo, error) {
			assert.Equal(t, "sess-1", sessionID)
			return services.WorkspaceSSHConnectionInfo{
				SessionID: sessionID,
				VMID:      "vm-1",
				Host:      "vm-ssh.smithers.sh",
				Username:  "root",
				Port:      22,
				HostKeys: []services.WorkspaceSSHHostKey{{
					Algorithm:         "ssh-ed25519",
					PublicKey:         "AAAAC3NzaC1lZDI1NTE5AAAAIExampleSessKey",
					FingerprintSHA256: "SHA256:sess-fp",
				}},
			}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workspace/sessions/sess-1/ssh", nil)
	req = withRouteParams(req, map[string]string{"id": "sess-1"})
	req = withWorkspaceRepoCtx(req, "alice", "demo")
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.GetSSHConnectionInfo(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "no-store", rec.Header().Get("Cache-Control"),
		"response embeds a plaintext SSH access token and must never be cached")
	var body services.WorkspaceSSHConnectionInfo
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Len(t, body.HostKeys, 1)
	assert.Equal(t, "SHA256:sess-fp", body.HostKeys[0].FingerprintSHA256)
	assert.Equal(t, "ssh-ed25519", body.HostKeys[0].Algorithm)
}
