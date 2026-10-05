package services

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/runtimebridge"
)

// answerLauncher is the stack's fake launcher plus the dispatcher's signal
// admission, recorded as admitted.
type answerLauncher struct {
	*fakeMythicalLauncher
	mu      sync.Mutex
	signals []flowdispatch.SignalRequest
}

func (l *answerLauncher) SignalInTx(_ context.Context, _ pgx.Tx, request flowdispatch.SignalRequest) (jobs.RequestReceipt, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.signals = append(l.signals, request)
	return jobs.RequestReceipt{}, nil
}

func (l *answerLauncher) sent() []flowdispatch.SignalRequest {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]flowdispatch.SignalRequest(nil), l.signals...)
}

// humanAsk is a HumanTask `ask` parked in the run's planning step, as the
// control run summary reports it.
func humanAsk(token, name, prompt string) flowruntime.PendingWait {
	request, _ := json.Marshal(map[string]any{"task": "human", "name": name, "kind": "ask", "prompt": prompt, "attempt": 1, "maxAttempts": 3})
	return flowruntime.PendingWait{RunID: "planning-execution", FlowID: "coding/PreparePlan", Reason: "approval", Token: token, Name: name, Attempt: 1, Request: request, CreatedAt: 1}
}

// projectAsking reports the attempt's run as the dispatcher observes it: its
// launch's scope and target, and the human waits its tree is parked on.
func (o *mythicalOrchestration) projectAsking(launch flowdispatch.LaunchRequest, state jobs.State, runID string, waits ...flowruntime.PendingWait) {
	o.t.Helper()
	status := "running"
	if len(waits) > 0 {
		status = "waiting-approval"
	}
	output := ""
	update := flowdispatch.ProjectionUpdate{State: state, Scope: launch.Scope, Checkpoint: flowdispatch.RuntimeCheckpoint{FlowID: launch.FlowID, Target: launch.Target,
		Projection: launch.Projection, RunID: runID, ExecutionDigest: todoPinOne,
		Run: &flowruntime.FlowRuntimeRun{RunID: runID, FlowID: launch.FlowID, Status: status, PendingWaits: waits, FinalOutput: &output}}}
	require.NoError(o.t, o.service.ProjectFlowRuntime(context.Background(), update))
}

func (o *mythicalOrchestration) person(login string) (int64, context.Context) {
	o.t.Helper()
	var id int64
	require.NoError(o.t, o.pool.QueryRow(context.Background(), `INSERT INTO users(username, lower_username, display_name) VALUES ($1, $1, $1) RETURNING id`, login).Scan(&id))
	return id, middleware.ContextWithAuthInfo(context.Background(), &middleware.AuthInfo{User: &db.User{ID: id}, SessionHash: login + "-session"})
}

func (o *mythicalOrchestration) todoCard(n int64) map[string]any {
	o.t.Helper()
	card, err := o.service.Todo(context.Background(), o.repoID, n)
	require.NoError(o.t, err)
	encoded, err := json.Marshal(card)
	require.NoError(o.t, err)
	return decodeJSON(o.t, encoded)
}

func (o *mythicalOrchestration) facts(item db.MythicalItem, eventType string) []map[string]any {
	o.t.Helper()
	rows, err := o.pool.Query(context.Background(), `SELECT data FROM product_job_events WHERE principal_id = $1 AND event_type = $2 ORDER BY sequence`,
		todoOperationScope(item).PrincipalID, eventType)
	require.NoError(o.t, err)
	defer rows.Close()
	var out []map[string]any
	for rows.Next() {
		var data []byte
		require.NoError(o.t, rows.Scan(&data))
		out = append(out, decodeJSON(o.t, data))
	}
	require.NoError(o.t, rows.Err())
	return out
}

// newAskingTodo is an owner's TODO whose attempt's run is bound (Working).
func newAskingTodo(t *testing.T) (*mythicalOrchestration, context.Context, *answerLauncher, db.MythicalItem, flowdispatch.LaunchRequest) {
	t.Helper()
	o, session := newTodoAdmission(t)
	launcher := &answerLauncher{fakeMythicalLauncher: o.launcher}
	o.service.SetLauncher(launcher)
	o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
	item := o.fileTodo(session, "asking")
	o.wake()
	launches := o.launcher.byFlow("todo")
	require.Len(t, launches, 1)
	o.projectAsking(launches[0], jobs.StateWaiting, "todo-run-1")
	item = o.byID(uuidString(item.ID))
	require.Equal(t, "working", todoState(item))
	return o, session, launcher, item, launches[0]
}

