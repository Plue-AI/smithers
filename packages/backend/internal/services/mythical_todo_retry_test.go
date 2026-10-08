package services

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

type retryCapturedLanes struct {
	*fakeMythicalLanes
	head    string
	err     error
	queries *db.Queries
}

func (l retryCapturedLanes) CapturedHead(ctx context.Context, id string, _, _ int64) (string, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.deleted) == 0 || l.deleted[len(l.deleted)-1] != id {
		return "", errors.New("capture read before confirmed retirement")
	}
	if l.queries != nil {
		lane, err := l.queries.GetMythicalLane(ctx, id)
		if err != nil || lane.RetiredAt.Valid {
			return "", errors.New("capture read after its binding retired")
		}
	}
	return l.head, l.err
}

func TestTodoRetryCarriesTheStoppedCapture(t *testing.T) {
	for _, scenario := range []string{"clean", "retired", "released", "review", "verify", "native", "native wrong parent", "unavailable", "invalid", "missing ref", "missing base"} {
		t.Run(scenario, func(t *testing.T) {
			o, session := newTodoAdmission(t)
			o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
			item := o.fileTodo(session, "Retry captured work")
			o.wake()
			o.projectTodo(o.launcher.byFlow("todo")[0], jobs.StateWaiting, "old-root", todoPinOne, "")
			item = o.byID(uuidString(item.ID))
			branch := item.WorkspaceID
			_, err := o.pool.Exec(t.Context(), `INSERT INTO workspaces(id,repository_id,user_id,status) VALUES($1,$2,$3,'stopped')`, branch, o.repoID, o.userID)
			require.NoError(t, err)
			prefix := o.landedMain()
			head := o.commit("Captured member work", "MEMBER.md", "Keep these captured bytes\n")
			if scenario != "missing ref" {
				o.git(o.work, "push", "-q", o.hostDir, "HEAD:refs/smithers/branches/"+item.WorkspaceID+"/head")
			}
			reader := retryCapturedLanes{fakeMythicalLanes: o.lanes, head: head, queries: o.service.queries()}
			if scenario == "unavailable" {
				reader.err = errors.New("capture unavailable")
			}
			if scenario == "invalid" {
				reader.head = "not-a-commit"
			}
			o.service.lanes = reader
			checks := mythicalChecksOf(item)
			checks.Fault = &mythicalFault{Class: "policy", Tag: "launch_bound", Kind: mythicalFailStopped}
			if scenario == "native" || scenario == "native wrong parent" {
				checks.Rebase = &mythicalRebase{Onto: prefix, Native: &machined.RewriteResult{Head: head, Inspected: true}}
				item.CandidateBase = strings.Repeat("a", 40)
				if scenario == "native wrong parent" {
					checks.Rebase.Onto = strings.Repeat("f", 40)
				}
			} else {
				item.CandidateBase = prefix
			}
			if scenario == "missing base" {
				item.CandidateBase, item.BaseCommit, checks.InitialPrefix = "", "invalid", ""
			}
			item.State, item.Checks = "blocked", checks.encode()
			if scenario == "retired" || scenario == "released" {
				require.NoError(t, o.service.queries().RetireMythicalLane(t.Context(), branch))
			}
			if scenario == "released" {
				item.WorkspaceID = ""
			}
			if scenario == "review" || scenario == "verify" {
				q := o.service.queries()
				isolated, err := q.CreateWorkspace(t.Context(), db.CreateWorkspaceParams{RepositoryID: o.repoID, UserID: o.userID, Name: scenario, Kind: "vm", Status: "stopped"})
				require.NoError(t, err)
				_, _, err = q.BindMythicalLane(t.Context(), db.MythicalLane{WorkspaceID: isolated.ID, RepositoryID: o.repoID, ItemID: item.ID, Name: "TODO 1 " + scenario + " g2"})
				require.NoError(t, err)
				require.NoError(t, q.RetireMythicalLane(t.Context(), branch))
				item.WorkspaceID = isolated.ID
				if scenario == "review" {
					checks.Review = &mythicalReview{Lane: isolated.ID}
					item.Checks = checks.encode()
				}
			}
			_, err = o.service.queries().SaveMythicalItem(context.Background(), item)
			require.NoError(t, err)
			_, err = o.service.ControlTodo(session, item.Number.Int64, TodoControlInput{Op: "retry", Repository: o.repoID, Actor: o.userID, Request: "retry-capture"})
			require.NoError(t, err)
			o.wake()
			o.wake()
			next := o.byID(uuidString(item.ID))
			if scenario != "clean" && scenario != "native" && scenario != "retired" && scenario != "released" && scenario != "review" && scenario != "verify" {
				require.EqualValues(t, 1, next.Attempt, "unknown source never admits a successor")
				require.Len(t, o.launcher.byFlow("todo"), 1)
				if scenario != "missing ref" {
					return
				}
				bound, err := o.service.queries().GetMythicalLane(context.Background(), item.WorkspaceID)
				require.NoError(t, err)
				require.False(t, bound.RetiredAt.Valid, "retain source authority until successor admission")
				o.git(o.work, "push", "-q", o.hostDir, "HEAD:refs/smithers/branches/"+item.WorkspaceID+"/head")
				o.wake()
				o.wake()
				next = o.byID(uuidString(item.ID))
			}
			require.EqualValues(t, 2, next.Attempt)
			require.Equal(t, head, next.BaseCommit, "Retry uses the final captured bytes")
			require.Equal(t, prefix, mythicalChecksOf(next).InitialPrefix, "retain the captured delta's actual base")
			require.Equal(t, todoPinOne, next.FlowDigest.String)
			bound, err := o.service.queries().GetMythicalLane(context.Background(), branch)
			require.NoError(t, err)
			require.True(t, bound.RetiredAt.Valid, "retire only after successor admission")
		})
	}
}

