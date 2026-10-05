package compose

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/live"
)

// runRefreshEvery is how often a watched run's lane is read: a step's state
// reaches run:<lane>:<run> within 1 s (C-J11-01).
const runRefreshEvery = 250 * time.Millisecond

// errRunNotOnLane is a host's answer that names no such run: a lane's run
// ids are its own, and a review's machine runs none of the TODO's.
var errRunNotOnLane = errors.New("the lane's host answered no such run")

// runReader is the lane's flow seam (flowdispatch.Service).
type runReader interface {
	CallRPC(context.Context, flowruntime.Target, string, json.RawMessage) (json.RawMessage, error)
}

// runJournals keeps a run's projections on the install (spec §7.2 run:<id>):
// read from the run's lane while it runs, kept in run_journals, and served
// from there once the lane stops. A merged TODO's lane is stopped (the
// stack retires it) and a read never wakes a sleeping branch (mvp.md §6), so
// the install, not the lane, is where a finished run is read.
type runJournals struct {
	pool    *pgxpool.Pool
	queries *db.Queries
	reader  runReader

	mu   sync.Mutex
	kept map[string][]byte // lane/run/selector → the answer last kept
}

func newRunJournals(pool *pgxpool.Pool, queries *db.Queries, reader runReader) *runJournals {
	return &runJournals{pool: pool, queries: queries, reader: reader, kept: map[string][]byte{}}
}

// answered reports whether a host answer is a successful snapshot.
func answered(answer json.RawMessage) bool {
	var envelope struct {
		OK bool `json:"ok"`
	}
	return json.Unmarshal(answer, &envelope) == nil && envelope.OK
}

// keep stores one host answer of lane's run, unless it is the one kept last.
func (j *runJournals) keep(ctx context.Context, repository int64, lane, run, tag string, answer json.RawMessage) {
	if j == nil || !live.KeptProjections[tag] || !answered(answer) {
		return
	}
	key := lane + "/" + run + "/" + tag
	j.mu.Lock()
	same := bytes.Equal(j.kept[key], answer)
	j.mu.Unlock()
	if same {
		return
	}
	_, err := j.pool.Exec(ctx, `INSERT INTO run_journals (workspace_id, run_id, selector, repository_id, answer) VALUES ($1, $2, $3, $4, $5::text::json)
		ON CONFLICT (workspace_id, run_id, selector) DO UPDATE SET answer = EXCLUDED.answer, captured_at = now()`,
		lane, run, tag, repository, string(answer))
	if err != nil {
		if ctx.Err() == nil {
			slog.Warn("run_journal.keep_failed", "workspace_id", lane, "run_id", run, "selector", tag, "error", err)
		}
		return
	}
	j.mu.Lock()
	j.kept[key] = append([]byte(nil), answer...)
	j.mu.Unlock()
}

// retained answers lane's run projection as last kept.
func (j *runJournals) retained(ctx context.Context, lane, run, tag string) (json.RawMessage, bool) {
	if j == nil {
		return nil, false
	}
	var answer string
	err := j.pool.QueryRow(ctx, `SELECT answer::text FROM run_journals WHERE workspace_id = $1 AND run_id = $2 AND selector = $3`, lane, run, tag).Scan(&answer)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) && ctx.Err() == nil {
			slog.Warn("run_journal.read_failed", "workspace_id", lane, "run_id", run, "error", err)
		}
		return nil, false
	}
	return json.RawMessage(answer), true
}

// laneTarget is the browser relay's target for a lane, read as the person
// it is shared with (a TODO's lane belongs to the machine service and is
// shared for writing with that one person, GetFlowWorkspaceForUserRepo), or
// as its owner.
func (j *runJournals) laneTarget(ctx context.Context, workspace db.Workspace, slug string) flowruntime.Target {
	reader := workspace.UserID
	var shared []int64
	if rows, err := j.pool.Query(ctx, `SELECT grantee_user_id FROM workspace_shares WHERE workspace_id = $1 AND level = 'write'`, workspace.ID); err == nil {
		for rows.Next() {
			var user int64
			if rows.Scan(&user) == nil {
				shared = append(shared, user)
			}
		}
		rows.Close()
	}
	if len(shared) == 1 {
		reader = shared[0]
	}
	return flowruntime.Target{
		TenantID:    "repository:" + strconv.FormatInt(workspace.RepositoryID, 10),
		PrincipalID: "user:" + strconv.FormatInt(reader, 10),
		WorkspaceID: workspace.ID, BindingKind: "browser-flow", BindingID: slug,
	}
}