// J2 step 4 / J3 step 6: the run asks one question and the TODO shows Needs
// you with Answer; a steer does not settle it; the first answer settles it
// and signals the parked wait point with the answer text; a later answer is
// refused with who answered.
func TestTodoQuestionNeedsYouAndTheFirstAnswerWins(t *testing.T) {
	o, session, launcher, item, launch := newAskingTodo(t)
	ctx := context.Background()
	n := item.Number.Int64
	var ownerLogin string
	require.NoError(t, o.pool.QueryRow(ctx, `SELECT username FROM users WHERE id=$1`, o.userID).Scan(&ownerLogin))
	ask := humanAsk("WaitFor-token-1", "coding-clarification", "Use backoff or a fixed delay?")

	// Waits that are not a named HumanTask ask are not questions: a confirm,
	// an in-run approval of the agent's own ask (no wait point to signal),
	// and an ask without a prompt.
	confirm := humanAsk("WaitFor-token-0", "coding-plan-approval", "Approve this plan?")
	confirm.Request = json.RawMessage(`{"task":"human","name":"coding-plan-approval","kind":"confirm","prompt":"Approve this plan?"}`)
	approval := flowruntime.PendingWait{RunID: "todo-run-1", Reason: "approval", Token: "ask-request-1", Request: json.RawMessage(`{"question":"May I?"}`)}
	blank := humanAsk("WaitFor-token-9", "coding-clarification", " ")
	o.projectAsking(launch, jobs.StateWaiting, "todo-run-1", confirm, approval, blank)
	require.Equal(t, "working", todoState(o.byID(uuidString(item.ID))))

	// The question opens Needs you, once however often it is observed.
	o.projectAsking(launch, jobs.StateWaiting, "todo-run-1", ask)
	o.projectAsking(launch, jobs.StateWaiting, "todo-run-1", confirm, ask)
	item = o.byID(uuidString(item.ID))
	require.Equal(t, "needs_you", todoState(item))
	waits := todoOpenWaits(item)
	require.Len(t, waits, 1)
	wait := waits[0]
	require.Equal(t, "question", wait.Kind)
	require.Equal(t, "Use backoff or a fixed delay?", wait.Prompt)
	require.Regexp(t, `^q-[0-9a-f]{16}$`, wait.ID)
	require.Equal(t, &TodoWaitSignal{Scope: launch.Scope, Target: launch.Target, Flow: "todo", Run: "todo-run-1", Name: "coding-clarification"}, wait.Signal)
	card := o.todoCard(n)
	require.Equal(t, "needs_you", card["state"])
	require.Equal(t, []any{map[string]any{"id": wait.ID, "kind": "question", "prompt": "Use backoff or a fixed delay?", "since": wait.Since.Format(time.RFC3339Nano),
		"actions": []any{map[string]any{"tag": "todo.answer", "label": "Answer",
			"input": []any{map[string]any{"name": "answer", "label": "Answer", "kind": "text", "required": true}}}}}}, card["waits"])
	require.NotContains(t, card, "first_answer")
	opened := o.facts(item, "todo.run_updated")
	require.Equal(t, "needs_you", opened[len(opened)-1]["to"])

	// A steer never settles a question by itself.
	steer := "use the existing retry helper"
	_, err := o.service.ControlTodo(session, n, TodoControlInput{Steer: &steer})
	require.Error(t, err)
	require.Equal(t, "needs_you", todoState(o.byID(uuidString(item.ID))))
	require.Empty(t, launcher.sent())

	// Refusals before any write.
	for _, input := range []TodoAnswerInput{{Wait: wait.ID}, {Answer: "x"}, {Wait: wait.ID, Answer: "  "}, {Wait: wait.ID, Answer: "\xff"},
		{Wait: wait.ID, Answer: strings.Repeat("a", todoAnswerBytes+1)}} {
		var refusal *TodoControlError
		require.ErrorAs(t, o.service.AnswerTodo(session, o.repoID, o.userID, n, input), &refusal)
		require.Equal(t, "invalid_answer", refusal.Code)
	}
	var missing *TodoControlError
	require.ErrorAs(t, o.service.AnswerTodo(session, o.repoID, o.userID, n, TodoAnswerInput{Wait: "q-0000000000000000", Answer: "x"}), &missing)
	require.Equal(t, 404, missing.Status)
	require.ErrorAs(t, o.service.AnswerTodo(session, o.repoID, o.userID, n+40, TodoAnswerInput{Wait: wait.ID, Answer: "x"}), &missing)
	require.Equal(t, "todo_not_found", missing.Code)
	require.Equal(t, "needs_you", todoState(o.byID(uuidString(item.ID))))
	require.Empty(t, launcher.sent())

	// The first answer settles the question and signals the wait point.
	require.NoError(t, o.service.AnswerTodo(session, o.repoID, o.userID, n, TodoAnswerInput{Wait: wait.ID, Answer: "Use backoff"}))
	item = o.byID(uuidString(item.ID))
	require.Equal(t, "working", todoState(item), "the answer settled the only wait")
	signals := launcher.sent()
	require.Len(t, signals, 1)
	require.Equal(t, flowdispatch.SignalRequest{Scope: launch.Scope, RequestID: "todo-answer:" + uuidString(item.ID) + ":" + wait.ID, Target: launch.Target,
		FlowID: "todo", RunID: "todo-run-1", Name: "coding-clarification", Payload: json.RawMessage(`"Use backoff"`),
		AuthorizationContext: signals[0].AuthorizationContext, Projection: signals[0].Projection}, signals[0])
	require.Equal(t, "mythical-answer", decodeJSON(t, signals[0].Projection)["kind"], "no stack projector reads the signal's outcome as the run's")
	card = o.todoCard(n)
	require.Equal(t, []any{}, card["waits"])
	answer := card["first_answer"].(map[string]any)
	require.Equal(t, "Use backoff", answer["text"])
	require.Equal(t, ownerLogin, answer["by"].(map[string]any)["login"])
	require.Equal(t, "person", answer["by"].(map[string]any)["kind"])
	require.NotEmpty(t, answer["by"].(map[string]any)["avatar_url"], "the answer settles with the person's avatar")
	answered := o.facts(item, "todo.answered")
	require.Len(t, answered, 1)
	require.Equal(t, "needs_you", answered[0]["from"])
	require.Equal(t, "working", answered[0]["to"])
	require.Equal(t, ownerLogin, answered[0]["actor"].(map[string]any)["login"])

	// The same person's same answer again is that answer; anyone else's,
	// or another text, learns who answered.
	require.NoError(t, o.service.AnswerTodo(session, o.repoID, o.userID, n, TodoAnswerInput{Wait: wait.ID, Answer: "Use backoff"}))
	alice, aliceSession := o.person("alice")
	for _, answer := range []struct {
		ctx  context.Context
		user int64
		text string
	}{{aliceSession, alice, "Use a fixed delay"}, {aliceSession, alice, "Use backoff"}, {session, o.userID, "Use a fixed delay"}} {
		var later *TodoAnsweredError
		require.ErrorAs(t, o.service.AnswerTodo(answer.ctx, o.repoID, answer.user, n, TodoAnswerInput{Wait: wait.ID, Answer: answer.text}), &later)
		require.Equal(t, ownerLogin, later.AnsweredBy)
		encoded, err := json.Marshal(later)
		require.NoError(t, err)
		require.JSONEq(t, `{"code":"answered","class":"conflict","message":"`+ownerLogin+` answered","answered_by":"`+ownerLogin+`"}`, string(encoded))
	}
	require.Len(t, launcher.sent(), 1, "one signal per question")
	require.Len(t, o.facts(item, "todo.answered"), 1)

	// The run still reports the wait until the signal reaches it; that
	// observation neither reopens nor duplicates the question.
	o.projectAsking(launch, jobs.StateWaiting, "todo-run-1", ask)
	o.projectAsking(launch, jobs.StateWaiting, "todo-run-1")
	item = o.byID(uuidString(item.ID))
	require.Equal(t, "working", todoState(item))
	require.Len(t, mythicalChecksOf(item).Waits, 1)
	require.Equal(t, "Use backoff", mythicalChecksOf(item).Waits[0].Answer)
}

