package services

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/stretchr/testify/require"
)

func steerFixture() (db.MythicalItem, TodoControlInput, context.Context) {
	text := " Keep the question open.\nAdd a cancellation check. "
	item := db.MythicalItem{State: "running", Source: "todo", Attempt: 2,
		RequestRunID: "same-run", WorkspaceID: "same-workspace", CandidateVerified: true,
		FlowDigest: pgtype.Text{String: strings.Repeat("a", 64), Valid: true},
		Checks: (mythicalChecks{FlowSource: strings.Repeat("b", 40), RunLaunched: true, RunAttached: true,
			Land: &mythicalLand{Head: strings.Repeat("c", 40)}}).encode(),
	}
	input := TodoControlInput{Actor: 9, Repository: 5, Request: "steer-1", Steer: &text}
	ctx := middleware.ContextWithAuthInfo(context.Background(), &middleware.AuthInfo{User: &db.User{ID: 9}, SessionHash: "person"})
	return item, input, ctx
}

func TestTodoSteerLifecycleAndOpenQuestions(t *testing.T) {
	for _, tc := range []struct {
		name, state                 string
		paused, attaching, question bool
		wantState                   string
		wantAttempt                 int32
		deliver                     bool
	}{
		{"queued", "queued", false, false, false, "queued", 3, false},
		{"starting", "running", false, true, false, "running", 2, false},
		{"working", "running", false, false, false, "running", 2, true},
		{"review", "proposed", false, false, false, "running", 2, true},
		{"review question", "proposed", false, false, true, "running", 2, true},
		{"paused review", "proposed", true, false, false, "proposed", 2, false},
		{"rebase", "integrating", false, false, false, "integrating", 2, true},
		{"paused", "running", true, false, false, "running", 2, false},
		{"failed", "blocked", false, false, false, "queued", 3, false},
		{"question", "running", false, false, true, "running", 2, true},
		{"paused question", "running", true, false, true, "running", 2, false},
		{"attaching question", "running", false, true, true, "running", 2, false},
		{"failed question", "blocked", false, false, true, "queued", 3, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			item, input, ctx := steerFixture()
			item.State = tc.state
			item.PausedAt = pgtype.Timestamptz{Time: time.Unix(123, 0), Valid: tc.paused}
			checks := mythicalChecksOf(item)
			checks.RunAttached = !tc.attaching
			if tc.state == "integrating" {
				item.PRNumber, item.PRState = pgtype.Int8{Int64: 4, Valid: true}, "open"
				checks.Rebase = &mythicalRebase{}
			}
			if tc.question {
				checks.Waits = []TodoWait{{ID: "question-1", Kind: "question", Prompt: "Which behavior?", Signal: &TodoWaitSignal{Run: "same-run", Name: "answer"}}}
			}
			if tc.state == "queued" {
				checks.RunLaunched, checks.RunAttached = false, false
			}
			item.Checks = checks.encode()
			if tc.state == "integrating" {
				require.Equal(t, "in_review", todoState(item), "the card masks an active rebase")
			}
			before, err := json.Marshal(item)
			require.NoError(t, err)
			now := time.Unix(1234, 0).UTC()
			next, feedback, deliver, replay, err := prepareTodoSteer(ctx, item, input, json.RawMessage(`{"kind":"person","login":"member"}`), now)
			require.NoError(t, err)
			require.False(t, replay)
			require.Equal(t, tc.deliver, deliver)
			require.Equal(t, tc.wantState, next.State)
			require.Equal(t, tc.wantAttempt, feedback.Attempt)
			require.Equal(t, item.Attempt, next.Attempt, "admission never allocates the next attempt itself")
			require.Equal(t, "same-run", next.RequestRunID)
			require.Equal(t, "same-workspace", next.WorkspaceID)
			require.Equal(t, *input.Steer, feedback.Text)
			require.Equal(t, now, feedback.At)
			require.NotEmpty(t, feedback.ID)
			require.False(t, next.CandidateVerified)
			require.Nil(t, mythicalChecksOf(next).Land)
			require.Equal(t, checks.Waits, mythicalChecksOf(next).Waits, "steering never answers or withdraws a question")
			after, err := json.Marshal(item)
			require.NoError(t, err)
			require.JSONEq(t, string(before), string(after), "preparation must not mutate its input")
		})
	}
}

