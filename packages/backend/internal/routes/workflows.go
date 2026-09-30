package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// WorkflowRouteService is the service interface used by the workflow HTTP handler.
// It includes ListWorkflowSteps and ListWorkflowLogsSince so WorkflowHandler.Service
// can be wired directly as WorkflowRunHandler.Service without a runtime type assertion.
type WorkflowRouteService interface {
	GetWorkflowLogStreamHead(context.Context, int64) (int64, error)
	ListWorkflowDefinitions(ctx context.Context, repositoryID int64, page, perPage int) ([]db.WorkflowDefinition, error)
	GetWorkflowDefinition(ctx context.Context, repositoryID, definitionID int64) (db.WorkflowDefinition, error)
	ListWorkflowRunsByRepo(ctx context.Context, repositoryID int64, page, perPage int) ([]db.WorkflowRun, error)
	ListWorkflowRunsByDefinition(ctx context.Context, repositoryID, definitionID int64, page, perPage int) ([]db.WorkflowRun, error)
	GetWorkflowRun(ctx context.Context, repositoryID, runID int64) (db.WorkflowRun, error)
	CancelWorkflowRun(ctx context.Context, repositoryID, runID int64) error
	ResumeRun(ctx context.Context, repositoryID, runID int64) error
	DispatchForEvent(ctx context.Context, input services.DispatchForEventInput) ([]services.WorkflowRunResult, error)
	InvokeWorkflow(ctx context.Context, input services.InvokeWorkflowInput) (*services.InvokeWorkflowResult, error)
	RerunRun(ctx context.Context, input services.RerunInput) (*services.WorkflowRunResult, error)
	ListWorkflowSteps(ctx context.Context, runID int64) ([]db.WorkflowStep, error)
	ListWorkflowLogsSince(ctx context.Context, runID, afterID int64, limit int32) ([]db.WorkflowLog, error)
}

// WorkflowHandler handles workflow execution HTTP routes.
type WorkflowHandler struct {
	Service WorkflowRouteService
}

// workflowDefinitionResponse is the JSON response for a workflow definition.
type workflowDefinitionResponse struct {
	ID           int64           `json:"id"`
	RepositoryID int64           `json:"repository_id"`
	Name         string          `json:"name"`
	Path         string          `json:"path"`
	Config       json.RawMessage `json:"config"`
	IsActive     bool            `json:"is_active"`
	CreatedAt    time.Time       `json:"created_at"`
	UpdatedAt    time.Time       `json:"updated_at"`
}

// workflowRunResponse is the JSON response for a workflow run.
type workflowRunResponse struct {
	ID                   int64  `json:"id"`
	RepositoryID         int64  `json:"repository_id"`
	WorkflowDefinitionID int64  `json:"workflow_definition_id"`
	Status               string `json:"status"`
	TriggerEvent         string `json:"trigger_event"`
	TriggerRef           string `json:"trigger_ref"`
	TriggerCommitSha     string `json:"trigger_commit_sha"`
	// ExecutionPlane names the machine the run executed on: "sandbox" is a
	// NixOS kind=vm guest booted from the repository's closure image,
	// "runner" the Debian gVisor runner pool, "agent" an agent session. It is
	// fixed at run creation and never changes.
	ExecutionPlane string `json:"execution_plane"`
	// CancelReason explains why a cancelled run was cancelled. Empty for an
	// operator or API cancel; "superseded_by_run:<id>" when a newer push run
	// to the same ref replaced this one, so the UI can render
	// "Superseded by run 11763" instead of a bare cancelled.
	CancelReason string     `json:"cancel_reason"`
	CheckRunID   *int64     `json:"check_run_id"`
	CheckRunURL  *string    `json:"check_run_url"`
	StartedAt    *time.Time `json:"started_at"`
	CompletedAt  *time.Time `json:"completed_at"`
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
}

// listWorkflowsResponse is the JSON response for listing workflows.
type listWorkflowsResponse struct {
	Workflows []workflowDefinitionResponse `json:"workflows"`
}

// listWorkflowRunsResponse is the JSON response for listing workflow runs.
type listWorkflowRunsResponse struct {
	WorkflowRuns []workflowRunResponse `json:"workflow_runs"`
}

func toWorkflowDefinitionResponse(d db.WorkflowDefinition) workflowDefinitionResponse {
	return workflowDefinitionResponse{
		ID:           d.ID,
		RepositoryID: d.RepositoryID,
		Name:         d.Name,
		Path:         d.Path,
		Config:       d.Config,
		IsActive:     d.IsActive,
		CreatedAt:    d.CreatedAt,
		UpdatedAt:    d.UpdatedAt,
	}
}

