package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

type commandRunRouteService struct {
	runtimeFacetService
	admitInput        services.WorkspaceCommandInput
	admitWorkspaceID  string
	admitRepoID       int64
	admitUserID       int64
	admitErr          error
	admitCalls        int
	getWorkspaceID    string
	getRepoID         int64
	getUserID         int64
	getOperationID    string
	getCalls          int
	getErr            error
	cancelOperationID string
	cancelWorkspaceID string
	cancelRepoID      int64
	cancelUserID      int64
	cancelCalls       int
	cancelErr         error
	cancelState       jobs.State
}

func (s *commandRunRouteService) AdmitWorkspaceCommand(_ context.Context, workspaceID string, repositoryID, userID int64, input services.WorkspaceCommandInput) (jobs.RequestReceipt, error) {
	s.admitCalls++
	s.admitWorkspaceID, s.admitRepoID, s.admitUserID, s.admitInput = workspaceID, repositoryID, userID, input
	return jobs.RequestReceipt{OperationID: input.OperationID, RequestID: input.OperationID, State: jobs.StateAccepted}, s.admitErr
}

func (s *commandRunRouteService) GetWorkspaceCommandRun(_ context.Context, workspaceID string, repositoryID, userID int64, operationID string) (services.WorkspaceCommandRun, error) {
	s.getCalls++
	s.getWorkspaceID, s.getRepoID, s.getUserID, s.getOperationID = workspaceID, repositoryID, userID, operationID
	return services.WorkspaceCommandRun{OperationID: operationID, State: jobs.StateCompleted, Result: &services.WorkspaceCommandResult{ExitCode: 3, Stdout: "done\n"}}, s.getErr
}

func (s *commandRunRouteService) CancelWorkspaceCommandRun(_ context.Context, workspaceID string, repositoryID, userID int64, operationID string) (services.WorkspaceCommandRun, error) {
	s.cancelCalls++
	s.cancelWorkspaceID, s.cancelRepoID, s.cancelUserID, s.cancelOperationID = workspaceID, repositoryID, userID, operationID
	state := s.cancelState
	if state == "" {
		state = jobs.StateCancelled
	}
	return services.WorkspaceCommandRun{OperationID: operationID, State: state}, s.cancelErr
}

func commandRunRouteRequest(method, path, body string, authed bool) *http.Request {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	if authed {
		request = withAuth(request, 7, "alice")
	}
	return withWorkspaceRepoCtx(request, "alice", "demo")
}

func commandRunRouter(service WorkspaceRouteService) http.Handler {
	router := chi.NewRouter()
	RegisterWorkspaceRuntimeRoutes(router, &WorkspaceHandler{Service: service}, nil, nil)
	return http.StripPrefix("/api/repos/alice/demo", router)
}

