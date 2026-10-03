package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// Durable admission/cancellation uses the real dispatcher and PostgreSQL.
// No runtime is contacted: resolving one here is a test failure.
type todoStorageNoRuntime struct{}

func (todoStorageNoRuntime) ResolveFlowRuntime(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
	return nil, errors.New("storage cancellation must not contact a runtime")
}

func todoStorageDispatch(t *testing.T, f *todoFixture, item db.MythicalItem) (*jobs.Store, jobs.Scope, jobs.RequestReceipt) {
	return todoStorageDispatchPhase(t, f, item, "request")
}

func todoStorageDispatchPhase(t *testing.T, f *todoFixture, item db.MythicalItem, phase string) (*jobs.Store, jobs.Scope, jobs.RequestReceipt) {
	t.Helper()
	ctx := context.Background()
	store, err := jobs.NewStore(f.pool)
	require.NoError(t, err)
	launcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Resolver: todoStorageNoRuntime{}})
	require.NoError(t, err)
	f.service.SetLauncher(launcher)
	scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", f.repoID), PrincipalID: fmt.Sprintf("user:%d", f.userID)}
	projection, err := json.Marshal(mythicalProjection{Kind: mythicalBindingKind, ItemID: uuidString(item.ID), Generation: item.Generation, Phase: phase})
	require.NoError(t, err)
	receipt, err := launcher.Admit(ctx, flowdispatch.LaunchRequest{
		Scope: scope, RequestID: mythicalLaunchRequestID(item, phase), FlowID: "todo",
		Target:  flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, WorkspaceID: "storage-workspace", BindingKind: mythicalBindingKind, BindingID: uuidString(item.ID)},
		Payload: json.RawMessage(`{}`), Projection: projection, ApprovalPolicy: flowdispatch.ApprovalAuto,
	})
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `UPDATE product_job_requests SET state = 'waiting' WHERE id = $1`, receipt.OperationID)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `UPDATE product_job_dispatches SET external_receipt = '{"version":1,"runId":"attempt-run"}' WHERE operation_id = $1`, receipt.OperationID)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `INSERT INTO todo_attempts(todo_id, attempt, run_id) VALUES ($1, 1, 'attempt-run')`, uuidString(item.TodoID))
	require.NoError(t, err)
	return store, scope, receipt
}

// A parked/failed attempt can still have a live run after the item leaves
// running. Item phase alone cannot decide whether that run needs cancelling.
func TestTodoTerminalCancelsAttemptAfterItemLeavesLaunchPhase(t *testing.T) {
	for _, terminal := range []string{"landed", "cancelled"} {
		t.Run(terminal, func(t *testing.T) {
			f := newTodoFixture(t)
			f.create("attempt", "An attempt held on the branch")
			item := f.item(1)
			item.State, item.Attempt, item.Generation = "blocked", 1, 2
			_, err := db.New(f.pool).SaveMythicalItem(context.Background(), item)
			require.NoError(t, err)
			_, err = f.pool.Exec(context.Background(), `UPDATE todos SET state = 'failed' WHERE id = $1`, uuidString(item.TodoID))
			require.NoError(t, err)
			store, scope, receipt := todoStorageDispatch(t, f, f.item(1))
			ended := f.item(1)
			ended.State = terminal
			ended.PRMergeCommit = strings.Repeat("c", 40)
			ended.PRNumber = pgtype.Int8{Int64: 9, Valid: true}
			_, err = f.service.saveItem(context.Background(), ended)
			require.NoError(t, err)
			operation, err := store.Get(context.Background(), scope, receipt.OperationID)
			require.NoError(t, err)
			assert.True(t, operation.CancellationRequested, "the attempt run must be cancelled even after the item stopped launching")
		})
	}
}