func toWorkflowRunResponse(r db.WorkflowRun) workflowRunResponse {
	resp := workflowRunResponse{
		ID:                   r.ID,
		RepositoryID:         r.RepositoryID,
		WorkflowDefinitionID: r.WorkflowDefinitionID,
		Status:               r.Status,
		TriggerEvent:         r.TriggerEvent,
		TriggerRef:           r.TriggerRef,
		TriggerCommitSha:     r.TriggerCommitSha,
		ExecutionPlane:       r.ExecutionPlane,
		CancelReason:         r.CancelReason,
		CreatedAt:            r.CreatedAt,
		UpdatedAt:            r.UpdatedAt,
	}
	if r.StartedAt.Valid {
		t := r.StartedAt.Time
		resp.StartedAt = &t
	}
	if r.CompletedAt.Valid {
		t := r.CompletedAt.Time
		resp.CompletedAt = &t
	}
	if r.CheckRunID.Valid {
		value := r.CheckRunID.Int64
		resp.CheckRunID = &value
	}
	if r.CheckRunUrl.Valid {
		value := r.CheckRunUrl.String
		resp.CheckRunURL = &value
	}
	return resp
}

// ListWorkflows handles GET /api/repos/:owner/:repo/workflows
func (h *WorkflowHandler) ListWorkflows(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		errors.WriteError(w, errors.Internal("workflow service unavailable"))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		errors.WriteError(w, errors.Internal("repository context not loaded"))
		return
	}

	cursor, limit, err := parseOffsetPagination(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	page := cursorToPage(cursor, limit)
	defs, err := h.Service.ListWorkflowDefinitions(r.Context(), repoCtx.Repository.ID, page, limit)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	workflows := make([]workflowDefinitionResponse, len(defs))
	for i, d := range defs {
		workflows[i] = toWorkflowDefinitionResponse(d)
	}
	resp := listWorkflowsResponse{Workflows: workflows}
	errors.WriteJSON(w, http.StatusOK, resp)
}

// GetWorkflow handles GET /api/repos/:owner/:repo/workflows/:id
func (h *WorkflowHandler) GetWorkflow(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		errors.WriteError(w, errors.Internal("workflow service unavailable"))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		errors.WriteError(w, errors.Internal("repository context not loaded"))
		return
	}

	rawID := chi.URLParam(r, "id")
	defID, err := strconv.ParseInt(rawID, 10, 64)
	if err != nil || defID <= 0 {
		errors.WriteError(w, errors.BadRequest("invalid workflow id"))
		return
	}

	def, err := h.Service.GetWorkflowDefinition(r.Context(), repoCtx.Repository.ID, defID)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	errors.WriteJSON(w, http.StatusOK, toWorkflowDefinitionResponse(def))
}

// ListWorkflowRuns handles GET /api/repos/:owner/:repo/workflows/:id/runs
func (h *WorkflowHandler) ListWorkflowRuns(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		errors.WriteError(w, errors.Internal("workflow service unavailable"))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		errors.WriteError(w, errors.Internal("repository context not loaded"))
		return
	}

	rawID := chi.URLParam(r, "id")
	defID, err2 := strconv.ParseInt(rawID, 10, 64)
	if err2 != nil || defID <= 0 {
		errors.WriteError(w, errors.BadRequest("invalid workflow id"))
		return
	}

	// Verify the workflow definition exists for this repo.
	if _, err := h.Service.GetWorkflowDefinition(r.Context(), repoCtx.Repository.ID, defID); err != nil {
		writeRouteError(w, r, err)
		return
	}

	cursor, limit, pagErr := parseOffsetPagination(r)
	if pagErr != nil {
		errors.WriteError(w, pagErr.(*errors.APIError))
		return
	}

	page := cursorToPage(cursor, limit)
	runs, err := h.Service.ListWorkflowRunsByDefinition(r.Context(), repoCtx.Repository.ID, defID, page, limit)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	runResponses := make([]workflowRunResponse, len(runs))
	for i, run := range runs {
		runResponses[i] = toWorkflowRunResponse(run)
	}
	resp := listWorkflowRunsResponse{WorkflowRuns: runResponses}
	errors.WriteJSON(w, http.StatusOK, resp)
}

