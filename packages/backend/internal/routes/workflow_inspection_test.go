package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type mockWorkflowInspectionRouteService struct {
	listWorkflowDefinitionsFn func(ctx context.Context, repositoryID int64, page, perPage int) ([]db.WorkflowDefinition, error)
	getWorkflowDefinitionFn   func(ctx context.Context, repositoryID, definitionID int64) (db.WorkflowDefinition, error)
	listWorkflowRunsByRepoFn  func(ctx context.Context, repositoryID int64, page, perPage int) ([]db.WorkflowRun, error)
	getWorkflowRunFn          func(ctx context.Context, repositoryID, runID int64) (db.WorkflowRun, error)
	dispatchForEventFn        func(ctx context.Context, input services.DispatchForEventInput) ([]services.WorkflowRunResult, error)
	resumeRunFn               func(ctx context.Context, repositoryID, runID int64) error
	listWorkflowStepsFn       func(ctx context.Context, runID int64) ([]db.WorkflowStep, error)
	listWorkflowLogsSinceFn   func(ctx context.Context, runID, afterID int64, limit int32) ([]db.WorkflowLog, error)
}

func (m *mockWorkflowInspectionRouteService) ListWorkflowDefinitions(ctx context.Context, repositoryID int64, page, perPage int) ([]db.WorkflowDefinition, error) {
	if m.listWorkflowDefinitionsFn != nil {
		return m.listWorkflowDefinitionsFn(ctx, repositoryID, page, perPage)
	}
	return nil, nil
}

func (m *mockWorkflowInspectionRouteService) GetWorkflowDefinition(ctx context.Context, repositoryID, definitionID int64) (db.WorkflowDefinition, error) {
	if m.getWorkflowDefinitionFn != nil {
		return m.getWorkflowDefinitionFn(ctx, repositoryID, definitionID)
	}
	return db.WorkflowDefinition{}, nil
}

func (m *mockWorkflowInspectionRouteService) ListWorkflowRunsByRepo(ctx context.Context, repositoryID int64, page, perPage int) ([]db.WorkflowRun, error) {
	if m.listWorkflowRunsByRepoFn != nil {
		return m.listWorkflowRunsByRepoFn(ctx, repositoryID, page, perPage)
	}
	return nil, nil
}

func (m *mockWorkflowInspectionRouteService) ListWorkflowRunsByDefinition(_ context.Context, _, _ int64, _, _ int) ([]db.WorkflowRun, error) {
	return nil, nil
}

func (m *mockWorkflowInspectionRouteService) GetWorkflowRun(ctx context.Context, repositoryID, runID int64) (db.WorkflowRun, error) {
	if m.getWorkflowRunFn != nil {
		return m.getWorkflowRunFn(ctx, repositoryID, runID)
	}
	return db.WorkflowRun{}, nil
}

func (m *mockWorkflowInspectionRouteService) CancelWorkflowRun(_ context.Context, _, _ int64) error {
	return nil
}

func (m *mockWorkflowInspectionRouteService) DispatchForEvent(ctx context.Context, input services.DispatchForEventInput) ([]services.WorkflowRunResult, error) {
	if m.dispatchForEventFn != nil {
		return m.dispatchForEventFn(ctx, input)
	}
	return nil, nil
}
func (m *mockWorkflowInspectionRouteService) InvokeWorkflow(ctx context.Context, input services.InvokeWorkflowInput) (*services.InvokeWorkflowResult, error) {
	return nil, nil
}

func (m *mockWorkflowInspectionRouteService) RerunRun(_ context.Context, _ services.RerunInput) (*services.WorkflowRunResult, error) {
	return nil, nil
}

func (m *mockWorkflowInspectionRouteService) ResumeRun(ctx context.Context, repositoryID, runID int64) error {
	if m.resumeRunFn != nil {
		return m.resumeRunFn(ctx, repositoryID, runID)
	}
	return nil
}

func (m *mockWorkflowInspectionRouteService) ListWorkflowSteps(ctx context.Context, runID int64) ([]db.WorkflowStep, error) {
	if m.listWorkflowStepsFn != nil {
		return m.listWorkflowStepsFn(ctx, runID)
	}
	return nil, nil
}

func (m *mockWorkflowInspectionRouteService) ListWorkflowLogsSince(ctx context.Context, runID, afterID int64, limit int32) ([]db.WorkflowLog, error) {
	if m.listWorkflowLogsSinceFn != nil {
		return m.listWorkflowLogsSinceFn(ctx, runID, afterID, limit)
	}
	return nil, nil
}

