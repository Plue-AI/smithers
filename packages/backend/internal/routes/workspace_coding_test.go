package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type codingRouteTestService struct {
	*mockWorkspaceRouteService
	called bool
}

func (s *codingRouteTestService) ReadCodingRevisions(_ context.Context, workspace string, repo, user int64, ids []string) (services.WorkspaceCodingResult, error) {
	s.called = true
	return services.WorkspaceCodingResult{Status: "read", OperationID: strings.Join(ids, ",")}, nil
}

func (s *codingRouteTestService) ApplyCodingOperation(_ context.Context, workspace string, repo, user int64, input services.WorkspaceCodingInput) (services.WorkspaceCodingResult, error) {
	s.called = true
	return services.WorkspaceCodingResult{Status: "accepted", OperationID: input.ExpectedOperationID}, nil
}

func TestWorkspaceCodingRoutes_StrictJSONAndAuth(t *testing.T) {
	for _, body := range []string{`{"operation":"create","unknown":1}`, `{} {}`, `{"target":{"unrecognized":1}}`, strings.Repeat(" ", 65<<10)} {
		service := &codingRouteTestService{mockWorkspaceRouteService: &mockWorkspaceRouteService{}}
		h := &WorkspaceHandler{Service: service}
		req := httptest.NewRequest(http.MethodPost, "/coding/operations", strings.NewReader(body))
		req = withAuth(withWorkspaceRepoCtx(withRouteParams(req, map[string]string{"id": "ws"}), "alice", "demo"), 1, "alice")
		rec := httptest.NewRecorder()
		h.ApplyCodingOperation(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
		require.False(t, service.called)
	}
	h := &WorkspaceHandler{Service: &codingRouteTestService{mockWorkspaceRouteService: &mockWorkspaceRouteService{}}}
	rec := httptest.NewRecorder()
	h.ApplyCodingOperation(rec, httptest.NewRequest(http.MethodPost, "/coding/operations", strings.NewReader(`{}`)))
	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestWorkspaceCodingRoutes_ReadNativeSelectors(t *testing.T) {
	queryless := httptest.NewRequest(http.MethodGet, "/coding/revisions", nil)
	queryless = withAuth(withWorkspaceRepoCtx(withRouteParams(queryless, map[string]string{"id": "ws"}), "alice", "demo"), 1, "alice")
	querylessRec := httptest.NewRecorder()
	(&WorkspaceHandler{Service: &codingRouteTestService{mockWorkspaceRouteService: &mockWorkspaceRouteService{}}}).ReadCodingRevisions(querylessRec, queryless)
	require.Equal(t, http.StatusOK, querylessRec.Code)
	require.Contains(t, querylessRec.Body.String(), `"status":"read"`)

	h := &WorkspaceHandler{Service: &codingRouteTestService{mockWorkspaceRouteService: &mockWorkspaceRouteService{}}}
	req := httptest.NewRequest(http.MethodGet, "/coding/revisions?change_id=one&change_id=two", nil)
	req = withAuth(withWorkspaceRepoCtx(withRouteParams(req, map[string]string{"id": "ws"}), "alice", "demo"), 1, "alice")
	rec := httptest.NewRecorder()
	h.ReadCodingRevisions(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), `"operationId":"one,two"`)
}