// read asks a running lane's host for one projection of run and keeps it.
func (j *runJournals) read(ctx context.Context, workspace db.Workspace, slug, run, tag string) (json.RawMessage, error) {
	payload, _ := json.Marshal(map[string]any{"selector": map[string]string{"_tag": tag, "runId": run}})
	answer, err := j.reader.CallRPC(ctx, j.laneTarget(ctx, workspace, slug), "Projection.Snapshot", payload)
	if err != nil {
		return nil, err
	}
	if !answered(answer) {
		return nil, fmt.Errorf("%w: %s of %s on %s", errRunNotOnLane, tag, run, workspace.ID)
	}
	j.keep(ctx, workspace.RepositoryID, workspace.ID, run, tag, answer)
	return answer, nil
}

// capture keeps every retained projection of the TODO run on a lane its
// stack is about to stop. A capture that fails leaves what was kept before;
// the stop goes on.
func (j *runJournals) capture(ctx context.Context, workspace db.Workspace) {
	if j == nil || j.reader == nil || workspace.Status != "running" {
		return
	}
	lane, err := j.queries.GetMythicalLane(ctx, workspace.ID)
	if err != nil {
		return
	}
	item, err := j.queries.GetMythicalItem(ctx, lane.ItemID)
	if err != nil || item.RequestRunID == "" {
		return
	}
	repository, slug, err := installRepository(ctx, j.queries)
	if err != nil || repository != workspace.RepositoryID {
		return
	}
	// The stack's pass waits on this: a host that does not answer soon
	// leaves what earlier reads kept.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	for tag := range live.KeptProjections {
		if _, err := j.read(ctx, workspace, slug, item.RequestRunID, tag); err != nil && !errors.Is(err, errRunNotOnLane) {
			slog.Warn("run_journal.capture_failed", "workspace_id", workspace.ID, "run_id", item.RequestRunID, "selector", tag, "error", err)
		}
	}
}

// rows is a snapshot answer's rows.
func rows(answer json.RawMessage) ([]json.RawMessage, error) {
	var envelope struct {
		Payload struct {
			Rows []json.RawMessage `json:"rows"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(answer, &envelope); err != nil {
		return nil, err
	}
	return envelope.Payload.Rows, nil
}

// snapshot is the run:<lane>:<run> model: the run's summary row and its
// steps (run-tree rows), read from the lane while it runs and from the
// install once it stops. Every subscriber reads the same bytes.
func (j *runJournals) snapshot(ctx context.Context, slug, lane, run string) (json.RawMessage, error) {
	summary, steps, err := j.answers(ctx, slug, lane, run)
	if err != nil {
		return nil, err
	}
	summaryRows, err := rows(summary)
	if err != nil || len(summaryRows) != 1 {
		return nil, fmt.Errorf("run %s on %s has no summary", run, lane)
	}
	stepRows, err := rows(steps)
	if err != nil {
		return nil, err
	}
	if stepRows == nil {
		stepRows = []json.RawMessage{}
	}
	return json.Marshal(map[string]any{"run": summaryRows[0], "steps": stepRows})
}

func (j *runJournals) answers(ctx context.Context, slug, lane, run string) (json.RawMessage, json.RawMessage, error) {
	workspace, err := j.queries.GetWorkspace(ctx, lane)
	if err == nil && workspace.Status == "running" && j.reader != nil {
		var summary, steps json.RawMessage
		var summaryErr, stepsErr error
		var both sync.WaitGroup
		both.Add(2)
		go func() { defer both.Done(); summary, summaryErr = j.read(ctx, workspace, slug, run, "run-summary") }()
		go func() { defer both.Done(); steps, stepsErr = j.read(ctx, workspace, slug, run, "run-tree") }()
		both.Wait()
		if summaryErr == nil && stepsErr == nil {
			return summary, steps, nil
		}
	}
	summary, ok := j.retained(ctx, lane, run, "run-summary")
	if !ok {
		return nil, nil, fmt.Errorf("run %s on %s is not kept", run, lane)
	}
	steps, ok := j.retained(ctx, lane, run, "run-tree")
	if !ok {
		steps = json.RawMessage(`{"ok":true,"payload":{"rows":[]}}`)
	}
	return summary, steps, nil
}