func TestWorkflowHandler_ListWorkflowRunsV2_ReturnsEnhancedRuns(t *testing.T) {
	t.Parallel()

	h := WorkflowHandler{Service: &mockWorkflowInspectionRouteService{
		listWorkflowRunsByRepoFn: func(_ context.Context, repositoryID int64, page, perPage int) ([]db.WorkflowRun, error) {
			assert.Equal(t, int64(101), repositoryID)
			assert.Equal(t, 1, page)
			assert.Equal(t, 30, perPage)
			return []db.WorkflowRun{
				makeWFRun(7, 101, 3, "running"),
			}, nil
		},
		listWorkflowDefinitionsFn: func(_ context.Context, repositoryID int64, page, perPage int) ([]db.WorkflowDefinition, error) {
			assert.Equal(t, int64(101), repositoryID)
			return []db.WorkflowDefinition{
				makeWFDef(3, 101, "dev-cycle"),
			}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workflows/runs", nil)
	req = withRepoContext(req, "alice", "demo")
	rec := httptest.NewRecorder()

	h.ListWorkflowRunsV2(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var resp listWorkflowRunsInspectionResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	require.Len(t, resp.Runs, 1)
	assert.Equal(t, "dev-cycle", resp.Runs[0].WorkflowName)
	assert.Equal(t, ".smithers/workflows/dev-cycle.tsx", resp.Runs[0].WorkflowPath)
}

func TestListWorkflowRunsFiltersBeforePagination(t *testing.T) {
	t.Parallel()

	// Newest first; neither the first database page nor the second consists
	// entirely of matching runs.
	all := []db.WorkflowRun{
		makeWFRun(7, 101, 3, "success"),
		makeWFRun(6, 101, 3, "success"),
		makeWFRun(5, 101, 3, "failed"),
		makeWFRun(4, 101, 3, "running"),
		makeWFRun(3, 101, 3, "failure"),
		makeWFRun(2, 101, 3, "success"),
		makeWFRun(1, 101, 3, "error"),
	}
	h := WorkflowHandler{Service: &mockWorkflowInspectionRouteService{
		listWorkflowRunsByRepoFn: func(_ context.Context, _ int64, page, perPage int) ([]db.WorkflowRun, error) {
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
	}}

	for _, tc := range []struct {
		query string
		want  []int64
	}{
		{"state=failure&limit=2", []int64{5, 3}},
		{"state=failed&limit=2&cursor=2", []int64{1}},
		{"state=failure&limit=2&cursor=4", nil},
		{"state=terminal&limit=2&cursor=2", []int64{5, 3}},
		{"limit=2", []int64{7, 6}},
	} {
		t.Run(tc.query, func(t *testing.T) {
			req := withRepoContext(httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workflows/runs?"+tc.query, nil), "alice", "demo")
			rec := httptest.NewRecorder()
			h.ListWorkflowRunsV2(rec, req)
			require.Equal(t, http.StatusOK, rec.Code)
			var resp listWorkflowRunsInspectionResponse
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
			ids := make([]int64, 0, len(resp.Runs))
			for _, run := range resp.Runs {
				ids = append(ids, run.ID)
			}
			if tc.want == nil {
				require.Empty(t, ids)
			} else {
				require.Equal(t, tc.want, ids)
			}
		})
	}
}

func TestWorkflowHandler_GetWorkflowRunV2_ReturnsNodesGraphAndPlan(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC()
	h := WorkflowHandler{Service: &mockWorkflowInspectionRouteService{
		getWorkflowRunFn: func(_ context.Context, repositoryID, runID int64) (db.WorkflowRun, error) {
			assert.Equal(t, int64(101), repositoryID)
			assert.Equal(t, int64(7), runID)
			run := makeWFRun(7, 101, 3, "running")
			run.StartedAt.Time = now
			run.StartedAt.Valid = true
			return run, nil
		},
		getWorkflowDefinitionFn: func(_ context.Context, repositoryID, definitionID int64) (db.WorkflowDefinition, error) {
			assert.Equal(t, int64(101), repositoryID)
			assert.Equal(t, int64(3), definitionID)
			return makeWFDef(3, 101, "dev-cycle"), nil
		},
		listWorkflowStepsFn: func(_ context.Context, runID int64) ([]db.WorkflowStep, error) {
			assert.Equal(t, int64(7), runID)
			return []db.WorkflowStep{
				{ID: 11, WorkflowRunID: 7, Name: "research", Position: 1, Status: "success"},
				{ID: 12, WorkflowRunID: 7, Name: "review", Position: 2, Status: "running"},
			}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workflows/runs/7", nil)
	req = withRepoContext(req, "alice", "demo")
	req = withRouteParams(req, map[string]string{"id": "7"})
	rec := httptest.NewRecorder()

	h.GetWorkflowRunV2(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var resp workflowRunInspectionResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	assert.Equal(t, int64(7), resp.Run.ID)
	require.Len(t, resp.Nodes, 2)
	assert.Equal(t, "research", resp.Nodes[0].Name)
	assert.Contains(t, resp.Mermaid, "graph TD")
	assert.Contains(t, resp.PlanXML, "<workflow")
}

func TestWorkflowHandler_GetWorkflowRunNode_ByNameReturnsLogs(t *testing.T) {
	t.Parallel()

	h := WorkflowHandler{Service: &mockWorkflowInspectionRouteService{
		getWorkflowRunFn: func(_ context.Context, repositoryID, runID int64) (db.WorkflowRun, error) {
			assert.Equal(t, int64(101), repositoryID)
			assert.Equal(t, int64(7), runID)
			return makeWFRun(7, 101, 3, "running"), nil
		},
		getWorkflowDefinitionFn: func(_ context.Context, repositoryID, definitionID int64) (db.WorkflowDefinition, error) {
			assert.Equal(t, int64(3), definitionID)
			return makeWFDef(3, 101, "dev-cycle"), nil
		},
		listWorkflowStepsFn: func(_ context.Context, runID int64) ([]db.WorkflowStep, error) {
			assert.Equal(t, int64(7), runID)
			return []db.WorkflowStep{
				{ID: 22, WorkflowRunID: 7, Name: "implement", Position: 2, Status: "running"},
			}, nil
		},
		listWorkflowLogsSinceFn: func(_ context.Context, runID, afterID int64, limit int32) ([]db.WorkflowLog, error) {
			assert.Equal(t, int64(7), runID)
			assert.Equal(t, int64(0), afterID)
			assert.Equal(t, workflowNodeLogsLimit, limit)
			return []db.WorkflowLog{
				{ID: 1, WorkflowRunID: 7, WorkflowStepID: 22, Sequence: 1, Stream: "stdout", Entry: "reading"},
				{ID: 2, WorkflowRunID: 7, WorkflowStepID: 22, Sequence: 2, Stream: "stdout", Entry: "writing"},
			}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workflows/runs/7/nodes/implement", nil)
	req = withRepoContext(req, "alice", "demo")
	req = withRouteParams(req, map[string]string{"id": "7", "nodeId": "implement"})
	rec := httptest.NewRecorder()

	h.GetWorkflowRunNode(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var resp workflowRunNodeDetailResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	assert.Equal(t, int64(7), resp.RunID)
	assert.Equal(t, "implement", resp.Node.Name)
	require.Len(t, resp.Logs, 2)
	assert.Equal(t, "reading", resp.Logs[0].Entry)
}

func TestWorkflowHandler_GetWorkflowRunNode_PaginatesPastNoisyEarlierStep(t *testing.T) {
	t.Parallel()

	callCount := 0
	h := WorkflowHandler{Service: &mockWorkflowInspectionRouteService{
		getWorkflowRunFn: func(_ context.Context, repositoryID, runID int64) (db.WorkflowRun, error) {
			return makeWFRun(7, 101, 3, "running"), nil
		},
		getWorkflowDefinitionFn: func(_ context.Context, repositoryID, definitionID int64) (db.WorkflowDefinition, error) {
			return makeWFDef(3, 101, "dev-cycle"), nil
		},
		listWorkflowStepsFn: func(_ context.Context, runID int64) ([]db.WorkflowStep, error) {
			return []db.WorkflowStep{
				{ID: 21, WorkflowRunID: 7, Name: "noisy", Position: 1, Status: "succeeded"},
				{ID: 22, WorkflowRunID: 7, Name: "implement", Position: 2, Status: "running"},
			}, nil
		},
		listWorkflowLogsSinceFn: func(_ context.Context, runID, afterID int64, limit int32) ([]db.WorkflowLog, error) {
			callCount++
			switch afterID {
			case 0:
				logs := make([]db.WorkflowLog, int(workflowNodeLogsLimit))
				for i := range logs {
					id := int64(i + 1)
					logs[i] = db.WorkflowLog{ID: id, WorkflowRunID: 7, WorkflowStepID: 21, Sequence: id, Stream: "stdout", Entry: "noise"}
				}
				return logs, nil
			case int64(workflowNodeLogsLimit):
				return []db.WorkflowLog{
					{ID: int64(workflowNodeLogsLimit) + 1, WorkflowRunID: 7, WorkflowStepID: 22, Sequence: 1, Stream: "stdout", Entry: "step-b-log"},
				}, nil
			default:
				t.Fatalf("unexpected afterID %d", afterID)
				return nil, nil
			}
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workflows/runs/7/nodes/implement", nil)
	req = withRepoContext(req, "alice", "demo")
	req = withRouteParams(req, map[string]string{"id": "7", "nodeId": "implement"})
	rec := httptest.NewRecorder()

	h.GetWorkflowRunNode(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var resp workflowRunNodeDetailResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	require.Len(t, resp.Logs, 1)
	assert.Equal(t, "step-b-log", resp.Logs[0].Entry)
	assert.GreaterOrEqual(t, callCount, 2)
}

func TestWorkflowHandler_DispatchWorkflowByIdentifier_ResolvesWorkflowName(t *testing.T) {
	t.Parallel()

	var dispatched services.DispatchForEventInput
	h := WorkflowHandler{Service: &mockWorkflowInspectionRouteService{
		listWorkflowDefinitionsFn: func(_ context.Context, repositoryID int64, page, perPage int) ([]db.WorkflowDefinition, error) {
			assert.Equal(t, int64(101), repositoryID)
			assert.Equal(t, 1, page)
			assert.Equal(t, workflowDefinitionLookupLimit, perPage)
			def := makeWFDef(3, 101, "dev-cycle")
			def.Config = json.RawMessage(`{"on":{"workflow_dispatch":{"inputs":{"issue":{"required":true}}}},"jobs":{}}`)
			return []db.WorkflowDefinition{def}, nil
		},
		dispatchForEventFn: func(_ context.Context, input services.DispatchForEventInput) ([]services.WorkflowRunResult, error) {
			dispatched = input
			return []services.WorkflowRunResult{{WorkflowDefinitionID: 3, WorkflowRunID: 11}}, nil
		},
	}}

	req := httptest.NewRequest(
		http.MethodPost,
		"/api/repos/alice/demo/workflows/dev-cycle/dispatch",
		strings.NewReader(`{"ref":"main","inputs":{"issue":"JJH-157"}}`),
	)
	req = withRepoContext(req, "alice", "demo")
	req = withRouteParams(req, map[string]string{"name": "dev-cycle"})
	req = withAuth(req, 7, "alice")
	rec := httptest.NewRecorder()

	h.DispatchWorkflowByIdentifier(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
	require.NotNil(t, dispatched.WorkflowDefinitionID)
	assert.Equal(t, int64(3), *dispatched.WorkflowDefinitionID)
	assert.Equal(t, "workflow_dispatch", dispatched.Event.Type)
	assert.Equal(t, "JJH-157", dispatched.Event.Inputs["issue"])

	var resp dispatchResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	require.Len(t, resp.Runs, 1)
	assert.Equal(t, int64(11), resp.Runs[0].WorkflowRunID)
	assert.Equal(t, int64(3), resp.Runs[0].WorkflowDefinitionID)
}

func TestWorkflowHandler_ResumeWorkflowRun_Success(t *testing.T) {
	t.Parallel()

	var resumedRepoID, resumedRunID int64
	h := WorkflowHandler{Service: &mockWorkflowInspectionRouteService{
		resumeRunFn: func(_ context.Context, repositoryID, runID int64) error {
			resumedRepoID = repositoryID
			resumedRunID = runID
			return nil
		},
	}}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workflows/runs/5/resume", nil)
	req = withRepoContext(req, "alice", "demo")
	req = withRouteParams(req, map[string]string{"id": "5"})
	rec := httptest.NewRecorder()

	h.ResumeWorkflowRun(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Equal(t, int64(101), resumedRepoID)
	assert.Equal(t, int64(5), resumedRunID)
}

func TestWorkflowHandler_ResumeWorkflowRun_ServiceError(t *testing.T) {
	t.Parallel()

	h := WorkflowHandler{Service: &mockWorkflowInspectionRouteService{
		resumeRunFn: func(_ context.Context, _, _ int64) error {
			return pkgerrors.Conflict("cannot resume workflow run with status \"running\"")
		},
	}}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workflows/runs/5/resume", nil)
	req = withRepoContext(req, "alice", "demo")
	req = withRouteParams(req, map[string]string{"id": "5"})
	rec := httptest.NewRecorder()

	h.ResumeWorkflowRun(rec, req)

	require.Equal(t, http.StatusConflict, rec.Code)
	assert.Contains(t, rec.Body.String(), "running")
}

func (m *mockWorkflowInspectionRouteService) GetWorkflowLogStreamHead(context.Context, int64) (int64, error) {
	return 0, nil
}
