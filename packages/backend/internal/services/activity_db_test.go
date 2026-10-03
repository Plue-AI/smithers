package services

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// engineEvent is a runtime journal event the way the coding host reports a
// flow engine record (control.engine.event wrapping the engine's record).
func engineEvent(sequence int64, eventType, nodeID, kind, action string) flowruntime.FlowRuntimeEvent {
	payload, _ := json.Marshal(map[string]any{"version": 1, "eventType": eventType,
		"payload": map[string]any{"nodeId": nodeID, "kind": kind, "attempt": 1, "action": action}})
	return flowruntime.FlowRuntimeEvent{Sequence: sequence, Kind: "control.engine.event", RunID: "run-7", Payload: payload}
}

// An agent step from the runtime projection appends one step entry to the
// TODO's branch, once however often its page is observed, and publishes it
// on branch:<id>:activity.
func TestActivityRecordsAgentStepsFromTheRuntimeProjection(t *testing.T) {
	f := newTodoFixture(t)
	ctx := context.Background()
	view := f.create("k", "Ship it")
	item := f.item(1)
	// Publication must observe the new runtime row, never its old run binding (§3.1).
	_, err := f.pool.Exec(ctx, `CREATE FUNCTION assert_activity_facts() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.topic LIKE 'branch:%:activity' AND NOT EXISTS (SELECT 1 FROM mythical_items WHERE request_run_id = 'run-7') THEN RAISE EXCEPTION 'activity published before item save'; END IF;
 RETURN NEW; END $$; CREATE TRIGGER assert_activity_facts BEFORE INSERT ON projection_events FOR EACH ROW EXECUTE FUNCTION assert_activity_facts()`, pgx.QueryExecModeSimpleProtocol)
	require.NoError(t, err)
	projection, _ := json.Marshal(mythicalProjection{Kind: mythicalBindingKind, ItemID: uuidString(item.ID), Generation: item.Generation, Phase: "request"})
	update := flowdispatch.ProjectionUpdate{State: jobs.StateWaiting,
		Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: projection, RunID: "run-7"},
		Events: []flowruntime.FlowRuntimeEvent{
			{Sequence: 1, Kind: "control.run.running", RunID: "run-7", Payload: json.RawMessage(`{}`)},
			engineEvent(2, "flows.engine.plan-recorded", "", "", ""),
			engineEvent(3, "flows.engine.node-scheduled", "implement", "ActionCall", "coding/implement"),
			engineEvent(4, "flows.engine.node-scheduled", "gate", "Branch", ""),
			engineEvent(5, "flows.engine.node-settled", "implement", "ActionCall", "coding/implement"),
		}}
	require.NoError(t, f.service.ProjectFlowRuntime(ctx, update))
	require.NoError(t, f.service.ProjectFlowRuntime(ctx, update), "a page observed again")

	_, entries, err := f.todos.BranchActivity(ctx, view.Branch.ID)
	require.NoError(t, err)
	require.Len(t, entries, 1, "one step: the action call's start")
	entry := entries[0]
	assert.Equal(t, "step", entry.Kind)
	assert.Equal(t, int64(1), entry.Seq)
	assert.JSONEq(t, `{"kind":"agent","agent":"coding","run":"run-7","todo":1}`, string(entry.Actor))
	assert.JSONEq(t, `{"step":"implement","phase":"request","run":"run-7","action":"coding/implement"}`, string(entry.Summary))
	rows := f.projections("branch:" + view.Branch.ID + ":activity")
	require.Len(t, rows, 1)
	var delta ActivityDelta
	require.NoError(t, json.Unmarshal(rows[0].Payload, &delta))
	assert.Equal(t, "entry", delta.Type)
	assert.Equal(t, int64(1), delta.Entry.Seq)

	// The run reporting its id also moved the TODO from starting? It is
	// queued: the item was never launched, so nothing but the step changed.
	assert.Equal(t, string(TodoQueued), f.todo(1).State)

	// A projection of an older generation records nothing.
	stale, _ := json.Marshal(mythicalProjection{Kind: mythicalBindingKind, ItemID: uuidString(item.ID), Generation: item.Generation + 5, Phase: "request"})
	update.Checkpoint.Projection = stale
	update.Events = []flowruntime.FlowRuntimeEvent{engineEvent(9, "flows.engine.node-scheduled", "check", "ActionCall", "")}
	require.NoError(t, f.service.ProjectFlowRuntime(ctx, update))
	_, entries, err = f.todos.BranchActivity(ctx, view.Branch.ID)
	require.NoError(t, err)
	assert.Len(t, entries, 1)
}

