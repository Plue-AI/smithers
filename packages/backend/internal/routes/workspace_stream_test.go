package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// ---- mock workspace service for stream tests ----

type mockWorkspaceStreamService struct {
	getWorkspaceFn func(ctx context.Context, workspaceID string, repositoryID, userID int64) (services.WorkspaceResponse, error)
	getSessionFn   func(ctx context.Context, sessionID string, repositoryID, userID int64) (services.WorkspaceSessionResponse, error)
}

func (m *mockWorkspaceStreamService) CreateWorkspace(_ context.Context, _ services.CreateWorkspaceInput) (services.WorkspaceResponse, error) {
	return services.WorkspaceResponse{}, nil
}

func (m *mockWorkspaceStreamService) GetWorkspace(ctx context.Context, workspaceID string, repositoryID, userID int64) (services.WorkspaceResponse, error) {
	if m.getWorkspaceFn != nil {
		return m.getWorkspaceFn(ctx, workspaceID, repositoryID, userID)
	}
	return services.WorkspaceResponse{ID: workspaceID}, nil
}

func (m *mockWorkspaceStreamService) ListWorkspaces(_ context.Context, _, _ int64, _, _ int) ([]services.WorkspaceResponse, int64, error) {
	return nil, 0, nil
}

func (m *mockWorkspaceStreamService) ListUserWorkspacesAcrossRepos(_ context.Context, _ int64, _, _ int) (services.UserWorkspaceListResult, error) {
	return services.UserWorkspaceListResult{}, nil
}

func (m *mockWorkspaceStreamService) ListWorkspaceFiles(context.Context, string, int64, int64, string) ([]services.WorkspaceFileEntry, error) {
	return nil, nil
}

func (m *mockWorkspaceStreamService) ReadWorkspaceFile(context.Context, string, int64, int64, string) (services.WorkspaceFileContent, error) {
	return services.WorkspaceFileContent{}, nil
}

func (m *mockWorkspaceStreamService) WriteWorkspaceFile(context.Context, string, int64, int64, string, string, string) (services.WorkspaceFileContent, error) {
	return services.WorkspaceFileContent{}, nil
}

func (m *mockWorkspaceStreamService) ListWorkspaceServices(context.Context, string, int64, int64) ([]services.WorkspaceManagedService, error) {
	return nil, nil
}

func (m *mockWorkspaceStreamService) ManageWorkspaceService(context.Context, string, int64, int64, string, string) (services.WorkspaceManagedService, error) {
	return services.WorkspaceManagedService{}, nil
}

func (m *mockWorkspaceStreamService) GetWorkspaceSSHConnectionInfo(_ context.Context, _ string, _, _ int64) (services.WorkspaceSSHConnectionInfo, error) {
	return services.WorkspaceSSHConnectionInfo{}, nil
}

func (m *mockWorkspaceStreamService) SuspendWorkspace(_ context.Context, _ string, _, _ int64) (services.WorkspaceResponse, error) {
	return services.WorkspaceResponse{}, nil
}

func (m *mockWorkspaceStreamService) ResumeWorkspace(_ context.Context, _ string, _, _ int64) (services.WorkspaceResponse, error) {
	return services.WorkspaceResponse{}, nil
}

func (m *mockWorkspaceStreamService) DeleteWorkspace(_ context.Context, _ string, _, _ int64) error {
	return nil
}

func (m *mockWorkspaceStreamService) ForkWorkspace(_ context.Context, _ services.ForkWorkspaceInput) (services.WorkspaceResponse, error) {
	return services.WorkspaceResponse{}, nil
}

func (m *mockWorkspaceStreamService) CreateWorkspaceSnapshot(_ context.Context, _ services.CreateWorkspaceSnapshotInput) (services.WorkspaceSnapshotResponse, error) {
	return services.WorkspaceSnapshotResponse{}, nil
}

func (m *mockWorkspaceStreamService) GetWorkspaceSnapshot(_ context.Context, _ string, _, _ int64) (services.WorkspaceSnapshotResponse, error) {
	return services.WorkspaceSnapshotResponse{}, nil
}

func (m *mockWorkspaceStreamService) ListWorkspaceSnapshots(_ context.Context, _, _ int64, _, _ int) ([]services.WorkspaceSnapshotResponse, int64, error) {
	return nil, 0, nil
}

func (m *mockWorkspaceStreamService) DeleteWorkspaceSnapshot(_ context.Context, _ string, _, _ int64) error {
	return nil
}

func (m *mockWorkspaceStreamService) CreateSession(_ context.Context, _ services.CreateWorkspaceSessionInput) (services.WorkspaceSessionResponse, error) {
	return services.WorkspaceSessionResponse{}, nil
}

func (m *mockWorkspaceStreamService) GetSession(ctx context.Context, sessionID string, repositoryID, userID int64) (services.WorkspaceSessionResponse, error) {
	if m.getSessionFn != nil {
		return m.getSessionFn(ctx, sessionID, repositoryID, userID)
	}
	return services.WorkspaceSessionResponse{ID: sessionID}, nil
}

