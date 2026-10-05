package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
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

// startWorker runs the stack worker until the test ends, with the stale
// sweep set to hours: only the worker's own schedule moves an item.
func (f *publicationFixture) startWorker() {
	f.t.Helper()
	f.service.sweepEvery = 6 * time.Hour
	ctx, cancel := context.WithCancel(context.Background())
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		f.service.Start(ctx)
	}()
	f.t.Cleanup(func() {
		cancel()
		<-stopped
	})
}

// A pass whose save loses its race (the stack's claim ends, or another
// writer moves the TODO) records nothing and runs the stack again at once:
// the TODO is in review seconds later, with one push and one pull request,
// never at the stale sweep (J7 run 1: T1 stayed proposing 8 minutes).
func TestTodoMovesOnSecondsAfterItsPassLosesARace(t *testing.T) {
	const push = "/rehearsal-owner/app.git/git-receive-pack"
	for _, tc := range []struct {
		name string
		// arm makes the race happen once inside the first pass's proposal.
		arm func(f *publicationFixture, item db.MythicalItem, race func(sql string))
	}{
		{"the claim's lease ends before the push is recorded", func(f *publicationFixture, _ db.MythicalItem, race func(string)) {
			guard := f.service.outbound.AcceptedGeneration
			var once sync.Once
			f.service.outbound.AcceptedGeneration = func(ctx context.Context, item db.MythicalItem, kind string) error {
				err := guard(ctx, item, kind)
				if kind == "push" {
					once.Do(func() {
						race(`UPDATE mythical_stacks SET lease_expires_at = NOW() - interval '1 second' WHERE repository_id = $1`)
					})
				}
				return err
			}
		}},
		{"the claim's lease ends during the push", func(f *publicationFixture, _ db.MythicalItem, race func(string)) {
			f.fake.OnNextRequest(http.MethodPost, push, func() {
				race(`UPDATE mythical_stacks SET lease_expires_at = NOW() - interval '1 second' WHERE repository_id = $1`)
			})
		}},
		{"a newer claim takes the stack during the push", func(f *publicationFixture, _ db.MythicalItem, race func(string)) {
			// The newer claimant's lease has ended too, so the stack is
			// claimable again; only the lost pass's own request runs it.
			f.fake.OnNextRequest(http.MethodPost, push, func() {
				race(`UPDATE mythical_stacks SET claim = claim + 1, lease_expires_at = NOW() - interval '1 second' WHERE repository_id = $1`)
			})
		}},
		{"another writer moves the TODO during the push", func(f *publicationFixture, item db.MythicalItem, race func(string)) {
			f.fake.OnNextRequest(http.MethodPost, push, func() {
				_, err := f.pool.Exec(context.Background(), `UPDATE mythical_items SET version = version + 1 WHERE id = $1`, item.ID)
				race("")
				assert.NoError(f.t, err)
			})
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newPublicationFixture(t, false)
			item := f.todo("Add a greeting", "Do it", f.main, "JOURNEY.md", "Hello\n")
			var raced atomic.Bool
			tc.arm(f, item, func(sql string) {
				if sql != "" {
					_, err := f.pool.Exec(context.Background(), sql, f.repoID)
					assert.NoError(t, err)
				}
				raced.Store(true)
			})
			started := time.Now()
			f.service.MainMoved(context.Background(), f.repoID)
			f.startWorker()
			deadline := started.Add(20 * time.Second)
			for {
				item = f.item(item.Number.Int64)
				if todoState(item) == "in_review" || time.Now().After(deadline) {
					break
				}
				time.Sleep(100 * time.Millisecond)
			}
			require.True(t, raced.Load(), "the race happened inside the pass")
			require.Equal(t, "in_review", todoState(item), "state %s: %s", item.State, item.Reason)
			assert.Empty(t, item.PendingOp)
			branch := mythicalChecksOf(item).Branch
			require.NotEmpty(t, branch)
			assert.Equal(t, f.githubRef(branch), item.PRHead, "the pull request is at the pushed head")
			assert.Equal(t, []string{"POST " + push, "POST /repos/rehearsal-owner/app/pulls"}, f.writes(), "one push and one pull request")
			t.Logf("in review %s after the stack was requested", time.Since(started).Round(time.Millisecond))
		})
	}
}