// Twenty members answer one question at once: exactly one answer settles it
// and signals the run; the other nineteen learn who answered.
func TestTodoConcurrentAnswersOneWins(t *testing.T) {
	o, session, launcher, item, launch := newAskingTodo(t)
	n := item.Number.Int64
	o.projectAsking(launch, jobs.StateWaiting, "todo-run-1", humanAsk("WaitFor-token-2", "coding-clarification", "Which helper?"))
	wait := todoOpenWaits(o.byID(uuidString(item.ID)))[0]
	type answerer struct {
		ctx  context.Context
		user int64
		text string
	}
	people := []answerer{{session, o.userID, "helper 0"}}
	for i := 1; i < 20; i++ {
		id, ctx := o.person("member-" + strconv.Itoa(i))
		people = append(people, answerer{ctx, id, "helper " + strconv.Itoa(i)})
	}
	errs := make([]error, len(people))
	var start, done sync.WaitGroup
	start.Add(1)
	for i, person := range people {
		done.Add(1)
		go func() {
			defer done.Done()
			start.Wait()
			errs[i] = o.service.AnswerTodo(person.ctx, o.repoID, person.user, n, TodoAnswerInput{Wait: wait.ID, Answer: person.text})
		}()
	}
	start.Done()
	done.Wait()
	winner := slices.IndexFunc(errs, func(err error) bool { return err == nil })
	require.GreaterOrEqual(t, winner, 0, "%v", errs)
	settled := mythicalChecksOf(o.byID(uuidString(item.ID))).Waits[0]
	require.Equal(t, people[winner].text, settled.Answer)
	for i, err := range errs {
		if i == winner {
			continue
		}
		var later *TodoAnsweredError
		require.ErrorAs(t, err, &later, "answer %d", i)
		require.Equal(t, settled.AnsweredBy, later.AnsweredBy)
	}
	signals := launcher.sent()
	require.Len(t, signals, 1)
	require.JSONEq(t, `"`+people[winner].text+`"`, string(signals[0].Payload))
	require.Len(t, o.facts(o.byID(uuidString(item.ID)), "todo.answered"), 1)
}

