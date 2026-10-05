package services

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// J4.2d, C-J4-02: Retry on a failed TODO starts the next attempt of the same
// pin with the steer as its first input. The attempt number keeps counting,
// so attempt 1 keeps its evidence; the same press again is the same retry and
// starts nothing more; another press once the TODO left failed is 409. The
// card shows the failure while it lasts and the steer from then on.
func TestTodoRetryStartsTheNextAttemptWithItsSteer(t *testing.T) {
	o, session := newTodoAdmission(t)
	ctx := context.Background()
	o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
	item := o.fileTodo(session, "retried")
	n, id := item.Number.Int64, uuidString(item.ID)
	o.wake()
	launches := o.launcher.byFlow("todo")
	require.Len(t, launches, 1)
	o.projectTodo(launches[0], jobs.StateWaiting, "todo-run-1", todoPinOne, "")
	require.Equal(t, "working", todoState(o.byID(id)))

	// Every plan failed: a typed stop only a person lifts.
	failed := o.byID(id)
	checks := mythicalChecksOf(failed)
	checks.Fault = &mythicalFault{Class: "factory", Tag: "very_hard", Kind: mythicalFailPlan}
	failed.State, failed.Reason, failed.Checks = "blocked", mythicalVeryHard+"the lane's request ended blocked", checks.encode()
	failed, err := o.service.queries().SaveMythicalItem(ctx, failed)
	require.NoError(t, err)
	card := o.todoCard(n)
	require.Equal(t, "failed", card["state"])
	require.Equal(t, map[string]any{"step": "plan", "class": "factory", "message": "Every plan failed", "retryable": true}, card["failure"])
	require.Equal(t, []any{}, card["steers"])
	attemptOne := card["evidence"].([]any)[0].(map[string]any)
	require.EqualValues(t, 1, attemptOne["attempt"])

	steer := "use the helper in lib/retry.ts"
	press := TodoControlInput{Op: "retry", Steer: &steer, Repository: o.repoID, Actor: o.userID, Request: "retry-1"}
	_, err = o.service.ControlTodo(mythicalRunContext(ctx, o.userID), n, press)
	var refusal *TodoControlError
	require.ErrorAs(t, err, &refusal)
	require.Equal(t, http.StatusForbidden, refusal.Status, "a run's credential never lifts a typed stop")
	require.Equal(t, "failed", todoState(o.byID(id)))

	receipt, err := o.service.ControlTodo(session, n, press)
	require.NoError(t, err)
	require.Equal(t, TodoControlReceipt{State: "accepted", Attempt: 2}, receipt)
	again, err := o.service.ControlTodo(session, n, press)
	require.NoError(t, err)
	require.Equal(t, receipt, again, "the same press again is the same retry")
	queued := o.byID(id)
	require.Equal(t, "queued", queued.State)
	require.Empty(t, queued.Reason)
	require.EqualValues(t, 1, queued.Attempt, "the attempt number keeps counting")
	retried := mythicalChecksOf(queued)
	require.Zero(t, retried.Replans)
	require.EqualValues(t, 1, retried.AttemptBase, "the attempt bound counts from the retry")
	require.Nil(t, retried.Fault)
	require.Len(t, retried.Retries, 1)
	require.Equal(t, todoPinOne, queued.FlowDigest.String, "Retry keeps the pin")

	owner, err := o.service.queries().GetUserByID(ctx, o.userID)
	require.NoError(t, err)
	card = o.todoCard(n)
	require.Equal(t, "queued", card["state"])
	require.NotContains(t, card, "failure")
	steers := card["steers"].([]any)
	require.Len(t, steers, 1)
	require.Equal(t, steer, steers[0].(map[string]any)["text"])
	require.Equal(t, "person", steers[0].(map[string]any)["by"].(map[string]any)["kind"])
	require.Equal(t, owner.Username, steers[0].(map[string]any)["by"].(map[string]any)["login"])
	at, err := time.Parse(time.RFC3339Nano, steers[0].(map[string]any)["at"].(string))
	require.NoError(t, err)
	require.False(t, at.IsZero())

	other := press
	other.Request = "retry-2"
	_, err = o.service.ControlTodo(session, n, other)
	require.ErrorAs(t, err, &refusal)
	require.Equal(t, &TodoControlError{http.StatusConflict, "conflict", "conflict", "TODO has not failed"}, refusal)

	// The stack takes the launch: attempt 2 of the same pin, the steer its
	// first input, revision 1 its prompt.
	o.wake()
	o.wake()
	launches = o.launcher.byFlow("todo")
	require.Len(t, launches, 2, "one press, one attempt")
	second := launches[1]
	require.Equal(t, "mythical:"+id+":2:todo:2", second.RequestID)
	payload := decodeJSON(t, second.Payload)
	require.Equal(t, steer, payload["feedback"])
	require.Equal(t, decodeJSON(t, launches[0].Payload)["prompt"], payload["prompt"])
	require.NotContains(t, decodeJSON(t, launches[0].Payload), "feedback", "attempt 1 had no steer")
	o.projectTodo(second, jobs.StateWaiting, "todo-run-2", todoPinOne, "")
	card = o.todoCard(n)
	require.Equal(t, "working", card["state"])
	require.Equal(t, map[string]any{"id": "todo-run-2", "attempt": float64(2), "indicators": []any{}}, card["run"])
	kept := card["evidence"].([]any)[0].(map[string]any)
	require.EqualValues(t, 1, kept["attempt"])
	require.Equal(t, recordedTodoEvidence(attemptOne["items"].([]any)), recordedTodoEvidence(kept["items"].([]any)), "attempt 1 keeps its evidence")

	facts := o.facts(queued, "todo.retried")
	require.Len(t, facts, 1)
	require.EqualValues(t, 2, facts[0]["attempt"])
	require.Equal(t, true, facts[0]["steer"])
	require.Equal(t, "failed", facts[0]["from"])
	require.Equal(t, "queued", facts[0]["to"])
	require.Equal(t, owner.Username, facts[0]["actor"].(map[string]any)["login"])

	_, err = o.service.ControlTodo(session, n+100, other)
	require.ErrorAs(t, err, &refusal)
	require.Equal(t, "todo_not_found", refusal.Code)
}