// A branch's activity answers its newest 200 entries, oldest first, numbered
// per branch without gaps.
func TestActivityListsTheNewest200InOrder(t *testing.T) {
	f := newTodoFixture(t)
	ctx := context.Background()
	view := f.create("k", "Ship it")
	other := f.create("k2", "Another")
	for i := 1; i <= ActivityLimit+5; i++ {
		require.NoError(t, pgx.BeginFunc(ctx, f.pool, func(tx pgx.Tx) error {
			_, appended, err := AppendActivity(ctx, tx, view.Branch.ID, TodoPerson(f.memberID, ""), nil, ActivitySteer, map[string]int{"i": i}, "")
			if err == nil && !appended {
				err = fmt.Errorf("entry %d was not appended", i)
			}
			return err
		}))
	}
	require.NoError(t, pgx.BeginFunc(ctx, f.pool, func(tx pgx.Tx) error {
		_, _, err := AppendActivity(ctx, tx, other.Branch.ID, TodoPerson(f.memberID, ""), nil, ActivityAnswer, map[string]int{"i": 1}, "")
		return err
	}))
	repositoryID, entries, err := f.todos.BranchActivity(ctx, view.Branch.ID)
	require.NoError(t, err)
	assert.Equal(t, f.repoID, repositoryID)
	require.Len(t, entries, ActivityLimit)
	for i, entry := range entries {
		assert.Equal(t, int64(i+6), entry.Seq)
		var summary map[string]int
		require.NoError(t, json.Unmarshal(entry.Summary, &summary))
		assert.Equal(t, i+6, summary["i"])
	}
	_, theirs, err := f.todos.BranchActivity(ctx, other.Branch.ID)
	require.NoError(t, err)
	require.Len(t, theirs, 1)
	assert.Equal(t, int64(1), theirs[0].Seq, "each branch numbers its own entries")

	err = pgx.BeginFunc(ctx, f.pool, func(tx pgx.Tx) error {
		_, _, err := AppendActivity(ctx, tx, view.Branch.ID, TodoPerson(f.memberID, ""), nil, "chat", map[string]int{}, "")
		return err
	})
	require.ErrorContains(t, err, "not one of spec §3's")
	_, _, err = f.todos.BranchActivity(ctx, "not-a-branch")
	require.Error(t, err)
	_, _, err = f.todos.BranchActivity(ctx, "00000000-0000-4000-8000-000000000000")
	require.Error(t, err)
	_ = db.New(f.pool)
}

