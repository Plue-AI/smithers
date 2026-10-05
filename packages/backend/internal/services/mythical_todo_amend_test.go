package services

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// amend is the session's Amend of TODO n with the Idempotency-Key key.
func (o *mythicalOrchestration) amend(ctx context.Context, n int64, text string, acceptance []string, key string) (TodoAmendReceipt, error) {
	return o.service.AmendTodo(ctx, n, TodoAmendInput{Prompt: text, Acceptance: acceptance, Repository: o.repoID, Actor: o.userID, Request: key})
}

// todoRevisions is the item's prompt revisions as stored.
func todoRevisions(t *testing.T, item db.MythicalItem) []map[string]any {
	t.Helper()
	var revisions []map[string]any
	require.NoError(t, json.Unmarshal(item.Revisions, &revisions))
	return revisions
}

func (o *mythicalOrchestration) todoCount() int {
	o.t.Helper()
	var n int
	require.NoError(o.t, o.pool.QueryRow(context.Background(), `SELECT count(*) FROM mythical_items WHERE repository_id = $1`, o.repoID).Scan(&n))
	return n
}

// J7.1, spec §10.2.2, §10.4.2: Amend appends revision n+1 with reason amend
// and delivers it to the coding agent as a steer, by the TODO's state.
// Queued: the next attempt's first input, while the run's prompt stays
// revision 1. Starting: held, then sent when the run attaches. Working: sent
// to the live run at once. No TODO is made; the run, attempt and number stay;
// the same press again sends nothing more; the card shows the revisions and
// keeps amendments out of steers[].
func TestTodoAmendDeliversEachRevisionAsASteerByState(t *testing.T) {
	o, session, launcher, item := newSteeredTodo(t)
	n, id := item.Number.Int64, uuidString(item.ID)
	items := o.todoCount()

	receipt, err := o.amend(session, n, "[QUEUED] also greet in French", []string{"JOURNEY.md greets in French"}, "amend-queued")
	require.NoError(t, err)
	require.Equal(t, TodoAmendReceipt{State: "accepted", N: n, Rev: 2}, receipt)
	require.Empty(t, launcher.sent(), "a queued TODO has no run to message")
	queued := o.byID(id)
	revisions := todoRevisions(t, queued)
	require.Len(t, revisions, 2)
	require.Equal(t, "Add a greeting to JOURNEY.md", revisions[0]["text"], "revision 1 is the TODO as filed")
	require.Equal(t, map[string]any{"n": float64(2), "reason": "amend", "text": "[QUEUED] also greet in French",
		"acceptance": []any{"JOURNEY.md greets in French"}, "by": revisions[1]["by"], "at": revisions[1]["at"]}, revisions[1])
	require.Equal(t, "person", revisions[1]["by"].(map[string]any)["kind"])
	require.NotEmpty(t, revisions[1]["at"])

	o.wake()
	launches := o.launcher.byFlow("coding/request")
	require.Len(t, launches, 1)
	payload := decodeJSON(t, launches[0].Payload)
	require.Equal(t, "Amendment (revision 2):\n[QUEUED] also greet in French\n\nAcceptance:\n- JOURNEY.md greets in French", payload["feedback"],
		"the queued amendment is the attempt's first input")
	require.Contains(t, payload["prompt"], "Add a greeting to JOURNEY.md")
	require.NotContains(t, payload["prompt"], "[QUEUED]", "the run's prompt is revision 1 (§10.4.2)")
	require.NotContains(t, todoPrompt(o.byID(id)), "[QUEUED]")

	receipt, err = o.amend(session, n, "[STARTING] keep it to one line", nil, "amend-starting")
	require.NoError(t, err)
	require.Equal(t, 3, receipt.Rev)
	require.Empty(t, launcher.sent(), "a starting attempt holds the amendment until its run attaches")
	o.projectAsking(launches[0], jobs.StateWaiting, "request-run-1")
	sent := launcher.sent()
	require.Len(t, sent, 1, "the held amendment goes to the run once it attaches")
	require.Equal(t, "request-run-1", sent[0].RunID)
	require.Equal(t, launches[0].Target, sent[0].Target)
	require.Equal(t, "Amendment (revision 3):\n[STARTING] keep it to one line", sent[0].Steer.Body)

	receipt, err = o.amend(session, n, "[WORKING] use the helper in lib/retry.ts", []string{"lib/retry.ts is used"}, "amend-working")
	require.NoError(t, err)
	require.Equal(t, TodoAmendReceipt{State: "accepted", N: n, Rev: 4}, receipt)
	again, err := o.amend(session, n, "[WORKING] use the helper in lib/retry.ts", []string{"lib/retry.ts is used"}, "amend-working")
	require.NoError(t, err)
	require.Equal(t, receipt, again, "the same press again answers the same receipt")
	_, err = o.amend(session, n, "something else", nil, "amend-working")
	require.Equal(t, &TodoControlError{http.StatusConflict, "idempotency_mismatch", "conflict", "Idempotency-Key was already used for a different amendment"}, refusalOf(t, err))
	sent = launcher.sent()
	require.Len(t, sent, 2, "the same press again sends nothing more")
	require.Equal(t, "request-run-1", sent[1].RunID)
	require.Equal(t, "Amendment (revision 4):\n[WORKING] use the helper in lib/retry.ts\n\nAcceptance:\n- lib/retry.ts is used", sent[1].Steer.Body)
	require.Equal(t, "todo-steer:"+id+":amend:amend-working", sent[1].RequestID)

	working := o.byID(id)
	require.Equal(t, "working", todoState(working))
	require.EqualValues(t, 1, working.Attempt, "the same attempt")
	require.Equal(t, "request-run-1", working.RequestRunID, "the same run")
	require.Equal(t, n, working.Number.Int64)
	require.Equal(t, items, o.todoCount(), "Amend makes no TODO")
	require.Len(t, todoRevisions(t, working), 4)
	card := o.todoCard(n)
	require.Len(t, card["prompt_revisions"], 4)
	require.Empty(t, card["steers"], "amendments are revisions on the card, not steers")
	facts := o.facts(working, "todo.amended")
	require.Len(t, facts, 3)
	require.Equal(t, []any{"held", "held", "sent"}, []any{facts[0]["delivery"], facts[1]["delivery"], facts[2]["delivery"]})
	require.Equal(t, []any{float64(2), float64(3), float64(4)}, []any{facts[0]["rev"], facts[1]["rev"], facts[2]["rev"]})
	require.Equal(t, "working", facts[2]["from"])

	// A steer and an amendment share delivery but not identity: a steer press
	// with the amendment's key is its own steer.
	_, err = o.steer(session, n, "plain steer", "amend-working")
	require.NoError(t, err)
	require.Len(t, launcher.sent(), 3)
	require.Len(t, o.todoCard(n)["steers"], 1)
}