// A TODO merged or dropped while its question was open is not answered:
// 409, and the run receives nothing.
func TestTodoAnswerRefusedOnceSettled(t *testing.T) {
	for _, state := range []string{"landed", "cancelled"} {
		t.Run(state, func(t *testing.T) {
			o, session, launcher, item, launch := newAskingTodo(t)
			o.projectAsking(launch, jobs.StateWaiting, "todo-run-1", humanAsk("WaitFor-token-7", "coding-clarification", "Which?"))
			wait := todoOpenWaits(o.byID(uuidString(item.ID)))[0]
			_, err := o.pool.Exec(context.Background(), `UPDATE mythical_items SET state=$2 WHERE id=$1`, item.ID, state)
			require.NoError(t, err)
			var settled *TodoControlError
			require.ErrorAs(t, o.service.AnswerTodo(session, o.repoID, o.userID, item.Number.Int64, TodoAnswerInput{Wait: wait.ID, Answer: "this"}), &settled)
			require.Equal(t, 409, settled.Status)
			require.Empty(t, launcher.sent())
		})
	}
}

// terminalContext is a stage-1 terminal's delegated credential for userID on
// branch, with the Smithers-Via hint the agent working in it sends.
func terminalContext(userID int64, branch, session, hint string) context.Context {
	scopes := "read:repository,read:user,repo:1," + strings.Join(middleware.DelegationScopes(middleware.Delegation{Via: "terminal", Branch: branch, Profile: middleware.TerminalProfileS1, Session: session}), ",")
	return middleware.ContextWithAuthInfo(context.Background(), &middleware.AuthInfo{User: &db.User{ID: userID}, IsTokenAuth: true, TokenSystemIssued: true,
		RawScopes: scopes, Scopes: middleware.ParseTokenScopes(scopes), ViaHint: hint})
}

