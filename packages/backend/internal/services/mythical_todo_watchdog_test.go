package services

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

func watchdogStep(i int) flowruntime.Event {
	return flowruntime.Event{Kind: "flows.engine.v2.attempt-lifecycle", Payload: []byte(fmt.Sprintf(`{"version":2,"executionId":"child","stepKeyDigest":"step-%d","attempt":0,"lifecycle":{"state":"succeeded"}}`, i))}
}

func TestTodoWatchdogRetainsStepsAndExcludesWaits(t *testing.T) {
	start := time.Date(2026, 10, 6, 10, 0, 0, 0, time.UTC)
	item := db.MythicalItem{State: "running", Attempt: 1, FlowDigest: pgtype.Text{String: todoPinOne, Valid: true}}
	update := flowdispatch.ProjectionUpdate{Checkpoint: flowdispatch.RuntimeCheckpoint{Run: &flowruntime.Run{Status: "running"}}, Events: []flowruntime.Event{watchdogStep(1)}}
	// The admitted run needs a timer before observation: a non-yielding
	// override may prevent the host from returning its first running page.
	ack := flowdispatch.ProjectionUpdate{State: jobs.StateWaiting, Checkpoint: flowdispatch.RuntimeCheckpoint{RunID: "accepted"}}
	projectTodoWatchdog(&item, ack, start)
	require.Equal(t, start.UnixMilli(), mythicalChecksOf(item).Watchdog.ActiveSince)
	projectTodoWatchdog(&item, update, start)
	projectTodoWatchdog(&item, update, start.Add(time.Minute))
	w := mythicalChecksOf(item).Watchdog
	require.Len(t, w.Steps, 1, "replayed completion spends one step")
	require.Equal(t, time.Minute.Milliseconds(), w.elapsed(start.Add(time.Minute)))
	update.Checkpoint.Run.PendingWaits = []flowruntime.PendingWait{{CreatedAt: float64(start.Add(2 * time.Minute).UnixMilli())}}
	projectTodoWatchdog(&item, update, start.Add(time.Hour))
	w = mythicalChecksOf(item).Watchdog
	require.Equal(t, (2 * time.Minute).Milliseconds(), w.ActiveMillis)
	require.Zero(t, w.ActiveSince)
	// Rehydrate the persisted JSON, then resume the same attempt after a wait.
	item.Checks = mythicalChecksOf(item).encode()
	update.Checkpoint.Run.PendingWaits = nil
	projectTodoWatchdog(&item, update, start.Add(2*time.Hour))
	require.Equal(t, (2 * time.Minute).Milliseconds(), mythicalChecksOf(item).Watchdog.ActiveMillis)
	item.PausedAt = pgtype.Timestamptz{Time: start.Add(2*time.Hour + time.Minute), Valid: true}
	projectTodoWatchdog(&item, update, start.Add(3*time.Hour))
	require.Equal(t, (3 * time.Minute).Milliseconds(), mythicalChecksOf(item).Watchdog.ActiveMillis)
	require.Zero(t, mythicalChecksOf(item).Watchdog.ActiveSince)
	item.PausedAt = pgtype.Timestamptz{}
	acceptTodoWatchdog(&item, start.Add(4*time.Hour))
	require.False(t, todoWatchdogEligible(item), "first acceptance ends the pre-proposal allowance")
}

func TestTodoWatchdogAndAccounting(t *testing.T) {
	for _, boundary := range []string{"time", "steps"} {
		t.Run(boundary, func(t *testing.T) {
			o, session := newTodoAdmission(t)
			o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
			start := time.Now().UTC()

			item := o.fileTodo(session, "watchdog-"+boundary)
			o.wake()
			launch := o.launcher.last("todo")
			update := flowdispatch.ProjectionUpdate{State: jobs.StateWaiting, Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: launch.Projection, FlowID: "todo", RunID: "watchdog-run", ExecutionDigest: todoPinOne, Run: &flowruntime.Run{RunID: "watchdog-run", Status: "running"}}}
			if boundary == "steps" {
				for i := range 1023 {
					update.Events = append(update.Events, watchdogStep(i))
				}
			}
			require.NoError(t, o.service.ProjectFlowRuntime(t.Context(), update))
			stack, err := db.New(o.pool).GetMythicalStack(t.Context(), o.repoID)
			require.NoError(t, err)
			current := o.byID(uuidString(item.ID))
			start = time.UnixMilli(mythicalChecksOf(current).Watchdog.ActiveSince)
			st := &mythicalItemStep{s: o.service, r: &mythicalRun{row: stack}, now: start.Add(4*time.Hour - time.Millisecond)}
			if boundary == "steps" {
				st.now = start
			}
			before, _, err := st.enforceTodoWatchdog(t.Context(), current)
			require.NoError(t, err)
			require.Nil(t, before)
			require.Equal(t, "running", o.byID(uuidString(item.ID)).State, "the preceding boundary remains runnable")
			if boundary == "time" {
				st.now = start.Add(4 * time.Hour)
			} else {
				update.Events = []flowruntime.Event{watchdogStep(1023)}
				require.NoError(t, o.service.ProjectFlowRuntime(t.Context(), update))
			}
			_, saved, err := st.enforceTodoWatchdog(t.Context(), o.byID(uuidString(item.ID)))
			require.NoError(t, err)
			require.True(t, saved)
			stopped := o.byID(uuidString(item.ID))
			require.Equal(t, "blocked", stopped.State, stopped.Reason)
			require.Equal(t, &mythicalFault{Class: "factory", Tag: "no_proposal", Kind: mythicalFailPlan}, mythicalChecksOf(stopped).Fault)
			require.EqualValues(t, 1, mythicalChecksOf(stopped).Launches)
			require.Equal(t, mythicalChecksOf(stopped).AdmissionDay, mythicalChecksOf(o.byID(uuidString(item.ID))).AdmissionDay)
			require.Len(t, o.launcher.byFlow("todo"), 1, "watchdog adds no model launch or daily charge")
			o.wake()
			require.Equal(t, "blocked", o.byID(uuidString(item.ID)).State)
			require.Len(t, o.launcher.byFlow("todo"), 1, "an expired attempt waits for person Retry")
		})
	}
}