// recordedTodoEvidence drops the model access the card reads live for the
// current attempt only.
func recordedTodoEvidence(items []any) []any {
	var recorded []any
	for _, item := range items {
		if item.(map[string]any)["kind"] != "model_access" {
			recorded = append(recorded, item)
		}
	}
	return recorded
}

// Two presses of one Retry at once start one attempt: the stack's row lock
// serializes them and the second answers the first's receipt.
func TestTodoRetryConcurrentPressesStartOneAttempt(t *testing.T) {
	o, session := newTodoAdmission(t)
	o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
	item := o.fileTodo(session, "pressed")
	o.wake()
	o.projectTodo(o.launcher.byFlow("todo")[0], jobs.StateWaiting, "todo-run-1", todoPinOne, "")
	failed := o.byID(uuidString(item.ID))
	failed.State = "blocked"
	_, err := o.service.queries().SaveMythicalItem(context.Background(), failed)
	require.NoError(t, err)
	press := TodoControlInput{Op: "retry", Repository: o.repoID, Actor: o.userID, Request: "press"}
	receipts := make(chan TodoControlReceipt, 4)
	errs := make(chan error, 4)
	for range 4 {
		go func() {
			receipt, err := o.service.ControlTodo(session, item.Number.Int64, press)
			receipts <- receipt
			errs <- err
		}()
	}
	for range 4 {
		require.NoError(t, <-errs)
		require.Equal(t, TodoControlReceipt{State: "accepted", Attempt: 2}, <-receipts)
	}
	require.Len(t, mythicalChecksOf(o.byID(uuidString(item.ID))).Retries, 1)
	require.Empty(t, mythicalChecksOf(o.byID(uuidString(item.ID))).Steers, "a Retry without a steer holds none")
}

