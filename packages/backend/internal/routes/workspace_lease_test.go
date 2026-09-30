package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type leaseRouteService struct {
	*mockWorkspaceRouteService
	renew func(workspaceID string, repositoryID, userID int64) (services.WorkspaceResponse, error)
}

func (s *leaseRouteService) RenewWorkspaceLease(_ context.Context, workspaceID string, repositoryID, userID int64) (services.WorkspaceResponse, error) {
	return s.renew(workspaceID, repositoryID, userID)
}

func leaseRequest() *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workspaces/ws-1/lease", nil)
	req = withRouteParams(req, map[string]string{"id": "ws-1"})
	req = withWorkspaceRepoCtx(req, "alice", "demo")
	return withAuth(req, 1, "alice")
}

func TestRenewWorkspaceLease(t *testing.T) {
	expires := time.Now().Add(time.Minute).UTC().Truncate(time.Second)
	var got []any
	h := &WorkspaceHandler{Service: &leaseRouteService{mockWorkspaceRouteService: &mockWorkspaceRouteService{},
		renew: func(id string, repo, user int64) (services.WorkspaceResponse, error) {
			got = []any{id, user}
			return services.WorkspaceResponse{ID: id, ClientLeaseExpiresAt: &expires}, nil
		}}}
	rec := httptest.NewRecorder()
	h.RenewWorkspaceLease(rec, leaseRequest())
	require.Equal(t, http.StatusOK, rec.Code)
	require.Equal(t, []any{"ws-1", int64(1)}, got)
	var body services.WorkspaceResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.True(t, expires.Equal(*body.ClientLeaseExpiresAt))

	h = &WorkspaceHandler{Service: &leaseRouteService{mockWorkspaceRouteService: &mockWorkspaceRouteService{},
		renew: func(string, int64, int64) (services.WorkspaceResponse, error) {
			return services.WorkspaceResponse{}, pkgerrors.Conflict("workspace has no client lease")
		}}}
	rec = httptest.NewRecorder()
	h.RenewWorkspaceLease(rec, leaseRequest())
	require.Equal(t, http.StatusConflict, rec.Code)

	rec = httptest.NewRecorder()
	(&WorkspaceHandler{Service: &mockWorkspaceRouteService{}}).RenewWorkspaceLease(rec, leaseRequest())
	require.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestCreateWorkspacePassesClientLease(t *testing.T) {
	var lease int32
	h := &WorkspaceHandler{Service: &mockWorkspaceRouteService{
		createWorkspaceFn: func(_ context.Context, input services.CreateWorkspaceInput) (services.WorkspaceResponse, error) {
			lease = input.ClientLeaseSeconds
			return services.WorkspaceResponse{ID: "ws-1"}, nil
		},
	}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workspaces", strings.NewReader(`{"client_lease_seconds":300}`))
	req = withWorkspaceRepoCtx(req, "alice", "demo")
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.CreateWorkspace(rec, req)
	require.Less(t, rec.Code, 300, rec.Body.String())
	require.Equal(t, int32(300), lease)
}