// A command can outlive the API request timeout. Admission must return a
// receipt while the command is still running so the caller can poll it.
func TestWorkspaceCommandRunReturnsReceiptBeforeCommandExits(t *testing.T) {
	service := &commandRunRouteService{}
	request := commandRunRouteRequest(http.MethodPost, "/api/repos/alice/demo/workspaces/ws1/command-runs", `{"operation_id":"op1","args":["sleep","600"]}`, true)
	recorder := httptest.NewRecorder()
	middleware.JSONTimeout(50*time.Millisecond)(commandRunRouter(service)).ServeHTTP(recorder, request)
	require.Equal(t, http.StatusAccepted, recorder.Code, recorder.Body.String())
	var receipt struct {
		OperationID string `json:"operationId"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &receipt))
	require.Equal(t, "op1", receipt.OperationID)
	require.Equal(t, "ws1", service.admitWorkspaceID)
	require.EqualValues(t, 200, service.admitRepoID)
	require.EqualValues(t, 7, service.admitUserID)
	require.Equal(t, []string{"sleep", "600"}, service.admitInput.Args)
}

func TestWorkspaceCommandRunAdmissionRejectsInvalidRequests(t *testing.T) {
	for _, test := range []struct {
		name   string
		body   string
		authed bool
		status int
	}{
		{name: "missing authentication", body: `{"operation_id":"op1","args":["true"]}`, status: http.StatusUnauthorized},
		{name: "invalid JSON", body: `{`, authed: true, status: http.StatusBadRequest},
		{name: "trailing JSON", body: `{"operation_id":"op1","args":["true"]} {}`, authed: true, status: http.StatusBadRequest},
		{name: "unknown field", body: `{"operation_id":"op1","args":["true"],"shell":true}`, authed: true, status: http.StatusBadRequest},
	} {
		t.Run(test.name, func(t *testing.T) {
			service := &commandRunRouteService{}
			recorder := httptest.NewRecorder()
			commandRunRouter(service).ServeHTTP(recorder, commandRunRouteRequest(http.MethodPost, "/api/repos/alice/demo/workspaces/ws1/command-runs", test.body, test.authed))
			require.Equal(t, test.status, recorder.Code, recorder.Body.String())
			require.Zero(t, service.admitCalls)
		})
	}
	t.Run("service error keeps status", func(t *testing.T) {
		service := &commandRunRouteService{admitErr: pkgerrors.Forbidden("no")}
		recorder := httptest.NewRecorder()
		commandRunRouter(service).ServeHTTP(recorder, commandRunRouteRequest(http.MethodPost, "/api/repos/alice/demo/workspaces/ws1/command-runs", `{"operation_id":"op1","args":["true"]}`, true))
		require.Equal(t, http.StatusForbidden, recorder.Code, recorder.Body.String())
		require.Equal(t, 1, service.admitCalls)
	})
}

func TestWorkspaceCommandRunReadAndCancel(t *testing.T) {
	service := &commandRunRouteService{}
	path := "/api/repos/alice/demo/workspaces/ws1/command-runs/op1"
	read := httptest.NewRecorder()
	commandRunRouter(service).ServeHTTP(read, commandRunRouteRequest(http.MethodGet, path, "", true))
	require.Equal(t, http.StatusOK, read.Code, read.Body.String())
	var run services.WorkspaceCommandRun
	require.NoError(t, json.Unmarshal(read.Body.Bytes(), &run))
	require.Equal(t, "op1", run.OperationID)
	require.Equal(t, jobs.StateCompleted, run.State)
	require.NotNil(t, run.Result)
	require.Equal(t, 3, run.Result.ExitCode)
	require.Equal(t, "done\n", run.Result.Stdout)
	require.Equal(t, "ws1", service.getWorkspaceID)
	require.EqualValues(t, 200, service.getRepoID)
	require.EqualValues(t, 7, service.getUserID)
	require.Equal(t, "op1", service.getOperationID)

	cancel := httptest.NewRecorder()
	commandRunRouter(service).ServeHTTP(cancel, commandRunRouteRequest(http.MethodPost, path+"/cancel", "", true))
	require.Equal(t, http.StatusOK, cancel.Code, cancel.Body.String())
	require.NoError(t, json.Unmarshal(cancel.Body.Bytes(), &run))
	require.Equal(t, jobs.StateCancelled, run.State)
	require.Equal(t, "op1", service.cancelOperationID)
	require.Equal(t, "ws1", service.cancelWorkspaceID)
	require.EqualValues(t, 200, service.cancelRepoID)
	require.EqualValues(t, 7, service.cancelUserID)
	require.Equal(t, 1, service.cancelCalls)
}

func TestWorkspaceCommandRunReadAndCancelKeepServiceErrors(t *testing.T) {
	for _, test := range []struct {
		name    string
		method  string
		path    string
		service commandRunRouteService
		status  int
	}{
		{name: "unknown run", method: http.MethodGet, path: "/api/repos/alice/demo/workspaces/ws1/command-runs/missing", service: commandRunRouteService{getErr: pkgerrors.NotFound("run")}, status: http.StatusNotFound},
		{name: "cancel forbidden", method: http.MethodPost, path: "/api/repos/alice/demo/workspaces/ws1/command-runs/op1/cancel", service: commandRunRouteService{cancelErr: pkgerrors.Forbidden("no")}, status: http.StatusForbidden},
	} {
		t.Run(test.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			commandRunRouter(&test.service).ServeHTTP(recorder, commandRunRouteRequest(test.method, test.path, "", true))
			require.Equal(t, test.status, recorder.Code, recorder.Body.String())
		})
	}
}

func TestWorkspaceCommandRunReadAndCancelRequireAuth(t *testing.T) {
	for _, methodAndPath := range []struct{ method, path string }{
		{http.MethodGet, "/api/repos/alice/demo/workspaces/ws1/command-runs/op1"},
		{http.MethodPost, "/api/repos/alice/demo/workspaces/ws1/command-runs/op1/cancel"},
	} {
		service := &commandRunRouteService{}
		recorder := httptest.NewRecorder()
		commandRunRouter(service).ServeHTTP(recorder, commandRunRouteRequest(methodAndPath.method, methodAndPath.path, "", false))
		require.Equal(t, http.StatusUnauthorized, recorder.Code, recorder.Body.String())
		require.Zero(t, service.getCalls)
		require.Zero(t, service.cancelCalls)
	}
}

func TestWorkspaceCommandRunCancelPendingReturnsAccepted(t *testing.T) {
	service := &commandRunRouteService{cancelState: jobs.StateRunning}
	recorder := httptest.NewRecorder()
	commandRunRouter(service).ServeHTTP(recorder, commandRunRouteRequest(http.MethodPost, "/api/repos/alice/demo/workspaces/ws1/command-runs/op1/cancel", "", true))
	require.Equal(t, http.StatusAccepted, recorder.Code, recorder.Body.String())
	require.JSONEq(t, `{"operationId":"op1","state":"running"}`, recorder.Body.String())
}