// J6 3b and 3d (T-ACC-04, spec §8.11.1): a terminal's credential answers its
// own branch's TODO for its member, and the answer is by "Claude Code for
// Ben" when Claude Code sent it, or "Ben's terminal" when no agent hint
// names one. Another branch's terminal is refused before any write, and so
// is a run credential.
func TestTodoAnswerByATerminalCredential(t *testing.T) {
	for _, tc := range []struct {
		hint string
		by   map[string]any
		ref  map[string]any
	}{
		{"claude-code", map[string]any{"kind": "agent", "id": "agent-session-5e55-session", "agent": "claude-code", "session_id": "5e55-session",
			"for_member": map[string]any{"login": "ben", "name": "Ben Ito"}, "color_index": float64(0)},
			map[string]any{"person": "ben", "via": "claude-code", "session": "5e55-session"}},
		{"browser", map[string]any{"kind": "person", "login": "ben", "name": "Ben Ito", "via": "terminal", "color_index": float64(0)},
			map[string]any{"person": "ben", "via": "terminal", "session": "5e55-session"}},
	} {
		t.Run(tc.hint, func(t *testing.T) {
			o, session, launcher, item, launch := newAskingTodo(t)
			n := item.Number.Int64
			o.projectAsking(launch, jobs.StateWaiting, "todo-run-1", humanAsk("WaitFor-token-8", "coding-clarification", "Which helper?"))
			wait := todoOpenWaits(o.byID(uuidString(item.ID)))[0]
			ben, benSession := o.person("ben")
			_, err := o.pool.Exec(context.Background(), `UPDATE users SET display_name='Ben Ito' WHERE id=$1`, ben)
			require.NoError(t, err)
			branch := "0b1c0000-0000-4000-8000-00000000b1c0"
			_, err = o.pool.Exec(context.Background(), `UPDATE mythical_items SET workspace_id=$2 WHERE id=$1`, item.ID, strings.ToUpper(branch))
			require.NoError(t, err)

			// Refused before any write: another branch's terminal, and a run
			// credential.
			var refused *AccessError
			other := terminalContext(ben, "0b1c0000-0000-4000-8000-0000000other", "5e55-session", tc.hint)
			require.ErrorAs(t, o.service.AnswerTodo(other, o.repoID, ben, n, TodoAnswerInput{Wait: wait.ID, Answer: "the retry helper"}), &refused)
			require.Equal(t, AccessError{Status: 403, Class: "permission", Code: "permission", Message: "A terminal acts only on its own branch's TODO"}, *refused)
			run := middleware.ContextWithAuthInfo(context.Background(), &middleware.AuthInfo{User: &db.User{ID: ben}, IsTokenAuth: true, TokenSystemIssued: true, RawScopes: "read:repository,repo:1"})
			require.Error(t, o.service.AnswerTodo(run, o.repoID, ben, n, TodoAnswerInput{Wait: wait.ID, Answer: "the retry helper"}))
			require.Equal(t, "needs_you", todoState(o.byID(uuidString(item.ID))))
			require.Empty(t, launcher.sent())

			// Its own branch's TODO: answered for Ben, by the terminal or its agent.
			require.NoError(t, o.service.AnswerTodo(terminalContext(ben, branch, "5e55-session", tc.hint), o.repoID, ben, n, TodoAnswerInput{Wait: wait.ID, Answer: "the retry helper"}))
			item = o.byID(uuidString(item.ID))
			require.Equal(t, "working", todoState(item))
			require.Len(t, launcher.sent(), 1)
			answer := o.todoCard(n)["first_answer"].(map[string]any)
			by := answer["by"].(map[string]any)
			require.NotEmpty(t, by["avatar_url"])
			delete(by, "avatar_url")
			if member, ok := by["for_member"].(map[string]any); ok {
				require.NotEmpty(t, member["avatar_url"])
				delete(member, "avatar_url")
			}
			require.Equal(t, tc.by, by)
			require.Equal(t, "the retry helper", answer["text"])
			answered := o.facts(item, "todo.answered")
			require.Len(t, answered, 1)
			require.Equal(t, tc.ref, answered[0]["by"])
			require.Equal(t, "ben", answered[0]["actor"].(map[string]any)["login"])

			// The same answer again from Ben's browser is that answer; anyone
			// else learns that Ben answered.
			require.NoError(t, o.service.AnswerTodo(benSession, o.repoID, ben, n, TodoAnswerInput{Wait: wait.ID, Answer: "the retry helper"}))
			var later *TodoAnsweredError
			require.ErrorAs(t, o.service.AnswerTodo(session, o.repoID, o.userID, n, TodoAnswerInput{Wait: wait.ID, Answer: "a fixed delay"}), &later)
			require.Equal(t, "ben", later.AnsweredBy)
			require.Len(t, launcher.sent(), 1)
		})
	}
}

// A question the run stops reporting, or every question of a run that
// ended, is withdrawn unanswered; it cannot be answered. A re-ask is a new
// question. Another run's report never touches the attempt's questions.
func TestTodoQuestionWithdrawnWhenTheRunStopsAsking(t *testing.T) {
	o, session, launcher, item, launch := newAskingTodo(t)
	n := item.Number.Int64
	first := humanAsk("WaitFor-token-3", "coding-clarification", "Which file?")
	o.projectAsking(launch, jobs.StateWaiting, "todo-run-1", first)
	withdrawn := todoOpenWaits(o.byID(uuidString(item.ID)))[0]

	o.projectAsking(launch, jobs.StateWaiting, "foreign-run")
	require.Equal(t, "needs_you", todoState(o.byID(uuidString(item.ID))), "only the bound run speaks for its questions")

	again := humanAsk("WaitFor-token-4", "coding-clarification", "Which file, exactly?")
	o.projectAsking(launch, jobs.StateWaiting, "todo-run-1", again)
	item = o.byID(uuidString(item.ID))
	open := todoOpenWaits(item)
	require.Len(t, open, 1)
	require.NotEqual(t, withdrawn.ID, open[0].ID)
	require.Equal(t, "Which file, exactly?", open[0].Prompt)
	var gone *TodoControlError
	require.ErrorAs(t, o.service.AnswerTodo(session, o.repoID, o.userID, n, TodoAnswerInput{Wait: withdrawn.ID, Answer: "a.txt"}), &gone)
	require.Equal(t, 409, gone.Status)

	// The run ended while asking: Failed, not Needs you.
	o.projectAsking(launch, jobs.StateFailed, "todo-run-1", again)
	item = o.byID(uuidString(item.ID))
	require.Empty(t, todoOpenWaits(item))
	require.NotEqual(t, "needs_you", todoState(item))
	require.Empty(t, launcher.sent())
	require.NotContains(t, o.todoCard(n), "first_answer", "a withdrawn question has no answer")
}