// §4.1 in_review → working, §10.6.2a row 7: an amendment to a TODO in review
// cancels the attempt's runs and starts the next attempt with the amendment
// first; the pull request stays open. A failed TODO is retried with it.
func TestTodoAmendInReviewOrFailedStartsTheNextAttempt(t *testing.T) {
	o, session, launcher, item := newSteeredTodo(t)
	n, id := item.Number.Int64, uuidString(item.ID)
	o.wake()
	o.projectAsking(o.launcher.byFlow("coding/request")[0], jobs.StateWaiting, "request-run-1")
	reviewed := o.byID(id)
	reviewed.State, reviewed.RequestOutcome = "proposed", "validated"
	reviewed.PRNumber, reviewed.PRState, reviewed.PRHead = pgtype.Int8{Int64: 4, Valid: true}, "open", strings.Repeat("ab", 20)
	_, err := o.service.queries().SaveMythicalItem(context.Background(), reviewed)
	require.NoError(t, err)

	receipt, err := o.amend(session, n, "[REVIEW] rename the file", nil, "amend-review")
	require.NoError(t, err)
	require.Equal(t, 2, receipt.Rev)
	require.Empty(t, launcher.sent())
	queued := o.byID(id)
	require.Equal(t, "queued", queued.State)
	require.Equal(t, "open", queued.PRState, "the open pull request stays open")
	require.Equal(t, "next_attempt", o.facts(queued, "todo.amended")[0]["delivery"])
	o.wake()
	launches := o.launcher.byFlow("coding/request")
	require.Len(t, launches, 2)
	require.Equal(t, "Amendment (revision 2):\n[REVIEW] rename the file", decodeJSON(t, launches[1].Payload)["feedback"])
	require.EqualValues(t, 2, o.byID(id).Attempt)

	failed := o.byID(id)
	failed.State, failed.Reason = "blocked", "checks failed"
	_, err = o.service.queries().SaveMythicalItem(context.Background(), failed)
	require.NoError(t, err)
	receipt, err = o.amend(session, n, "[FIXED] keep the file", nil, "amend-failed")
	require.NoError(t, err)
	require.Equal(t, 3, receipt.Rev)
	retried := o.byID(id)
	require.Equal(t, "queued", retried.State)
	require.Equal(t, "retry", o.facts(retried, "todo.amended")[1]["delivery"])
	o.wake()
	launches = o.launcher.byFlow("coding/request")
	require.Equal(t, "Amendment (revision 2):\n[REVIEW] rename the file\n\nAmendment (revision 3):\n[FIXED] keep the file",
		decodeJSON(t, launches[len(launches)-1].Payload)["feedback"], "every amendment reaches each later attempt, in order")
	require.EqualValues(t, 3, o.byID(id).Attempt)
}

