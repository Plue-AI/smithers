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
// The dispatcher's observation of a run on its live host is the source: every
// observed page's events are kept as the journal, and every lifecycle page
// also retains the host's own summary and tree rows and its monitor. Nothing
// here folds a journal; reads of a sleeping branch serve these answers and
// never wake the machine.
type runArchive struct {
	pool *pgxpool.Pool
	// host is bound after the dispatcher it reads through is built.
	host runArchiveHost
}

// runArchiveReader is the product database the archive is read from.
type runArchiveReader interface {
	QueryRow(context.Context, string, ...any) pgx.Row
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

// archivedRun is one run's retained host answers, and where its journal is.
type archivedRun struct {
	db         runArchiveReader
	repository int64
	workspace  string
	run        string
	FlowID     string
	Status     string
	Summary    json.RawMessage
	Tree       json.RawMessage
	Monitor    json.RawMessage
}

// archivedEventsPage bounds one page of the archived journal, as the host's
// own run-events projection pages it.
const archivedEventsPage = 500

// ProjectFlowRuntime keeps every observed page's events, and captures the
// host's answers at each lifecycle change. A failure is logged and never
// fails the observation; the next lifecycle page captures again.
func (a *runArchive) ProjectFlowRuntime(ctx context.Context, update flowdispatch.ProjectionUpdate) error {
	if a == nil || a.pool == nil {
		return nil
	}
	if err := a.keep(ctx, update); err != nil && ctx.Err() == nil {
		slog.Warn("run archive events failed", "run_id", update.Checkpoint.RunID,
			"workspace_id", update.Checkpoint.Target.WorkspaceID, "error", err)
	}
	if a.host == nil || !runArchiveLifecycle(update) {
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

// keep appends the page's events to the run's archived journal.
func (a *runArchive) keep(ctx context.Context, update flowdispatch.ProjectionUpdate) error {
	cp := update.Checkpoint
	repository, ok := archiveRepository(cp.Target)
	if !ok || cp.RunID == "" || cp.Target.WorkspaceID == "" || len(update.Events) == 0 {
		return nil
	}
	sequences := make([]int64, 0, len(update.Events))
	offsets := make([]int64, 0, len(update.Events))
	events := make([]string, 0, len(update.Events))
	for _, event := range update.Events {
		if event.RunID != "" && event.RunID != cp.RunID {
			return fmt.Errorf("run archive: page of run %s carries run %s's event", cp.RunID, event.RunID)
		}
		event.RunID = cp.RunID
		var offset int64
		if event.Cursor != nil && event.Cursor.Offset != nil {
			offset = *event.Cursor.Offset
		}
		raw, err := json.Marshal(event)
		if err != nil {
			return err
		}
		sequences, offsets, events = append(sequences, event.Sequence), append(offsets, offset), append(events, string(raw))
	}
	_, err := a.pool.Exec(ctx, `INSERT INTO run_archive_events (repository_id, workspace_id, run_id, sequence, cursor_offset, event)
		SELECT $1, $2, $3, page.sequence, page.cursor_offset, page.event::jsonb
		FROM unnest($4::bigint[], $5::bigint[], $6::text[]) AS page(sequence, cursor_offset, event)
		ON CONFLICT DO NOTHING`, repository, cp.Target.WorkspaceID, cp.RunID, sequences, offsets, events)
	return err
}

func (a *runArchive) capture(ctx context.Context, cp flowdispatch.RuntimeCheckpoint) error {
	repository, ok := archiveRepository(cp.Target)
	if !ok || cp.RunID == "" || cp.Target.WorkspaceID == "" {
		return errors.New("run archive: checkpoint names no repository run")
	}
	callContext, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	snapshot := func(kind string) ([]json.RawMessage, error) {
		raw, err := a.host.CallRPC(callContext, cp.Target, "Projection.Snapshot",
			json.RawMessage(fmt.Sprintf(`{"selector":{"_tag":%q,"runId":%q}}`, kind, cp.RunID)))
		if err != nil {
			return nil, err
		}
		var answer struct {
			OK      bool `json:"ok"`
			Payload struct {
				Rows []json.RawMessage `json:"rows"`
			} `json:"payload"`
		}
		if json.Unmarshal(raw, &answer) != nil || !answer.OK || answer.Payload.Rows == nil {
			return nil, fmt.Errorf("run archive: invalid %s snapshot", kind)
		}
		return answer.Payload.Rows, nil
	}
	summaries, err := snapshot("run-summary")
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
	tree, err := snapshot("run-tree")
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

// readRunArchive is the run's retained host answers, or pgx.ErrNoRows.
func readRunArchive(ctx context.Context, db runArchiveReader, repository int64, workspace, run string) (archivedRun, error) {
	archived := archivedRun{db: db, repository: repository, workspace: workspace, run: run}
	if db == nil {
		return archived, pgx.ErrNoRows
	}
	if typed, ok := db.(*pgxpool.Pool); ok && typed == nil {
		return archived, pgx.ErrNoRows
	}
	err := db.QueryRow(ctx, `SELECT flow_id, status, summary, tree, monitor FROM run_archives
		WHERE repository_id = $1 AND workspace_id = $2 AND run_id = $3`, repository, workspace, run).
		Scan(&archived.FlowID, &archived.Status, &archived.Summary, &archived.Tree, &archived.Monitor)
	return archived, err
}

// archivedEvent is one archived journal row and its position.
type archivedEvent struct {
	sequence, offset int64
	raw              json.RawMessage
}

// eventsAfter pages the archived journal in order: at most limit rows after
// (sequence, offset), or from the start when after is nil.
func (archived archivedRun) eventsAfter(ctx context.Context, after *[2]int64, limit int) ([]archivedEvent, error) {
	from := [2]int64{-1, -1}
	if after != nil {
		from = *after
	}
	rows, err := archived.db.Query(ctx, `SELECT sequence, cursor_offset, event FROM run_archive_events
		WHERE repository_id = $1 AND workspace_id = $2 AND run_id = $3 AND (sequence, cursor_offset) > ($4, $5)
		ORDER BY sequence, cursor_offset LIMIT $6`, archived.repository, archived.workspace, archived.run, from[0], from[1], limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	events := []archivedEvent{}
	for rows.Next() {
		var event archivedEvent
		if err := rows.Scan(&event.sequence, &event.offset, &event.raw); err != nil {
			return nil, err
		}
		events = append(events, event)
	}
	return events, rows.Err()
}

// head is the newest archived journal sequence.
func (archived archivedRun) head(ctx context.Context) (int64, error) {
	var head int64
	err := archived.db.QueryRow(ctx, `SELECT COALESCE(MAX(sequence), 0) FROM run_archive_events
		WHERE repository_id = $1 AND workspace_id = $2 AND run_id = $3`, archived.repository, archived.workspace, archived.run).Scan(&head)
	return head, err
}

// journal is the archived journal as the monitor's journal tab shows it.
func (archived archivedRun) journal(ctx context.Context) ([]any, error) {
	entries := []any{}
	var after *[2]int64
	for pages := 0; pages < 200; pages++ {
		events, err := archived.eventsAfter(ctx, after, archivedEventsPage)
		if err != nil {
			return nil, err
		}
		for _, event := range events {
			entry, err := journalEntry(event.raw)
			if err != nil {
				return nil, err
			}
			entries = append(entries, entry)
		}
		if len(events) < archivedEventsPage {
			return entries, nil
		}
		last := events[len(events)-1]
		after = &[2]int64{last.sequence, last.offset}
	}
	return nil, errors.New("run archive: journal exceeds the inspection limit")
}

// journalEntry is one run-events row as a monitor journal entry.
func journalEntry(raw json.RawMessage) (map[string]any, error) {
	var event flowruntime.Event
	if err := json.Unmarshal(raw, &event); err != nil {
		return nil, err
	}
	text := "null"
	if len(event.Payload) > 0 {
		text = string(event.Payload)
	}
	kind := event.Kind
	if kind == "" {
		kind = "event"
	}
	return map[string]any{"seq": event.Sequence, "at": time.UnixMilli(int64(event.OccurredAt)).UTC().Format("2006-01-02T15:04:05.000Z07:00"),
		"type": kind, "text": text}, nil
}

// snapshot answers a Projection.Snapshot of the archived run the way its host
// did: run-summary and run-tree rows as retained, run-events as the journal,
// paged after the caller's cursor. ok is false for anything else.
func (archived archivedRun) snapshot(ctx context.Context, payload json.RawMessage) (json.RawMessage, bool, error) {
	var request struct {
		Selector map[string]any `json:"selector"`
		After    *struct {
			Value  int64 `json:"value"`
			Offset int64 `json:"offset"`
		} `json:"after"`
	}
	if json.Unmarshal(payload, &request) != nil || len(request.Selector) != 2 || request.Selector["runId"] != archived.run {
		return nil, false, nil
	}
	kind, _ := request.Selector["_tag"].(string)
	if kind != "run-events" && request.After != nil {
		return nil, false, nil
	}
	head, err := archived.head(ctx)
	if err != nil {
		return nil, false, err
	}
	cursor := [2]int64{head, 0}
	var rows []json.RawMessage
	switch kind {
	case "run-summary":
		rows = []json.RawMessage{archived.Summary}
	case "run-tree":
		if err := json.Unmarshal(archived.Tree, &rows); err != nil {
			return nil, false, err
		}
	case "run-events":
		var after *[2]int64
		if request.After != nil {
			after = &[2]int64{request.After.Value, request.After.Offset}
			cursor = *after
		}
		events, err := archived.eventsAfter(ctx, after, archivedEventsPage)
		if err != nil {
			return nil, false, err
		}
		rows = []json.RawMessage{}
		for _, event := range events {
			rows = append(rows, event.raw)
			cursor = [2]int64{event.sequence, event.offset}
		}
	default:
		return nil, false, nil
	}
	selector := map[string]string{"_tag": kind, "runId": archived.run}
	answer, err := json.Marshal(map[string]any{"ok": true, "payload": map[string]any{"selector": selector,
		"cursor": map[string]any{"selector": selector, "projection": kind, "runId": archived.run, "value": cursor[0], "offset": cursor[1]}, "rows": rows}})
	return answer, err == nil, err
}

// livePage is the archived run as the run:<id> topic serves it: the summary
// without its wall-clock rollup, the tree rows, and the journal after the
// subscriber's cursor. The archive never changes under a cursor it served.
func (archived archivedRun) livePage(ctx context.Context, after *int64) (live.LogPage, map[string]any, error) {
	head, err := archived.head(ctx)
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
	if after != nil && *after < head {
		events, err := archived.eventsAfter(ctx, &[2]int64{*after, 1<<53 - 1}, 1000+1)
		if err != nil {
			return live.LogPage{}, nil, err
		}
		if len(events) > 1000 {
			return live.LogPage{Gap: true}, nil, nil
		}
		for _, event := range events {
			newer = append(newer, event.raw)
		}
	}
	return live.LogPage{Cursor: head}, map[string]any{"summary": summary, "steps": steps, "events": newer}, nil
}
