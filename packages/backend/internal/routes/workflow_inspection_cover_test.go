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
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestWorkflowInspection_Cov_ListFiltersStatesAndHandlesErrors(t *testing.T) {
	h := WorkflowHandler{Service: &mockWorkflowInspectionRouteService{
		listWorkflowRunsByRepoFn: func(_ context.Context, repositoryID int64, page, perPage int) ([]db.WorkflowRun, error) {
			assert.Equal(t, int64(101), repositoryID)
			all := []db.WorkflowRun{
				makeWFRun(5, repositoryID, 14, "queued"),
				makeWFRun(4, repositoryID, 13, "running"),
				makeWFRun(3, repositoryID, 12, "canceled"),
				makeWFRun(2, repositoryID, 11, "error"),
				makeWFRun(1, repositoryID, 10, "completed"),
			}
			start := (page - 1) * perPage
			if start >= len(all) {
				return nil, nil
			}
			end := start + perPage
			if end > len(all) {
				end = len(all)
			}
			return all[start:end], nil
		},
		listWorkflowDefinitionsFn: func(_ context.Context, repositoryID int64, page, perPage int) ([]db.WorkflowDefinition, error) {
			assert.Equal(t, 1, page)
			assert.Equal(t, workflowDefinitionLookupLimit, perPage)
			return []db.WorkflowDefinition{
				makeWFDef(10, repositoryID, "build"),
				makeWFDef(11, repositoryID, "lint"),
				makeWFDef(12, repositoryID, "deploy"),
			}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workflows/runs?cursor=2&limit=2&state=finished", nil)
	req = withRepoContext(req, "alice", "demo")
	rec := httptest.NewRecorder()
	h.ListWorkflowRunsV2(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	var body listWorkflowRunsInspectionResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Len(t, body.Runs, 1)
	assert.Equal(t, "success", normalizeWorkflowState(body.Runs[0].Status))
	assert.Equal(t, "build", body.Runs[0].WorkflowName)

	badLimitReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workflows/runs?limit=bad", nil)
	badLimitReq = withRepoContext(badLimitReq, "alice", "demo")
	badLimitRec := httptest.NewRecorder()
	h.ListWorkflowRunsV2(badLimitRec, badLimitReq)
	require.Equal(t, http.StatusBadRequest, badLimitRec.Code)

	noRepoReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workflows/runs", nil)
	noRepoRec := httptest.NewRecorder()
	h.ListWorkflowRunsV2(noRepoRec, noRepoReq)
	require.Equal(t, http.StatusInternalServerError, noRepoRec.Code)

	nilServiceReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workflows/runs", nil)
	nilServiceReq = withRepoContext(nilServiceReq, "alice", "demo")
	nilServiceRec := httptest.NewRecorder()
	(&WorkflowHandler{}).ListWorkflowRunsV2(nilServiceRec, nilServiceReq)
	require.Equal(t, http.StatusInternalServerError, nilServiceRec.Code)
}

func TestWorkflowInspection_Cov_GetRunAndNodeErrorBranches(t *testing.T) {
	nilReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workflows/runs/1", nil)
	nilReq = withRepoContext(nilReq, "alice", "demo")
	nilReq = withRouteParams(nilReq, map[string]string{"id": "1"})
	nilRec := httptest.NewRecorder()
	(&WorkflowHandler{}).GetWorkflowRunV2(nilRec, nilReq)
	require.Equal(t, http.StatusInternalServerError, nilRec.Code)

	invalidReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workflows/runs/nope", nil)
	invalidReq = withRepoContext(invalidReq, "alice", "demo")
	invalidReq = withRouteParams(invalidReq, map[string]string{"id": "nope"})
	invalidRec := httptest.NewRecorder()
	(&WorkflowHandler{Service: &mockWorkflowInspectionRouteService{}}).GetWorkflowRunV2(invalidRec, invalidReq)
	require.Equal(t, http.StatusBadRequest, invalidRec.Code)

	missingNodeHandler := WorkflowHandler{Service: &mockWorkflowInspectionRouteService{
		getWorkflowRunFn: func(_ context.Context, repositoryID, runID int64) (db.WorkflowRun, error) {
			return makeWFRun(runID, repositoryID, 20, "running"), nil
		},
		getWorkflowDefinitionFn: func(_ context.Context, repositoryID, definitionID int64) (db.WorkflowDefinition, error) {
			return makeWFDef(definitionID, repositoryID, "build"), nil
		},
		listWorkflowStepsFn: func(_ context.Context, runID int64) ([]db.WorkflowStep, error) {
			return []db.WorkflowStep{{ID: 101, WorkflowRunID: runID, Name: "compile", Status: "success"}}, nil
		},
		listWorkflowLogsSinceFn: func(_ context.Context, runID, afterID int64, limit int32) ([]db.WorkflowLog, error) {
			return nil, pkgerrors.Forbidden("logs disabled")
		},
	}}

	blankNodeReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workflows/runs/9/nodes/%20", nil)
	blankNodeReq = withRepoContext(blankNodeReq, "alice", "demo")
	blankNodeReq = withRouteParams(blankNodeReq, map[string]string{"id": "9", "nodeId": "   "})
	blankNodeRec := httptest.NewRecorder()
	missingNodeHandler.GetWorkflowRunNode(blankNodeRec, blankNodeReq)
	require.Equal(t, http.StatusBadRequest, blankNodeRec.Code)

	missingNodeReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workflows/runs/9/nodes/test", nil)
	missingNodeReq = withRepoContext(missingNodeReq, "alice", "demo")
	missingNodeReq = withRouteParams(missingNodeReq, map[string]string{"id": "9", "nodeId": "test"})
	missingNodeRec := httptest.NewRecorder()
	missingNodeHandler.GetWorkflowRunNode(missingNodeRec, missingNodeReq)
	require.Equal(t, http.StatusNotFound, missingNodeRec.Code)

	logErrReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workflows/runs/9/nodes/compile", nil)
	logErrReq = withRepoContext(logErrReq, "alice", "demo")
	logErrReq = withRouteParams(logErrReq, map[string]string{"id": "9", "nodeId": "compile"})
	logErrRec := httptest.NewRecorder()
	missingNodeHandler.GetWorkflowRunNode(logErrRec, logErrReq)
	require.Equal(t, http.StatusForbidden, logErrRec.Code)

	noRepoReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workflows/runs/9/nodes/compile", nil)
	noRepoReq = withRouteParams(noRepoReq, map[string]string{"id": "9", "nodeId": "compile"})
	noRepoRec := httptest.NewRecorder()
	missingNodeHandler.GetWorkflowRunNode(noRepoRec, noRepoReq)
	require.Equal(t, http.StatusInternalServerError, noRepoRec.Code)
}

func TestWorkflowInspection_Cov_DispatchIdentifierBranches(t *testing.T) {
	var gotInput services.DispatchForEventInput
	h := WorkflowHandler{Service: &mockWorkflowInspectionRouteService{
		getWorkflowDefinitionFn: func(_ context.Context, repositoryID, definitionID int64) (db.WorkflowDefinition, error) {
			assert.Equal(t, int64(101), repositoryID)
			assert.Equal(t, int64(44), definitionID)
			def := makeWFDef(definitionID, repositoryID, "release")
			def.Config = json.RawMessage(`{"on":{"workflow_dispatch":{"inputs":{"target":{"required":false,"default":"staging"}}}},"jobs":{}}`)
			return def, nil
		},
		dispatchForEventFn: func(_ context.Context, input services.DispatchForEventInput) ([]services.WorkflowRunResult, error) {
			gotInput = input
			return []services.WorkflowRunResult{{WorkflowDefinitionID: 44, WorkflowRunID: 900}}, nil
		},
		listWorkflowDefinitionsFn: func(_ context.Context, repositoryID int64, page, perPage int) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{makeWFDef(45, repositoryID, "nightly")}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workflows/44/dispatch", strings.NewReader(`{"inputs":{}}`))
	req = withRepoContext(req, "alice", "demo")
	req = withRouteParams(req, map[string]string{"name": "44"})
	req = withAuth(req, 5, "alice")
	rec := httptest.NewRecorder()
	h.DispatchWorkflowByIdentifier(rec, req)
	require.Equal(t, http.StatusCreated, rec.Code)
	require.NotNil(t, gotInput.WorkflowDefinitionID)
	assert.Equal(t, int64(44), *gotInput.WorkflowDefinitionID)
	assert.Equal(t, "main", gotInput.Event.Ref)
	assert.Equal(t, "staging", gotInput.Event.Inputs["target"])

	resolved, err := h.resolveWorkflowDefinitionIdentifier(context.Background(), 101, ".smithers/workflows/nightly.tsx")
	require.NoError(t, err)
	assert.Equal(t, int64(45), resolved.ID)
	resolved, err = h.resolveWorkflowDefinitionIdentifier(context.Background(), 101, "NIGHTLY")
	require.NoError(t, err)
	assert.Equal(t, int64(45), resolved.ID)
	_, err = h.resolveWorkflowDefinitionIdentifier(context.Background(), 101, "missing")
	require.Error(t, err)

	noAuthReq := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workflows/44/dispatch", strings.NewReader(`{}`))
	noAuthReq = withRepoContext(noAuthReq, "alice", "demo")
	noAuthReq = withRouteParams(noAuthReq, map[string]string{"name": "44"})
	noAuthRec := httptest.NewRecorder()
	h.DispatchWorkflowByIdentifier(noAuthRec, noAuthReq)
	require.Equal(t, http.StatusUnauthorized, noAuthRec.Code)

	badBodyReq := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workflows/44/dispatch", strings.NewReader(`not-json`))
	badBodyReq = withRepoContext(badBodyReq, "alice", "demo")
	badBodyReq = withRouteParams(badBodyReq, map[string]string{"name": "44"})
	badBodyReq = withAuth(badBodyReq, 5, "alice")
	badBodyRec := httptest.NewRecorder()
	h.DispatchWorkflowByIdentifier(badBodyRec, badBodyReq)
	require.Equal(t, http.StatusBadRequest, badBodyRec.Code)
}

func TestWorkflowInspection_Cov_HelperBranches(t *testing.T) {
	assert.True(t, workflowRunMatchesState("success", "finished"))
	assert.True(t, workflowRunMatchesState("failed", "terminal"))
	assert.True(t, workflowRunMatchesState("in-progress", "running"))
	assert.True(t, workflowRunMatchesState("queued", ""))
	assert.False(t, workflowRunMatchesState("running", "finished"))
	assert.Equal(t, "unknown", normalizeWorkflowState(" UNKNOWN "))

	value, apiErr := parsePositiveInt64Param("42", "bad id")
	require.Nil(t, apiErr)
	assert.Equal(t, int64(42), value)
	_, apiErr = parsePositiveInt64Param("0", "bad id")
	require.NotNil(t, apiErr)

	def := makeWFDef(8, 101, "Deploy")
	def.Path = ".smithers/workflows/deploy-prod.yaml"
	assert.True(t, workflowIdentifierMatches(def, "deploy"))
	assert.True(t, workflowIdentifierMatches(def, "deploy-prod"))
	assert.True(t, workflowIdentifierMatches(def, ".smithers/workflows/deploy-prod.yaml"))
	assert.False(t, workflowIdentifierMatches(def, " "))

	started := time.Date(2026, 7, 6, 12, 0, 0, 0, time.UTC)
	completed := started.Add(125 * time.Second)
	assert.Nil(t, timestamptzPtr(pgtype.Timestamptz{}))
	assert.Equal(t, started, *timestamptzPtr(pgtype.Timestamptz{Time: started, Valid: true}))
	seconds, label := formatWorkflowDuration(&started, &completed)
	assert.Equal(t, int64(125), seconds)
	assert.Equal(t, "2m 5s", label)
	seconds, label = formatWorkflowDuration(nil, &completed)
	assert.Zero(t, seconds)
	assert.Empty(t, label)
	before := started.Add(-time.Second)
	seconds, label = formatWorkflowDuration(&started, &before)
	assert.Zero(t, seconds)
	assert.Empty(t, label)

	steps := []db.WorkflowStep{{
		ID:          77,
		Name:        "build|quote\nstep",
		Position:    1,
		Status:      "running",
		StartedAt:   pgtype.Timestamptz{Time: started, Valid: true},
		CompletedAt: pgtype.Timestamptz{Time: completed, Valid: true},
	}}
	nodes := buildWorkflowRunNodes(steps)
	require.Len(t, nodes, 1)
	assert.True(t, workflowNodeMatches(steps[0], "77"))
	assert.True(t, workflowNodeMatches(steps[0], "BUILD|QUOTE\nSTEP"))
	assert.False(t, workflowNodeMatches(steps[0], " "))

	mermaid := buildWorkflowRunMermaid(nodes)
	assert.Contains(t, mermaid, "graph TD")
	assert.Contains(t, mermaid, "fill:#3b82f6")
	assert.Equal(t, "graph TD\n", buildWorkflowRunMermaid(nil))
	assert.Equal(t, "#22c55e", workflowNodeFillColor("complete"))
	assert.Equal(t, "#ef4444", workflowNodeFillColor("error"))
	assert.Equal(t, "#9ca3af", workflowNodeFillColor("canceled"))
	assert.Equal(t, "#6b7280", workflowNodeFillColor("pending"))
	assert.Equal(t, "#94a3b8", workflowNodeFillColor("blocked"))

	xml := buildWorkflowPlanXML(def, makeWFRun(99, 101, def.ID, "running"), nodes)
	assert.Contains(t, xml, `name="Deploy"`)
	assert.Contains(t, xml, `step_id="77"`)

	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", "99")
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workflows/runs/99", nil)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	req = withRepoContext(req, "alice", "demo")
	resp, err := (&WorkflowHandler{Service: &mockWorkflowInspectionRouteService{
		getWorkflowRunFn: func(_ context.Context, repositoryID, runID int64) (db.WorkflowRun, error) {
			return makeWFRun(runID, repositoryID, def.ID, "running"), nil
		},
		getWorkflowDefinitionFn: func(_ context.Context, repositoryID, definitionID int64) (db.WorkflowDefinition, error) {
			return def, nil
		},
		listWorkflowStepsFn: func(_ context.Context, runID int64) ([]db.WorkflowStep, error) {
			return steps, nil
		},
	}}).buildWorkflowRunInspectionResponse(context.Background(), req)
	require.NoError(t, err)
	assert.Equal(t, int64(99), resp.Run.ID)
	require.Len(t, resp.Nodes, 1)
}