// Amend refuses, before any revision, fact or signal, what it cannot take:
// no store or signal admission, a pinned todo composition's run, a merge in
// flight, a merged or dropped TODO, a TODO that does not exist, a run's or
// a delegated credential, a missing Idempotency-Key and an invalid number.
func TestTodoAmendRefusals(t *testing.T) {
	_, err := NewMythicalService(nil, nil).AmendTodo(context.Background(), 3, TodoAmendInput{Prompt: "x", Request: "k"})
	require.Equal(t, "todo_control_unavailable", refusalOf(t, err).Code)
	var none *MythicalService
	_, err = none.AmendTodo(context.Background(), 0, TodoAmendInput{Prompt: "x", Request: "k"})
	require.Equal(t, "invalid_todo", refusalOf(t, err).Code)
	_, err = none.AmendTodo(context.Background(), 3, TodoAmendInput{Prompt: "x"})
	require.Equal(t, "idempotency_key_required", refusalOf(t, err).Code)
	_, err = none.AmendTodo(context.Background(), 3, TodoAmendInput{Prompt: "x", Request: strings.Repeat("k", todoAmendRequestBytes+1)})
	require.Equal(t, "idempotency_key_required", refusalOf(t, err).Code)

	o, session := newTodoAdmission(t) // the fake launcher admits no signals
	plain := o.fileTodo(session, "no-signals")
	_, err = o.amend(session, plain.Number.Int64, "x", nil, "k")
	require.Equal(t, "todo_control_unavailable", refusalOf(t, err).Code)
	require.Len(t, todoRevisions(t, o.byID(uuidString(plain.ID))), 1)

	o, session, launcher, item := newSteeredTodo(t)
	n, id := item.Number.Int64, uuidString(item.ID)
	unchanged := func(why string) {
		t.Helper()
		require.Len(t, todoRevisions(t, o.byID(id)), 1, why)
		require.Empty(t, o.facts(o.byID(id), "todo.amended"), why)
		require.Empty(t, launcher.sent(), why)
	}
	_, err = o.amend(session, n+100, "x", nil, "k-missing")
	require.Equal(t, &TodoControlError{http.StatusNotFound, "todo_not_found", "user", "TODO not found"}, refusalOf(t, err))
	_, err = o.amend(mythicalRunContext(context.Background(), o.userID), n, "from a run", nil, "k-run")
	require.Equal(t, http.StatusForbidden, refusalOf(t, err).Status, "a run never amends a TODO")
	delegated := middleware.ContextWithAuthInfo(context.Background(), &middleware.AuthInfo{User: &db.User{ID: o.userID}, IsTokenAuth: true, TokenSystemIssued: true,
		RawScopes: strings.Join(middleware.DelegationScopes(middleware.Delegation{Via: "claude-code", Session: "s1"}), ",")})
	_, err = o.amend(delegated, n, "for Ben", nil, "k-delegated")
	require.Equal(t, &TodoControlError{http.StatusServiceUnavailable, "confirmation_unavailable", "infra", "Confirm in the app"}, refusalOf(t, err))
	unchanged("refused callers write nothing")

	o.wake()
	o.projectAsking(o.launcher.byFlow("coding/request")[0], jobs.StateWaiting, "request-run-1")
	pinned := o.byID(id)
	pinned.FlowDigest = pgtype.Text{String: todoPinOne, Valid: true}
	_, err = o.service.queries().SaveMythicalItem(context.Background(), pinned)
	require.NoError(t, err)
	_, err = o.amend(session, n, "x", nil, "k-pinned")
	require.Equal(t, "todo_control_unavailable", refusalOf(t, err).Code, "the todo composition's host refuses messages")
	unchanged("a pinned run's amendment writes nothing")

	fenced := o.byID(id)
	fenced.FlowDigest = pgtype.Text{}
	fenced.PendingOp = []byte(`{"kind":"merge","target":"3","desired":"` + strings.Repeat("a", 40) + `","state":"intended"}`)
	_, err = o.service.queries().SaveMythicalItem(context.Background(), fenced)
	require.NoError(t, err)
	_, err = o.amend(session, n, "x", nil, "k-merging")
	require.Equal(t, &TodoControlError{http.StatusConflict, "merging", "conflict", "TODO is merging"}, refusalOf(t, err))
	unchanged("a merging TODO takes no amendment")

	for _, state := range []string{"landed", "cancelled", "rejected", "declined"} {
		closed := o.byID(id)
		closed.PendingOp, closed.State = nil, state
		_, err = o.service.queries().SaveMythicalItem(context.Background(), closed)
		require.NoError(t, err)
		_, err = o.amend(session, n, "x", nil, "k-"+state)
		require.Equal(t, &TodoControlError{http.StatusConflict, "todo_closed", "conflict", "TODO is closed"}, refusalOf(t, err), state)
	}
	unchanged("a closed TODO takes no amendment")
}