// The launch receipt is runtime identity, not evidence that an action ran.
func TestActivityRuntimeFirstStepBoundaryPostgres(t *testing.T) {
	f := newTodoFixture(t)
	ctx := context.Background()
	view := f.create("first-step", "First step")
	item := f.item(1)
	item.State = "running"
	item.WorkspaceID = uuid.NewString()
	_, err := f.pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,status) VALUES($1,$2,$3,'running')`, item.WorkspaceID, f.repoID, f.userID)
	require.NoError(t, err)
	_, err = f.service.saveItem(ctx, item)
	require.NoError(t, err)
	require.Equal(t, string(TodoStarting), f.todo(1).State)
	item = f.item(1)
	projection, _ := json.Marshal(mythicalProjection{Kind: mythicalBindingKind, ItemID: uuidString(item.ID), Generation: item.Generation, Phase: "request"})
	update := flowdispatch.ProjectionUpdate{State: jobs.StateWaiting, Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: projection, RunID: "run-7"}}
	before := len(f.events(1))
	require.NoError(t, f.service.ProjectFlowRuntime(ctx, update))
	require.Equal(t, "run-7", f.item(1).RequestRunID, "keep receipt for cancellation/recovery")
	require.Equal(t, string(TodoStarting), f.todo(1).State, "no journal events at launch")
	require.Len(t, f.events(1), before)
	update.Events = []flowruntime.FlowRuntimeEvent{engineEvent(1, "flows.engine.node-scheduled", "branch", "Branch", "")}
	require.NoError(t, f.service.ProjectFlowRuntime(ctx, update))
	require.Equal(t, string(TodoStarting), f.todo(1).State, "control nodes are not action steps")
	update.Events = []flowruntime.FlowRuntimeEvent{engineEvent(2, "flows.engine.node-scheduled", "implement", "ActionCall", "coding/implement")}
	require.NoError(t, f.service.ProjectFlowRuntime(ctx, update))
	require.Equal(t, string(TodoWorking), f.todo(1).State)
	require.Len(t, f.events(1), before+1)
	require.Equal(t, string(TodoRunStarted), f.events(1)[before].Kind)
	_, entries, err := f.todos.BranchActivity(ctx, view.Branch.ID)
	require.NoError(t, err)
	require.Len(t, entries, 1)
	after := f.todo(1)
	require.NoError(t, f.service.ProjectFlowRuntime(ctx, update))
	update.Events = nil // an older receipt page must not undo persisted evidence
	require.NoError(t, f.service.ProjectFlowRuntime(ctx, update))
	require.Equal(t, after, f.todo(1))
	require.Len(t, f.events(1), before+1)
	require.Len(t, f.projections("branch:"+view.Branch.ID+":activity"), 1)
	stale, _ := json.Marshal(mythicalProjection{Kind: mythicalBindingKind, ItemID: uuidString(item.ID), Generation: item.Generation - 1, Phase: "request"})
	update.Checkpoint.Projection, update.Checkpoint.RunID = stale, "stale-run"
	update.Events = []flowruntime.FlowRuntimeEvent{engineEvent(3, "flows.engine.node-scheduled", "other", "ActionCall", "")}
	require.NoError(t, f.service.ProjectFlowRuntime(ctx, update))
	require.Equal(t, "run-7", f.item(1).RequestRunID)
	require.Equal(t, after, f.todo(1))
	require.Len(t, f.projections("branch:"+view.Branch.ID+":activity"), 1)
}

func TestActivitySystemRequesterPostgres(t *testing.T) {
	f := newTodoFixture(t)
	ctx := context.Background()
	view := f.create("system", "History")
	requester := TodoPerson(f.memberID, "agent")
	require.NoError(t, pgx.BeginFunc(ctx, f.pool, func(tx pgx.Tx) error {
		entry, appended, err := AppendActivity(ctx, tx, view.Branch.ID, todoStackActor, &requester, ActivityRebase, map[string]string{"onto": "T8"}, "history-1")
		if err != nil {
			return err
		}
		require.True(t, appended)
		require.JSONEq(t, `{"kind":"system","name":"stack"}`, string(entry.Actor))
		require.JSONEq(t, string(todoActorRef(requester.encode())), string(entry.AskedBy))
		return nil
	}))
	var actor, asked []byte
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT actor, asked_by FROM activity WHERE branch_id=$1`, view.Branch.ID).Scan(&actor, &asked))
	require.JSONEq(t, `{"system":"stack"}`, string(actor))
	require.JSONEq(t, string(requester.encode()), string(asked))
	_, entries, err := f.todos.BranchActivity(ctx, view.Branch.ID)
	require.NoError(t, err)
	require.Len(t, entries, 1)
	require.JSONEq(t, string(todoActorRef(asked)), string(entries[0].AskedBy))
	rows := f.projections("branch:" + view.Branch.ID + ":activity")
	require.Len(t, rows, 1)
	var delta ActivityDelta
	require.NoError(t, json.Unmarshal(rows[0].Payload, &delta))
	require.JSONEq(t, string(todoActorRef(actor)), string(delta.Entry.Actor))
	require.JSONEq(t, string(todoActorRef(asked)), string(delta.Entry.AskedBy))
	require.NoError(t, pgx.BeginFunc(ctx, f.pool, func(tx pgx.Tx) error {
		original, appended, err := AppendActivity(ctx, tx, view.Branch.ID, TodoPerson(f.memberID, ""), nil, ActivityRebase, map[string]string{}, "history-1")
		require.False(t, appended)
		require.JSONEq(t, string(todoActorRef(asked)), string(original.AskedBy))
		return err
	}))
	require.Len(t, f.projections("branch:"+view.Branch.ID+":activity"), 1)
}

func TestActivityFirstStepRollsBackWithTodoEventPostgres(t *testing.T) {
	f := newTodoFixture(t)
	ctx := context.Background()
	view := f.create("atomic", "Atomic first step")
	item := f.item(1)
	item.State = "running"
	item.WorkspaceID = uuid.NewString()
	_, err := f.pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,status) VALUES($1,$2,$3,'running')`, item.WorkspaceID, f.repoID, f.userID)
	require.NoError(t, err)
	_, err = f.service.saveItem(ctx, item)
	require.NoError(t, err)
	item = f.item(1)
	before := f.todo(1)
	// A failed durable state event must also undo the step and runtime identity.
	_, err = f.pool.Exec(ctx, `CREATE FUNCTION refuse_run_started() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN IF NEW.kind = 'run_started' THEN RAISE EXCEPTION 'event unavailable'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER refuse_run_started BEFORE INSERT ON todo_events FOR EACH ROW EXECUTE FUNCTION refuse_run_started()`)
	require.NoError(t, err)
	projection, _ := json.Marshal(mythicalProjection{Kind: mythicalBindingKind, ItemID: uuidString(item.ID), Generation: item.Generation, Phase: "request"})
	update := flowdispatch.ProjectionUpdate{State: jobs.StateWaiting, Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: projection, RunID: "run-7"}, Events: []flowruntime.FlowRuntimeEvent{engineEvent(1, runtimeNodeScheduled, "implement", runtimeActionCall, "")}}
	require.ErrorContains(t, f.service.ProjectFlowRuntime(ctx, update), "event unavailable")
	require.Equal(t, item, f.item(1))
	require.Equal(t, before, f.todo(1))
	require.Len(t, f.events(1), 2)
	require.Empty(t, f.projections("branch:"+view.Branch.ID+":activity"))
	_, entries, err := f.todos.BranchActivity(ctx, view.Branch.ID)
	require.NoError(t, err)
	require.Empty(t, entries)
}