// Without the dispatcher's signal admission nothing is settled.
func TestTodoAnswerUnavailableWithoutSignals(t *testing.T) {
	o, session, _, item, launch := newAskingTodo(t)
	o.projectAsking(launch, jobs.StateWaiting, "todo-run-1", humanAsk("WaitFor-token-5", "coding-clarification", "Which?"))
	wait := todoOpenWaits(o.byID(uuidString(item.ID)))[0]
	o.service.SetLauncher(o.launcher)
	var unavailable *TodoControlError
	require.ErrorAs(t, o.service.AnswerTodo(session, o.repoID, o.userID, item.Number.Int64, TodoAnswerInput{Wait: wait.ID, Answer: "this"}), &unavailable)
	require.Equal(t, 503, unavailable.Status)
	require.Equal(t, "needs_you", todoState(o.byID(uuidString(item.ID))))
}

// askingHost is a runtime protocol peer whose todo run parks on human waits
// and completes the one a signal names, as Control's deliverSignal does.
type askingHost struct {
	mu      sync.Mutex
	source  string
	waits   []flowruntime.PendingWait
	signals []map[string]any
}

func (h *askingHost) resolver(t *testing.T) flowruntime.FlowRuntimeResolver {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		identity := flowruntime.Identity{Protocol: flowruntime.Protocol, RuntimeArtifactDigest: strings.Repeat("a", 64), SourceRevision: h.source, OwnerGeneration: 1}
		if r.URL.Path == "/health" {
			_ = json.NewEncoder(w).Encode(map[string]any{"runtimeBridge": identity})
			return
		}
		var input map[string]any
		if json.NewDecoder(r.Body).Decode(&input) != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		h.mu.Lock()
		defer h.mu.Unlock()
		var value map[string]any
		if r.URL.Path == "/runtime/v1/observe" {
			status := "running"
			if len(h.waits) > 0 {
				status = "waiting-approval"
			}
			value = map[string]any{"run": flowruntime.Run{RunID: "todo-run", FlowID: "todo", Status: status, PendingWaits: h.waits},
				"events": []any{}, "nextCursor": "", "hasMore": false, "terminal": false}
		} else {
			operation, _ := input["operation"].(string)
			if operation == "signal" {
				signal, _ := input["signal"].(map[string]any)
				h.signals = append(h.signals, signal)
				h.waits = slices.DeleteFunc(h.waits, func(wait flowruntime.PendingWait) bool { return wait.Name == signal["name"] })
			}
			value = map[string]any{"operation": operation, "applicationRequestId": input["applicationRequestId"], "ownerGeneration": 1,
				"runtimeArtifactDigest": identity.RuntimeArtifactDigest, "sourceRevision": identity.SourceRevision,
				"receipt": flowruntime.Receipt{Tag: "Accepted", RunID: "todo-run"}}
			if operation == "launch" {
				value["executionDigest"] = todoPinOne
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"protocol": flowruntime.Protocol, "ok": true, "value": value})
	}))
	t.Cleanup(server.Close)
	bridge, err := runtimebridge.New(runtimebridge.Config{Endpoint: server.URL, Credential: "fixture-token"})
	require.NoError(t, err)
	return flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) { return bridge, nil })
}

func (h *askingHost) ask(wait flowruntime.PendingWait) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.waits = append(h.waits, wait)
}

func (h *askingHost) delivered() []map[string]any {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]map[string]any(nil), h.signals...)
}