func TestTodoRetryCannotRestoreAChangedOrForeignBinding(t *testing.T) {
	for _, scenario := range []string{"changed item", "foreign item", "deleted branch"} {
		t.Run(scenario, func(t *testing.T) {
			o, session := newTodoAdmission(t)
			o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
			item := o.fileTodo(session, "Retry binding")
			o.wake()
			item = o.byID(uuidString(item.ID))
			q := o.service.queries()
			_, err := o.pool.Exec(t.Context(), `INSERT INTO workspaces(id,repository_id,user_id,status) VALUES($1,$2,$3,'stopped')`, item.WorkspaceID, o.repoID, o.userID)
			require.NoError(t, err)
			require.NoError(t, q.RetireMythicalLane(t.Context(), item.WorkspaceID))
			switch scenario {
			case "changed item":
				_, err = q.SaveMythicalItem(t.Context(), item)
			case "foreign item":
				other := o.fileTodo(session, "Other binding")
				_, err = o.pool.Exec(t.Context(), `UPDATE mythical_lanes SET item_id=$2 WHERE workspace_id=$1`, item.WorkspaceID, other.ID)
			case "deleted branch":
				_, err = o.pool.Exec(t.Context(), `UPDATE workspaces SET deleted_at=now() WHERE id=$1`, item.WorkspaceID)
			}
			require.NoError(t, err)
			step := mythicalItemStep{s: o.service}
			_, err = step.restoreRetryBranch(t.Context(), item)
			require.Error(t, err)
			lane, err := q.GetMythicalLane(t.Context(), item.WorkspaceID)
			require.NoError(t, err)
			require.True(t, lane.RetiredAt.Valid, "refusal cannot restore execution authority")
			require.Len(t, o.launcher.byFlow("todo"), 1)
		})
	}
}

func TestTodoRetryBeforeFirstAdmissionNeedsNoCapture(t *testing.T) {
	o, session := newTodoAdmission(t)
	o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
	item := o.fileTodo(session, "Retry admission")
	item.State = "blocked"
	_, err := o.service.queries().SaveMythicalItem(t.Context(), item)
	require.NoError(t, err)
	o.service.lanes = retryCapturedLanes{fakeMythicalLanes: o.lanes, err: errors.New("no admitted machine exists")}
	_, err = o.service.ControlTodo(session, item.Number.Int64, TodoControlInput{Op: "retry", Repository: o.repoID, Actor: o.userID, Request: "retry-before-admission"})
	require.NoError(t, err)
	o.wake()
	next := o.byID(uuidString(item.ID))
	require.EqualValues(t, 1, next.Attempt)
	require.Len(t, o.launcher.byFlow("todo"), 1)
}

