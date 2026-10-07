package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// ---- mock service for workspace SSE tests ----

type mockWorkspaceSSEService struct {
	getWorkspaceFunc func(ctx context.Context, workspaceID string, repositoryID, userID int64) (services.WorkspaceResponse, error)
	getSessionFunc   func(ctx context.Context, sessionID string, repositoryID, userID int64) (services.WorkspaceSessionResponse, error)
}

func (m *mockWorkspaceSSEService) CreateWorkspace(ctx context.Context, input services.CreateWorkspaceInput) (services.WorkspaceResponse, error) {
	return services.WorkspaceResponse{}, nil
}
func (m *mockWorkspaceSSEService) GetWorkspace(ctx context.Context, workspaceID string, repositoryID, userID int64) (services.WorkspaceResponse, error) {
	if m.getWorkspaceFunc != nil {
		return m.getWorkspaceFunc(ctx, workspaceID, repositoryID, userID)
	}
	return services.WorkspaceResponse{ID: workspaceID}, nil
}
func (m *mockWorkspaceSSEService) ListWorkspaces(ctx context.Context, repositoryID, userID int64, page, perPage int) ([]services.WorkspaceResponse, int64, error) {
	return nil, 0, nil
}
func (m *mockWorkspaceSSEService) ListUserWorkspacesAcrossRepos(ctx context.Context, userID int64, page, perPage int) (services.UserWorkspaceListResult, error) {
	return services.UserWorkspaceListResult{}, nil
}
func (m *mockWorkspaceSSEService) ListWorkspaceFiles(context.Context, string, int64, int64, string) ([]services.WorkspaceFileEntry, error) {
	return nil, nil
}
func (m *mockWorkspaceSSEService) ReadWorkspaceFile(context.Context, string, int64, int64, string) (services.WorkspaceFileContent, error) {
	return services.WorkspaceFileContent{}, nil
}
func (m *mockWorkspaceSSEService) WriteWorkspaceFile(context.Context, string, int64, int64, string, string, string) (services.WorkspaceFileContent, error) {
	return services.WorkspaceFileContent{}, nil
}
func (m *mockWorkspaceSSEService) ListWorkspaceServices(context.Context, string, int64, int64) ([]services.WorkspaceManagedService, error) {
	return nil, nil
}
func (m *mockWorkspaceSSEService) ManageWorkspaceService(context.Context, string, int64, int64, string, string) (services.WorkspaceManagedService, error) {
	return services.WorkspaceManagedService{}, nil
}
func (m *mockWorkspaceSSEService) GetWorkspaceSSHConnectionInfo(ctx context.Context, workspaceID string, repositoryID, userID int64) (services.WorkspaceSSHConnectionInfo, error) {
	return services.WorkspaceSSHConnectionInfo{}, nil
}
func (m *mockWorkspaceSSEService) SuspendWorkspace(ctx context.Context, workspaceID string, repositoryID, userID int64) (services.WorkspaceResponse, error) {
	return services.WorkspaceResponse{}, nil
}
func (m *mockWorkspaceSSEService) ResumeWorkspace(ctx context.Context, workspaceID string, repositoryID, userID int64) (services.WorkspaceResponse, error) {
	return services.WorkspaceResponse{}, nil
}
func (m *mockWorkspaceSSEService) DeleteWorkspace(ctx context.Context, workspaceID string, repositoryID, userID int64) error {
	return nil
}
func (m *mockWorkspaceSSEService) ForkWorkspace(ctx context.Context, input services.ForkWorkspaceInput) (services.WorkspaceResponse, error) {
	return services.WorkspaceResponse{}, nil
}
func (m *mockWorkspaceSSEService) CreateWorkspaceSnapshot(ctx context.Context, input services.CreateWorkspaceSnapshotInput) (services.WorkspaceSnapshotResponse, error) {
	return services.WorkspaceSnapshotResponse{}, nil
}
func (m *mockWorkspaceSSEService) GetWorkspaceSnapshot(ctx context.Context, snapshotID string, repositoryID, userID int64) (services.WorkspaceSnapshotResponse, error) {
	return services.WorkspaceSnapshotResponse{}, nil
}
func (m *mockWorkspaceSSEService) ListWorkspaceSnapshots(ctx context.Context, repositoryID, userID int64, page, perPage int) ([]services.WorkspaceSnapshotResponse, int64, error) {
	return nil, 0, nil
}
func (m *mockWorkspaceSSEService) DeleteWorkspaceSnapshot(ctx context.Context, snapshotID string, repositoryID, userID int64) error {
	return nil
}
func (m *mockWorkspaceSSEService) CreateSession(ctx context.Context, input services.CreateWorkspaceSessionInput) (services.WorkspaceSessionResponse, error) {
	return services.WorkspaceSessionResponse{}, nil
}
func (m *mockWorkspaceSSEService) GetSession(ctx context.Context, sessionID string, repositoryID, userID int64) (services.WorkspaceSessionResponse, error) {
	if m.getSessionFunc != nil {
		return m.getSessionFunc(ctx, sessionID, repositoryID, userID)
	}
	return services.WorkspaceSessionResponse{ID: sessionID}, nil
}
func (m *mockWorkspaceSSEService) ListSessions(ctx context.Context, repositoryID, userID int64, page, perPage int) ([]services.WorkspaceSessionResponse, int64, error) {
	return nil, 0, nil
}
func (m *mockWorkspaceSSEService) GetSSHConnectionInfo(ctx context.Context, sessionID string, repositoryID, userID int64) (services.WorkspaceSSHConnectionInfo, error) {
	return services.WorkspaceSSHConnectionInfo{}, nil
}
func (m *mockWorkspaceSSEService) DestroySession(ctx context.Context, sessionID string, repositoryID, userID int64) error {
	return nil
}

