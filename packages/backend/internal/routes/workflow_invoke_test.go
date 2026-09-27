package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestWorkflowHandler_InvokeWorkflow_Created(t *testing.T) {
	t.Parallel()
	var captured services.InvokeWorkflowInput
	h := WorkflowHandler{Service: &mockWorkflowRouteService{
		invokeWorkflowFn: func(_ context.Context, input services.InvokeWorkflowInput) (*services.InvokeWorkflowResult, error) {
			captured = input
			return &services.InvokeWorkflowResult{
				Run: db.WorkflowRun{
					ID:                   42,
					RepositoryID:         input.RepositoryID,
					WorkflowDefinitionID: 11,
					Status:               "queued",
					TriggerEvent:         services.InvokeTriggerEvent,
					TriggerRef:           input.TriggerRef,
				},
				Definition: db.WorkflowDefinition{
					ID:   11,
					Name: "echo",
					Path: ".smithers/workflows/echo.tsx",
				},
			}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/invoke",
		strings.NewReader(`{"flow":"echo","input":{"goal":"hi"},"trigger":"webhook"}`))
	req = withRepoContextAndBookmark(req, "alice", "demo", "main")
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.InvokeWorkflow(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
	assert.Equal(t, int64(101), captured.RepositoryID)
	assert.Equal(t, "echo", captured.Identifier)
	assert.Equal(t, "main", captured.TriggerRef)
	assert.Equal(t, map[string]interface{}{"goal": "hi"}, captured.Input)

	var body invokeWorkflowResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, int64(42), body.RunID)
	assert.Equal(t, int64(42), body.ID)
	assert.Equal(t, "queued", body.Status)
	assert.Equal(t, "echo", body.Flow)
	assert.Equal(t, ".smithers/workflows/echo.tsx", body.Path)
}

func TestWorkflowHandler_InvokeWorkflow_UnknownFlowIsNotFound(t *testing.T) {
	t.Parallel()
	h := WorkflowHandler{Service: &mockWorkflowRouteService{}}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/invoke", strings.NewReader(`{"flow":"missing"}`))
	req = withRepoContextAndBookmark(req, "alice", "demo", "main")
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.InvokeWorkflow(rec, req)
	assert.Equal(t, http.StatusNotFound, rec.Code)
}

func TestWorkflowHandler_InvokeWorkflow_RejectsMalformedBody(t *testing.T) {
	t.Parallel()
	h := WorkflowHandler{Service: &mockWorkflowRouteService{}}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/invoke", strings.NewReader(`{`))
	req = withRepoContextAndBookmark(req, "alice", "demo", "main")
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.InvokeWorkflow(rec, req)
	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestWorkflowHandler_GetWorkflowRunStatus(t *testing.T) {
	t.Parallel()
	started := time.Now().Add(-time.Minute)
	h := WorkflowHandler{Service: &mockWorkflowRouteService{
		getWorkflowRunFn: func(_ context.Context, repositoryID, runID int64) (db.WorkflowRun, error) {
			require.Equal(t, int64(42), runID)
			return db.WorkflowRun{
				ID:                   42,
				RepositoryID:         repositoryID,
				WorkflowDefinitionID: 11,
				Status:               "success",
				TriggerEvent:         "invoke",
				StartedAt:            pgtype.Timestamptz{Time: started, Valid: true},
			}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/runs/42/status", nil)
	req = withRepoContext(req, "alice", "demo")
	req = withAuth(req, 1, "alice")
	req = withRouteParams(req, map[string]string{"id": "42"})
	rec := httptest.NewRecorder()
	h.GetWorkflowRunStatus(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var body workflowRunStatusResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, int64(42), body.RunID)
	assert.Equal(t, "success", body.Status)
	assert.Equal(t, "invoke", body.TriggerEvent)
	require.NotNil(t, body.StartedAt)
	assert.Nil(t, body.CompletedAt)
}

func TestWorkflowHandler_GetWorkflowRunStatus_InvalidID(t *testing.T) {
	t.Parallel()
	h := WorkflowHandler{Service: &mockWorkflowRouteService{}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/runs/nope/status", nil)
	req = withRepoContext(req, "alice", "demo")
	req = withAuth(req, 1, "alice")
	req = withRouteParams(req, map[string]string{"id": "nope"})
	rec := httptest.NewRecorder()
	h.GetWorkflowRunStatus(rec, req)
	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestWorkflowHandler_GetWorkflowRunStatus_NotFound(t *testing.T) {
	t.Parallel()
	h := WorkflowHandler{Service: &mockWorkflowRouteService{}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/runs/42/status", nil)
	req = withRepoContext(req, "alice", "demo")
	req = withAuth(req, 1, "alice")
	req = withRouteParams(req, map[string]string{"id": "42"})
	rec := httptest.NewRecorder()
	h.GetWorkflowRunStatus(rec, req)
	assert.Equal(t, http.StatusNotFound, rec.Code)
}