// A pass that finds a newer claim when it finishes asks for another pass,
// even when it saw nothing due: what it could not record is decided again.
func TestMythicalPassThatLostItsClaimRunsTheStackAgain(t *testing.T) {
	f := newPublicationFixture(t, false)
	ctx := context.Background()
	q := db.New(f.pool)
	f.service.MainMoved(ctx, f.repoID)
	claimed, err := q.ClaimMythicalStacks(ctx, 1, mythicalLease.Seconds())
	require.NoError(t, err)
	require.Len(t, claimed, 1)
	// Another worker claims the stack and finishes its pass first.
	_, err = f.pool.Exec(ctx, `UPDATE mythical_stacks SET claim = claim + 1, running = false, lease_expires_at = NULL,
		processed_generation = requested_generation WHERE repository_id = $1`, f.repoID)
	require.NoError(t, err)

	f.service.runClaimed(ctx, claimed[0])
	stack, err := q.GetMythicalStack(ctx, f.repoID)
	require.NoError(t, err)
	assert.Equal(t, stack.ProcessedGeneration+1, stack.RequestedGeneration, "the stack is asked to run again")
	assert.False(t, stack.NextAttemptAt.Time.After(time.Now()), "at once")
}

func TestMythicalStepFailedDue(t *testing.T) {
	now := time.Date(2026, 10, 5, 3, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name string
		err  error
		want time.Time
	}{
		{"a lost lease runs the stack again at once", db.ErrMythicalLeaseLost, now},
		{"a moved item runs the stack again at once", db.ErrMythicalItemMoved, now},
		{"a wrapped lost race is still one", fmt.Errorf("record the push: %w", db.ErrMythicalLeaseLost), now},
		{"a row not found is no lost race", pgx.ErrNoRows, now.Add(time.Minute)},
		{"a transient failure waits a minute", errors.New("read the pull request branch: exit status 128"), now.Add(time.Minute)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, mythicalStepFailedDue(tc.err, now))
		})
	}
	assert.ErrorIs(t, db.ErrMythicalLeaseLost, pgx.ErrNoRows, "callers that read no rows as a lost race still do")
	assert.ErrorIs(t, db.ErrMythicalItemMoved, pgx.ErrNoRows)
}

// A recovered GitHub operation that saved its item (sent, settled or held)
// is a step the worker takes on; an unchanged one waits for an event.
func TestMythicalDueAfterARecoveredOperation(t *testing.T) {
	now := time.Date(2026, 10, 5, 3, 0, 0, 0, time.UTC)
	later := pgtype.Timestamptz{Time: now.Add(5 * time.Minute), Valid: true}
	for _, tc := range []struct {
		name  string
		item  db.MythicalItem
		moved bool
		want  time.Time
	}{
		{"a settled push opens its pull request at once", db.MythicalItem{State: "proposing", PRHead: "head"}, true, now},
		{"a sent push is looked up at once", db.MythicalItem{State: "proposing", PendingOp: json.RawMessage(`{"state":"unknown"}`)}, true, now},
		{"a person's push is held until the poll", db.MythicalItem{State: "proposing", NextAttemptAt: later}, true, later.Time},
		{"a landed merge takes no step", db.MythicalItem{State: "landed"}, true, time.Time{}},
		{"a dropped TODO's sent close is looked up at once", db.MythicalItem{State: "cancelled", PendingOp: json.RawMessage(`{"kind":"close","state":"unknown"}`), WorkspaceID: "w"}, true, now},
		{"a dropped TODO's settled close releases its lane at once", db.MythicalItem{State: "cancelled", PRState: "closed", WorkspaceID: "w"}, true, now},
		{"a dropped TODO with no lane takes no step", db.MythicalItem{State: "cancelled", PRState: "closed"}, true, time.Time{}},
		{"an unchanged close waits for an event", db.MythicalItem{State: "cancelled", PendingOp: json.RawMessage(`{"kind":"close","state":"unknown"}`)}, false, time.Time{}},
		{"a merge still open on GitHub waits for an event", db.MythicalItem{State: "proposed"}, false, time.Time{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, mythicalDue(tc.item, tc.moved, now))
		})
	}
}
