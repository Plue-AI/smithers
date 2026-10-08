package compose

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/live"
)

// runArchiveHost is the dispatcher's read-only reach into a run's live host.
type runArchiveHost interface {
	Monitor(context.Context, flowruntime.Target, string, *int64) (json.RawMessage, error)
	CallRPC(context.Context, flowruntime.Target, string, json.RawMessage) (json.RawMessage, error)
}

// runArchive keeps a run readable after its branch machine stops (T-FLW-07).
// While the dispatcher observes a run on its live host, every lifecycle page
// retains that host's own answers for the run: its summary and tree rows and
// its monitor, journal included. Nothing here folds a journal; reads of a
// sleeping branch serve these answers and never wake the machine.
type runArchive struct {
	pool *pgxpool.Pool
	// host is bound after the dispatcher it reads through is built.
	host runArchiveHost
}

// archivedRun is one run's retained host answers.
type archivedRun struct {
	FlowID  string
	Status  string
	Summary json.RawMessage
	Tree    json.RawMessage
	Monitor json.RawMessage
}

// ProjectFlowRuntime captures the run at each observed lifecycle change. A
// capture that fails is logged and never fails the observation: the next
// lifecycle page captures again.
func (a *runArchive) ProjectFlowRuntime(ctx context.Context, update flowdispatch.ProjectionUpdate) error {
	if a == nil || a.pool == nil || a.host == nil || !runArchiveLifecycle(update) {
		return nil
	}
	if err := a.capture(ctx, update.Checkpoint); err != nil && ctx.Err() == nil {
		slog.Warn("run archive capture failed", "run_id", update.Checkpoint.RunID,
			"workspace_id", update.Checkpoint.Target.WorkspaceID, "error", err)
	}
	return nil
}

func runArchiveLifecycle(update flowdispatch.ProjectionUpdate) bool {
	for _, event := range update.Events {
		if strings.HasPrefix(event.Kind, "control.run.") {
			return true
		}
	}
	return false
}

func archiveRepository(target flowruntime.Target) (int64, bool) {
	id, err := strconv.ParseInt(strings.TrimPrefix(target.TenantID, "repository:"), 10, 64)
	return id, err == nil && id > 0 && strings.HasPrefix(target.TenantID, "repository:")
}

func (a *runArchive) capture(ctx context.Context, cp flowdispatch.RuntimeCheckpoint) error {
	repository, ok := archiveRepository(cp.Target)
	if !ok || cp.RunID == "" || cp.Target.WorkspaceID == "" {
		return errors.New("run archive: checkpoint names no repository run")
	}
	callContext, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	snapshot := func(kind string) (json.RawMessage, []json.RawMessage, error) {
		raw, err := a.host.CallRPC(callContext, cp.Target, "Projection.Snapshot",
			json.RawMessage(fmt.Sprintf(`{"selector":{"_tag":%q,"runId":%q}}`, kind, cp.RunID)))
		if err != nil {
			return nil, nil, err
		}
		var answer struct {
			OK      bool `json:"ok"`
			Payload struct {
				Rows []json.RawMessage `json:"rows"`
			} `json:"payload"`
		}
		if json.Unmarshal(raw, &answer) != nil || !answer.OK || answer.Payload.Rows == nil {
			return nil, nil, fmt.Errorf("run archive: invalid %s snapshot", kind)
		}
		return raw, answer.Payload.Rows, nil
	}
	_, summaries, err := snapshot("run-summary")
	if err != nil {
		return err
	}
	var row struct {
		RunID  string `json:"runId"`
		FlowID string `json:"flowId"`
		Status string `json:"status"`
	}
	if len(summaries) != 1 || json.Unmarshal(summaries[0], &row) != nil || row.RunID != cp.RunID || row.FlowID == "" || row.Status == "" {
		return errors.New("run archive: invalid run summary")
	}
	_, tree, err := snapshot("run-tree")
	if err != nil {
		return err
	}
	treeRows, err := json.Marshal(tree)
	if err != nil {
		return err
	}
	monitor, err := a.host.Monitor(callContext, cp.Target, cp.RunID, nil)
	if err != nil {
		return err
	}
	var identity struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(monitor, &identity) != nil || identity.ID != cp.RunID {
		return errors.New("run archive: invalid monitor")
	}
	_, err = a.pool.Exec(ctx, `INSERT INTO run_archives (repository_id, workspace_id, run_id, flow_id, status, summary, tree, monitor)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (repository_id, workspace_id, run_id) DO UPDATE SET flow_id = EXCLUDED.flow_id, status = EXCLUDED.status,
			summary = EXCLUDED.summary, tree = EXCLUDED.tree, monitor = EXCLUDED.monitor, captured_at = now()`,
		repository, cp.Target.WorkspaceID, cp.RunID, row.FlowID, row.Status, summaries[0], treeRows, monitor)
	return err
}