func TestTodoTerminalSettlesEveryWaitAndRollsBackCancellation(t *testing.T) {
	for _, terminal := range []struct{ item, state string }{{"landed", "merged"}, {"cancelled", "dropped"}} {
		t.Run(terminal.item, func(t *testing.T) {
			f := newTodoFixture(t)
			f.create("waits", "Finish every wait")
			ctx := context.Background()
			item := f.item(1)
			_, err := f.pool.Exec(ctx, `UPDATE mythical_items SET state = 'blocked', paused_at = now() WHERE id = $1`, item.ID)
			require.NoError(t, err)
			_, err = f.pool.Exec(ctx, `UPDATE todos SET state = 'needs_you', needs_you = '{"kind":"question"}' WHERE id = $1`, uuidString(item.TodoID))
			require.NoError(t, err)
			for _, wait := range []struct{ id, kind, owner string }{
				{"question", "question", "run"}, {"approval", "approval", "run"},
				{"conflict", "conflict", "branch"}, {"moved", "moved_off", "branch"}, {"push", "foreign_push", "branch"},
			} {
				_, err = f.pool.Exec(ctx, `INSERT INTO todo_waits(wait_id, todo_id, kind, owner, payload) VALUES ($1, $2, $3, $4, '{}')`, wait.id, uuidString(item.TodoID), wait.kind, wait.owner)
				require.NoError(t, err)
			}
			_, err = f.pool.Exec(ctx, `INSERT INTO todo_waits(wait_id, todo_id, kind, owner, payload, settled_at, settled_by, outcome) VALUES ('old', $1, 'question', 'run', '{}', now() - interval '1 day', '{"person":7}', 'answered')`, uuidString(item.TodoID))
			require.NoError(t, err)
			store, scope, receipt := todoStorageDispatch(t, f, f.item(1))
			beforeEvents, beforeProjections := f.count("todo_events"), f.count("projection_events")
			ended := f.item(1)
			ended.State, ended.PRMergeCommit = terminal.item, strings.Repeat("c", 40)
			ended.PRNumber = pgtype.Int8{Int64: 9, Valid: true}
			tx, err := f.pool.Begin(ctx)
			require.NoError(t, err)
			defer tx.Rollback(ctx)
			saved, err := f.service.saveItemIn(ctx, tx, ended)
			require.NoError(t, err)
			assert.False(t, saved.PausedAt.Valid)
			var open, settled int
			require.NoError(t, tx.QueryRow(ctx, `SELECT count(*) FILTER (WHERE settled_at IS NULL), count(*) FILTER (WHERE outcome = $2 AND settled_by = '{"system":"stack"}') FROM todo_waits WHERE todo_id = $1`, uuidString(item.TodoID), terminal.state).Scan(&open, &settled))
			assert.Zero(t, open)
			assert.Equal(t, 5, settled, "every open wait ends with the work")
			var state string
			var overlaysClear bool
			require.NoError(t, tx.QueryRow(ctx, `SELECT state, needs_you IS NULL FROM todos WHERE id = $1`, uuidString(item.TodoID)).Scan(&state, &overlaysClear))
			assert.Equal(t, terminal.state, state)
			assert.True(t, overlaysClear)
			require.NoError(t, tx.Rollback(ctx))
			assert.Equal(t, "needs_you", f.todo(1).State)
			assert.True(t, f.item(1).PausedAt.Valid)
			assert.Equal(t, beforeEvents, f.count("todo_events"))
			assert.Equal(t, beforeProjections, f.count("projection_events"))
			operation, err := store.Get(ctx, scope, receipt.OperationID)
			require.NoError(t, err)
			assert.False(t, operation.CancellationRequested, "cancellation rolls back with the terminal transition")

			require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM todo_waits WHERE todo_id = $1 AND settled_at IS NULL`, uuidString(item.TodoID)).Scan(&open))
			assert.Equal(t, 5, open, "rollback keeps every open wait")

			_, err = f.service.saveItem(ctx, ended)
			require.NoError(t, err)
			assert.Equal(t, terminal.state, f.todo(1).State)
			var outcome string
			require.NoError(t, f.pool.QueryRow(ctx, `SELECT outcome FROM todo_waits WHERE wait_id = 'old'`).Scan(&outcome))
			assert.Equal(t, "answered", outcome, "already settled waits retain their answers")
			require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM todo_waits WHERE todo_id = $1 AND settled_at IS NULL`, uuidString(item.TodoID)).Scan(&open))
			assert.Zero(t, open)
			for _, topic := range []string{"todo:1", "home"} {
				rows := f.projections(topic)
				last := rows[len(rows)-1]
				var delta map[string]json.RawMessage
				require.NoError(t, json.Unmarshal(last.Payload, &delta))
				var view TodoView
				payload := delta["todo"]
				if topic == "home" {
					payload = delta["item"]
				}
				require.NoError(t, json.Unmarshal(payload, &view))
				assert.Equal(t, TodoState(terminal.state), view.State)
				assert.Empty(t, view.NeedsYou, "a terminal projection never publishes a stale wait")
			}
		})
	}
}