// An attempt receives every steer held for it or an earlier attempt, in
// order; one held for a later attempt waits; past the bound the latest
// steers are kept whole and the text stays valid UTF-8.
func TestTodoFeedbackHoldsSteersForTheirAttempt(t *testing.T) {
	steers := func(list ...todoSteer) db.MythicalItem {
		return db.MythicalItem{Checks: mythicalChecks{Steers: list}.encode()}
	}
	item := steers(todoSteer{Text: "first", Attempt: 2}, todoSteer{Text: "second", Attempt: 3}, todoSteer{Text: "later", Attempt: 5})
	require.Empty(t, todoFeedback(item, 1))
	require.Equal(t, "first", todoFeedback(item, 2))
	require.Equal(t, "first\n\nsecond", todoFeedback(item, 4))
	require.Equal(t, "first\n\nsecond\n\nlater", todoFeedback(item, 5))
	require.Empty(t, todoFeedback(db.MythicalItem{}, 3))

	long := strings.Repeat("é", mythicalPromptBytes/2)
	bounded := todoFeedback(steers(todoSteer{Text: long, Attempt: 1}, todoSteer{Text: long, Attempt: 1}), 1)
	require.LessOrEqual(t, len(bounded), todoFeedbackBytes)
	require.True(t, utf8.ValidString(bounded))
	require.True(t, strings.HasSuffix(bounded, "\n\n"+long), "the latest steer is kept whole")
}

// After a Retry the attempt bound counts from the attempt it left: three
// more plans, then the very hard continuation, then a stop, while the attempt
// number keeps counting.
func TestMythicalRetryBoundCountsFromTheLastRetry(t *testing.T) {
	now := time.Now()
	item := db.MythicalItem{Source: "todo", State: "running", Attempt: 4, Checks: mythicalChecks{AttemptBase: 3}.encode()}
	for _, attempt := range []int32{4, 5} {
		item.Attempt = attempt
		next := mythicalRetry(item, "the plan failed", &mythicalFault{Class: "factory", Tag: "x", Kind: mythicalFailPlan}, now)
		require.Equal(t, "retrying", next.State)
		require.Equal(t, attempt, next.Attempt, "the next start runs attempt %d", attempt+1)
		require.False(t, mythicalChecksOf(*next).VeryHard)
	}
	item.Attempt = 6
	hard := mythicalRetry(item, "the plan failed", nil, now)
	require.True(t, mythicalChecksOf(*hard).VeryHard)
	require.EqualValues(t, 5, hard.Attempt, "the very hard continuation runs attempt 6 again")
	hard.Attempt = 6
	stopped := mythicalRetry(*hard, "the plan failed", nil, now)
	require.Equal(t, "blocked", stopped.State)
}

// Profile lookup must finish before Retry holds the only database connection.
func TestTodoRetryProfileWithOneDatabaseConnection(t *testing.T) {
	o, session := newTodoAdmission(t)
	o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
	item := o.fileTodo(session, "single-connection-retry")
	o.wake()
	o.projectTodo(o.launcher.byFlow("todo")[0], jobs.StateWaiting, "todo-run-1", todoPinOne, "")
	failed := o.byID(uuidString(item.ID))
	failed.State = "blocked"
	_, err := o.service.queries().SaveMythicalItem(context.Background(), failed)
	require.NoError(t, err)
	config := o.pool.Config()
	config.MaxConns, config.MinConns = 1, 0
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	o.service.store = pool
	ctx, cancel := context.WithTimeout(session, time.Minute)
	defer cancel()
	steer := "Use the existing helper"
	receipt, err := o.service.retryTodo(ctx, item.Number.Int64, TodoControlInput{Op: "retry", Repository: o.repoID, Actor: o.userID, Request: "single", Steer: &steer})
	require.NoError(t, err)
	require.EqualValues(t, 2, receipt.Attempt)
	authors := mythicalChecksOf(o.byID(uuidString(item.ID))).Steers
	require.Len(t, authors, 1)
	require.Contains(t, string(authors[0].By), "avatar_url")
	require.Contains(t, string(authors[0].By), "color_index")
}