func TestTodoSteerFenceHoldsWithoutChangingCandidate(t *testing.T) {
	item, input, ctx := steerFixture()
	item.State = "proposed"
	item.PendingOp = []byte(`{"kind":"merge","target":"3","desired":"` + strings.Repeat("c", 40) + `","state":"intended"}`)
	next, feedback, deliver, replay, err := prepareTodoSteer(ctx, item, input, json.RawMessage(`{}`), time.Now())
	require.NoError(t, err)
	require.False(t, deliver)
	require.False(t, replay)
	require.NotEmpty(t, feedback.ID)
	require.Equal(t, "proposed", next.State)
	require.True(t, next.CandidateVerified)
	require.Equal(t, mythicalChecksOf(item).Land, mythicalChecksOf(next).Land)
	require.Equal(t, item.PendingOp, next.PendingOp)
}

func TestTodoSteerReplayAndHistoricalFeedback(t *testing.T) {
	item, input, ctx := steerFixture()
	checks := mythicalChecksOf(item)
	checks.Steers = []todoSteer{{Text: "historical retry", Attempt: 1}}
	item.Checks = checks.encode()
	next, first, _, _, err := prepareTodoSteer(ctx, item, input, json.RawMessage(`{}`), time.Unix(100, 0))
	require.NoError(t, err)
	// A late retry of the same admitted input must not create a new effect,
	// even after the TODO settled.
	next.State = "landed"
	replayed, feedback, deliver, replay, err := prepareTodoSteer(ctx, next, input, json.RawMessage(`{}`), time.Unix(200, 0))
	require.NoError(t, err)
	require.True(t, replay)
	require.False(t, deliver)
	require.Equal(t, first, feedback)
	require.Len(t, mythicalChecksOf(replayed).Steers, 2)
	require.Equal(t, "historical retry", mythicalChecksOf(replayed).Steers[0].Text)
	changed := "different body"
	input.Steer = &changed
	_, _, _, _, err = prepareTodoSteer(ctx, next, input, json.RawMessage(`{}`), time.Now())
	require.Error(t, err)
	input.Actor = 10
	next.State = "running"
	other, feedback, _, replay, err := prepareTodoSteer(ctx, next, input, json.RawMessage(`{}`), time.Now())
	require.NoError(t, err)
	require.False(t, replay, "request keys are scoped to the authenticated author")
	require.NotEqual(t, first.ID, feedback.ID)
	require.Len(t, mythicalChecksOf(other).Steers, 3)
}

func TestTodoSteerRefusesClosedOrUnboundRun(t *testing.T) {
	for _, state := range []string{"landed", "cancelled", "rejected", "declined"} {
		item, input, ctx := steerFixture()
		item.State = state
		_, _, _, _, err := prepareTodoSteer(ctx, item, input, json.RawMessage(`{}`), time.Now())
		var refusal *TodoControlError
		require.ErrorAs(t, err, &refusal)
		require.Equal(t, "todo_closed", refusal.Code)
	}
	for _, change := range []func(*db.MythicalItem){
		func(i *db.MythicalItem) { i.RequestRunID = "" },
		func(i *db.MythicalItem) { i.WorkspaceID = "" },
		func(i *db.MythicalItem) { i.FlowDigest.Valid = false },
	} {
		item, input, ctx := steerFixture()
		change(&item)
		_, _, _, _, err := prepareTodoSteer(ctx, item, input, json.RawMessage(`{}`), time.Now())
		var refusal *TodoControlError
		require.ErrorAs(t, err, &refusal)
		require.Equal(t, "todo_control_unavailable", refusal.Code)
	}
}
