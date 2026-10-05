package services

import (
	"context"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// steer is the session's steer of TODO n with the Idempotency-Key key.
func (o *mythicalOrchestration) steer(ctx context.Context, n int64, text, key string) (TodoControlReceipt, error) {
	return o.service.ControlTodo(ctx, n, TodoControlInput{Steer: &text, Repository: o.repoID, Actor: o.userID, Request: key})
}

// newSteeredTodo is an owner's TODO on the install's coding path
// (coding/request) with the dispatcher's signal admission recorded.
func newSteeredTodo(t *testing.T) (*mythicalOrchestration, context.Context, *answerLauncher, db.MythicalItem) {
	t.Helper()
	o, session := newTodoAdmission(t)
	launcher := &answerLauncher{fakeMythicalLauncher: o.launcher}
	o.service.SetLauncher(launcher)
	return o, session, launcher, o.fileTodo(session, "steered")
}

// J3.6, J4.2, §10.7.3: a steer reaches the TODO's coding run by its state.
// Queued: the attempt's first input. Starting: held, then sent to the run
// the moment the host attaches it. Working: sent to the live run at once, as
// a message under the launch's scope and target. The card lists every steer
// with its author; the same press again is the same steer; a run never
// steers; a steer never settles anything.
func TestTodoSteerReachesTheCodingRunByState(t *testing.T) {
	o, session, launcher, item := newSteeredTodo(t)
	n, id := item.Number.Int64, uuidString(item.ID)

	receipt, err := o.steer(session, n, "[QUEUED] keep it short", "steer-queued")
	require.NoError(t, err)
	require.Equal(t, TodoControlReceipt{State: "accepted"}, receipt)
	require.Empty(t, launcher.sent(), "a queued TODO has no run to message")
	o.wake()
	launches := o.launcher.byFlow("coding/request")
	require.Len(t, launches, 1)
	require.Equal(t, "[QUEUED] keep it short", decodeJSON(t, launches[0].Payload)["feedback"], "the queued steer is the attempt's first input")
	require.Equal(t, "starting", todoState(o.byID(id)))

	_, err = o.steer(session, n, "[STARTING] say hello in French", "steer-starting")
	require.NoError(t, err)
	require.Empty(t, launcher.sent(), "a starting attempt holds the steer until its run attaches")
	o.projectAsking(launches[0], jobs.StateWaiting, "request-run-1")
	require.Equal(t, "working", todoState(o.byID(id)))
	sent := launcher.sent()
	require.Len(t, sent, 1, "the held steer goes to the run once it attaches")
	require.Equal(t, "request-run-1", sent[0].RunID)
	require.Equal(t, "coding/request", sent[0].FlowID)
	require.Equal(t, launches[0].Target, sent[0].Target)
	require.Equal(t, launches[0].Scope, sent[0].Scope)
	require.Equal(t, "[STARTING] say hello in French", sent[0].Steer.Body)
	o.projectAsking(launches[0], jobs.StateWaiting, "request-run-1")
	require.Len(t, launcher.sent(), 1, "a later observation sends nothing again")

	_, err = o.steer(mythicalRunContext(context.Background(), o.userID), n, "from a run", "steer-run")
	require.Equal(t, http.StatusForbidden, refusalOf(t, err).Status, "a run never steers a TODO")

	_, err = o.steer(session, n, "[WORKING] use the helper in lib/retry.ts", "steer-working")
	require.NoError(t, err)
	again, err := o.steer(session, n, "[WORKING] use the helper in lib/retry.ts", "steer-working")
	require.NoError(t, err)
	require.Equal(t, TodoControlReceipt{State: "accepted"}, again)
	sent = launcher.sent()
	require.Len(t, sent, 2, "the same press again is the same steer")
	require.Equal(t, "request-run-1", sent[1].RunID)
	require.Equal(t, launches[0].Target, sent[1].Target)
	require.Equal(t, "[WORKING] use the helper in lib/retry.ts", sent[1].Steer.Body)
	require.Equal(t, sent[1].RequestID, sent[1].Steer.MessageID)
	require.NotEqual(t, sent[0].RequestID, sent[1].RequestID)

	working := o.byID(id)
	require.Equal(t, "working", todoState(working))
	require.Equal(t, "running", working.State)
	require.EqualValues(t, 1, working.Attempt)
	steers := o.todoCard(n)["steers"].([]any)
	require.Len(t, steers, 3)
	for i, text := range []string{"[QUEUED] keep it short", "[STARTING] say hello in French", "[WORKING] use the helper in lib/retry.ts"} {
		steer := steers[i].(map[string]any)
		require.Equal(t, text, steer["text"])
		require.Equal(t, "person", steer["by"].(map[string]any)["kind"])
	}
	stored := mythicalChecksOf(working).Steers
	require.Equal(t, []int32{1, 1, 1}, []int32{stored[0].Attempt, stored[1].Attempt, stored[2].Attempt})
	require.Equal(t, []string{"", "request-run-1", "request-run-1"}, []string{stored[0].Run, stored[1].Run, stored[2].Run})
	require.False(t, stored[1].Pending)
	facts := o.facts(working, "todo.steered")
	require.Len(t, facts, 3)
	require.Equal(t, []any{"held", "held", "sent"}, []any{facts[0]["delivery"], facts[1]["delivery"], facts[2]["delivery"]})
	require.Equal(t, "working", facts[2]["from"])
	require.Equal(t, "working", facts[2]["to"])
}

// §4.1 in_review → working, J10.2: a steer to a TODO past its coding run
// (in review) cancels the attempt's runs and queues the next attempt with
// every steer as its first input; the open pull request stays open. A steer
// to a merged TODO is 409 todo_closed.
func TestTodoSteerInReviewStartsTheNextAttemptWithTheSteer(t *testing.T) {
	o, session, launcher, item := newSteeredTodo(t)
	n, id := item.Number.Int64, uuidString(item.ID)
	o.wake()
	launches := o.launcher.byFlow("coding/request")
	require.Len(t, launches, 1)
	o.projectAsking(launches[0], jobs.StateWaiting, "request-run-1")

	reviewed := o.byID(id)
	reviewed.State, reviewed.RequestOutcome = "proposed", "validated"
	reviewed.PRNumber, reviewed.PRState, reviewed.PRHead = pgtype.Int8{Int64: 4, Valid: true}, "open", "0123456789abcdef0123456789abcdef01234567"
	reviewed, err := o.service.queries().SaveMythicalItem(context.Background(), reviewed)
	require.NoError(t, err)
	require.Equal(t, "in_review", todoState(reviewed))

	receipt, err := o.steer(session, n, "[REVIEW] rename the file", "steer-review")
	require.NoError(t, err)
	require.Equal(t, TodoControlReceipt{State: "accepted"}, receipt)
	require.Empty(t, launcher.sent(), "no run is live to message")
	queued := o.byID(id)
	require.Equal(t, "queued", queued.State)
	require.EqualValues(t, 1, queued.Attempt, "the next launch is attempt 2")
	require.True(t, queued.PRNumber.Valid)
	require.Equal(t, "open", queued.PRState, "the open pull request stays open")
	require.EqualValues(t, 1, mythicalChecksOf(queued).AttemptBase)
	require.Equal(t, "in_review", o.facts(queued, "todo.steered")[0]["from"])
	require.Equal(t, "next_attempt", o.facts(queued, "todo.steered")[0]["delivery"])

	o.wake()
	launches = o.launcher.byFlow("coding/request")
	require.Len(t, launches, 2)
	require.Equal(t, "[REVIEW] rename the file", decodeJSON(t, launches[1].Payload)["feedback"])
	started := o.byID(id)
	require.EqualValues(t, 2, started.Attempt)
	require.Equal(t, "starting", todoState(started))

	merged := o.byID(id)
	merged.State = "landed"
	_, err = o.service.queries().SaveMythicalItem(context.Background(), merged)
	require.NoError(t, err)
	_, err = o.steer(session, n, "too late", "steer-merged")
	require.Equal(t, &TodoControlError{http.StatusConflict, "todo_closed", "conflict", "TODO is closed"}, refusalOf(t, err))
}

// §10.7.3: a steer to a failed TODO is Retry with that steer: attempt n+1
// starts with it as its first input, under Retry's person-only guard.
func TestTodoSteerOnAFailedTodoRetriesIt(t *testing.T) {
	o, session, _, item := newSteeredTodo(t)
	n, id := item.Number.Int64, uuidString(item.ID)
	o.wake()
	failed := o.byID(id)
	checks := mythicalChecksOf(failed)
	checks.Fault = &mythicalFault{Class: "factory", Tag: "very_hard", Kind: mythicalFailPlan}
	failed.State, failed.Reason, failed.Checks = "blocked", mythicalVeryHard+"every plan failed", checks.encode()
	_, err := o.service.queries().SaveMythicalItem(context.Background(), failed)
	require.NoError(t, err)

	receipt, err := o.steer(session, n, "[FIXED] keep the file", "steer-failed")
	require.NoError(t, err)
	require.Equal(t, TodoControlReceipt{State: "accepted", Attempt: 2}, receipt)
	retried := o.byID(id)
	require.Equal(t, "queued", retried.State)
	require.Len(t, mythicalChecksOf(retried).Retries, 1)
	require.Len(t, mythicalChecksOf(retried).Steers, 1)
	o.wake()
	launches := o.launcher.byFlow("coding/request")
	require.Equal(t, "[FIXED] keep the file", decodeJSON(t, launches[len(launches)-1].Payload)["feedback"])
}

// A steer is refused, before any record, where it cannot be delivered or
// kept: no store or signal admission, and a merge in flight.
func TestTodoSteerRefusals(t *testing.T) {
	text := "x"
	_, err := NewMythicalService(nil, nil).ControlTodo(context.Background(), 3, TodoControlInput{Steer: &text})
	require.Equal(t, "todo_control_unavailable", refusalOf(t, err).Code)
	o, session := newTodoAdmission(t) // the fake launcher admits no signals
	item := o.fileTodo(session, "no-signals")
	_, err = o.steer(session, item.Number.Int64, "x", "k")
	require.Equal(t, "todo_control_unavailable", refusalOf(t, err).Code)
	require.Empty(t, mythicalChecksOf(o.byID(uuidString(item.ID))).Steers)

	fenced := db.MythicalItem{State: "proposed", PendingOp: []byte(`{"kind":"merge","target":"3","desired":"0123456789abcdef0123456789abcdef01234567","state":"intended"}`)}
	require.Equal(t, "merging", todoControlGuard(fenced, TodoControlInput{Steer: &text}, todoControlFacts{}).(*TodoControlError).Code)
	for _, state := range []string{"landed", "cancelled", "rejected", "declined"} {
		require.Equal(t, "todo_closed", todoControlGuard(db.MythicalItem{State: state}, TodoControlInput{Steer: &text}, todoControlFacts{}).(*TodoControlError).Code)
	}
}

// todoFeedback holds a steer pending its run's attach out of that
// attempt's payload (the attach sends it), and gives it to every later one.
func TestTodoFeedbackLeavesAPendingSteerToItsAttach(t *testing.T) {
	item := db.MythicalItem{Checks: mythicalChecks{Steers: []todoSteer{
		{Text: "first", Attempt: 1}, {Text: "pending", Attempt: 2, Pending: true}, {Text: "sent", Attempt: 2, Run: "run-2"},
	}}.encode()}
	require.Equal(t, "first\n\nsent", todoFeedback(item, 2))
	require.Equal(t, "first\n\npending\n\nsent", todoFeedback(item, 3))
}

var _ mythicalSignaler = (*flowdispatch.Service)(nil)
