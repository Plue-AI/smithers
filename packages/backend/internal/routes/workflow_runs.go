package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
)

// WorkflowRunRouteService is the minimal interface required by WorkflowRunHandler.
type WorkflowRunRouteService interface {
	GetWorkflowLogStreamHead(context.Context, int64) (int64, error)
	GetWorkflowRun(ctx context.Context, repoID, runID int64) (db.WorkflowRun, error)
	ListWorkflowSteps(ctx context.Context, runID int64) ([]db.WorkflowStep, error)
	ListWorkflowLogsSince(ctx context.Context, runID, afterID int64, limit int32) ([]db.WorkflowLog, error)
}

// WorkflowRunHandler handles workflow run REST and SSE endpoints.
type WorkflowRunHandler struct {
	Service WorkflowRunRouteService
	// Broker multiplexes all workflow-run LISTEN/NOTIFY streams over one shared
	// database connection and enforces the per-user concurrent stream cap.
	// If nil, the SSE stream endpoint returns a 500.
	Broker *sse.Broker
	// Metrics is used to record observability data (e.g. active connections).
	Metrics *SmithersMetrics
}

var (
	serveWorkflowRunBrokerSSE       = sse.ServeBrokerSSE
	marshalWorkflowRunReplayPayload = json.Marshal
)

// WorkflowRunLogsStream handles GET /api/repos/:owner/:repo/runs/:id/logs
// SSE endpoint for streaming workflow run logs.
//
// This endpoint is exempt from the HTTP timeout middleware because it is a
// long-lived streaming connection. Keep-alive comments are sent every 15 seconds.
//
// The endpoint supports Last-Event-ID header for replaying missed logs after
// a disconnect. Events are formatted as:
//
//	id: 42
//	event: log
//	data: {"log_id":42,"step":7,"line":1,"content":"hello","workflow_step_id":7,"sequence":1,"entry":"hello","stream":"stdout"}
//
// Persisted log records come from both step and run log tables. Run status
// has a separate status stream; catch-up failures emit stream.error without an ID.
func (h *WorkflowRunHandler) WorkflowRunLogsStream(w http.ResponseWriter, r *http.Request) {
	// Require authentication. The user ID drives the per-user SSE stream cap.
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	// Parse run ID from URL.
	runIDStr := chi.URLParam(r, "id")
	runID, convErr := strconv.ParseInt(runIDStr, 10, 64)
	if convErr != nil || runID <= 0 {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid run id"))
		return
	}

	// Get repository from context (set by LoadRepoContext middleware).
	repo := middleware.RepoFromContext(r.Context())
	if repo == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("repository context not loaded"))
		return
	}

	// Verify the run exists and belongs to this repository.
	_, svcErr := h.Service.GetWorkflowRun(r.Context(), repo.ID, runID)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	// Get steps for this run to build channel names.
	steps, svcErr := h.Service.ListWorkflowSteps(r.Context(), runID)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	// Build one LISTEN channel per workflow step and always include the
	// run-level channel for workflow_run_logs notifications.
	channels := make([]string, 0, len(steps)+1)
	for _, step := range steps {
		channels = append(channels, fmt.Sprintf("workflow_step_logs_%d", step.ID))
	}
	channels = append(channels, fmt.Sprintf("workflow_run_%d", runID))

	stream := h.durableWorkflowLogs(runID)
	cfg := sse.BrokerStreamConfig{
		Durable:       stream,
		Broker:        h.Broker,
		Channels:      channels,
		UserID:        user.ID,
		EventType:     "log",
		FormatEventID: extractLogID,
		OnConnect:     stream.OnConnect,
	}

	attachRevocation(&cfg, r, revocation.Principal{RepositoryID: repo.ID})
	if h.Metrics != nil && h.Metrics.SSEActiveConnections != nil {
		cfg.ActiveConnections = h.Metrics.SSEActiveConnections
	}

	serveWorkflowRunBrokerSSE(w, r, cfg)
}

// replayWorkflowLogs returns an OnConnect callback that replays missed workflow
// logs when the client reconnects with a Last-Event-ID header.
func (h *WorkflowRunHandler) replayWorkflowLogs(runID int64) func(http.ResponseWriter, *http.Request, http.Flusher) {
	stream := h.durableWorkflowLogs(runID)
	stream.Head, stream.Validate = nil, nil
	return stream.OnConnect
}

// extractLogID extracts the "log_id" field from a JSON log payload.
// Returns the stringified ID, or "" if extraction fails.
func extractLogID(data string) string {
	var partial struct {
		LogID int64 `json:"log_id"`
	}
	if err := json.Unmarshal([]byte(data), &partial); err != nil || partial.LogID == 0 {
		return ""
	}
	return strconv.FormatInt(partial.LogID, 10)
}

