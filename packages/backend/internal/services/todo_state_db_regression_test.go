package services

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// The engine's actual item-write transaction, not a reconstruction of it.
// §4.1 line 235 and §12.3 line 1128 at 2be05ba6: a reopened PR restores
// its dropped TODO, keeping its identity, revisions, branch and position.
func TestTodoStatePRReopenRestoresIdentityOncePostgres(t *testing.T) {
	f := newTodoFixture(t)
	for _, age := range []time.Duration{24 * time.Hour, todoReopenWindow} {
		t.Run(age.String(), func(t *testing.T) {
			f.t = t
			ctx := context.Background()
			f.todos.now = func() time.Time { return todoTestNow }
			view := f.create(fmt.Sprintf("reopen-%d", f.count("todos")), "Keep the original TODO")
			q := db.New(f.pool)
			before := f.todo(view.N)
			branch, err := q.GetBranch(ctx, view.Branch.ID)
			require.NoError(t, err)
			revisions, err := q.ListTodoRevisions(ctx, before.ID)
			require.NoError(t, err)

			item := f.item(view.N)
			item.State, item.PRNumber, item.PRState = "running", qaPR(), "open"
			item.WorkspaceID, item.RequestRunID = "ws-reopen", fmt.Sprintf("reported-run-%d", view.N)
			item.PRHead, item.CandidateVerified = strings.Repeat("b", 40), true
			_, err = f.service.saveItem(ctx, item)
			require.NoError(t, err)
			require.Equal(t, string(TodoStarting), f.todo(view.N).State, "a run receipt alone is not its first step")
			item = f.item(view.N)
			projection, err := json.Marshal(mythicalProjection{Kind: mythicalBindingKind, ItemID: uuidString(item.ID),
				Generation: item.Generation, Phase: "request"})
			require.NoError(t, err)
			// First-step evidence goes through the real runtime projector,
			// matching the launch/step boundary rather than fabricating state.
			err = f.service.ProjectFlowRuntime(ctx, flowdispatch.ProjectionUpdate{State: jobs.StateWaiting,
				Checkpoint: flowdispatch.RuntimeCheckpoint{RunID: item.RequestRunID, Projection: projection},
				Events: []flowruntime.FlowRuntimeEvent{{RunID: item.RequestRunID, Sequence: 1, Kind: runtimeEngineEventKind,
					Payload: json.RawMessage(`{"eventType":"flows.engine.node-scheduled","payload":{"nodeId":"implement","kind":"ActionCall"}}`)}},
			})
			require.NoError(t, err)
			require.Equal(t, string(TodoWorking), f.todo(view.N).State)
			item = f.item(view.N)
			item.State = "proposed"
			_, err = f.service.saveItem(ctx, item)
			require.NoError(t, err)
			item = f.item(view.N)
			item.State, item.PRState = "rejected", "closed"
			_, err = f.service.saveItem(ctx, item)
			require.NoError(t, err)
			require.Equal(t, string(TodoDropped), f.todo(view.N).State)
			_, err = f.pool.Exec(ctx, `UPDATE todos SET dropped_at = $1 WHERE id = $2`, todoTestNow.Add(-age), before.ID)
			require.NoError(t, err)
			eventCount := len(f.events(view.N))
			projectionCount := len(f.projections(ProjectionTopicTodo(view.N)))

			item = f.item(view.N)
			item.State, item.PRState = "proposed", "open"
			saved, err := f.service.saveItem(ctx, item)
			require.NoError(t, err)
			require.Equal(t, item.TodoID, saved.TodoID)
			after := f.todo(view.N)
			require.Equal(t, before.ID, after.ID)
			require.Equal(t, before.Number, after.Number)
			require.Equal(t, before.StackPosition, after.StackPosition)
			require.Equal(t, string(TodoInReview), after.State)
			require.False(t, after.DroppedAt.Valid)
			require.Equal(t, int(view.N), f.count("todos"))
			currentBranch, err := q.GetBranch(ctx, view.Branch.ID)
			require.NoError(t, err)
			require.Equal(t, branch, currentBranch)
			currentRevisions, err := q.ListTodoRevisions(ctx, before.ID)
			require.NoError(t, err)
			require.Equal(t, revisions, currentRevisions)
			events := f.events(view.N)
			require.Len(t, events, eventCount+1)
			last := events[len(events)-1]
			require.Equal(t, string(TodoPRReopened), last.Kind)
			require.Equal(t, string(TodoDropped), last.FromState.String)
			require.Equal(t, string(TodoInReview), last.ToState)
			require.JSONEq(t, `{"system":"stack"}`, string(last.Actor))
			require.Len(t, f.projections(ProjectionTopicTodo(view.N)), projectionCount+1)

			// The poll sees the same open PR again. No new event or TODO.
			_, err = f.service.saveItem(ctx, f.item(view.N))
			require.NoError(t, err)
			require.Equal(t, after, f.todo(view.N))
			require.Len(t, f.events(view.N), eventCount+1)
			require.Len(t, f.projections(ProjectionTopicTodo(view.N)), projectionCount+1)
			require.Equal(t, int(view.N), f.count("todos"))
		})
	}
}

