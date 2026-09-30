package routes

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

const (
	workflowDefinitionLookupLimit       = 1000
	workflowNodeLogsLimit         int32 = 10000
)

type workflowDefinitionSummaryResponse struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
	Path string `json:"path"`
}

type workflowRunListItemResponse struct {
	workflowRunResponse
	WorkflowName string `json:"workflow_name,omitempty"`
	WorkflowPath string `json:"workflow_path,omitempty"`
}

type listWorkflowRunsInspectionResponse struct {
	Runs []workflowRunListItemResponse `json:"runs"`
}

type workflowRunNodeResponse struct {
	ID              string     `json:"id"`
	StepID          int64      `json:"step_id"`
	Name            string     `json:"name"`
	Position        int64      `json:"position"`
	Status          string     `json:"status"`
	Iteration       int        `json:"iteration"`
	StartedAt       *time.Time `json:"started_at,omitempty"`
	CompletedAt     *time.Time `json:"completed_at,omitempty"`
	Duration        string     `json:"duration"`
	DurationSeconds int64      `json:"duration_seconds"`
}

type workflowRunInspectionResponse struct {
	Run      workflowRunResponse               `json:"run"`
	Workflow workflowDefinitionSummaryResponse `json:"workflow"`
	Nodes    []workflowRunNodeResponse         `json:"nodes"`
	Mermaid  string                            `json:"mermaid"`
	PlanXML  string                            `json:"plan_xml"`
}

type workflowRunLogEntryResponse struct {
	ID        int64     `json:"id"`
	Sequence  int64     `json:"sequence"`
	Stream    string    `json:"stream"`
	Entry     string    `json:"entry"`
	CreatedAt time.Time `json:"created_at"`
}

type workflowRunNodeDetailResponse struct {
	RunID   int64                         `json:"run_id"`
	Node    workflowRunNodeResponse       `json:"node"`
	Logs    []workflowRunLogEntryResponse `json:"logs"`
	Output  any                           `json:"output"`
	PlanXML string                        `json:"plan_xml"`
	Mermaid string                        `json:"mermaid"`
}

type workflowPlanXML struct {
	XMLName xml.Name           `xml:"workflow"`
	Name    string             `xml:"name,attr"`
	Path    string             `xml:"path,attr,omitempty"`
	RunID   int64              `xml:"run_id,attr"`
	Status  string             `xml:"status,attr"`
	Nodes   []workflowPlanNode `xml:"node"`
}

type workflowPlanNode struct {
	ID        string `xml:"id,attr"`
	StepID    int64  `xml:"step_id,attr"`
	Name      string `xml:"name,attr"`
	Position  int64  `xml:"position,attr"`
	Status    string `xml:"status,attr"`
	Iteration int    `xml:"iteration,attr"`
	Duration  string `xml:"duration,attr,omitempty"`
}

// ListWorkflowRunsV2 handles GET /api/repos/:owner/:repo/workflows/runs.
func (h *WorkflowHandler) ListWorkflowRunsV2(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("workflow service unavailable"))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("repository context not loaded"))
		return
	}

	cursor, limit, err := parseOffsetPagination(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	stateFilter := normalizeWorkflowState(r.URL.Query().Get("state"))
	var runs []db.WorkflowRun
	if stateFilter == "" {
		runs, err = h.Service.ListWorkflowRunsByRepo(r.Context(), repoCtx.Repository.ID, cursorToPage(cursor, limit), limit)
	} else {
		// Count matching runs before applying the requested offset. Filtering a
		// database page instead would hide older matches behind newer statuses.
		const batchSize = 100
		skip := cursorToOffset(cursor)
		for page := 1; ; page++ {
			var batch []db.WorkflowRun
			batch, err = h.Service.ListWorkflowRunsByRepo(r.Context(), repoCtx.Repository.ID, page, batchSize)
			if err != nil {
				break
			}
			for _, run := range batch {
				if !workflowRunMatchesState(run.Status, stateFilter) {
					continue
				}
				if skip > 0 {
					skip--
				} else {
					runs = append(runs, run)
					if len(runs) == limit {
						break
					}
				}
			}
			if len(runs) == limit || len(batch) < batchSize {
				break
			}
		}
	}
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	definitionMap, err := h.listWorkflowDefinitionsByID(r.Context(), repoCtx.Repository.ID)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	resp := listWorkflowRunsInspectionResponse{Runs: make([]workflowRunListItemResponse, 0, len(runs))}
	for _, run := range runs {
		item := workflowRunListItemResponse{workflowRunResponse: toWorkflowRunResponse(run)}
		if def, ok := definitionMap[run.WorkflowDefinitionID]; ok {
			item.WorkflowName = def.Name
			item.WorkflowPath = def.Path
		}
		resp.Runs = append(resp.Runs, item)
	}

	pkgerrors.WriteJSON(w, http.StatusOK, resp)
}

