package routes

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// invokeWorkflowRequest is the JSON body for POST /api/repos/{owner}/{repo}/invoke.
type invokeWorkflowRequest struct {
	// Flow is the repo-file flow to run: its name (`echo`), path
	// (`.smithers/workflows/echo.tsx`), or numeric definition ID.
	Flow string `json:"flow"`
	// Input becomes the run's dispatch_inputs (the workflow's ctx.input).
	Input map[string]interface{} `json:"input,omitempty"`
}

// invokeWorkflowResponse is the durable-run handle invocation returns.
type invokeWorkflowResponse struct {
	ID                   int64  `json:"id"`
	RunID                int64  `json:"run_id"`
	WorkflowDefinitionID int64  `json:"workflow_definition_id"`
	Flow                 string `json:"flow"`
	Path                 string `json:"path"`
	Status               string `json:"status"`
}

// InvokeWorkflow handles POST /api/repos/{owner}/{repo}/invoke — the
// server-credentialed invocation seam (smithersai/ui#7). A person's write
// credential (browser session or personal access token) starts the run; a
// run credential is refused by the route. The run records the "invoke"
// trigger whatever the body says. The run is
// created on the sandbox plane: the in-API scheduler claims it and executes
// the flow file with `smithers up` in a one-shot VM, recording logs and the
// terminal status durably. The response is the honest queued state.
func (h *WorkflowHandler) InvokeWorkflow(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("workflow service unavailable"))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("repository context not loaded"))
		return
	}

	var req invokeWorkflowRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	result, err := h.Service.InvokeWorkflow(r.Context(), services.InvokeWorkflowInput{
		RepositoryID: repoCtx.Repository.ID,
		Identifier:   req.Flow,
		Input:        req.Input,
		TriggerRef:   repoCtx.Repository.DefaultBookmark,
	})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusCreated, invokeWorkflowResponse{
		ID:                   result.Run.ID,
		RunID:                result.Run.ID,
		WorkflowDefinitionID: result.Definition.ID,
		Flow:                 result.Definition.Name,
		Path:                 result.Definition.Path,
		Status:               result.Run.Status,
	})
}

// workflowRunStatusResponse is the compact status view (smithersai/ui#7's
// `GET /runs/{runId}/status` contract) for clients following a run they did
// not necessarily start.
type workflowRunStatusResponse struct {
	ID                   int64      `json:"id"`
	RunID                int64      `json:"run_id"`
	WorkflowDefinitionID int64      `json:"workflow_definition_id"`
	Status               string     `json:"status"`
	TriggerEvent         string     `json:"trigger_event"`
	StartedAt            *time.Time `json:"started_at"`
	CompletedAt          *time.Time `json:"completed_at"`
}

// GetWorkflowRunStatus handles GET /api/repos/{owner}/{repo}/runs/{id}/status.
func (h *WorkflowHandler) GetWorkflowRunStatus(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("workflow service unavailable"))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("repository context not loaded"))
		return
	}

	runID, apiErr := parsePositiveInt64Param(chi.URLParam(r, "id"), "invalid run id")
	if apiErr != nil {
		pkgerrors.WriteError(w, apiErr)
		return
	}

	run, err := h.Service.GetWorkflowRun(r.Context(), repoCtx.Repository.ID, runID)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	resp := workflowRunStatusResponse{
		ID:                   run.ID,
		RunID:                run.ID,
		WorkflowDefinitionID: run.WorkflowDefinitionID,
		Status:               run.Status,
		TriggerEvent:         run.TriggerEvent,
	}
	if run.StartedAt.Valid {
		t := run.StartedAt.Time
		resp.StartedAt = &t
	}
	if run.CompletedAt.Valid {
		t := run.CompletedAt.Time
		resp.CompletedAt = &t
	}
	pkgerrors.WriteJSON(w, http.StatusOK, resp)
}