func TestTodoRetainsPinnedSourceAlongsideEditingBase(t *testing.T) {
	o, session := newTodoAdmission(t)
	o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
	first := o.fileTodo(session, "editing-prefix")
	o.wake()
	first = o.byID(uuidString(first.ID))
	candidate := o.laneResult(first.WorkspaceID, first.BaseCommit, map[string]string{"PREFIX.md": "prefix\n"}, "prefix")
	_, err := o.pool.Exec(t.Context(), `UPDATE mythical_items SET state='integrating',candidate_base=$2,candidate_head=$3,candidate_verified=true WHERE id=$1`, first.ID, first.BaseCommit, candidate)
	require.NoError(t, err)
	item := o.fileTodo(session, "pinned-source-import")
	o.wake()
	item = o.byID(uuidString(item.ID))
	source := mythicalChecksOf(item).FlowSource
	require.NotEqual(t, item.BaseCommit, source, "the stack prefix and admitted main source are distinct objects")
	require.Equal(t, item.BaseCommit, o.hostRef("refs/smithers/workspaces/"+item.WorkspaceID+"/sources/"+item.BaseCommit))
	require.Equal(t, source, o.hostRef("refs/smithers/workspaces/"+item.WorkspaceID+"/sources/"+source))
}

// The worker's snapshot can expire while a person or proposal commits.
// Re-read under the stack lock before spending cancellations or retiring lanes.
func TestTodoWatchdogKeepsConcurrentSettlement(t *testing.T) {
	for _, change := range []string{"proposal", "drop", "pause", "new attempt", "step progress"} {
		t.Run(change, func(t *testing.T) {
			o, session := newTodoAdmission(t)
			o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
			item := o.fileTodo(session, "race-watchdog")
			o.wake()
			item = o.byID(uuidString(item.ID))
			checks := mythicalChecksOf(item)
			checks.Watchdog = &todoWatchdog{ActiveMillis: (4 * time.Hour).Milliseconds()}
			item.Checks = checks.encode()
			item, err := db.New(o.pool).SaveMythicalItem(t.Context(), item)
			require.NoError(t, err)
			current := item
			switch change {
			case "proposal":
				acceptTodoWatchdog(&current, time.Now())
			case "drop":
				current.State = "cancelled"
			case "pause":
				current.PausedAt = pgtype.Timestamptz{Time: time.Now(), Valid: true}
			case "new attempt":
				current.Attempt++
				current.RequestRunID = "next-run"
			case "step progress":
				current.Summary = "new evidence"
			}
			current, err = db.New(o.pool).SaveMythicalItem(t.Context(), current)
			require.NoError(t, err)
			stack, err := db.New(o.pool).GetMythicalStack(t.Context(), o.repoID)
			require.NoError(t, err)
			st := &mythicalItemStep{s: o.service, r: &mythicalRun{row: stack}, now: time.Now()}
			next, saved, err := st.enforceTodoWatchdog(t.Context(), item)
			require.NoError(t, err)
			require.True(t, saved, "the caller must not advance its stale snapshot")
			require.Equal(t, current, *next)
			require.Equal(t, current, o.byID(uuidString(item.ID)))
			require.Empty(t, o.lanes.deleted, "a stale timer never retires a lane")
			require.Len(t, o.launcher.byFlow("todo"), 1)
		})
	}
}
