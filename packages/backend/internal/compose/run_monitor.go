package compose

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type monitorReader interface {
	Monitor(context.Context, flowruntime.Target, string, *int64) (json.RawMessage, error)
}

// The admission checkpoint correlates the run with its authorized host. All
// graph, lifecycle and journal data are read from Control, never reconstructed
// from product job status.
type runMonitors struct {
	pool   *pgxpool.Pool
	reader monitorReader
}

func (m *runMonitors) checkpoints(ctx context.Context, repo int64, id string) ([]flowdispatch.RuntimeCheckpoint, error) {
	workspace := ""
	if before, after, ok := strings.Cut(id, ":"); ok {
		workspace, id = before, after
	}
	rows, err := m.pool.Query(ctx, `SELECT DISTINCT ON (d.external_receipt->>'runId',d.external_receipt->'target'->>'WorkspaceID') d.external_receipt
 FROM product_job_requests r JOIN product_job_dispatches d ON d.operation_id=r.id
 WHERE r.tenant_id=$1 AND r.operation=$2 AND COALESCE(d.external_receipt->>'runId','')<>''
 AND ($3='' OR d.external_receipt->>'runId'=$3) AND ($4='' OR d.external_receipt->'target'->>'WorkspaceID'=$4)
 ORDER BY d.external_receipt->>'runId',d.external_receipt->'target'->>'WorkspaceID',r.created_at DESC`, fmt.Sprintf("repository:%d", repo), flowdispatch.OperationLaunch, id, workspace)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []flowdispatch.RuntimeCheckpoint{}
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var cp flowdispatch.RuntimeCheckpoint
		if err := json.Unmarshal(raw, &cp); err != nil {
			return nil, err
		}
		if cp.Target.TenantID != fmt.Sprintf("repository:%d", repo) || cp.Target.WorkspaceID == "" {
			return nil, errors.New("invalid run binding")
		}
		result = append(result, cp)
	}
	return result, rows.Err()
}
func (m *runMonitors) read(ctx context.Context, repo int64, id string, at *int64) (json.RawMessage, error) {
	cps, err := m.checkpoints(ctx, repo, id)
	if err != nil {
		return nil, err
	}
	if len(cps) != 1 {
		return nil, pgx.ErrNoRows
	}
	return m.readCheckpoint(ctx, repo, id, at, cps[0])
}

func (m *runMonitors) readCheckpoint(ctx context.Context, repo int64, id string, at *int64, cp flowdispatch.RuntimeCheckpoint) (json.RawMessage, error) {
	raw, err := m.reader.Monitor(ctx, cp.Target, cp.RunID, at)
	if err != nil {
		return nil, err
	}
	var value map[string]any
	if json.Unmarshal(raw, &value) != nil || value["id"] != cp.RunID {
		return nil, errors.New("invalid monitor")
	}
	// Each step's spend is priced from the proxy rows its dispatches name.
	if err := m.priceRunMonitor(ctx, cp.Target.WorkspaceID, value); err != nil {
		return nil, err
	}
	// Only the admitted version is authoritative; the journal does not name a
	// mutable registry's current version.
	value["version"] = cp.ExecutionDigest
	value["id"] = id
	if attempts, ok := value["attempts"].([]any); ok {
		for _, a := range attempts {
			if row, ok := a.(map[string]any); ok && row["run_id"] == cp.RunID {
				row["run_id"] = id
			}
		}
	}
	var number, attempt int64
	var title, itemState string
	var checks []byte
	err = m.pool.QueryRow(ctx, `SELECT number,attempt,title,state,checks FROM mythical_items
 WHERE repository_id=$1 AND $2 IN (request_run_id,vibe_run_id,verify_run_id) AND source='todo'`, repo, cp.RunID).Scan(&number, &attempt, &title, &itemState, &checks)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if err == nil {
		value["todo"], value["title"] = number, title
		var facts struct {
			Waits  []services.TodoWait `json:"waits"`
			Thrash *struct {
				Attempt  int64 `json:"attempt"`
				Failures []struct {
					Check string `json:"check"`
					Count int    `json:"count"`
				} `json:"failures"`
			} `json:"thrash"`
		}
		// Retained items may have no checks receipt yet. NULL is not corrupt history.
		if len(checks) != 0 {
			if err := json.Unmarshal(checks, &facts); err != nil {
				return nil, err
			}
		}
		// TODO waits retain their opening and settlement receipts. Replay uses
		// the selected journal's timestamp, never today's settled state.
		var cursor *time.Time
		if at != nil {
			journal, _ := value["journal"].([]any)
			for _, entry := range journal {
				row, _ := entry.(map[string]any)
				sequence, ok := row["seq"].(float64)
				stamp, stampOK := row["at"].(string)
				if !ok || sequence < 0 || sequence > float64(*at) || sequence != float64(int64(sequence)) || !stampOK {
					return nil, errors.New("invalid replay journal")
				}
				point, err := time.Parse(time.RFC3339Nano, stamp)
				if err != nil {
					return nil, errors.New("invalid replay timestamp")
				}
				if cursor == nil || point.After(*cursor) {
					cursor = &point
				}
			}
		}
		waits, _ := value["waits"].([]any)
		for _, wait := range facts.Waits {
			if wait.Signal == nil || wait.Signal.Run != cp.RunID ||
				(at != nil && (cursor == nil || wait.Since.After(*cursor))) {
				continue
			}
			switch wait.Kind {
			case "question", "approval", "pause", "sleep", "signal", "external_job":
			default:
				continue
			}
			projected := map[string]any{"id": wait.ID, "kind": wait.Kind, "label": wait.Prompt, "since": wait.Since.UTC().Format(time.RFC3339Nano)}
			if wait.SettledAt != nil && (at == nil || !wait.SettledAt.After(*cursor)) {
				var by any = map[string]any{"kind": "system", "color_index": 7}
				if len(wait.By) > 0 && string(wait.By) != "null" {
					if err := json.Unmarshal(wait.By, &by); err != nil {
						return nil, err
					}
				}
				projected["settled"] = map[string]any{"by": by, "at": wait.SettledAt.UTC().Format(time.RFC3339Nano)}
			}
			waits = append(waits, projected)
		}
		value["waits"] = waits
		if at == nil {
			if facts.Thrash != nil && facts.Thrash.Attempt == attempt {
				for _, failure := range facts.Thrash.Failures {
					if failure.Count >= 3 {
						markMonitorThrash(value, failure.Check)
					}
				}
			}
		}
	}

	if at != nil {
		journal, _ := value["journal"].([]any)
		events := make([]flowruntime.Event, 0, len(journal))
		for _, entry := range journal {
			row, _ := entry.(map[string]any)
			sequence, ok := row["seq"].(float64)
			text, textOK := row["text"].(string)
			kind, kindOK := row["type"].(string)
			if !ok || sequence < 0 || sequence > float64(*at) || sequence != float64(int64(sequence)) || !textOK || !kindOK || !json.Valid([]byte(text)) {
				return nil, errors.New("invalid replay journal")
			}
			events = append(events, flowruntime.Event{RunID: cp.RunID, Sequence: int64(sequence), Kind: kind, Payload: json.RawMessage(text)})
		}
		for _, check := range services.RunThrashChecks(cp.RunID, events) {
			markMonitorThrash(value, check)
		}
	}
	return json.Marshal(value)
}

