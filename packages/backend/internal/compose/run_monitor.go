package compose

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
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
func (m *runMonitors) read(ctx context.Context, repo int64, id string, at *int64, withJournal ...bool) (json.RawMessage, error) {
	cps, err := m.checkpoints(ctx, repo, id)
	if err != nil {
		return nil, err
	}
	if len(cps) != 1 {
		return nil, pgx.ErrNoRows
	}
	raw, err := m.readCheckpoint(ctx, repo, id, at, cps[0], len(withJournal) > 0 && withJournal[0])
	if err != nil {
		return nil, err
	}
	var pin struct {
		Kind    string `json:"kind"`
		ItemID  string `json:"itemId"`
		Attempt int    `json:"attempt"`
	}
	if json.Unmarshal(cps[0].Projection, &pin) != nil || pin.Kind != "mythical-item" || pin.ItemID == "" || pin.Attempt <= 1 || cps[0].FlowID != "todo" {
		return raw, nil
	}
	// Retry starts a new native root. Retain the earlier roots' own monitor
	// answers; never fold their steps into the current attempt or relaunch them.
	all, err := m.checkpoints(ctx, repo, "")
	if err != nil {
		return nil, err
	}
	type prior struct {
		n  int
		cp flowdispatch.RuntimeCheckpoint
	}
	previous := []prior{}
	for _, cp := range all {
		var p struct {
			Kind    string `json:"kind"`
			ItemID  string `json:"itemId"`
			Attempt int    `json:"attempt"`
		}
		if json.Unmarshal(cp.Projection, &p) == nil && cp.FlowID == "todo" && p.Kind == pin.Kind && p.ItemID == pin.ItemID && p.Attempt > 0 && p.Attempt < pin.Attempt {
			previous = append(previous, prior{p.Attempt, cp})
		}
	}
	sort.Slice(previous, func(i, j int) bool { return previous[i].n < previous[j].n })
	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	attempts := []any{}
	for _, p := range previous {
		retained, err := m.readCheckpoint(ctx, repo, p.cp.Target.WorkspaceID+":"+p.cp.RunID, nil, p.cp, false)
		if err != nil {
			return nil, err
		}
		var old map[string]any
		if err := json.Unmarshal(retained, &old); err != nil {
			return nil, err
		}
		rows, _ := old["attempts"].([]any)
		attempts = append(attempts, rows...)
		for _, key := range []string{"tokens", "cost_usd"} {
			current, _ := value[key].(float64)
			earlier, _ := old[key].(float64)
			value[key] = current + earlier
		}
	}
	rows, _ := value["attempts"].([]any)
	value["attempts"] = append(attempts, rows...)
	return json.Marshal(value)
}