// The whole loop through the real dispatcher, HTTP runtime bridge and
// PostgreSQL: the run parks on a question, the TODO shows Needs you, the
// answer's durable signal reaches the same run with the answer as its
// payload, the run stops waiting and the TODO is Working again.
func TestTodoAnswerResumesTheRunThatAsked(t *testing.T) {
	o, session := newTodoAdmission(t)
	peer := &askingHost{source: o.landedMain()}
	pool, startWorker := o.runDispatcher(t, peer.resolver(t))
	o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
	item := o.fileTodo(session, "resume")
	id := uuidString(item.ID)
	o.wake()
	startWorker()
	require.Eventually(t, func() bool { return todoState(o.byID(id)) == "working" }, 10*time.Second, 10*time.Millisecond)
	require.Equal(t, "todo-run", o.byID(id).RequestRunID)

	peer.ask(humanAsk("WaitFor-token-6", "coding-clarification", "Backoff or a fixed delay?"))
	require.Eventually(t, func() bool { return todoState(o.byID(id)) == "needs_you" }, 10*time.Second, 10*time.Millisecond)
	wait := todoOpenWaits(o.byID(id))[0]
	require.Empty(t, peer.delivered())

	require.NoError(t, o.service.AnswerTodo(session, o.repoID, o.userID, item.Number.Int64, TodoAnswerInput{Wait: wait.ID, Answer: "Use backoff"}))
	var admitted int
	require.NoError(t, pool.QueryRow(context.Background(), `SELECT count(*) FROM product_job_requests WHERE operation=$1 AND request_id=$2`,
		flowdispatch.OperationSignal, "todo-answer:"+id+":"+wait.ID).Scan(&admitted))
	require.Equal(t, 1, admitted, "the signal was admitted with the answer")
	require.Eventually(t, func() bool { return len(peer.delivered()) == 1 }, 10*time.Second, 10*time.Millisecond)
	require.Equal(t, map[string]any{"name": "coding-clarification", "payload": "Use backoff"}, peer.delivered()[0])
	require.Eventually(t, func() bool {
		item := o.byID(id)
		return todoState(item) == "working" && item.RequestRunID == "todo-run"
	}, 10*time.Second, 10*time.Millisecond)
	// Later observations of the resumed run leave the answered question settled.
	time.Sleep(50 * time.Millisecond)
	settled := mythicalChecksOf(o.byID(id)).Waits
	require.Len(t, settled, 1)
	require.Equal(t, "Use backoff", settled[0].Answer)
	require.NotNil(t, settled[0].SettledAt)
	require.Len(t, peer.delivered(), 1)
}

// failTodo stops the TODO's attempt as every plan failing does: a typed stop
// only a person lifts with Retry.
func (o *mythicalOrchestration) failTodo(id string) {
	o.t.Helper()
	failed := o.byID(id)
	checks := mythicalChecksOf(failed)
	checks.Fault = &mythicalFault{Class: "factory", Tag: "very_hard", Kind: mythicalFailPlan}
	failed.State, failed.Reason, failed.Checks = "blocked", mythicalVeryHard+"the lane's request ended blocked", checks.encode()
	_, err := o.service.queries().SaveMythicalItem(context.Background(), failed)
	require.NoError(o.t, err)
	require.Equal(o.t, "failed", todoState(o.byID(id)))
}

// J1 6 / J2 4 (the 2026-10-05 real walk): attempt 1 asks where the code
// goes and the owner answers, then the attempt fails. Retry starts attempt 2
// with that question and answer, and who gave it, next to the steer; a
// question its run withdrew unanswered carries nothing. Attempt 3 carries
// every answer so far, in the order asked.
func TestTodoAnswersReachEveryLaterAttempt(t *testing.T) {
	o, session, _, item, launch := newAskingTodo(t)
	ctx := context.Background()
	n, id := item.Number.Int64, uuidString(item.ID)
	var ownerLogin string
	require.NoError(t, o.pool.QueryRow(ctx, `SELECT username FROM users WHERE id=$1`, o.userID).Scan(&ownerLogin))
	require.NotContains(t, decodeJSON(t, launch.Payload), "answers", "attempt 1 has nothing to carry")

	where := "Put greet.mjs in the repository root or in src/?"
	o.projectAsking(launch, jobs.StateWaiting, "todo-run-1", humanAsk("WaitFor-token-1", "coding-clarification", where))
	asked := todoOpenWaits(o.byID(id))
	require.Len(t, asked, 1)
	require.NoError(t, o.service.AnswerTodo(session, o.repoID, o.userID, n, TodoAnswerInput{Wait: asked[0].ID, Answer: "Put it in the repository root."}))
	// A second question the run withdraws unanswered.
	o.projectAsking(launch, jobs.StateWaiting, "todo-run-1", humanAsk("WaitFor-token-2", "coding-clarification", "Which test runner?"))
	o.projectAsking(launch, jobs.StateWaiting, "todo-run-1")
	require.Len(t, mythicalChecksOf(o.byID(id)).Waits, 2)
	o.failTodo(id)

	steer := "keep the existing adds test"
	receipt, err := o.service.ControlTodo(session, n, TodoControlInput{Op: "retry", Steer: &steer, Repository: o.repoID, Actor: o.userID, Request: "retry-1"})
	require.NoError(t, err)
	require.EqualValues(t, 2, receipt.Attempt)
	o.wake()
	o.wake()
	launches := o.launcher.byFlow("todo")
	require.Len(t, launches, 2)
	second := decodeJSON(t, launches[1].Payload)
	require.Equal(t, steer, second["feedback"])
	require.Equal(t, []any{map[string]any{"question": where, "answer": "Put it in the repository root.", "by": ownerLogin}}, second["answers"])

	// Attempt 2 asks again; another member answers; the attempt fails and a
	// Retry without a steer carries both answers, in the order asked.
	o.projectAsking(launches[1], jobs.StateWaiting, "todo-run-2")
	name := "Export it as greet or as hello?"
	o.projectAsking(launches[1], jobs.StateWaiting, "todo-run-2", humanAsk("WaitFor-token-3", "coding-clarification", name))
	asked = todoOpenWaits(o.byID(id))
	require.Len(t, asked, 1)
	alice, aliceSession := o.person("alice")
	require.NoError(t, o.service.AnswerTodo(aliceSession, o.repoID, alice, n, TodoAnswerInput{Wait: asked[0].ID, Answer: "greet"}))
	o.failTodo(id)
	_, err = o.service.ControlTodo(session, n, TodoControlInput{Op: "retry", Repository: o.repoID, Actor: o.userID, Request: "retry-2"})
	require.NoError(t, err)
	o.wake()
	o.wake()
	launches = o.launcher.byFlow("todo")
	require.Len(t, launches, 3)
	third := decodeJSON(t, launches[2].Payload)
	require.Equal(t, steer, third["feedback"], "the steer stays with every later attempt")
	require.Equal(t, []any{
		map[string]any{"question": where, "answer": "Put it in the repository root.", "by": ownerLogin},
		map[string]any{"question": name, "answer": "greet", "by": "alice"},
	}, third["answers"])
}