// Invalid reopen facts refuse and roll back the whole item write. No
// fallback adoption may silently create another TODO (§4.1 line 235).
func TestTodoStatePRReopenGuardsRollBackPostgres(t *testing.T) {
	f := newTodoFixture(t)
	for _, row := range []struct {
		name string
		age  time.Duration
		head string
	}{
		{"expired", todoReopenWindow + time.Second, strings.Repeat("a", 40)},
		{"missing captured head", 24 * time.Hour, ""},
	} {
		t.Run(row.name, func(t *testing.T) {
			f.t = t
			ctx := context.Background()
			f.todos.now = func() time.Time { return todoTestNow }
			view := f.create(fmt.Sprintf("guard-%d", f.count("todos")), "Reopen guards")
			n := view.N
			item := f.item(n)
			item.State = "cancelled"
			_, err := f.service.saveItem(ctx, item)
			require.NoError(t, err)
			_, err = f.pool.Exec(ctx, `UPDATE todos SET dropped_at = $1 WHERE number = $2`, todoTestNow.Add(-row.age), n)
			require.NoError(t, err)
			before, todo, events := f.item(n), f.todo(n), f.events(n)
			projections := f.projections(ProjectionTopicTodo(n))
			item = before
			item.State, item.PRState, item.PRNumber = "proposed", "open", qaPR()
			item.PRHead, item.CandidateVerified = row.head, true
			_, err = f.service.saveItem(ctx, item)
			var refused *TodoTransitionRefused
			require.ErrorAs(t, err, &refused)
			require.Equal(t, TodoDropped, refused.From)
			require.Equal(t, TodoPRReopened, refused.Trigger)
			require.Equal(t, before, f.item(n))
			require.Equal(t, todo, f.todo(n))
			require.Equal(t, events, f.events(n))
			require.Equal(t, projections, f.projections(ProjectionTopicTodo(n)))
			require.Equal(t, int(view.N), f.count("todos"))
		})
	}
}

// §4.1/C-STK-01 forbid dropped→queued and dropped→working. A stale
// engine restart must refuse rather than attach the existing item to a
// second TODO. A PR reopen has its separate guarded edge above.
func TestTodoStateDroppedRestartNeverAdoptsAnotherTodoPostgres(t *testing.T) {
	f := newTodoFixture(t)
	for _, state := range []string{"queued", "running", "retrying"} {
		t.Run(state, func(t *testing.T) {
			f.t = t
			ctx := context.Background()
			view := f.create("restart-"+state, fmt.Sprintf("Restart %s", state))
			n := view.N
			item := f.item(n)
			item.State = "cancelled"
			_, err := f.service.saveItem(ctx, item)
			require.NoError(t, err)
			before, todo, events := f.item(n), f.todo(n), f.events(n)
			item = before
			item.State = state
			_, err = f.service.saveItem(ctx, item)
			var refused *TodoTransitionRefused
			require.ErrorAs(t, err, &refused, "a dropped TODO cannot be restarted by adopting another TODO")
			require.Equal(t, int(view.N), f.count("todos"))
			require.Equal(t, before, f.item(n))
			require.Equal(t, todo, f.todo(n))
			require.Equal(t, events, f.events(n))
		})
	}
}

// §4.1 line 233 at 2be05ba6: whatever the current unmerged phase,
// a GitHub merge on main must commit one honest transition on the same TODO.
func TestTodoStateMergedPRCommitsFromAllUnmergedStatesPostgres(t *testing.T) {
	f := newTodoFixture(t)
	for _, from := range []TodoState{TodoQueued, TodoStarting, TodoWorking, TodoNeedsYou, TodoPaused, TodoFailed, TodoInReview} {
		t.Run(string(from), func(t *testing.T) {
			f.t = t
			ctx := context.Background()
			view := f.create("merge-"+string(from), "Merged on GitHub")
			n := view.N
			_, err := f.pool.Exec(ctx, `UPDATE todos SET state = $1 WHERE number = $2`, string(from), n)
			require.NoError(t, err)
			before := f.todo(n)
			item := f.item(n)
			item.State, item.PRNumber, item.PRState = "landed", qaPR(), "merged"
			item.PRMergeCommit = strings.Repeat("c", 40)
			saved, err := f.service.saveItem(ctx, item)
			require.NoError(t, err)
			require.Equal(t, item.TodoID, saved.TodoID)
			after := f.todo(n)
			require.Equal(t, before.ID, after.ID)
			require.Equal(t, string(TodoMerged), after.State)
			require.True(t, after.MergedAt.Valid)
			require.Equal(t, before.Version+1, after.Version)
			events := f.events(n)
			require.Len(t, events, 2)
			require.Equal(t, string(TodoPRMerged), events[1].Kind)
			require.Equal(t, string(from), events[1].FromState.String)
			require.Equal(t, string(TodoMerged), events[1].ToState)
			require.JSONEq(t, `{"system":"stack"}`, string(events[1].Actor))
			require.Len(t, f.projections(ProjectionTopicTodo(n)), 2)
			require.Len(t, f.projections("home"), 2*int(n))
			require.Equal(t, int(view.N), f.count("todos"))
		})
	}
}