func (m *runMonitors) readCheckpoint(ctx context.Context, repo int64, id string, at *int64, cp flowdispatch.RuntimeCheckpoint, withJournal ...bool) (json.RawMessage, error) {
	var raw json.RawMessage
	var err error
	var archived *archivedRun
	// A settled root has a retained answer. Prefer it without resolving a
	// replacement host or waking a sleeping branch to answer a read.
	if found, archiveErr := readRunArchive(ctx, m.pool, repo, cp.Target.WorkspaceID, cp.RunID); archiveErr == nil && (found.Status == "completed" || found.Status == "failed" || found.Status == "cancelled" || found.Status == "interrupted") {
		raw, archived = found.Monitor, &found
	}
	if archived == nil {
		raw, err = m.reader.Monitor(ctx, cp.Target, cp.RunID, at)
		if err != nil {
			found, archiveErr := readRunArchive(ctx, m.pool, repo, cp.Target.WorkspaceID, cp.RunID)
			if archiveErr != nil {
				return nil, err
			}
			raw, archived = found.Monitor, &found
		}
	}
	var value map[string]any
	if json.Unmarshal(raw, &value) != nil || value["id"] != cp.RunID {
		return nil, errors.New("invalid monitor")
	}
	// The journal tab reads the run's journal page by page: from the live
	// host's run-events projection, or from the archive of a sleeping branch.
	if len(withJournal) > 0 && withJournal[0] && value["journal"] == nil {
		var journal []any
		if archived != nil {
			journal, err = archived.journal(ctx)
		} else {
			journal, err = m.liveJournal(ctx, cp)
		}
		if err != nil {
			return nil, err
		}
		if journal != nil {
			value["journal"] = journal
		}
	}
	// A journal opened at the current frame still needs a cursor, so the
	// shipped scrubber can request its first historical frame.
	if at == nil && len(withJournal) > 0 && withJournal[0] {
		var last int64
		journal, _ := value["journal"].([]any)
		for _, entry := range journal {
			row, _ := entry.(map[string]any)
			sequence, ok := row["seq"].(float64)
			if !ok || sequence < 0 || sequence != float64(int64(sequence)) {
				return nil, errors.New("invalid journal sequence")
			}
			if int64(sequence) > last {
				last = int64(sequence)
			}
		}
		value["replay"] = map[string]any{"at": last, "last": last}
	}
	// Replaying a sleeping branch reads its retained journal. The browser
	// uses the same shipped native trace fold; no machine wakes and no
	// repository module is evaluated to render an archived frame.
	if archived != nil && at != nil {
		journal, journalErr := archived.journal(ctx)
		if journalErr != nil {
			return nil, journalErr
		}
		selected := []any{}
		var last int64
		for _, entry := range journal {
			row, ok := entry.(map[string]any)
			if !ok {
				return nil, errors.New("invalid archived journal")
			}
			sequence, ok := row["seq"].(float64)
			if !ok || sequence < 0 || sequence != float64(int64(sequence)) {
				return nil, errors.New("invalid archived sequence")
			}
			if int64(sequence) > last {
				last = int64(sequence)
			}
			if int64(sequence) <= *at {
				selected = append(selected, entry)
			}
		}
		if *at > last {
			return nil, errors.New("replay beyond archived journal")
		}
		value["journal"] = selected
		value["waits"] = []any{}
		value["replay"] = map[string]any{"at": *at, "last": last}
		value["archive_replay"] = map[string]any{"run_id": cp.RunID}
	}
	// Each step's spend is priced from the proxy rows its dispatches name.
	if err := m.priceRunMonitor(ctx, cp.Target.WorkspaceID, value); err != nil {
		return nil, err
	}
	// Only the admitted version is authoritative; the journal does not name a
	// mutable registry's current version.
	value["version"] = cp.ExecutionDigest
	value["id"] = id
	var pinnedAttempt struct {
		Attempt int `json:"attempt"`
	}
	_ = json.Unmarshal(cp.Projection, &pinnedAttempt)
	if attempts, ok := value["attempts"].([]any); ok {
		for _, a := range attempts {
			if row, ok := a.(map[string]any); ok && row["run_id"] == cp.RunID {
				row["run_id"] = id
				if pinnedAttempt.Attempt > 0 {
					row["n"] = pinnedAttempt.Attempt
				}
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
	if len(attempts) == 0 {
		return
	}
	attempt, _ := attempts[len(attempts)-1].(map[string]any)
	steps, _ := attempt["steps"].([]any)
	failed := map[string]bool{}
	for _, raw := range steps {
		step, _ := raw.(map[string]any)
		output, _ := step["output"].(string)
		var receipt struct {
			Check  string `json:"checkId"`
			Status string `json:"status"`
		}
		if json.Unmarshal([]byte(output), &receipt) == nil && receipt.Check == check && receipt.Status == "failed" {
			key, _ := step["key"].(string)
			failed[key] = true
		}
	}
	phases, _ := attempt["phases"].([]any)
	for i := len(phases) - 1; i >= 0; i-- {
		phase, _ := phases[i].(map[string]any)
		title, _ := phase["title"].(string)
		step, _ := phase["step"].(string)
		// Native receipts identify the actual failing step. Older journals with
		// labels alone retain their last failing check phase.
		tone, _ := phase["tone"].(string)
		matches := failed[step] || (len(failed) == 0 && (title == "Ran checks" || strings.HasPrefix(title, "Ran checks · ")) && (tone == "fail" || strings.Contains(title, "failed")))
		if matches {
			phase["tone"] = "thrash"
			phase["indicator"] = "Thrashing: " + check + " failed 3×"
			return
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
		id, decodeErr := url.PathUnescape(chi.URLParam(r, "id"))
		if decodeErr != nil {
			browserFlowTyped(w, 400, "invalid_request", "Invalid run")
			return
		}
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
			// Every run is listed with its state and Inspect door. A run whose
			// monitor cannot be read now keeps its row from the admission's
			// last observation, never hiding it from the list.
			rows := []json.RawMessage{}
			for _, cp := range cps {
				id := cp.Target.WorkspaceID + ":" + cp.RunID
				v, e := m.read(r.Context(), repo, id, nil)
				if e != nil {
					status := ""
					if cp.Run != nil {
						status = cp.Run.Status
					}
					if v, e = json.Marshal(map[string]any{"id": id, "flow": cp.FlowID, "title": cp.FlowID, "state": monitorRunState(status), "unavailable": true}); e != nil {
						browserFlowTyped(w, 503, "run_unavailable", "Run unavailable")
						return
					}
				}
				rows = append(rows, v)
			}
			browserFlowJSON(w, 200, rows)
			return
		}
		raw, e := m.read(r.Context(), repo, id, at, strings.HasSuffix(r.URL.Path, "/trace"))
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

// monitorRunState is a recorded run status in the monitor's words (the
// gateway's monitor uses the same mapping).
func monitorRunState(status string) string {
	switch status {
	case "completed", "done":
		return "done"
	case "failed":
		return "failed"
	case "cancelled", "interrupted":
		return "interrupted"
	case "held":
		return "held"
	case "waiting", "waiting-approval", "paused", "suspended":
		return "waiting"
	}
	return "running"
}

// liveJournal pages the run's journal from its live host's run-events
// projection, as the run:<id> topic reads it.
func (m *runMonitors) liveJournal(ctx context.Context, cp flowdispatch.RuntimeCheckpoint) ([]any, error) {
	caller, ok := m.reader.(interface {
		CallRPC(context.Context, flowruntime.Target, string, json.RawMessage) (json.RawMessage, error)
	})
	if !ok {
		// A monitor reader with no projection door serves no journal tab.
		return nil, nil
	}
	reader := runProjectionReader{call: caller.CallRPC, target: cp.Target, run: cp.RunID}
	entries := []any{}
	var cursor *runProjectionCursor
	for pages := 0; pages < 200; pages++ {
		page, err := reader.snapshot(ctx, "run-events", cursor)
		if err != nil {
			return nil, err
		}
		for _, raw := range page.Rows {
			entry, err := journalEntry(raw)
			if err != nil {
				return nil, err
			}
			entries = append(entries, entry)
		}
		if len(page.Rows) == 0 || (cursor != nil && page.Cursor.Value == cursor.Value && page.Cursor.Offset == cursor.Offset) {
			return entries, nil
		}
		next := page.Cursor
		cursor = &next
	}
	return nil, errors.New("run journal exceeds the inspection limit")
}