// The carried answers keep the latest within their bounds: at most
// todoCarriedAnswers, whole entries within todoCarriedBytes, each field
// clipped on a rune boundary; unanswered and withdrawn questions and other
// waits carry nothing.
func TestTodoAnswersKeepTheLatestWithinTheirBounds(t *testing.T) {
	at := time.Now()
	answered := func(prompt, answer, by string) TodoWait {
		return TodoWait{Kind: "question", Prompt: prompt, Answer: answer, AnsweredBy: by, SettledAt: &at}
	}
	item := func(waits ...TodoWait) db.MythicalItem {
		return db.MythicalItem{Checks: mythicalChecks{Waits: waits}.encode()}
	}
	require.Empty(t, todoAnswers(db.MythicalItem{}))
	require.Equal(t, []todoCarriedAnswer{{Question: "root or src?", Answer: "root", By: "ben"}}, todoAnswers(item(
		TodoWait{Kind: "question", Prompt: "still open?"},
		TodoWait{Kind: "question", Prompt: "withdrawn?", SettledAt: &at},
		TodoWait{Kind: "conflict", Prompt: "conflict", Answer: "x", AnsweredBy: "ben", SettledAt: &at},
		answered("root or src?", "root", "ben"),
		answered("blank?", "  ", "ben"),
	)))

	var many []TodoWait
	for i := range todoCarriedAnswers + 3 {
		many = append(many, answered("q"+strconv.Itoa(i), "a"+strconv.Itoa(i), "ben"))
	}
	kept := todoAnswers(item(many...))
	require.Len(t, kept, todoCarriedAnswers)
	require.Equal(t, "q3", kept[0].Question, "the oldest are dropped")
	require.Equal(t, "q"+strconv.Itoa(todoCarriedAnswers+2), kept[len(kept)-1].Question)

	// The middle answer clips to its bound; with the latest it fills the
	// byte bound exactly, so the oldest no longer fits whole.
	clipped := answered(strings.Repeat("ü", todoCarriedQuestionBytes), strings.Repeat("é", todoCarriedAnswerBytes), strings.Repeat("b", 300))
	last := answered("last?", strings.Repeat("x", todoCarriedBytes-todoCarriedQuestionBytes-todoCarriedAnswerBytes-len("last?")), "ben")
	big := todoAnswers(item(answered("first?", "a", "ben"), clipped, last))
	require.Len(t, big, 2)
	require.Equal(t, todoCarriedQuestionBytes, len(big[0].Question))
	require.Equal(t, todoCarriedAnswerBytes, len(big[0].Answer), "é and ü are two bytes: the clip keeps every whole one")
	require.Equal(t, todoCarriedByBytes, len(big[0].By))
	require.True(t, utf8.ValidString(big[0].Question) && utf8.ValidString(big[0].Answer))
	require.Equal(t, "last?", big[1].Question)
	require.Equal(t, todoCarriedBytes, len(big[0].Question)+len(big[0].Answer)+len(big[1].Question)+len(big[1].Answer))
	require.Equal(t, "ab", todoClip("ab\u00e9", 3), "a rune is never split")
}