// ListAllWorkflowRuns handles GET /api/repos/:owner/:repo/actions/runs
func (h *WorkflowHandler) ListAllWorkflowRuns(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		errors.WriteError(w, errors.Internal("workflow service unavailable"))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		errors.WriteError(w, errors.Internal("repository context not loaded"))
		return
	}

	cursor, limit, err := parseOffsetPagination(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	page := cursorToPage(cursor, limit)
	runs, err := h.Service.ListWorkflowRunsByRepo(r.Context(), repoCtx.Repository.ID, page, limit)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	runResponses := make([]workflowRunResponse, len(runs))
	for i, run := range runs {
		runResponses[i] = toWorkflowRunResponse(run)
	}
	resp := listWorkflowRunsResponse{WorkflowRuns: runResponses}
	errors.WriteJSON(w, http.StatusOK, resp)
}

// GetWorkflowRun handles GET /api/repos/:owner/:repo/actions/runs/:id
func (h *WorkflowHandler) GetWorkflowRun(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		errors.WriteError(w, errors.Internal("workflow service unavailable"))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		errors.WriteError(w, errors.Internal("repository context not loaded"))
		return
	}

	rawID := chi.URLParam(r, "id")
	runID, err := strconv.ParseInt(rawID, 10, 64)
	if err != nil || runID <= 0 {
		errors.WriteError(w, errors.BadRequest("invalid run id"))
		return
	}

	run, err := h.Service.GetWorkflowRun(r.Context(), repoCtx.Repository.ID, runID)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	errors.WriteJSON(w, http.StatusOK, toWorkflowRunResponse(run))
}