// GetWorkflowRunV2 handles GET /api/repos/:owner/:repo/workflows/runs/:id.
func (h *WorkflowHandler) GetWorkflowRunV2(w http.ResponseWriter, r *http.Request) {
	resp, err := h.buildWorkflowRunInspectionResponse(r.Context(), r)
	if err != nil {
		if apiErr, ok := err.(*pkgerrors.APIError); ok {
			pkgerrors.WriteError(w, apiErr)
			return
		}
		writeRouteError(w, r, err)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusOK, resp)
}

// GetWorkflowRunNode handles GET /api/repos/:owner/:repo/workflows/runs/:id/nodes/:nodeId.
func (h *WorkflowHandler) GetWorkflowRunNode(w http.ResponseWriter, r *http.Request) {
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

	nodeID := strings.TrimSpace(chi.URLParam(r, "nodeId"))
	if nodeID == "" {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid node id"))
		return
	}

	run, err := h.Service.GetWorkflowRun(r.Context(), repoCtx.Repository.ID, runID)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	def, err := h.Service.GetWorkflowDefinition(r.Context(), repoCtx.Repository.ID, run.WorkflowDefinitionID)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	steps, err := h.Service.ListWorkflowSteps(r.Context(), run.ID)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	var matched *db.WorkflowStep
	for i := range steps {
		if workflowNodeMatches(steps[i], nodeID) {
			matched = &steps[i]
			break
		}
	}
	if matched == nil {
		pkgerrors.WriteError(w, pkgerrors.NotFound("workflow node not found"))
		return
	}

	// Scan the run's logs in id order, paginating past earlier steps' noise,
	// and collect up to workflowNodeLogsLimit entries for the matched step.
	nodeLogs := make([]workflowRunLogEntryResponse, 0)
	afterID := int64(0)
	for len(nodeLogs) < int(workflowNodeLogsLimit) {
		logs, err := h.Service.ListWorkflowLogsSince(r.Context(), run.ID, afterID, workflowNodeLogsLimit)
		if err != nil {
			writeRouteError(w, r, err)
			return
		}
		if len(logs) == 0 {
			break
		}
		for _, log := range logs {
			if log.WorkflowStepID != matched.ID {
				continue
			}
			nodeLogs = append(nodeLogs, workflowRunLogEntryResponse{
				ID:        log.ID,
				Sequence:  log.Sequence,
				Stream:    log.Stream,
				Entry:     log.Entry,
				CreatedAt: log.CreatedAt,
			})
			if len(nodeLogs) >= int(workflowNodeLogsLimit) {
				break
			}
		}
		if len(logs) < int(workflowNodeLogsLimit) {
			break
		}
		afterID = logs[len(logs)-1].ID
	}

	nodes := buildWorkflowRunNodes(steps)
	resp := workflowRunNodeDetailResponse{
		RunID:   run.ID,
		Node:    toWorkflowRunNodeResponse(*matched),
		Logs:    nodeLogs,
		Output:  nil,
		PlanXML: buildWorkflowPlanXML(def, run, nodes),
		Mermaid: buildWorkflowRunMermaid(nodes),
	}

	pkgerrors.WriteJSON(w, http.StatusOK, resp)
}