// Concurrent amendments serialize on the stack's row lock: different presses
// take consecutive revisions, and one press sent twice at once is one
// revision and one signal.
func TestTodoAmendConcurrentPressesTakeConsecutiveRevisions(t *testing.T) {
	o, session, launcher, item := newSteeredTodo(t)
	n, id := item.Number.Int64, uuidString(item.ID)
	o.wake()
	o.projectAsking(o.launcher.byFlow("coding/request")[0], jobs.StateWaiting, "request-run-1")
	var wg sync.WaitGroup
	revs := make(chan int, 8)
	for i := range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			key := fmt.Sprintf("press-%d", i%4)
			receipt, err := o.amend(session, n, "follow-up "+key, nil, key)
			if err == nil {
				revs <- receipt.Rev
			} else {
				t.Errorf("amend %s: %v", key, err)
			}
		}()
	}
	wg.Wait()
	close(revs)
	seen := map[int]int{}
	for rev := range revs {
		seen[rev]++
	}
	require.Equal(t, map[int]int{2: 2, 3: 2, 4: 2, 5: 2}, seen, "each press is one revision, answered twice")
	revisions := todoRevisions(t, o.byID(id))
	require.Len(t, revisions, 5)
	for i, revision := range revisions[1:] {
		require.Equal(t, float64(i+2), revision["n"])
	}
	require.Len(t, launcher.sent(), 4, "one signal per press")
}

