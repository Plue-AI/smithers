package services

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// press is the session's Stop or Resume of TODO n with the Idempotency-Key key.
func (o *mythicalOrchestration) press(ctx context.Context, n int64, op, key string) (TodoControlReceipt, error) {
	return o.service.ControlTodo(ctx, n, TodoControlInput{Op: op, Repository: o.repoID, Actor: o.userID, Request: key})
}

// J4, §4.1 working → paused → queued, §10.7.1: Stop cancels the working
// attempt's run and the TODO shows Paused; the stack takes no step for it,
// even after the cancelled run ends. A steer while paused is held. Resume
// queues the same attempt again on the TODO's lane with the steer as its
// first input, and it starts and works as before. Each press is idempotent
// by key; a second Stop and a second Resume are 409; a run presses neither.
func TestTodoStopPausesAndResumeRunsTheAttemptAgain(t *testing.T) {
	o, session, _, item := newSteeredTodo(t)
	n, id := item.Number.Int64, uuidString(item.ID)
	_, err := o.press(session, n, "stop", "stop-queued")
	require.Equal(t, "TODO has no executing run", refusalOf(t, err).Message, "a queued TODO has nothing to stop")
	o.wake()
	launches := o.launcher.byFlow("coding/request")
	require.Len(t, launches, 1)
	o.projectAsking(launches[0], jobs.StateWaiting, "request-run-1")
	working := o.byID(id)
	require.Equal(t, "working", todoState(working))

	_, err = o.press(mythicalRunContext(context.Background(), o.userID), n, "stop", "stop-run")
	require.Equal(t, http.StatusForbidden, refusalOf(t, err).Status, "a run never stops a TODO")
	require.Empty(t, o.launcher.cancelled)

	receipt, err := o.press(session, n, "stop", "stop-1")
	require.NoError(t, err)
	require.Equal(t, TodoControlReceipt{State: "accepted"}, receipt)
	again, err := o.press(session, n, "stop", "stop-1")
	require.NoError(t, err)
	require.Equal(t, receipt, again, "the same press again is the same stop")
	_, err = o.press(session, n, "stop", "stop-2")
	require.Equal(t, "TODO is paused", refusalOf(t, err).Message)
	require.Equal(t, []string{launches[0].RequestID}, o.launcher.cancelled, "the attempt's run is cancelled with the stop")
	paused := o.byID(id)
	require.True(t, paused.PausedAt.Valid)
	require.Equal(t, "paused", todoState(paused))
	require.Equal(t, "paused", o.todoCard(n)["state"])
	require.Equal(t, working.WorkspaceID, paused.WorkspaceID, "the TODO keeps its lane")
	stopped := o.facts(paused, "todo.stopped")
	require.Len(t, stopped, 1)
	require.Equal(t, "working", stopped[0]["from"])
	require.Equal(t, "paused", stopped[0]["to"])

	// The cancelled run ends; the stack takes no step for the paused TODO.
	o.project(launches[0], jobs.StateCancelled, "request-run-1", "")
	o.wake()
	o.wake()
	require.Len(t, o.launcher.byFlow("coding/request"), 1, "nothing starts while paused")
	require.Equal(t, "paused", todoState(o.byID(id)))
	require.Equal(t, "running", o.byID(id).State)

	_, err = o.steer(session, n, "[PAUSED] add a farewell too", "steer-paused")
	require.NoError(t, err)
	require.Equal(t, "paused", todoState(o.byID(id)), "a steer does not resume a paused TODO")

	receipt, err = o.press(session, n, "resume", "resume-1")
	require.NoError(t, err)
	require.Equal(t, TodoControlReceipt{State: "accepted"}, receipt)
	again, err = o.press(session, n, "resume", "resume-1")
	require.NoError(t, err)
	require.Equal(t, receipt, again, "the same press again is the same resume")
	_, err = o.press(session, n, "resume", "resume-2")
	require.Equal(t, "TODO is not paused", refusalOf(t, err).Message)
	resumed := o.byID(id)
	require.False(t, resumed.PausedAt.Valid)
	require.Equal(t, "queued", todoState(resumed))
	facts := o.facts(resumed, "todo.resumed")
	require.Len(t, facts, 1)
	require.Equal(t, "paused", facts[0]["from"])
	require.Equal(t, "queued", facts[0]["to"])

	o.wake()
	launches = o.launcher.byFlow("coding/request")
	require.Len(t, launches, 2, "Resume runs the attempt again")
	restarted := o.byID(id)
	require.EqualValues(t, 1, restarted.Attempt, "the same attempt, not a new one")
	require.EqualValues(t, 2, restarted.Generation)
	require.Equal(t, working.WorkspaceID, restarted.WorkspaceID, "on the TODO's own lane")
	require.Equal(t, "[PAUSED] add a farewell too", decodeJSON(t, launches[1].Payload)["feedback"])
	require.Equal(t, "starting", todoState(restarted))
	o.projectAsking(launches[1], jobs.StateWaiting, "request-run-2")
	require.Equal(t, "working", todoState(o.byID(id)))
	require.Equal(t, "request-run-2", o.byID(id).RequestRunID)
}

// §4.1: Stop is refused while a question is open; only an answer settles it.
func TestTodoStopRefusedWhileAQuestionIsOpen(t *testing.T) {
	o, session, _, item, launch := newAskingTodo(t)
	o.projectAsking(launch, jobs.StateWaiting, "todo-run-1", humanAsk("token-1", "clarify", "Which file?"))
	item = o.byID(uuidString(item.ID))
	require.Equal(t, "needs_you", todoState(item))
	_, err := o.press(session, item.Number.Int64, "stop", "stop-asking")
	require.Equal(t, "Answer the open wait first", refusalOf(t, err).Message)
	require.Empty(t, o.launcher.cancelled)
	require.False(t, o.byID(uuidString(item.ID)).PausedAt.Valid)
}

// itemWith is a paused item in state at attempt with checks.
func itemWith(state string, attempt int32, checks mythicalChecks) db.MythicalItem {
	return db.MythicalItem{State: state, Attempt: attempt, Checks: checks.encode(), PausedAt: pgtype.Timestamptz{Time: time.Now(), Valid: true}}
}

// A paused TODO resumes into its state's next step: one stopped during the
// review of its pull request is reviewed again; a failed one stays failed.
func TestMythicalResumedByState(t *testing.T) {
	review := mythicalChecks{Review: &mythicalReview{Head: "h", RunID: "review-1", Verdict: mythicalCancelled}}
	inReview := mythicalResumed(itemWith("proposed", 2, review))
	require.False(t, inReview.PausedAt.Valid)
	require.Equal(t, "proposed", inReview.State)
	require.Nil(t, mythicalChecksOf(inReview).Review, "the stopped review runs again")
	approved := mythicalChecks{Review: &mythicalReview{Head: "h", RunID: "review-1", Verdict: "approve"}}
	require.NotNil(t, mythicalChecksOf(mythicalResumed(itemWith("proposed", 2, approved))).Review, "a finished review stands")
	failed := mythicalResumed(itemWith("blocked", 2, mythicalChecks{}))
	require.Equal(t, "blocked", failed.State)
	require.EqualValues(t, 2, failed.Attempt)
	working := mythicalResumed(itemWith("verifying", 2, mythicalChecks{RunLaunched: true, RunAttached: true}))
	require.Equal(t, "queued", working.State)
	require.EqualValues(t, 1, working.Attempt, "start counts the same attempt once more")
	require.False(t, mythicalChecksOf(working).RunLaunched)
}
