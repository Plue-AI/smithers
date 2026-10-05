package services

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// delivered leaves TODO number as SubmitLane leaves a delivered attempt:
// integrating its verified candidate, its delivery run submitted but not yet
// projected. It answers the item.
func (f *publicationFixture) delivered(title string) db.MythicalItem {
	f.t.Helper()
	item := f.todo(title, "Do "+title, f.main, "JOURNEY.md", title+"\n")
	item.State, item.RequestOutcome, item.RequestRunID, item.VibeOutcome = "integrating", "validated", "request-run-1", "submitted"
	item, err := db.New(f.pool).SaveMythicalItem(context.Background(), item)
	require.NoError(f.t, err)
	return item
}

// projectVibe reports the attempt's delivery run as ended, as flowdispatch
// does when coding/vibe settles.
func (f *publicationFixture) projectVibe(item db.MythicalItem, runID string) {
	f.t.Helper()
	projection, err := json.Marshal(mythicalProjection{Kind: mythicalBindingKind, ItemID: uuidString(item.ID), Generation: item.Generation,
		Attempt: item.Attempt, Phase: "vibe"})
	require.NoError(f.t, err)
	output := `{"submitted":true}`
	require.NoError(f.t, f.service.ProjectFlowRuntime(context.Background(), flowdispatch.ProjectionUpdate{State: jobs.StateCompleted,
		Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: projection, RunID: runID, Run: &flowruntime.FlowRuntimeRun{RunID: runID, FinalOutput: &output}}}))
}

