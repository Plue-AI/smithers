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

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

type runtimeFacetService struct {
	mockWorkspaceRouteService
	command     services.WorkspaceCommandInput
	launch      services.WorkspaceServiceLaunchInput
	workspaceID string
	repoID      int64
	userID      int64
	err         error
}

func (s *runtimeFacetService) AdmitWorkspaceCommand(_ context.Context, workspaceID string, repositoryID, userID int64, input services.WorkspaceCommandInput) (jobs.RequestReceipt, error) {
	s.workspaceID, s.repoID, s.userID, s.command = workspaceID, repositoryID, userID, input
	return jobs.RequestReceipt{OperationID: input.OperationID, State: jobs.StateAccepted}, s.err
}

func (s *runtimeFacetService) GetWorkspaceCommandRun(context.Context, string, int64, int64, string) (services.WorkspaceCommandRun, error) {
	return services.WorkspaceCommandRun{}, s.err
}

func (s *runtimeFacetService) CancelWorkspaceCommandRun(context.Context, string, int64, int64, string) (services.WorkspaceCommandRun, error) {
	return services.WorkspaceCommandRun{}, s.err
}

func (s *runtimeFacetService) LaunchWorkspaceService(_ context.Context, workspaceID string, repositoryID, userID int64, input services.WorkspaceServiceLaunchInput) (services.WorkspaceManagedService, error) {
	s.workspaceID, s.repoID, s.userID, s.launch = workspaceID, repositoryID, userID, input
	return services.WorkspaceManagedService{Name: input.Name}, s.err
}

func runtimeFacetRequest(t *testing.T, path, body string, authed bool) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	if authed {
		req = withAuth(req, 7, "alice")
	}
	req = withWorkspaceRepoCtx(req, "alice", "demo")
	return withRouteParams(req, map[string]string{"id": "ws1"})
}

func TestAdmitWorkspaceCommand(t *testing.T) {
	t.Parallel()

	t.Run("passes the scoped identity and decoded input", func(t *testing.T) {
		svc := &runtimeFacetService{}
		rec := httptest.NewRecorder()
		(&WorkspaceHandler{Service: svc}).AdmitWorkspaceCommand(rec, runtimeFacetRequest(t, "/command-runs", `{"operation_id":"op1","args":["ls","-la"]}`, true))
		require.Equal(t, http.StatusAccepted, rec.Code, rec.Body.String())
		assert.Equal(t, "ws1", svc.workspaceID)
		assert.EqualValues(t, 200, svc.repoID)
		assert.EqualValues(t, 7, svc.userID)
		assert.Equal(t, []string{"ls", "-la"}, svc.command.Args)
		var result jobs.RequestReceipt
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &result))
		assert.Equal(t, "op1", result.OperationID)
	})
	t.Run("unknown fields are refused", func(t *testing.T) {
		rec := httptest.NewRecorder()
		(&WorkspaceHandler{Service: &runtimeFacetService{}}).AdmitWorkspaceCommand(rec, runtimeFacetRequest(t, "/command-runs", `{"args":["ls"],"shell":true}`, true))
		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})
	t.Run("requires auth", func(t *testing.T) {
		rec := httptest.NewRecorder()
		(&WorkspaceHandler{Service: &runtimeFacetService{}}).AdmitWorkspaceCommand(rec, runtimeFacetRequest(t, "/command-runs", `{}`, false))
		assert.Equal(t, http.StatusUnauthorized, rec.Code)
	})
	t.Run("service without execution is 500", func(t *testing.T) {
		rec := httptest.NewRecorder()
		(&WorkspaceHandler{Service: &mockWorkspaceRouteService{}}).AdmitWorkspaceCommand(rec, runtimeFacetRequest(t, "/command-runs", `{}`, true))
		assert.Equal(t, http.StatusInternalServerError, rec.Code)
	})
	t.Run("service errors keep their status", func(t *testing.T) {
		rec := httptest.NewRecorder()
		(&WorkspaceHandler{Service: &runtimeFacetService{err: pkgerrors.Forbidden("no")}}).AdmitWorkspaceCommand(rec, runtimeFacetRequest(t, "/command-runs", `{"args":["ls"]}`, true))
		assert.Equal(t, http.StatusForbidden, rec.Code)
	})
}

func TestLaunchWorkspaceService(t *testing.T) {
	t.Parallel()

	t.Run("creates the managed service", func(t *testing.T) {
		svc := &runtimeFacetService{}
		rec := httptest.NewRecorder()
		(&WorkspaceHandler{Service: svc}).LaunchWorkspaceService(rec, runtimeFacetRequest(t, "/services", `{"name":"web","args":["npm","start"],"port":3000}`, true))
		require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
		assert.Equal(t, "web", svc.launch.Name)
		assert.EqualValues(t, 3000, svc.launch.Port)
		assert.EqualValues(t, 7, svc.userID)
	})
	t.Run("unknown fields are refused", func(t *testing.T) {
		rec := httptest.NewRecorder()
		(&WorkspaceHandler{Service: &runtimeFacetService{}}).LaunchWorkspaceService(rec, runtimeFacetRequest(t, "/services", `{"name":"web","host":"0.0.0.0"}`, true))
		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})
	t.Run("service without managed services is 500", func(t *testing.T) {
		rec := httptest.NewRecorder()
		(&WorkspaceHandler{Service: &mockWorkspaceRouteService{}}).LaunchWorkspaceService(rec, runtimeFacetRequest(t, "/services", `{}`, true))
		assert.Equal(t, http.StatusInternalServerError, rec.Code)
	})
	t.Run("service errors keep their status", func(t *testing.T) {
		rec := httptest.NewRecorder()
		(&WorkspaceHandler{Service: &runtimeFacetService{err: pkgerrors.Conflict("port taken")}}).LaunchWorkspaceService(rec, runtimeFacetRequest(t, "/services", `{"name":"web"}`, true))
		assert.Equal(t, http.StatusConflict, rec.Code)
	})
}