// ---- helper ----

func sseAPIErrorMessage(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var payload struct {
		Message string `json:"message"`
	}
	err := json.Unmarshal(rec.Body.Bytes(), &payload)
	require.NoError(t, err)
	return payload.Message
}

// ---- RequireRepoPermission middleware integration tests ----
// These tests verify the middleware chain applied in cmd/server/main.go
// where RequireRepoPermission(PermissionRead) gates workspace SSE endpoints.

func TestStreamWorkspace_PermissionDenied_WithMiddleware(t *testing.T) {
	t.Parallel()

	h := &WorkspaceHandler{Service: &mockWorkspaceSSEService{}}

	r := chi.NewRouter()
	// Simulate the middleware chain from main.go: auth + repo context + permission check.
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			user := &db.User{ID: 1, Username: "alice"}
			ctx := middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{User: user})
			// PermissionNone: user has no access to this private repo.
			ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{
				Owner:      "owner",
				Repository: &db.Repository{ID: 101, Name: "repo"},
			}, middleware.PermissionNone)
			next.ServeHTTP(w, req.WithContext(ctx))
		})
	})
	r.With(middleware.RequireRepoPermission(middleware.PermissionRead)).
		Get("/repos/{owner}/{repo}/workspaces/{id}/stream", h.StreamWorkspace)

	req := httptest.NewRequest(http.MethodGet, "/repos/owner/repo/workspaces/ws-123/stream", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	require.Equal(t, http.StatusForbidden, rec.Code)
	assert.Equal(t, "permission denied", sseAPIErrorMessage(t, rec))
}