func TestTodoRetryAdmitsBeforeOldNativeContinuation(t *testing.T) {
	o, session := newTodoAdmission(t)
	o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
	item := o.fileTodo(session, "Retry the stopped native continuation")
	o.wake()
	launches := o.launcher.byFlow("todo")
	require.Len(t, launches, 1)
	o.projectTodo(launches[0], jobs.StateWaiting, "stopped-root", todoPinOne, "")
	item = o.byID(uuidString(item.ID))
	checks := mythicalChecksOf(item)
	checks.Launches = 12
	checks.Fault = &mythicalFault{Class: "policy", Tag: "launch_bound", Kind: mythicalFailStopped}
	checks.Rebase = &mythicalRebase{Onto: strings.Repeat("a", 40), Native: &machined.RewriteResult{Head: strings.Repeat("c", 40), Inspected: true}}
	item.State, item.Checks = "blocked", checks.encode()
	_, err := o.service.queries().SaveMythicalItem(context.Background(), item)
	require.NoError(t, err)
	receipt, err := o.service.ControlTodo(session, item.Number.Int64, TodoControlInput{Op: "retry", Repository: o.repoID, Actor: o.userID, Request: "retry-native-stop"})
	require.NoError(t, err)
	require.EqualValues(t, 2, receipt.Attempt)
	o.wake()
	o.wake()
	next := o.byID(uuidString(item.ID))
	require.EqualValues(t, 2, next.Attempt, "Retry starts a successor, not old native verification")
	require.Len(t, o.launcher.byFlow("todo"), 2)
	require.Nil(t, mythicalChecksOf(next).Rebase, "old native continuation is not revived")
	require.Equal(t, todoPinOne, next.FlowDigest.String)
}

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
	var denied *AccessError
	require.ErrorAs(t, err, &denied)
	require.Equal(t, http.StatusForbidden, denied.Status, "a run's credential never lifts a typed stop")
	require.Equal(t, "permission", denied.Class)
	require.Equal(t, "permission", denied.Code)
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
	var refusal *TodoControlError
	require.ErrorAs(t, err, &refusal)
	require.Equal(t, &TodoControlError{http.StatusConflict, "todo_transition_refused", "conflict", "TODO has not failed"}, refusal)

	// The stack takes the launch: attempt 2 of the same pin, the steer its
	// first input, revision 1 its prompt.
	o.wake()
	o.wake()
	launches = o.launcher.byFlow("todo")
	require.Len(t, launches, 2, "one press, one attempt")
	second := launches[1]
	admitted := mythicalChecksOf(o.byID(id)).Attempts
	require.Len(t, admitted, 2, "retry admission records both attempts before attachment")
	require.Equal(t, int32(1), admitted[0].Attempt)
	require.Equal(t, "todo-run-1", admitted[0].RunID)
	require.Equal(t, int32(2), admitted[1].Attempt)
	require.Empty(t, admitted[1].RunID, "attempt 2 never borrows attempt 1's run")
	require.Equal(t, todoPinOne, admitted[1].FlowDigest)
	require.Equal(t, "mythical:"+id+":2:todo:2", second.RequestID)
	payload := decodeJSON(t, second.Payload)
	require.Equal(t, steer, payload["feedback"])
	require.Equal(t, decodeJSON(t, launches[0].Payload)["prompt"], payload["prompt"])
	require.NotContains(t, decodeJSON(t, launches[0].Payload), "feedback", "attempt 1 had no steer")
	o.projectTodo(second, jobs.StateWaiting, "todo-run-2", todoPinOne, "")
	attached := mythicalChecksOf(o.byID(id)).Attempts
	require.Len(t, attached, 2)
	require.Equal(t, admitted[0], attached[0])
	require.Equal(t, "todo-run-2", attached[1].RunID)

	card = o.todoCard(n)
	require.Equal(t, "working", card["state"])
	require.Equal(t, map[string]any{"id": "todo-run-2", "attempt": float64(2), "executing": true, "indicators": []any{}}, card["run"])
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

func TestTodoRetryCurrentFlowPinsAtAcceptance(t *testing.T) {
	o, session := newTodoAdmission(t)
	ctx := context.Background()
	o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
	item := o.fileTodo(session, "current retry")
	id := uuidString(item.ID)
	o.wake()
	launches := o.launcher.byFlow("todo")
	require.Len(t, launches, 1)
	o.projectTodo(launches[0], jobs.StateWaiting, "old-run", todoPinOne, "")
	failed := o.byID(id)
	failed.State, failed.Reason = "blocked", "fixture failure"
	failed, err := o.service.queries().SaveMythicalItem(ctx, failed)
	require.NoError(t, err)
	earlier := currentTodoEvidence(failed)
	active := strings.Repeat("c", 64)
	o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return active, nil })
	receipt, err := o.service.ControlTodo(session, item.Number.Int64, TodoControlInput{Op: "retry-current-flow", Repository: o.repoID, Actor: o.userID, Request: "current-retry"})
	require.NoError(t, err)
	require.EqualValues(t, 2, receipt.Attempt)
	queued := o.byID(id)
	require.Equal(t, todoPinOne, queued.FlowDigest.String)
	require.Equal(t, "old-run", queued.RequestRunID)
	require.Equal(t, earlier, mythicalChecksOf(queued).Attempts[0])
	// Another activation before admission cannot change the accepted retry.
	o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
	o.wake()
	o.wake()
	launches = o.launcher.byFlow("todo")
	require.Len(t, launches, 2)
	require.Equal(t, active, launches[1].Pin.ExecutionDigest)
	require.EqualValues(t, 2, o.byID(id).Attempt)
	require.Equal(t, earlier, mythicalChecksOf(o.byID(id)).Attempts[0])
}

func TestTodoFirstInputRetainsAttribution(t *testing.T) {
	item := db.MythicalItem{Checks: (mythicalChecks{Steers: []todoSteer{
		{ID: "first", Text: "Use the retry helper", Attempt: 1, Attribution: map[string]string{"person": "ben", "via": "claude-code"}},
		{ID: "second", Text: "Cap retries at five", Attempt: 1, Attribution: map[string]string{"person": "will"}},
	}}).encode()}
	require.Equal(t, "[TODO input first by {\"person\":\"ben\",\"via\":\"claude-code\"}]\nUse the retry helper\n\n[TODO input second by {\"person\":\"will\"}]\nCap retries at five", todoFeedback(item, 1))
}