type workflowRunStreamLogPayload struct {
	LogID   int64  `json:"log_id"`
	Step    int64  `json:"step"`
	Line    int64  `json:"line"`
	Content string `json:"content"`
	Stream  string `json:"stream,omitempty"`
}

func normalizeWorkflowRunLogPayload(data string) (workflowRunStreamLogPayload, bool) {
	var payload struct {
		LogID          int64  `json:"log_id"`
		Step           int64  `json:"step"`
		Line           int64  `json:"line"`
		Content        string `json:"content"`
		Stream         string `json:"stream"`
		WorkflowStepID int64  `json:"workflow_step_id"`
		Sequence       int64  `json:"sequence"`
		Entry          string `json:"entry"`
	}
	if err := json.Unmarshal([]byte(data), &payload); err != nil {
		return workflowRunStreamLogPayload{}, false
	}
	if payload.Step == 0 {
		payload.Step = payload.WorkflowStepID
	}
	if payload.Line == 0 {
		payload.Line = payload.Sequence
	}
	if payload.Content == "" {
		payload.Content = payload.Entry
	}
	if payload.Step == 0 || payload.Line == 0 {
		return workflowRunStreamLogPayload{}, false
	}
	return workflowRunStreamLogPayload{
		LogID:   payload.LogID,
		Step:    payload.Step,
		Line:    payload.Line,
		Content: payload.Content,
		Stream:  payload.Stream,
	}, true
}

// WorkflowRunStatusStream handles
// GET /api/repos/:owner/:repo/runs/:id/status/stream — the run STATUS half of
// the invocation seam (smithersai/ui#7): a browser or worker follows a run it
// did not start. The stream LISTENs on the run's lifecycle channel
// (`workflow_run_events_<id>`, published by the sandbox scheduler, runner,
// and cancel/resume paths) and opens with an honest snapshot of the run's
// current status so a late joiner immediately sees a terminal state instead
// of waiting for an event that already fired.
//
// Event frames carry `event: status` with the notifier's JSON payload
// ({run_id, source}); the snapshot frame adds the full current status:
//
//	id: <runID>
//	event: status
//	data: {"run_id":42,"status":"success","source":"snapshot"}
func (h *WorkflowRunHandler) WorkflowRunStatusStream(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	runIDStr := chi.URLParam(r, "id")
	runID, convErr := strconv.ParseInt(runIDStr, 10, 64)
	if convErr != nil || runID <= 0 {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid run id"))
		return
	}

	repo := middleware.RepoFromContext(r.Context())
	if repo == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("repository context not loaded"))
		return
	}

	run, svcErr := h.Service.GetWorkflowRun(r.Context(), repo.ID, runID)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	channels := []string{fmt.Sprintf("workflow_run_events_%d", runID)}

	// Both callbacks run on the stream's own goroutine, never concurrently.
	lastStatus, written := "", false
	snapshot := func(w http.ResponseWriter, r *http.Request, flusher http.Flusher, onlyChanged bool) {
		current, fetchErr := h.Service.GetWorkflowRun(r.Context(), repo.ID, runID)
		if fetchErr != nil {
			if onlyChanged {
				return
			}
			current = run
		}
		if onlyChanged && written && current.Status == lastStatus {
			return
		}
		payload, marshalErr := json.Marshal(map[string]any{
			"run_id": current.ID,
			"status": current.Status,
			"source": "snapshot",
		})
		if marshalErr != nil {
			return
		}
		lastStatus, written = current.Status, true
		_, _ = fmt.Fprint(w, sse.FormatEvent(sse.Event{
			ID:   strconv.FormatInt(run.ID, 10),
			Type: "status",
			Data: string(payload),
		}))
		flusher.Flush()
	}
	cfg := sse.BrokerStreamConfig{
		Broker:    h.Broker,
		Channels:  channels,
		UserID:    user.ID,
		EventType: "status",
		// Re-read after the broker subscription is live: a terminal
		// transition that fired before subscribe is caught here, and any
		// transition after subscribe arrives as its own event. The repair
		// read catches a transition whose wakeup was lost.
		OnConnect: func(w http.ResponseWriter, r *http.Request, flusher http.Flusher) {
			snapshot(w, r, flusher, false)
		},
		Repair: func(w http.ResponseWriter, r *http.Request, flusher http.Flusher) {
			snapshot(w, r, flusher, true)
		},
	}

	attachRevocation(&cfg, r, revocation.Principal{RepositoryID: repo.ID})
	if h.Metrics != nil && h.Metrics.SSEActiveConnections != nil {
		cfg.ActiveConnections = h.Metrics.SSEActiveConnections
	}

	serveWorkflowRunBrokerSSE(w, r, cfg)
}