func TestStreamWorkspace_PermissionAllowed_WithMiddleware(t *testing.T) {
	t.Parallel()

	svc := &mockWorkspaceSSEService{
		getWorkspaceFunc: func(_ context.Context, id string, repoID, userID int64) (services.WorkspaceResponse, error) {
			assert.Equal(t, "ws-123", id)
			assert.Equal(t, int64(101), repoID)
			assert.Equal(t, int64(1), userID)
			return services.WorkspaceResponse{ID: id}, nil
		},
	}
	h := &WorkspaceHandler{Service: svc, Broker: nil}

	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			user := &db.User{ID: 1, Username: "alice"}
			ctx := middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{User: user})
			ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{
				Owner:      "owner",
				Repository: &db.Repository{ID: 101, Name: "repo"},
			}, middleware.PermissionRead)
			next.ServeHTTP(w, req.WithContext(ctx))
		})
	})
	r.With(middleware.RequireRepoPermission(middleware.PermissionRead)).
		Get("/repos/{owner}/{repo}/workspaces/{id}/stream", h.StreamWorkspace)

	// Use a cancellable context so the SSE stream unblocks when Pool is nil.
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately so the handler returns
	req := httptest.NewRequest(http.MethodGet, "/repos/owner/repo/workspaces/ws-123/stream", nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	// 200 means the middleware chain passed and the SSE stream started.
	// Handler proceeds past permission check but returns 500 due to nil pool.
	require.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestStreamSession_PermissionDenied_WithMiddleware(t *testing.T) {
	t.Parallel()

	h := &WorkspaceHandler{Service: &mockWorkspaceSSEService{}}

	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			user := &db.User{ID: 1, Username: "alice"}
			ctx := middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{User: user})
			ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{
				Owner:      "owner",
				Repository: &db.Repository{ID: 101, Name: "repo"},
			}, middleware.PermissionNone)
			next.ServeHTTP(w, req.WithContext(ctx))
		})
	})
	r.With(middleware.RequireRepoPermission(middleware.PermissionRead)).
		Get("/repos/{owner}/{repo}/workspace/sessions/{id}/stream", h.StreamSession)

	req := httptest.NewRequest(http.MethodGet, "/repos/owner/repo/workspace/sessions/sess-123/stream", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	require.Equal(t, http.StatusForbidden, rec.Code)
	assert.Equal(t, "permission denied", sseAPIErrorMessage(t, rec))
}

func TestStreamSession_PermissionAllowed_WithMiddleware(t *testing.T) {
	t.Parallel()

	svc := &mockWorkspaceSSEService{
		getSessionFunc: func(_ context.Context, id string, repoID, userID int64) (services.WorkspaceSessionResponse, error) {
			assert.Equal(t, "sess-123", id)
			assert.Equal(t, int64(101), repoID)
			assert.Equal(t, int64(1), userID)
			return services.WorkspaceSessionResponse{ID: id}, nil
		},
	}
	h := &WorkspaceHandler{Service: svc, Broker: nil}

	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			user := &db.User{ID: 1, Username: "alice"}
			ctx := middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{User: user})
			ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{
				Owner:      "owner",
				Repository: &db.Repository{ID: 101, Name: "repo"},
			}, middleware.PermissionRead)
			next.ServeHTTP(w, req.WithContext(ctx))
		})
	})
	r.With(middleware.RequireRepoPermission(middleware.PermissionRead)).
		Get("/repos/{owner}/{repo}/workspace/sessions/{id}/stream", h.StreamSession)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	req := httptest.NewRequest(http.MethodGet, "/repos/owner/repo/workspace/sessions/sess-123/stream", nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	// Handler proceeds past permission check but returns 500 due to nil pool.
	require.Equal(t, http.StatusInternalServerError, rec.Code)
}

// ---- Workspace terminal WebSocket permission middleware test ----
// Verifies that RequireRepoPermission(PermissionWrite) blocks read-only users
// from accessing the terminal endpoint (fix applied alongside the SSE fix).

func TestTerminalWebSocket_PermissionDenied_WithMiddleware(t *testing.T) {
	t.Parallel()

	handler := &WorkspaceTerminalHandler{
		Service: &mockWorkspaceTerminalService{},
	}

	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			user := &db.User{ID: 1, Username: "alice"}
			ctx := middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{User: user})
			// Read-only user should be blocked from write-level terminal endpoint.
			ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{
				Owner:      "owner",
				Repository: &db.Repository{ID: 101, Name: "repo"},
			}, middleware.PermissionRead)
			next.ServeHTTP(w, req.WithContext(ctx))
		})
	})
	r.With(middleware.RequireRepoPermission(middleware.PermissionWrite)).
		Get("/repos/{owner}/{repo}/workspace/sessions/{id}/terminal", handler.TerminalWebSocket)

	req := httptest.NewRequest(http.MethodGet, "/repos/owner/repo/workspace/sessions/sess-123/terminal", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	require.Equal(t, http.StatusForbidden, rec.Code)
	assert.Equal(t, "permission denied", sseAPIErrorMessage(t, rec))
}