// A finished TODO is in review seconds after its last run settles: the
// worker takes the steps that need no outside event (integrating, proposing,
// proposed) at once. The stale sweep, set to hours here, is never what moves
// it (J1: TODO in_review took 9.4 minutes when it was).
func TestTodoIsInReviewSecondsAfterItsRunSettles(t *testing.T) {
	f := newPublicationFixture(t, false)
	f.service.sweepEvery = 6 * time.Hour
	item := f.delivered("Add a greeting")
	require.Equal(t, "working", todoState(item))

	ctx, cancel := context.WithCancel(context.Background())
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		f.service.Start(ctx)
	}()
	t.Cleanup(func() {
		cancel()
		<-stopped
	})

	settled := time.Now()
	f.projectVibe(item, "vibe-run-1")
	deadline := settled.Add(30 * time.Second)
	for {
		item = f.item(item.Number.Int64)
		if todoState(item) == "in_review" || time.Now().After(deadline) {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	require.Equal(t, "in_review", todoState(item), "state %s: %s", item.State, item.Reason)
	require.Equal(t, "proposed", item.State)
	assert.Equal(t, "vibe-run-1", item.VibeRunID)
	assert.True(t, item.PRNumber.Valid, "the pull request is open")
	t.Logf("in review %s after the delivery run settled", time.Since(settled).Round(time.Millisecond))
}

// An item that waits (a retry, a back-off, the pull request poll) runs the
// stack again when its wait ends, not at the stale sweep.
func TestMythicalWaitingItemRunsTheStackWhenItIsDue(t *testing.T) {
	f := newPublicationFixture(t, false)
	ctx := context.Background()
	item := f.todo("Add a greeting", "Do it", f.main, "JOURNEY.md", "Hello\n")
	const wait = 2 * time.Second
	_, err := f.pool.Exec(ctx, `UPDATE mythical_items SET next_attempt_at = NOW() + make_interval(secs => $2) WHERE id = $1`, item.ID, wait.Seconds())
	require.NoError(t, err)
	q := db.New(f.pool)

	// A pass passes over the waiting item and asks to run again when it is due.
	f.service.MainMoved(ctx, f.repoID)
	require.NoError(t, f.service.PollOnce(ctx))
	require.Equal(t, "proposing", f.item(item.Number.Int64).State)
	stack, err := q.GetMythicalStack(ctx, f.repoID)
	require.NoError(t, err)
	assert.Equal(t, stack.ProcessedGeneration+1, stack.RequestedGeneration, "the stack is asked to run again")
	due := f.item(item.Number.Int64).NextAttemptAt.Time
	assert.WithinDuration(t, due, stack.NextAttemptAt.Time, time.Second, "at the item's due time")

	// Not before then.
	require.NoError(t, f.service.PollOnce(ctx))
	require.Equal(t, "proposing", f.item(item.Number.Int64).State)

	time.Sleep(time.Until(stack.NextAttemptAt.Time) + 100*time.Millisecond)
	require.NoError(t, f.service.PollOnce(ctx))
	item = f.item(item.Number.Int64)
	require.Equal(t, "proposed", item.State, item.Reason)
	assert.Equal(t, "in_review", todoState(item))

	// An event before the due time runs the stack at once: the schedule
	// never delays a signal.
	_, err = f.pool.Exec(ctx, `UPDATE mythical_stacks SET requested_generation = processed_generation + 1, next_attempt_at = NOW() + interval '1 hour' WHERE repository_id = $1`, f.repoID)
	require.NoError(t, err)
	f.service.MainMoved(ctx, f.repoID)
	stack, err = q.GetMythicalStack(ctx, f.repoID)
	require.NoError(t, err)
	assert.False(t, stack.NextAttemptAt.Time.After(time.Now()), "a request is due now")
}

// A stack another signal already asked to run, or one that is not active,
// keeps its request: the schedule only asks an idle active stack.
func TestScheduleMythicalStackAsksOnlyAnIdleActiveStack(t *testing.T) {
	f := newPublicationFixture(t, false)
	ctx := context.Background()
	q := db.New(f.pool)
	before, err := q.GetMythicalStack(ctx, f.repoID)
	require.NoError(t, err)
	require.Equal(t, before.ProcessedGeneration, before.RequestedGeneration)

	scheduled, err := q.ScheduleMythicalStack(ctx, f.repoID, 60)
	require.NoError(t, err)
	assert.EqualValues(t, 1, scheduled)
	after, err := q.GetMythicalStack(ctx, f.repoID)
	require.NoError(t, err)
	assert.Equal(t, before.RequestedGeneration+1, after.RequestedGeneration)
	assert.WithinDuration(t, time.Now().Add(time.Minute), after.NextAttemptAt.Time, 5*time.Second)
	claimed, err := q.ClaimMythicalStacks(ctx, 1, mythicalLease.Seconds())
	require.NoError(t, err)
	assert.Empty(t, claimed, "nothing runs before the due time")

	// Already requested: unchanged.
	scheduled, err = q.ScheduleMythicalStack(ctx, f.repoID, 1)
	require.NoError(t, err)
	assert.Zero(t, scheduled)
	again, err := q.GetMythicalStack(ctx, f.repoID)
	require.NoError(t, err)
	assert.Equal(t, after.RequestedGeneration, again.RequestedGeneration)
	assert.Equal(t, after.NextAttemptAt.Time, again.NextAttemptAt.Time)

	// Not active: unchanged.
	_, err = f.pool.Exec(ctx, `UPDATE mythical_stacks SET state = 'frozen', processed_generation = requested_generation WHERE repository_id = $1`, f.repoID)
	require.NoError(t, err)
	scheduled, err = q.ScheduleMythicalStack(ctx, f.repoID, 1)
	require.NoError(t, err)
	assert.Zero(t, scheduled)
}

func TestMythicalNextDue(t *testing.T) {
	now := time.Date(2026, 10, 5, 3, 0, 0, 0, time.UTC)
	later := pgtype.Timestamptz{Time: now.Add(30 * time.Second), Valid: true}
	past := pgtype.Timestamptz{Time: now.Add(-time.Second), Valid: true}
	reviewing, _ := json.Marshal(mythicalChecks{Review: &mythicalReview{Head: "head"}})
	for _, tc := range []struct {
		name          string
		before, after db.MythicalItem
		want          time.Time
	}{
		{"a step the worker takes next is due now", db.MythicalItem{State: "integrating"}, db.MythicalItem{State: "proposing", NextAttemptAt: past}, now},
		{"a refresh is due now", db.MythicalItem{State: "proposed", PRHead: "head"}, db.MythicalItem{State: "integrating"}, now},
		{"a wait is due when it ends", db.MythicalItem{State: "running"}, db.MythicalItem{State: "retrying", NextAttemptAt: later}, later.Time},
		{"a wait in place is due when it ends", db.MythicalItem{State: "proposed"}, db.MythicalItem{State: "proposed", NextAttemptAt: later}, later.Time},
		{"a launched run wakes the stack itself", db.MythicalItem{State: "queued"}, db.MythicalItem{State: "running"}, time.Time{}},
		{"a delivery in flight wakes the stack itself", db.MythicalItem{State: "running", RequestOutcome: "validated"}, db.MythicalItem{State: "delivering", RequestOutcome: "validated"}, time.Time{}},
		{"a review in flight wakes the stack itself", db.MythicalItem{State: "proposing"}, db.MythicalItem{State: "proposed", PRHead: "head", Checks: reviewing}, time.Time{}},
		{"an unmoved item waits for an event", db.MythicalItem{State: "proposed"}, db.MythicalItem{State: "proposed", Reason: "waiting for a free lane", NextAttemptAt: past}, time.Time{}},
		{"a settled item takes no step", db.MythicalItem{State: "proposed"}, db.MythicalItem{State: "landed"}, time.Time{}},
		{"a blocked item waits for a person", db.MythicalItem{State: "running"}, db.MythicalItem{State: "blocked", NextAttemptAt: later}, time.Time{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, mythicalNextDue(tc.before, tc.after, now))
		})
	}
}