func TestTodoTerminalCancelsAllBoundLaunchesAndKeepsOtherWork(t *testing.T) {
	f := newTodoFixture(t)
	f.create("bound", "End every launch bound to this item")
	f.create("unrelated", "Keep another TODO running")
	ctx := context.Background()
	item := f.item(1)
	store, scope, first := todoStorageDispatch(t, f, item)
	other := f.item(2)
	otherRepository := f.repository("another")
	type launchCase struct {
		name, principal, item string
		repository            int64
		cancel                bool
		terminal              bool
	}
	cases := []launchCase{
		{name: "older-generation", principal: scope.PrincipalID, item: uuidString(item.ID), repository: f.repoID, cancel: true},
		{name: "earlier-actor", principal: "user:999", item: uuidString(item.ID), repository: f.repoID, cancel: true},
		{name: "other-todo", principal: scope.PrincipalID, item: uuidString(other.ID), repository: f.repoID},
		{name: "other-repository", principal: scope.PrincipalID, item: uuidString(item.ID), repository: otherRepository},
		{name: "completed-run", principal: scope.PrincipalID, item: uuidString(item.ID), repository: f.repoID, terminal: true},
	}
	receipts := make([]jobs.RequestReceipt, len(cases))
	for i, c := range cases {
		payload, err := json.Marshal(map[string]any{"projection": mythicalProjection{Kind: mythicalBindingKind, ItemID: c.item, Phase: "request", Generation: 1}})
		require.NoError(t, err)
		receipts[i], err = store.Admit(ctx, jobs.Admission{
			Scope:     jobs.Scope{TenantID: fmt.Sprintf("repository:%d", c.repository), PrincipalID: c.principal},
			Operation: flowdispatch.OperationLaunch, RequestID: c.name, Payload: payload, EffectPolicy: jobs.EffectReconcile,
		})
		require.NoError(t, err)
		if c.terminal {
			_, err := f.pool.Exec(ctx, `UPDATE product_job_requests SET state = 'completed', terminal_receipt = '{}' WHERE id = $1`, receipts[i].OperationID)
			require.NoError(t, err)
		}
	}
	item = f.item(1)
	item.State = "cancelled"
	_, err := f.service.saveItem(ctx, item)
	require.NoError(t, err)
	operation, err := store.Get(ctx, scope, first.OperationID)
	require.NoError(t, err)
	assert.True(t, operation.CancellationRequested)
	for i, c := range cases {
		operation, err := store.Get(ctx, jobs.Scope{TenantID: fmt.Sprintf("repository:%d", c.repository), PrincipalID: c.principal}, receipts[i].OperationID)
		require.NoError(t, err)
		assert.Equal(t, c.cancel, operation.CancellationRequested, c.name)
	}
}

func TestTodoRefusedMergeKeepsWaitAndAttempt(t *testing.T) {
	f := newTodoFixture(t)
	f.create("unconfirmed", "Wait for GitHub main")
	ctx := context.Background()
	item := f.item(1)
	store, scope, receipt := todoStorageDispatch(t, f, item)
	_, err := f.pool.Exec(ctx, `INSERT INTO todo_waits(wait_id, todo_id, kind, owner, payload) VALUES ('q', $1, 'question', 'run', '{}')`, uuidString(item.TodoID))
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `UPDATE todos SET state = 'needs_you', needs_you = '{"kind":"question"}' WHERE id = $1`, uuidString(item.TodoID))
	require.NoError(t, err)
	item = f.item(1)
	item.State, item.PRNumber = "landed", pgtype.Int8{Int64: 9, Valid: true}
	beforeEvents, beforeProjections := f.count("todo_events"), f.count("projection_events")
	_, err = f.service.saveItem(ctx, item)
	var refused *TodoTransitionRefused
	require.ErrorAs(t, err, &refused, "GitHub main does not yet contain this merge")
	assert.Equal(t, "queued", f.item(1).State)
	assert.Equal(t, "needs_you", f.todo(1).State)
	assert.Equal(t, beforeEvents, f.count("todo_events"))
	assert.Equal(t, beforeProjections, f.count("projection_events"))
	var open bool
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT settled_at IS NULL FROM todo_waits WHERE wait_id = 'q'`).Scan(&open))
	assert.True(t, open)
	operation, err := store.Get(ctx, scope, receipt.OperationID)
	require.NoError(t, err)
	assert.False(t, operation.CancellationRequested)
}

func TestTodoCreationRollbackReusesNumberAndKey(t *testing.T) {
	f := newTodoFixture(t)
	ctx := context.Background()
	// The number has been allocated before this FK refusal. PostgreSQL must
	// roll back the allocation, its branch/revision and idempotency key.
	_, _, err := f.todos.Create(ctx, f.repoID, TodoPerson(999999, ""), "rollback-key", CreateTodoInput{Title: "Rollback a creation"})
	require.ErrorContains(t, err, "todos_owner_id_fkey")
	for _, table := range []string{"todos", "todo_revisions", "todo_events", "projection_events", "mythical_items"} {
		assert.Zero(t, f.count(table), table)
	}
	view := f.create("rollback-key", "Rollback a creation")
	assert.Equal(t, int64(1), view.N)
	assert.Equal(t, "smithers/rollback-a-creation", view.Branch.Name)
}