func (m *mockWorkspaceStreamService) ListSessions(_ context.Context, _, _ int64, _, _ int) ([]services.WorkspaceSessionResponse, int64, error) {
	return nil, 0, nil
}

func (m *mockWorkspaceStreamService) GetSSHConnectionInfo(_ context.Context, _ string, _, _ int64) (services.WorkspaceSSHConnectionInfo, error) {
	return services.WorkspaceSSHConnectionInfo{}, nil
}

func (m *mockWorkspaceStreamService) DestroySession(_ context.Context, _ string, _, _ int64) error {
	return nil
}

// ---- StreamWorkspace tests ----

func TestStreamWorkspace_RequiresAuth(t *testing.T) {
	t.Parallel()

	h := &WorkspaceHandler{Service: &mockWorkspaceStreamService{}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/workspaces/abc-123/stream", nil)
	rec := httptest.NewRecorder()
	h.StreamWorkspace(rec, req)
	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestStreamWorkspace_MissingRepoContext(t *testing.T) {
	t.Parallel()

	h := &WorkspaceHandler{Service: &mockWorkspaceStreamService{}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/workspaces/abc-123/stream", nil)
	req = withRouteParams(req, map[string]string{"id": "abc-123"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.StreamWorkspace(rec, req)
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestStreamWorkspace_MissingWorkspaceID(t *testing.T) {
	t.Parallel()

	h := &WorkspaceHandler{Service: &mockWorkspaceStreamService{}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/workspaces//stream", nil)
	req = withRouteParams(req, map[string]string{"id": ""})
	req = withAuth(req, 1, "alice")
	req = withRepoCtx(req, 101, "owner", "repo")
	rec := httptest.NewRecorder()
	h.StreamWorkspace(rec, req)
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestStreamWorkspace_WorkspaceNotFound(t *testing.T) {
	t.Parallel()

	svc := &mockWorkspaceStreamService{
		getWorkspaceFn: func(_ context.Context, _ string, _, _ int64) (services.WorkspaceResponse, error) {
			return services.WorkspaceResponse{}, pkgerrors.NotFound("workspace not found")
		},
	}
	h := &WorkspaceHandler{Service: svc}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/workspaces/abc-123/stream", nil)
	req = withRouteParams(req, map[string]string{"id": "abc-123"})
	req = withAuth(req, 1, "alice")
	req = withRepoCtx(req, 101, "owner", "repo")
	rec := httptest.NewRecorder()
	h.StreamWorkspace(rec, req)
	require.Equal(t, http.StatusNotFound, rec.Code)
}

func TestStreamWorkspace_NilPool_Returns500(t *testing.T) {
	t.Parallel()

	h := &WorkspaceHandler{
		Service: &mockWorkspaceStreamService{},
		Broker:  nil,
	}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/workspaces/abc-123/stream", nil)
	req = withRouteParams(req, map[string]string{"id": "abc-123"})
	req = withAuth(req, 1, "alice")
	req = withRepoCtx(req, 101, "owner", "repo")
	rec := httptest.NewRecorder()
	h.StreamWorkspace(rec, req)
	require.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestStreamWorkspace_NonFlusher_Returns500(t *testing.T) {
	t.Parallel()

	h := &WorkspaceHandler{Service: &mockWorkspaceStreamService{}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/workspaces/abc-123/stream", nil)
	req = withRouteParams(req, map[string]string{"id": "abc-123"})
	req = withAuth(req, 1, "alice")
	req = withRepoCtx(req, 101, "owner", "repo")
	rec := &nonFlusherWriter{ResponseWriter: httptest.NewRecorder()}
	h.StreamWorkspace(rec, req)
	require.Equal(t, http.StatusInternalServerError, rec.ResponseWriter.(*httptest.ResponseRecorder).Code)
}

func TestStreamWorkspace_InvalidLastEventID_IgnoredGracefully(t *testing.T) {
	t.Parallel()

	h := &WorkspaceHandler{Service: &mockWorkspaceStreamService{}, Broker: nil}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/workspaces/abc-123/stream", nil)
	req.Header.Set("Last-Event-ID", "not-a-number")
	req = withRouteParams(req, map[string]string{"id": "abc-123"})
	req = withAuth(req, 1, "alice")
	req = withRepoCtx(req, 101, "owner", "repo")
	rec := httptest.NewRecorder()
	h.StreamWorkspace(rec, req)
	// Pool==nil -> 500 (the invalid header was gracefully ignored, not a 400)
	require.Equal(t, http.StatusInternalServerError, rec.Code)
}

// ---- StreamSession tests ----

func TestStreamSession_RequiresAuth(t *testing.T) {
	t.Parallel()

	h := &WorkspaceHandler{Service: &mockWorkspaceStreamService{}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/workspace/sessions/abc-123/stream", nil)
	rec := httptest.NewRecorder()
	h.StreamSession(rec, req)
	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestStreamSession_MissingRepoContext(t *testing.T) {
	t.Parallel()

	h := &WorkspaceHandler{Service: &mockWorkspaceStreamService{}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/workspace/sessions/abc-123/stream", nil)
	req = withRouteParams(req, map[string]string{"id": "abc-123"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.StreamSession(rec, req)
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestStreamSession_MissingSessionID(t *testing.T) {
	t.Parallel()

	h := &WorkspaceHandler{Service: &mockWorkspaceStreamService{}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/workspace/sessions//stream", nil)
	req = withRouteParams(req, map[string]string{"id": ""})
	req = withAuth(req, 1, "alice")
	req = withRepoCtx(req, 101, "owner", "repo")
	rec := httptest.NewRecorder()
	h.StreamSession(rec, req)
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestStreamSession_SessionNotFound(t *testing.T) {
	t.Parallel()

	svc := &mockWorkspaceStreamService{
		getSessionFn: func(_ context.Context, _ string, _, _ int64) (services.WorkspaceSessionResponse, error) {
			return services.WorkspaceSessionResponse{}, pkgerrors.NotFound("session not found")
		},
	}
	h := &WorkspaceHandler{Service: svc}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/workspace/sessions/abc-123/stream", nil)
	req = withRouteParams(req, map[string]string{"id": "abc-123"})
	req = withAuth(req, 1, "alice")
	req = withRepoCtx(req, 101, "owner", "repo")
	rec := httptest.NewRecorder()
	h.StreamSession(rec, req)
	require.Equal(t, http.StatusNotFound, rec.Code)
}

func TestStreamSession_NilPool_Returns500(t *testing.T) {
	t.Parallel()

	h := &WorkspaceHandler{
		Service: &mockWorkspaceStreamService{},
		Broker:  nil,
	}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/workspace/sessions/abc-123/stream", nil)
	req = withRouteParams(req, map[string]string{"id": "abc-123"})
	req = withAuth(req, 1, "alice")
	req = withRepoCtx(req, 101, "owner", "repo")
	rec := httptest.NewRecorder()
	h.StreamSession(rec, req)
	require.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestStreamSession_NonFlusher_Returns500(t *testing.T) {
	t.Parallel()

	h := &WorkspaceHandler{Service: &mockWorkspaceStreamService{}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/workspace/sessions/abc-123/stream", nil)
	req = withRouteParams(req, map[string]string{"id": "abc-123"})
	req = withAuth(req, 1, "alice")
	req = withRepoCtx(req, 101, "owner", "repo")
	rec := &nonFlusherWriter{ResponseWriter: httptest.NewRecorder()}
	h.StreamSession(rec, req)
	require.Equal(t, http.StatusInternalServerError, rec.ResponseWriter.(*httptest.ResponseRecorder).Code)
}

func TestStreamSession_InvalidLastEventID_IgnoredGracefully(t *testing.T) {
	t.Parallel()

	h := &WorkspaceHandler{Service: &mockWorkspaceStreamService{}, Broker: nil}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/workspace/sessions/abc-123/stream", nil)
	req.Header.Set("Last-Event-ID", "garbage")
	req = withRouteParams(req, map[string]string{"id": "abc-123"})
	req = withAuth(req, 1, "alice")
	req = withRepoCtx(req, 101, "owner", "repo")
	rec := httptest.NewRecorder()
	h.StreamSession(rec, req)
	// Pool==nil -> 500 (the invalid header was gracefully ignored)
	require.Equal(t, http.StatusInternalServerError, rec.Code)
}

// ---- extractWorkspaceEventID tests ----

func TestExtractWorkspaceEventID_WithID(t *testing.T) {
	t.Parallel()

	got := extractWorkspaceEventID(`{"id":42,"workspace_id":"abc-123"}`)
	assert.Equal(t, "42", got)
}

func TestExtractWorkspaceEventID_WithSequence(t *testing.T) {
	t.Parallel()

	got := extractWorkspaceEventID(`{"sequence":7,"status":"running"}`)
	assert.Equal(t, "7", got)
}

func TestExtractWorkspaceEventID_IDPreferredOverSequence(t *testing.T) {
	t.Parallel()

	got := extractWorkspaceEventID(`{"id":10,"sequence":7}`)
	assert.Equal(t, "10", got)
}

func TestExtractWorkspaceEventID_NoIDField(t *testing.T) {
	t.Parallel()

	got := extractWorkspaceEventID(`{"status":"running"}`)
	assert.Equal(t, "", got)
}

func TestExtractWorkspaceEventID_InvalidJSON(t *testing.T) {
	t.Parallel()

	got := extractWorkspaceEventID(`not json`)
	assert.Equal(t, "", got)
}

func TestExtractWorkspaceEventID_EmptyString(t *testing.T) {
	t.Parallel()

	got := extractWorkspaceEventID(``)
	assert.Equal(t, "", got)
}

func TestExtractWorkspaceEventID_ZeroID(t *testing.T) {
	t.Parallel()

	got := extractWorkspaceEventID(`{"id":0,"status":"starting"}`)
	assert.Equal(t, "", got)
}

func TestExtractWorkspaceEventID_LargeID(t *testing.T) {
	t.Parallel()

	got := extractWorkspaceEventID(`{"id":9999999999}`)
	assert.Equal(t, "9999999999", got)
}