// workflowStepResponse is the JSON response for a workflow step.
type workflowStepResponse struct {
	ID            int64      `json:"id"`
	WorkflowRunID int64      `json:"workflow_run_id"`
	Name          string     `json:"name"`
	Position      int64      `json:"position"`
	Status        string     `json:"status"`
	StartedAt     *time.Time `json:"started_at"`
	CompletedAt   *time.Time `json:"completed_at"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
}

// listWorkflowStepsResponse is the JSON response for listing workflow steps.
type listWorkflowStepsResponse struct {
	Steps []workflowStepResponse `json:"steps"`
}

func toWorkflowStepResponse(s db.WorkflowStep) workflowStepResponse {
	resp := workflowStepResponse{
		ID:            s.ID,
		WorkflowRunID: s.WorkflowRunID,
		Name:          s.Name,
		Position:      s.Position,
		Status:        s.Status,
		CreatedAt:     s.CreatedAt,
		UpdatedAt:     s.UpdatedAt,
	}
	if s.StartedAt.Valid {
		t := s.StartedAt.Time
		resp.StartedAt = &t
	}
	if s.CompletedAt.Valid {
		t := s.CompletedAt.Time
		resp.CompletedAt = &t
	}
	return resp
}

// ListWorkflowRunSteps handles GET /api/repos/:owner/:repo/actions/runs/:id/steps
func (h *WorkflowHandler) ListWorkflowRunSteps(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		errors.WriteError(w, errors.Internal("workflow service unavailable"))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		errors.WriteError(w, errors.Internal("repository context not loaded"))
		return
	}

	rawID := chi.URLParam(r, "id")
	runID, err := strconv.ParseInt(rawID, 10, 64)
	if err != nil || runID <= 0 {
		errors.WriteError(w, errors.BadRequest("invalid run id"))
		return
	}

	// Verify the run exists and belongs to this repository.
	if _, err := h.Service.GetWorkflowRun(r.Context(), repoCtx.Repository.ID, runID); err != nil {
		writeRouteError(w, r, err)
		return
	}

	steps, err := h.Service.ListWorkflowSteps(r.Context(), runID)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	stepResponses := make([]workflowStepResponse, len(steps))
	for i, s := range steps {
		stepResponses[i] = toWorkflowStepResponse(s)
	}
	errors.WriteJSON(w, http.StatusOK, listWorkflowStepsResponse{Steps: stepResponses})
}

// CancelWorkflowRun handles POST /api/repos/:owner/:repo/actions/runs/:id/cancel
func (h *WorkflowHandler) CancelWorkflowRun(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		errors.WriteError(w, errors.Internal("workflow service unavailable"))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		errors.WriteError(w, errors.Internal("repository context not loaded"))
		return
	}

	rawID := chi.URLParam(r, "id")
	runID, err := strconv.ParseInt(rawID, 10, 64)
	if err != nil || runID <= 0 {
		errors.WriteError(w, errors.BadRequest("invalid run id"))
		return
	}

	if err := h.Service.CancelWorkflowRun(r.Context(), repoCtx.Repository.ID, runID); err != nil {
		writeRouteError(w, r, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// rerunWorkflowRunRequest is the JSON request body for rerunning a workflow run.
type rerunWorkflowRunRequest struct{}

// RerunWorkflowRun handles POST /api/repos/:owner/:repo/actions/runs/:id/rerun
func (h *WorkflowHandler) RerunWorkflowRun(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		errors.WriteError(w, errors.Internal("workflow service unavailable"))
		return
	}

	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		errors.WriteError(w, errors.Internal("repository context not loaded"))
		return
	}

	rawID := chi.URLParam(r, "id")
	runID, err := strconv.ParseInt(rawID, 10, 64)
	if err != nil || runID <= 0 {
		errors.WriteError(w, errors.BadRequest("invalid run id"))
		return
	}

	var req rerunWorkflowRunRequest
	if !decodeOptionalJSONBody(w, r, &req) {
		return
	}

	result, err := h.Service.RerunRun(r.Context(), services.RerunInput{
		RepositoryID: repoCtx.Repository.ID,
		RunID:        runID,
		UserID:       user.ID,
	})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	errors.WriteJSON(w, http.StatusCreated, workflowRunResultResponse{
		ID:                   result.WorkflowRunID,
		WorkflowDefinitionID: result.WorkflowDefinitionID,
		WorkflowRunID:        result.WorkflowRunID,
		Steps:                result.Steps,
	})
}

// workflowRunResultResponse is the JSON response for a workflow run result.
// The id field mirrors workflow_run_id so callers can use either name.
type workflowRunResultResponse struct {
	ID                   int64                         `json:"id"`
	WorkflowDefinitionID int64                         `json:"workflow_definition_id"`
	WorkflowRunID        int64                         `json:"workflow_run_id"`
	Steps                []services.WorkflowStepResult `json:"steps"`
}

// DispatchWorkflow handles POST /api/repos/:owner/:repo/workflows/:id/dispatches
type dispatchWorkflowRequest struct {
	Ref    string                 `json:"ref"`
	Inputs map[string]interface{} `json:"inputs,omitempty"`
}

func (h *WorkflowHandler) DispatchWorkflow(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		errors.WriteError(w, errors.Internal("workflow service unavailable"))
		return
	}

	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		errors.WriteError(w, errors.Internal("repository context not loaded"))
		return
	}

	rawID := chi.URLParam(r, "id")
	defID, err := strconv.ParseInt(rawID, 10, 64)
	if err != nil || defID <= 0 {
		errors.WriteError(w, errors.BadRequest("invalid workflow id"))
		return
	}

	var req dispatchWorkflowRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	ref := req.Ref
	if ref == "" {
		ref = repoCtx.Repository.DefaultBookmark
	}

	// Fetch the definition to validate inputs against its schema.
	def, err := h.Service.GetWorkflowDefinition(r.Context(), repoCtx.Repository.ID, defID)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	// Validate dispatch inputs against the definition's input schema.
	// mergedInputs includes user-provided values plus defaults from the schema.
	mergedInputs, err := services.ValidateDispatchInputs(def.Config, req.Inputs)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	results, err := h.Service.DispatchForEvent(r.Context(), services.DispatchForEventInput{
		RepositoryID:         repoCtx.Repository.ID,
		UserID:               user.ID,
		WorkflowDefinitionID: &defID,
		Event: services.TriggerEvent{
			Type:   "workflow_dispatch",
			Ref:    ref,
			Inputs: mergedInputs,
		},
	})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	errors.WriteJSON(w, http.StatusCreated, toDispatchResponse(results))
}

// dispatchResponse is the JSON response returned by workflow dispatch endpoints.
type dispatchResponse struct {
	Runs []workflowRunResultResponse `json:"runs"`
}

func toDispatchResponse(results []services.WorkflowRunResult) dispatchResponse {
	runs := make([]workflowRunResultResponse, len(results))
	for i, r := range results {
		runs[i] = workflowRunResultResponse{
			ID:                   r.WorkflowRunID,
			WorkflowDefinitionID: r.WorkflowDefinitionID,
			WorkflowRunID:        r.WorkflowRunID,
			Steps:                r.Steps,
		}
	}
	return dispatchResponse{Runs: runs}
}