// runArchiveReader is the product database the archive is read from.
type runArchiveReader interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

// readRunArchive is the run's retained host answers, or pgx.ErrNoRows.
func readRunArchive(ctx context.Context, pool runArchiveReader, repository int64, workspace, run string) (archivedRun, error) {
	var archived archivedRun
	if pool == nil {
		return archived, pgx.ErrNoRows
	}
	if typed, ok := pool.(*pgxpool.Pool); ok && typed == nil {
		return archived, pgx.ErrNoRows
	}
	err := pool.QueryRow(ctx, `SELECT flow_id, status, summary, tree, monitor FROM run_archives
		WHERE repository_id = $1 AND workspace_id = $2 AND run_id = $3`, repository, workspace, run).
		Scan(&archived.FlowID, &archived.Status, &archived.Summary, &archived.Tree, &archived.Monitor)
	return archived, err
}

// events are the archived journal as the host's run-events rows, in order.
func (archived archivedRun) events(run string) ([]json.RawMessage, int64, error) {
	var monitor struct {
		Journal []struct {
			Seq  int64  `json:"seq"`
			At   string `json:"at"`
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"journal"`
	}
	if err := json.Unmarshal(archived.Monitor, &monitor); err != nil {
		return nil, 0, err
	}
	rows := make([]json.RawMessage, 0, len(monitor.Journal))
	var head int64
	for _, entry := range monitor.Journal {
		at, err := time.Parse(time.RFC3339Nano, entry.At)
		if err != nil || !json.Valid([]byte(entry.Text)) || entry.Seq < head {
			return nil, 0, errors.New("run archive: invalid journal")
		}
		head = entry.Seq
		row, err := json.Marshal(map[string]any{"sequence": entry.Seq, "kind": entry.Type, "runId": run,
			"occurredAt": at.UnixMilli(), "payload": json.RawMessage(entry.Text)})
		if err != nil {
			return nil, 0, err
		}
		rows = append(rows, row)
	}
	return rows, head, nil
}

// snapshot answers a Projection.Snapshot of the archived run the way its host
// did: run-summary and run-tree rows as retained, run-events as the journal.
// ok is false for any selector the archive does not hold.
func (archived archivedRun) snapshot(run string, payload json.RawMessage) (json.RawMessage, bool, error) {
	var request struct {
		Selector map[string]any `json:"selector"`
		After    any            `json:"after"`
	}
	if json.Unmarshal(payload, &request) != nil || len(request.Selector) != 2 || request.Selector["runId"] != run {
		return nil, false, nil
	}
	kind, _ := request.Selector["_tag"].(string)
	var rows []json.RawMessage
	_, head, err := archived.events(run)
	if err != nil {
		return nil, false, err
	}
	switch kind {
	case "run-summary":
		rows = []json.RawMessage{archived.Summary}
	case "run-tree":
		if err := json.Unmarshal(archived.Tree, &rows); err != nil {
			return nil, false, err
		}
	case "run-events":
		if request.After != nil {
			return nil, false, nil
		}
		if rows, _, err = archived.events(run); err != nil {
			return nil, false, err
		}
	default:
		return nil, false, nil
	}
	selector := map[string]string{"_tag": kind, "runId": run}
	answer, err := json.Marshal(map[string]any{"ok": true, "payload": map[string]any{"selector": selector,
		"cursor": map[string]any{"selector": selector, "projection": kind, "runId": run, "value": head, "offset": 0}, "rows": rows}})
	return answer, err == nil, err
}

// livePage is the archived run as the run:<id> topic serves it: the summary
// without its wall-clock rollup, the tree rows, and the journal after the
// subscriber's cursor. The archive never changes under a cursor it served.
func (archived archivedRun) livePage(run string, after *int64) (live.LogPage, map[string]any, error) {
	events, head, err := archived.events(run)
	if err != nil {
		return live.LogPage{}, nil, err
	}
	if after != nil && *after > head {
		return live.LogPage{Gap: true}, nil, nil
	}
	var summary map[string]json.RawMessage
	if err := json.Unmarshal(archived.Summary, &summary); err != nil {
		return live.LogPage{}, nil, err
	}
	delete(summary, "statusRollup")
	var steps []json.RawMessage
	if err := json.Unmarshal(archived.Tree, &steps); err != nil {
		return live.LogPage{}, nil, err
	}
	newer := []json.RawMessage{}
	if after != nil {
		for _, raw := range events {
			var event struct {
				Sequence int64 `json:"sequence"`
			}
			if json.Unmarshal(raw, &event) == nil && event.Sequence > *after {
				newer = append(newer, raw)
			}
		}
	}
	return live.LogPage{Cursor: head}, map[string]any{"summary": summary, "steps": steps, "events": newer}, nil
}