// DispatchWorkflowByIdentifier handles POST /api/repos/:owner/:repo/workflows/:name/dispatch.
func (h *WorkflowHandler) DispatchWorkflowByIdentifier(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("workflow service unavailable"))
		return
	}

	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("repository context not loaded"))
		return
	}

	identifier := chi.URLParam(r, "name")
	if strings.TrimSpace(identifier) == "" {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid workflow identifier"))
		return
	}

	var req dispatchWorkflowRequest
	if decErr := json.NewDecoder(r.Body).Decode(&req); decErr != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid request body"))
		return
	}

	ref := req.Ref
	if strings.TrimSpace(ref) == "" {
		ref = "main"
	}

	def, err := h.resolveWorkflowDefinitionIdentifier(r.Context(), repoCtx.Repository.ID, identifier)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	mergedInputs, err := services.ValidateDispatchInputs(def.Config, req.Inputs)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	results, err := h.Service.DispatchForEvent(r.Context(), services.DispatchForEventInput{
		RepositoryID:         repoCtx.Repository.ID,
		UserID:               user.ID,
		WorkflowDefinitionID: &def.ID,
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

	pkgerrors.WriteJSON(w, http.StatusCreated, toDispatchResponse(results))
}

// ResumeWorkflowRun handles POST /api/repos/:owner/:repo/workflows/runs/:id/resume.
func (h *WorkflowHandler) ResumeWorkflowRun(w http.ResponseWriter, r *http.Request) {
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

	if err := h.Service.ResumeRun(r.Context(), repoCtx.Repository.ID, runID); err != nil {
		writeRouteError(w, r, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (h *WorkflowHandler) buildWorkflowRunInspectionResponse(ctx context.Context, r *http.Request) (workflowRunInspectionResponse, error) {
	if h.Service == nil {
		return workflowRunInspectionResponse{}, pkgerrors.Internal("workflow service unavailable")
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		return workflowRunInspectionResponse{}, pkgerrors.Internal("repository context not loaded")
	}

	runID, apiErr := parsePositiveInt64Param(chi.URLParam(r, "id"), "invalid run id")
	if apiErr != nil {
		return workflowRunInspectionResponse{}, apiErr
	}

	run, err := h.Service.GetWorkflowRun(ctx, repoCtx.Repository.ID, runID)
	if err != nil {
		return workflowRunInspectionResponse{}, err
	}

	def, err := h.Service.GetWorkflowDefinition(ctx, repoCtx.Repository.ID, run.WorkflowDefinitionID)
	if err != nil {
		return workflowRunInspectionResponse{}, err
	}

	steps, err := h.Service.ListWorkflowSteps(ctx, run.ID)
	if err != nil {
		return workflowRunInspectionResponse{}, err
	}

	nodes := buildWorkflowRunNodes(steps)
	return workflowRunInspectionResponse{
		Run: toWorkflowRunResponse(run),
		Workflow: workflowDefinitionSummaryResponse{
			ID:   def.ID,
			Name: def.Name,
			Path: def.Path,
		},
		Nodes:   nodes,
		Mermaid: buildWorkflowRunMermaid(nodes),
		PlanXML: buildWorkflowPlanXML(def, run, nodes),
	}, nil
}

func (h *WorkflowHandler) resolveWorkflowDefinitionIdentifier(ctx context.Context, repositoryID int64, identifier string) (db.WorkflowDefinition, error) {
	if numericID, err := strconv.ParseInt(identifier, 10, 64); err == nil && numericID > 0 {
		return h.Service.GetWorkflowDefinition(ctx, repositoryID, numericID)
	}

	definitions, err := h.Service.ListWorkflowDefinitions(ctx, repositoryID, 1, workflowDefinitionLookupLimit)
	if err != nil {
		return db.WorkflowDefinition{}, err
	}

	for _, def := range definitions {
		if workflowIdentifierMatches(def, identifier) {
			return def, nil
		}
	}

	return db.WorkflowDefinition{}, pkgerrors.NotFound("workflow definition not found")
}

func (h *WorkflowHandler) listWorkflowDefinitionsByID(ctx context.Context, repositoryID int64) (map[int64]db.WorkflowDefinition, error) {
	definitions, err := h.Service.ListWorkflowDefinitions(ctx, repositoryID, 1, workflowDefinitionLookupLimit)
	if err != nil {
		return nil, err
	}

	result := make(map[int64]db.WorkflowDefinition, len(definitions))
	for _, def := range definitions {
		result[def.ID] = def
	}
	return result, nil
}

func parsePositiveInt64Param(raw string, message string) (int64, *pkgerrors.APIError) {
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value <= 0 {
		return 0, pkgerrors.BadRequest(message)
	}
	return value, nil
}

func workflowIdentifierMatches(def db.WorkflowDefinition, identifier string) bool {
	trimmed := strings.TrimSpace(identifier)
	if trimmed == "" {
		return false
	}

	if strings.EqualFold(def.Name, trimmed) {
		return true
	}

	base := strings.TrimSuffix(filepath.Base(def.Path), filepath.Ext(def.Path))
	return strings.EqualFold(base, trimmed) || strings.EqualFold(def.Path, trimmed)
}

func workflowRunMatchesState(status, filter string) bool {
	normalizedStatus := normalizeWorkflowState(status)
	normalizedFilter := normalizeWorkflowState(filter)
	if normalizedFilter == "" {
		return true
	}
	if normalizedFilter == "finished" {
		return normalizedStatus == "success" || normalizedStatus == "failure" || normalizedStatus == "cancelled"
	}
	return normalizedStatus == normalizedFilter
}

func normalizeWorkflowState(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "completed", "complete", "done", "success":
		return "success"
	case "failed", "failure", "error":
		return "failure"
	case "cancelled", "canceled":
		return "cancelled"
	case "queued", "pending":
		return "queued"
	case "running", "in_progress", "in-progress":
		return "running"
	case "finished", "terminal":
		return "finished"
	default:
		return strings.ToLower(strings.TrimSpace(raw))
	}
}

func buildWorkflowRunNodes(steps []db.WorkflowStep) []workflowRunNodeResponse {
	nodes := make([]workflowRunNodeResponse, 0, len(steps))
	for _, step := range steps {
		nodes = append(nodes, toWorkflowRunNodeResponse(step))
	}
	return nodes
}

func toWorkflowRunNodeResponse(step db.WorkflowStep) workflowRunNodeResponse {
	startedAt := timestamptzPtr(step.StartedAt)
	completedAt := timestamptzPtr(step.CompletedAt)
	durationSeconds, duration := formatWorkflowDuration(startedAt, completedAt)
	return workflowRunNodeResponse{
		ID:              strconv.FormatInt(step.ID, 10),
		StepID:          step.ID,
		Name:            step.Name,
		Position:        step.Position,
		Status:          step.Status,
		Iteration:       1,
		StartedAt:       startedAt,
		CompletedAt:     completedAt,
		Duration:        duration,
		DurationSeconds: durationSeconds,
	}
}

func workflowNodeMatches(step db.WorkflowStep, identifier string) bool {
	trimmed := strings.TrimSpace(identifier)
	if trimmed == "" {
		return false
	}
	if strconv.FormatInt(step.ID, 10) == trimmed {
		return true
	}
	return strings.EqualFold(step.Name, trimmed)
}

func timestamptzPtr(ts pgtype.Timestamptz) *time.Time {
	if !ts.Valid {
		return nil
	}
	value := ts.Time
	return &value
}

func formatWorkflowDuration(startedAt, completedAt *time.Time) (int64, string) {
	if startedAt == nil {
		return 0, ""
	}

	end := time.Now().UTC()
	if completedAt != nil {
		end = completedAt.UTC()
	}
	if end.Before(startedAt.UTC()) {
		return 0, ""
	}

	// end is guaranteed not to precede startedAt by the check above, so the
	// truncated second count is always >= 0.
	seconds := int64(end.Sub(startedAt.UTC()).Seconds())
	minutes := seconds / 60
	remainder := seconds % 60
	if minutes == 0 {
		return seconds, fmt.Sprintf("%ds", remainder)
	}
	return seconds, fmt.Sprintf("%dm %ds", minutes, remainder)
}

func buildWorkflowRunMermaid(nodes []workflowRunNodeResponse) string {
	var builder strings.Builder
	builder.WriteString("graph TD\n")

	if len(nodes) == 0 {
		return builder.String()
	}

	for index, node := range nodes {
		builder.WriteString(fmt.Sprintf("    N%d[%q]\n", index+1, node.Name))
	}
	for index := 0; index < len(nodes)-1; index++ {
		label := strings.TrimSpace(nodes[index].Status + " " + nodes[index].Duration)
		if label == "" {
			builder.WriteString(fmt.Sprintf("    N%d --> N%d\n", index+1, index+2))
			continue
		}
		builder.WriteString(fmt.Sprintf("    N%d -->|%s| N%d\n", index+1, mermaidLabel(label), index+2))
	}
	for index, node := range nodes {
		builder.WriteString(fmt.Sprintf("    style N%d fill:%s\n", index+1, workflowNodeFillColor(node.Status)))
	}

	return builder.String()
}

func workflowNodeFillColor(status string) string {
	switch normalizeWorkflowState(status) {
	case "success":
		return "#22c55e"
	case "failure":
		return "#ef4444"
	case "cancelled":
		return "#9ca3af"
	case "running":
		return "#3b82f6"
	case "queued":
		return "#6b7280"
	default:
		return "#94a3b8"
	}
}

func mermaidLabel(value string) string {
	replacer := strings.NewReplacer("|", "/", "\"", "'", "\n", " ")
	return replacer.Replace(value)
}

func buildWorkflowPlanXML(def db.WorkflowDefinition, run db.WorkflowRun, nodes []workflowRunNodeResponse) string {
	plan := workflowPlanXML{
		Name:   def.Name,
		Path:   def.Path,
		RunID:  run.ID,
		Status: run.Status,
		Nodes:  make([]workflowPlanNode, 0, len(nodes)),
	}
	for _, node := range nodes {
		plan.Nodes = append(plan.Nodes, workflowPlanNode{
			ID:        node.ID,
			StepID:    node.StepID,
			Name:      node.Name,
			Position:  node.Position,
			Status:    node.Status,
			Iteration: node.Iteration,
			Duration:  node.Duration,
		})
	}

	return xml.Header + string(mustMarshalWorkflowXML(plan))
}

// mustMarshalWorkflowXML marshals a workflowPlanXML value whose fields are all
// XML-marshalable (strings and ints), so xml.MarshalIndent cannot fail for it.
// The error path is unreachable at runtime; a panic here signals a programming
// error, never a request-triggerable failure.
func mustMarshalWorkflowXML(v any) []byte {
	encoded, err := xml.MarshalIndent(v, "", "  ")
	if err != nil {
		panic(fmt.Sprintf("workflow plan should be XML-marshalable: %v", err))
	}
	return encoded
}