func markMonitorThrash(value map[string]any, check string) {
	attempts, _ := value["attempts"].([]any)
	for _, a := range attempts {
		attempt, _ := a.(map[string]any)
		phases, _ := attempt["phases"].([]any)
		for i := len(phases) - 1; i >= 0; i-- {
			phase, _ := phases[i].(map[string]any)
			title, _ := phase["title"].(string)
			if title == "Ran checks" || strings.HasPrefix(title, "Ran checks · ") {
				phase["tone"] = "thrash"
				phase["indicator"] = "Thrashing: " + check + " failed 3×"
				break
			}
		}
	}
}
func mountRunMonitors(router chi.Router, cfg *config.Config, q *db.Queries, m *runMonitors) {
	access := []func(http.Handler) http.Handler{authLoader(q, cfg.Auth), middleware.RequireAuth}
	handler := func(w http.ResponseWriter, r *http.Request) {
		if services.InstallExecutionCredential(r.Context()) {
			m.serveExecutionTrace(w, r, q)
			return
		}
		if _, err := services.Authorize(r.Context(), q, "monitor"); err != nil {
			writeConfirmationDispatchError(w, err)
			return
		}
		repo, _, err := installRepository(r.Context(), q)
		if err != nil {
			browserFlowTyped(w, 503, "run_unavailable", "Run unavailable")
			return
		}
		id := chi.URLParam(r, "id")
		var at *int64
		if r.URL.Query().Has("at") {
			n, e := strconv.ParseInt(r.URL.Query().Get("at"), 10, 64)
			if e != nil || n < 0 {
				browserFlowTyped(w, 400, "invalid_request", "Invalid replay position")
				return
			}
			at = &n
		}
		if id == "" {
			cps, e := m.checkpoints(r.Context(), repo, "")
			if e != nil {
				browserFlowTyped(w, 503, "run_unavailable", "Run unavailable")
				return
			}
			rows := []json.RawMessage{}
			for _, cp := range cps {
				v, e := m.read(r.Context(), repo, cp.Target.WorkspaceID+":"+cp.RunID, nil)
				if e != nil {
					browserFlowTyped(w, 503, "run_unavailable", "Run unavailable")
					return
				}
				rows = append(rows, v)
			}
			browserFlowJSON(w, 200, rows)
			return
		}
		raw, e := m.read(r.Context(), repo, id, at)
		if errors.Is(e, pgx.ErrNoRows) {
			browserFlowTyped(w, 404, "run_not_found", "Run unavailable")
			return
		}
		if e != nil {
			browserFlowTyped(w, 503, "run_unavailable", "Run unavailable")
			return
		}
		browserFlowJSON(w, 200, json.RawMessage(raw))
	}
	router.With(access...).Get("/api/runs", handler)
	router.With(access...).Get("/api/runs/{id}", handler)
	router.With(access...).Get("/api/runs/{id}/trace", handler)
}