func TestTodoAmendInputBoundaries(t *testing.T) {
	for _, input := range []TodoAmendInput{
		{}, {Prompt: " \n\t"}, {Prompt: string([]byte{0xff})},
		{Prompt: "x", Acceptance: []string{""}}, {Prompt: "x", Acceptance: []string{" "}},
		{Prompt: "x", Acceptance: []string{string([]byte{0xc3})}},
		{Prompt: strings.Repeat("x", mythicalPromptBytes+1)},
		{Prompt: "x", Acceptance: []string{strings.Repeat("y", mythicalPromptBytes-len(todoAcceptanceHeading)-len(todoAcceptanceLine))}},
		{Prompt: "x", Acceptance: strings.Split(strings.Repeat("y\n", mythicalPromptBytes/4)+"y", "\n")},
	} {
		require.Equal(t, "invalid_amendment", input.validate().(*TodoControlError).Code, "%q", input.Prompt)
	}
	for _, input := range []TodoAmendInput{
		{Prompt: " Keep\nverbatim "}, {Prompt: strings.Repeat("x", mythicalPromptBytes)},
		{Prompt: "x", Acceptance: []string{strings.Repeat("y", mythicalPromptBytes-1-len(todoAcceptanceHeading)-len(todoAcceptanceLine))}},
		{Prompt: "é", Acceptance: []string{"a", "b"}},
	} {
		require.NoError(t, input.validate())
	}
	require.Equal(t, "Amendment (revision 2):\nx", todoAmendmentSteer(2, "x", nil))
	require.Equal(t, "Amendment (revision 12):\n x \n\nAcceptance:\n- a\n- b", todoAmendmentSteer(12, " x ", []string{"a", "b"}))
}

// FuzzTodoAmendInput: validate admits exactly a prompt with text and
// acceptance lines with text, valid UTF-8, within mythicalPromptBytes
// together; an admitted amendment's steer carries its text and every line
// whole, after its revision header, and fits a steer's feedback bound.
func FuzzTodoAmendInput(f *testing.F) {
	f.Add("Add a retry", "it retries\nonce", 2)
	f.Add(" ", "", 3)
	f.Add(string([]byte{0xff, 'a'}), "x", 9)
	f.Add(strings.Repeat("é", mythicalPromptBytes/2), "", 2)
	f.Fuzz(func(t *testing.T, prompt, acceptance string, rev int) {
		if rev < 2 || rev > 1<<20 {
			rev = 2
		}
		var lines []string
		if acceptance != "" {
			lines = strings.Split(acceptance, "\n")
		}
		input := TodoAmendInput{Prompt: prompt, Acceptance: lines}
		want := strings.TrimSpace(prompt) != "" && utf8.ValidString(prompt)
		size := len(prompt)
		if len(lines) > 0 {
			size += len("\n\nAcceptance:")
		}
		for _, line := range lines {
			want = want && strings.TrimSpace(line) != "" && utf8.ValidString(line)
			size += len("\n- ") + len(line)
		}
		want = want && size <= mythicalPromptBytes
		err := input.validate()
		require.Equal(t, want, err == nil, "validate(%q, %q) = %v", prompt, lines, err)
		if err != nil {
			require.Equal(t, "invalid_amendment", err.(*TodoControlError).Code)
			return
		}
		steer := todoAmendmentSteer(rev, prompt, lines)
		require.True(t, strings.HasPrefix(steer, fmt.Sprintf("Amendment (revision %d):\n%s", rev, prompt)))
		for _, line := range lines {
			require.Contains(t, steer, "\n- "+line)
		}
		require.True(t, utf8.ValidString(steer))
		require.LessOrEqual(t, len(steer), todoFeedbackBytes)
	})
}
