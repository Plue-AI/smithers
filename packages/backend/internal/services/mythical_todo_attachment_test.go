package services

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// Literal run identities exercise the production ingestion boundary, including
// the pin guards that must still apply across a candidate generation change.
func TestTodoBoundAttachmentAcrossGeneration(t *testing.T) {
	o, _, _, item, launch := newAskingTodo(t)
	ctx := context.Background()
	_, err := o.pool.Exec(ctx, `UPDATE mythical_items SET generation=generation+1, checks=jsonb_set(checks,'{run_attached}','false') WHERE id=$1`, item.ID)
	require.NoError(t, err)
	before := o.byID(uuidString(item.ID))
	require.Equal(t, "starting", todoState(before))
	var original mythicalProjection
	require.NoError(t, json.Unmarshal(launch.Projection, &original))
	count := func() int {
		var n int
		require.NoError(t, o.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events`).Scan(&n))
		return n
	}
	events := count()
	for _, name := range []string{"prior attempt", "no attempt", "wrong run", "empty run", "wrong nested run", "wrong pin", "wrong source", "verify phase", "unbound"} {
		t.Run(name, func(t *testing.T) {
			p := original
			run, nested, digest := "todo-run-1", "todo-run-1", todoPinOne
			switch name {
			case "prior attempt":
				p.Attempt++
			case "no attempt":
				p.Attempt = 0
			case "wrong run":
				run, nested = "other-run", "other-run"
			case "empty run":
				run, nested = "", ""
			case "wrong nested run":
				nested = "other-run"
			case "wrong pin":
				p.FlowDigest = todoPinTwo
			case "wrong source":
				p.FlowSource = "wrong-source"
			case "verify phase":
				p.Phase = "verify"
			case "unbound":
				_, err := o.pool.Exec(ctx, `UPDATE mythical_items SET request_run_id='' WHERE id=$1`, item.ID)
				require.NoError(t, err)
			}
			expected := o.byID(uuidString(item.ID))
			raw, err := json.Marshal(p)
			require.NoError(t, err)
			require.NoError(t, o.service.ProjectFlowRuntime(ctx, flowdispatch.ProjectionUpdate{State: jobs.StateWaiting, Checkpoint: flowdispatch.RuntimeCheckpoint{
				Projection: raw, FlowID: "todo", ExecutionDigest: digest, RunID: run, Run: &flowruntime.FlowRuntimeRun{RunID: nested},
			}}))
			require.Equal(t, expected, o.byID(uuidString(item.ID)))
			require.Equal(t, events, count())
			if name == "unbound" {
				_, err := o.pool.Exec(ctx, `UPDATE mythical_items SET request_run_id='todo-run-1' WHERE id=$1`, item.ID)
				require.NoError(t, err)
			}
		})
	}
	o.projectTodo(launch, jobs.StateWaiting, "todo-run-1", todoPinOne, "")
	after := o.byID(uuidString(item.ID))
	require.Equal(t, "working", todoState(after))
	require.Equal(t, before.Generation, after.Generation)
	require.Equal(t, before.Attempt, after.Attempt)
	require.Equal(t, before.RequestRunID, after.RequestRunID)
	require.Equal(t, events+1, count())
	o.projectTodo(launch, jobs.StateWaiting, "todo-run-1", todoPinOne, "")
	require.Equal(t, after, o.byID(uuidString(item.ID)))
	require.Equal(t, events+1, count())
	// An independent branch wait masks attachment, but does not prevent it or
	// get settled by the run. Person pause is also retained.
	_, err = o.pool.Exec(ctx, `UPDATE mythical_items SET generation=generation+1, paused_at=NOW(),
  checks=jsonb_set(jsonb_set(checks,'{run_attached}','false'),'{waits}',
  '[{"id":"foreign-1","kind":"foreign_push","prompt":"Alice pushed","since":"2026-10-05T12:00:00Z"}]') WHERE id=$1`, item.ID)
	require.NoError(t, err)
	waiting := o.byID(uuidString(item.ID))
	require.Equal(t, "needs_you", todoState(waiting))
	o.projectTodo(launch, jobs.StateWaiting, "todo-run-1", todoPinOne, "")
	attached := o.byID(uuidString(item.ID))
	require.True(t, mythicalChecksOf(attached).RunAttached)
	require.Equal(t, "needs_you", todoState(attached))
	require.Equal(t, waiting.PausedAt, attached.PausedAt)
	require.Equal(t, todoOpenWaits(waiting), todoOpenWaits(attached))
	require.Equal(t, events+2, count())

}
