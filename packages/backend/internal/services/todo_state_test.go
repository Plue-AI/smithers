package services

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// This table is transcribed from .specs/engineering/spec.md draft v0.4,
// committed at 2be05ba6 (spec blob last changed by 3a2217f5aa5e69f181ccf343e08e91355fac539a),
// §4.1 lines 213–235, §10.7.3 line 974, §10.6.4 line 964 and §12.3 lines
// 1124–1128. C-STK-01 lines 15–23 enumerate the trigger spellings. It is
// independent of todoTransitionTarget and todoItemPath.
//
// Binding scope for #3433 (Will, 2026-10-02): keep the single needs_you
// overlay and run_started at the first step; starting steers are held.
// Explicitly deferred newer spec portions: run_attached (§4.1 line 216),
// independent waits and fact-based guards (§4.1 lines 220, 236–237;
// §4.1.0a lines 257–268; C-STK-01 lines 17–19), S2 machine-released review
// re-admission (§4.1 line 227), and accepted-generation/reopen execution
// (§4.1 lines 225, 228, 235; §10.7.4 line 976) beyond identity restoration.
// They require their owning control/runtime tickets; this test does not
// claim those contracts. Terminal projection remains §4.1.0 lines 243–255.
// Guards that select multiple targets (answer) are tested separately below.
// Common rows: drop/pr_closed (§4.1 line 234); merged_via (§10.6.4 line 964);
// steer self-loops (§10.7.3 line 974, C-STK-01 line 21, starting-held ruling);
// evidence/rebase self-loops from working, needs_you and paused (§12.3 line
// 1126 and §4.1 line 233: PR stays ready while steered; binding QA ruling).
var specTodoTransitions = map[TodoState]map[TodoTrigger]TodoState{
	// §4.1 diagram line 196; C-STK-01 line 15: draft→queued (place).
	TodoDraft: {TodoPlace: TodoQueued},
	TodoQueued: {
		TodoStartFailed: TodoFailed,                             // §4.1.0a rank 5 + §3.2: provisioning failed before any grant (spec edge gap recorded in report)
		TodoWaitOpened:  TodoNeedsYou,                           // §4.1: branch waits open from any unmerged state
		TodoAdmit:       TodoStarting,                           // §4.1 line 215: admission grants the machine
		TodoSteer:       TodoQueued,                             // §10.7.3: a steer to a queued TODO is held
		TodoPRMerged:    TodoMerged,                             // §4.1 line 233
		TodoMergedVia:   TodoMerged,                             // §10.6.4: a later squash commit contains it
		TodoDrop:        TodoDropped, TodoPRClosed: TodoDropped, // any unmerged → dropped
	},
	TodoStarting: {
		TodoWaitOpened:  TodoNeedsYou, // §4.1: branch waits open from any unmerged state
		TodoRunStarted:  TodoWorking,  // §4.1 line 216, first-step protocol retained by ruling
		TodoStartFailed: TodoFailed,   // §4.1 line 217: failure.step = "start"
		TodoSteer:       TodoStarting,
		TodoPRMerged:    TodoMerged, // §4.1 line 233
		TodoMergedVia:   TodoMerged,
		TodoDrop:        TodoDropped, TodoPRClosed: TodoDropped,
	},
	TodoWorking: {
		TodoWaitOpened: TodoNeedsYou,                             // §4.1 line 218, single-overlay sources retained
		TodoStop:       TodoPaused,                               // §4.1 line 220
		TodoRunFailed:  TodoFailed, TodoRunUncertain: TodoFailed, // §4.1 line 222
		TodoPROpened:  TodoInReview, // §4.1 line 225
		TodoSteer:     TodoWorking,  // §10.7.3: delivered
		TodoPRMerged:  TodoMerged,   // §4.1 line 233: every unmerged state
		TodoMergedVia: TodoMerged,
		TodoDrop:      TodoDropped, TodoPRClosed: TodoDropped,
		TodoChecksUpdated: TodoWorking, TodoRebased: TodoWorking, // §12.3 line 1126
	},
	TodoNeedsYou: {
		TodoWaitOpened: TodoNeedsYou, // §4.1: branch waits open from any unmerged state
		TodoAnswer:     TodoWorking,  // §4.1 lines 219, 231; alternatives lines 230, 232 below
		TodoSteer:      TodoNeedsYou, // §10.7.3: a steer never settles an open question
		TodoPRMerged:   TodoMerged,
		TodoMergedVia:  TodoMerged,
		TodoDrop:       TodoDropped, TodoPRClosed: TodoDropped,
		TodoChecksUpdated: TodoNeedsYou, TodoRebased: TodoNeedsYou, // §12.3 line 1126
	},
	TodoPaused: {
		TodoWaitOpened: TodoNeedsYou, // §4.1: branch waits open from any unmerged state
		TodoResume:     TodoQueued,   // §4.1 line 221
		TodoSteer:      TodoPaused,   // §10.7.3: delivered on resume
		TodoPRMerged:   TodoMerged,
		TodoMergedVia:  TodoMerged,
		TodoDrop:       TodoDropped, TodoPRClosed: TodoDropped,
		TodoChecksUpdated: TodoPaused, TodoRebased: TodoPaused, // §12.3 line 1126
	},
	TodoFailed: {
		TodoWaitOpened: TodoNeedsYou,                                 // §4.1: branch waits open from any unmerged state
		TodoRetry:      TodoQueued, TodoRetryCurrentFlow: TodoQueued, // §4.1 lines 223–224
		TodoPRMerged:  TodoMerged, // §4.1 line 233
		TodoMergedVia: TodoMerged,
		TodoDrop:      TodoDropped, TodoPRClosed: TodoDropped,
	},
	TodoInReview: {
		TodoWaitOpened:       TodoNeedsYou,                                                        // §4.1 line 229
		TodoChangesRequested: TodoWorking, TodoReviewComment: TodoWorking, TodoSteer: TodoWorking, // §4.1 line 226, §12.3 line 1124: members
		TodoChecksUpdated: TodoInReview, TodoRebased: TodoInReview, // §4.1 line 228; §12.3 line 1126
		TodoPRMerged:  TodoMerged, // §4.1 line 233
		TodoMergedVia: TodoMerged,
		TodoDrop:      TodoDropped, TodoPRClosed: TodoDropped,
	},
	TodoMerged:  {TodoLearningDone: TodoMerged}, // §4.1.3 line 276
	TodoDropped: {TodoPRReopened: TodoInReview}, // §4.1 line 235; §12.3 line 1128
}

var todoTestNow = time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)

// satisfiedGuard meets every guard of §4.1 at once: a member acting, a
// granted machine, a start failure, a conflict wait (allowed from working and
// in review), a verified PR head merged on main, and a PR reopened a day
// after its drop with its head captured.
func satisfiedGuard() TodoGuard {
	return TodoGuard{
		Actor: TodoPerson(7, ""), Cause: "test", Now: todoTestNow,
		MachineGranted: true,
		Failure:        &TodoFailure{Step: "start", Class: "infra", Message: "the machine did not start", Retryable: true},
		WaitKind:       TodoWaitConflict, OpenWaitKind: TodoWaitConflict,
		PRHeadVerified: true, HasPR: true, OnMain: true,
		DroppedAt: todoTestNow.Add(-24 * time.Hour), HeadCaptured: true,
	}
}

func TestTodoTransitionAllowsExactlyTheSpecTable(t *testing.T) {
	sources := append([]TodoState{TodoDraft}, TodoStates...)
	allowed, refused := 0, 0
	expected := 0
	for _, row := range specTodoTransitions {
		expected += len(row)
	}
	for _, from := range sources {
		for _, trigger := range TodoTriggers {
			guard := satisfiedGuard()
			event, err := Transition(from, trigger, guard)
			want, ok := specTodoTransitions[from][trigger]
			if !ok {
				refused++
				var refusal *TodoTransitionRefused
				require.True(t, errors.As(err, &refusal), "%s from %s must be refused, got %+v", trigger, from, event)
				require.Equal(t, from, refusal.From)
				require.Equal(t, trigger, refusal.Trigger)
				require.Contains(t, err.Error(), "todo_transition_refused")
				require.Equal(t, TodoEvent{}, event, "a refused transition returns no event")
				continue
			}
			allowed++
			require.NoError(t, err, "%s from %s", trigger, from)
			require.Equal(t, trigger, event.Kind)
			require.Equal(t, from, event.From)
			require.Equal(t, want, event.To, "%s from %s", trigger, from)
			require.Equal(t, guard.Actor, event.Actor)
			require.Equal(t, "test", event.Cause)
			require.Equal(t, from == TodoInReview && want == TodoWorking, event.VoidApprovals, "%s from %s voids approvals", trigger, from)
			require.Equal(t, from != want && (want == TodoMerged || want == TodoDropped), event.EndsWork, "%s from %s ends the work", trigger, from)
			require.Equal(t, trigger == TodoSteer && (from == TodoQueued || from == TodoStarting || from == TodoPaused), event.SteerHeld,
				"%s from %s holds the steer", trigger, from)
		}
	}
	fmt.Printf("C-STK-01: %d allowed and %d refused of %d (state, trigger) pairs; the spec table lists %d\n",
		allowed, refused, len(sources)*len(TodoTriggers), expected)
	require.Equal(t, expected, allowed)
	require.Equal(t, len(sources)*len(TodoTriggers)-expected, refused)
}

func TestTodoTransitionRefusesShortcuts(t *testing.T) {
	// C-STK-01 "Fail when": none of these may ever be allowed.
	for _, c := range []struct {
		from    TodoState
		trigger TodoTrigger
	}{
		{TodoPaused, TodoRunStarted}, {TodoPaused, TodoAnswer}, {TodoQueued, TodoPROpened}, {TodoFailed, TodoRunStarted},
		{TodoFailed, TodoAdmit}, {TodoMerged, TodoSteer}, {TodoMerged, TodoChangesRequested}, {TodoDropped, TodoRetry},
		{TodoDropped, TodoPlace}, {TodoDropped, TodoResume}, {TodoMerged, TodoDrop}, {TodoDropped, TodoDrop},
		{TodoQueued, TodoRunStarted}, {TodoStarting, TodoStop}, {TodoNeedsYou, TodoStop},
		{TodoMerged, TodoMergedVia}, {TodoDropped, TodoMergedVia},
		{TodoDropped, TodoSteer}, {TodoFailed, TodoSteer}, {TodoMerged, TodoAnswer},
	} {
		_, err := Transition(c.from, c.trigger, satisfiedGuard())
		var refusal *TodoTransitionRefused
		require.True(t, errors.As(err, &refusal), "%s from %s", c.trigger, c.from)
	}
}

func TestTodoTransitionGuards(t *testing.T) {
	agent := TodoActor{Agent: "coding", Run: "run-1", Todo: 3}
	refused := []struct {
		name    string
		from    TodoState
		trigger TodoTrigger
		guard   func(*TodoGuard)
	}{
		{"admit without a machine", TodoQueued, TodoAdmit, func(g *TodoGuard) { g.MachineGranted = false }},
		{"start failure without a failure", TodoStarting, TodoStartFailed, func(g *TodoGuard) { g.Failure = nil }},
		{"start failure at another step", TodoStarting, TodoStartFailed, func(g *TodoGuard) { g.Failure = &TodoFailure{Step: "implement"} }},
		{"run failure without a failure", TodoWorking, TodoRunFailed, func(g *TodoGuard) { g.Failure = nil }},
		{"uncertain run without a failure", TodoWorking, TodoRunUncertain, func(g *TodoGuard) { g.Failure = nil }},
		{"in review waits on a question", TodoInReview, TodoWaitOpened, func(g *TodoGuard) { g.WaitKind = TodoWaitQuestion }},
		{"working waits on a stack-level kind", TodoWorking, TodoWaitOpened, func(g *TodoGuard) { g.WaitKind = "order" }},
		{"in review waits on a stack-level kind", TodoInReview, TodoWaitOpened, func(g *TodoGuard) { g.WaitKind = "force_push" }},
		{"wait with no kind", TodoWorking, TodoWaitOpened, func(g *TodoGuard) { g.WaitKind = "" }},
		{"agent answers a question", TodoNeedsYou, TodoAnswer, func(g *TodoGuard) { g.Actor, g.OpenWaitKind = agent, TodoWaitQuestion }},
		{"agent answers an approval", TodoNeedsYou, TodoAnswer, func(g *TodoGuard) { g.Actor, g.OpenWaitKind = agent, TodoWaitApproval }},
		{"system answers", TodoNeedsYou, TodoAnswer, func(g *TodoGuard) { g.Actor = todoStackActor }},
		{"answer back to review without a verified head", TodoNeedsYou, TodoAnswer, func(g *TodoGuard) { g.NoNewWork, g.PRHeadVerified = true, false }},
		{"PR opened for an unverified head", TodoWorking, TodoPROpened, func(g *TodoGuard) { g.PRHeadVerified = false }},
		{"review comment from the agent", TodoInReview, TodoReviewComment, func(g *TodoGuard) { g.Actor = agent }},
		{"merge not on main", TodoInReview, TodoPRMerged, func(g *TodoGuard) { g.OnMain = false }},
		{"PR closed with no PR", TodoWorking, TodoPRClosed, func(g *TodoGuard) { g.HasPR = false }},
		{"reopen 7 days and 1 second after the drop", TodoDropped, TodoPRReopened, func(g *TodoGuard) { g.DroppedAt = g.Now.Add(-todoReopenWindow - time.Second) }},
		{"reopen with no captured head", TodoDropped, TodoPRReopened, func(g *TodoGuard) { g.HeadCaptured = false }},
		{"merged via a later commit not on main", TodoQueued, TodoMergedVia, func(g *TodoGuard) { g.OnMain = false }},
		{"merged from working, not on main", TodoWorking, TodoPRMerged, func(g *TodoGuard) { g.OnMain = false }},
		{"working waits on a stack-level force push", TodoWorking, TodoWaitOpened, func(g *TodoGuard) { g.WaitKind = "force_push" }},
		{"an answer back to review after the machine was released, unverified", TodoNeedsYou, TodoAnswer, func(g *TodoGuard) {
			g.NoNewWork, g.MachineReleased, g.PRHeadVerified = true, true, false
		}},
		{"reopen with no drop time", TodoDropped, TodoPRReopened, func(g *TodoGuard) { g.DroppedAt = time.Time{} }},
		{"unknown trigger", TodoWorking, TodoTrigger("teleport"), func(*TodoGuard) {}},
	}
	for _, c := range refused {
		t.Run(c.name, func(t *testing.T) {
			guard := satisfiedGuard()
			c.guard(&guard)
			event, err := Transition(c.from, c.trigger, guard)
			var refusal *TodoTransitionRefused
			require.True(t, errors.As(err, &refusal), "got %+v", event)
			require.Equal(t, TodoEvent{}, event)
		})
	}

	t.Run("the coding agent settles its own conflict", func(t *testing.T) {
		guard := satisfiedGuard()
		guard.Actor, guard.OpenWaitKind = agent, TodoWaitConflict
		event, err := Transition(TodoNeedsYou, TodoAnswer, guard)
		require.NoError(t, err)
		require.Equal(t, TodoWorking, event.To)
		require.Equal(t, agent, event.Actor)
	})
	t.Run("an answer that needs no new work returns to review", func(t *testing.T) {
		guard := satisfiedGuard()
		guard.NoNewWork = true
		event, err := Transition(TodoNeedsYou, TodoAnswer, guard)
		require.NoError(t, err)
		require.Equal(t, TodoInReview, event.To)
	})
	t.Run("an answer after the machine was released queues the TODO for it again", func(t *testing.T) {
		guard := satisfiedGuard()
		guard.MachineReleased = true
		event, err := Transition(TodoNeedsYou, TodoAnswer, guard)
		require.NoError(t, err)
		require.Equal(t, TodoQueued, event.To)
		guard.Actor, guard.OpenWaitKind = agent, TodoWaitQuestion
		_, err = Transition(TodoNeedsYou, TodoAnswer, guard)
		require.Error(t, err, "the coding agent still answers only its own conflict")
	})
	t.Run("each wait kind a working TODO may raise", func(t *testing.T) {
		// §4.1 and §12.3: an outside push opens a wait whether working or in review.
		for _, kind := range []string{TodoWaitQuestion, TodoWaitApproval, TodoWaitConflict, TodoWaitMovedOff, TodoWaitForeignPush} {
			guard := satisfiedGuard()
			guard.WaitKind = kind
			event, err := Transition(TodoWorking, TodoWaitOpened, guard)
			require.NoError(t, err, kind)
			require.Equal(t, TodoNeedsYou, event.To)
		}
		guard := satisfiedGuard()
		guard.WaitKind = TodoWaitForeignPush
		event, err := Transition(TodoInReview, TodoWaitOpened, guard)
		require.NoError(t, err)
		require.Equal(t, TodoNeedsYou, event.To)
	})
	t.Run("a reopen exactly 7 days after the drop is allowed", func(t *testing.T) {
		guard := satisfiedGuard()
		guard.DroppedAt = guard.Now.Add(-todoReopenWindow)
		event, err := Transition(TodoDropped, TodoPRReopened, guard)
		require.NoError(t, err)
		require.Equal(t, TodoInReview, event.To)
	})
	t.Run("a failure is recorded on the event into failed", func(t *testing.T) {
		guard := satisfiedGuard()
		guard.Failure = &TodoFailure{Step: "checks", Class: "factory", Message: "the checks failed"}
		event, err := Transition(TodoWorking, TodoRunFailed, guard)
		require.NoError(t, err)
		require.Equal(t, guard.Failure, event.Failure)
	})
}

func TestTodoLearningDoneOnlyCountsLessons(t *testing.T) {
	event, err := Transition(TodoMerged, TodoLearningDone, satisfiedGuard())
	require.NoError(t, err)
	require.Equal(t, TodoMerged, event.To)
	require.Equal(t, 1, event.Lessons)
	for _, trigger := range TodoTriggers {
		if trigger == TodoLearningDone {
			continue
		}
		_, err := Transition(TodoMerged, trigger, satisfiedGuard())
		require.Error(t, err, "merged refuses %s", trigger)
	}
}

// The fifteen mythical_items states (migrations 0026 and 0053).
var mythicalItemStates = []string{"queued", "skipped", "declined", "cancelled", "running", "delivering", "integrating", "verifying",
	"proposing", "waiting", "proposed", "landed", "rejected", "retrying", "blocked"}

func projectionItem(state string, run bool) db.MythicalItem {
	item := db.MythicalItem{State: state}
	if run {
		item.RequestRunID = "run-1"
		item.Checks = (mythicalChecks{FirstStep: &mythicalFirstStep{Generation: item.Generation, Run: "run-1", Sequence: 1}}).encode()
	}
	return item
}

// C-STK-01 part A: §4.1.0 lines 243–255 at 2be05ba6 (draft v0.4),
// over every input: 15 item states × launched (for the launchable states)
// × an open needs_you × a set paused_at.
func TestProjectItemStateMapsEveryItemState(t *testing.T) {
	base := map[string]TodoState{
		"queued": TodoQueued, "skipped": TodoQueued,
		"running": TodoWorking, "delivering": TodoWorking, "integrating": TodoWorking, "verifying": TodoWorking,
		"proposing": TodoWorking, "waiting": TodoWorking, "retrying": TodoWorking,
		"proposed": TodoInReview, "landed": TodoMerged, "blocked": TodoFailed,
		"cancelled": TodoDropped, "rejected": TodoDropped, "declined": TodoDropped,
	}
	terminal := map[string]bool{"landed": true, "cancelled": true, "rejected": true, "declined": true}
	launchable := map[string]bool{"running": true, "retrying": true}
	require.Len(t, mythicalItemStates, 15)
	require.Len(t, base, 15)
	open, _ := json.Marshal(map[string]any{"kind": TodoWaitQuestion, "prompt": "Which?", "since": todoTestNow, "run_wait_id": "w1"})
	inputs := 0
	for _, state := range mythicalItemStates {
		for _, launched := range []bool{false, true} {
			if launched && !launchable[state] {
				continue
			}
			for _, needsYou := range []bool{false, true} {
				for _, paused := range []bool{false, true} {
					inputs++
					// Launched before its first step: the run has not reported
					// and the TODO has not started working yet.
					item := projectionItem(state, !launched)
					todo := db.Todo{State: string(TodoWorking)}
					if launched || state == "queued" || state == "skipped" {
						todo.State = string(TodoQueued)
					}
					want := base[state]
					if launched {
						want = TodoStarting
					}
					if !terminal[state] {
						switch {
						case needsYou:
							want = TodoNeedsYou
						case paused:
							want = TodoPaused
						}
					}
					if needsYou {
						todo.NeedsYou = open
					}
					if paused {
						item.PausedAt = pgtype.Timestamptz{Time: todoTestNow, Valid: true}
					}
					require.Equal(t, want, ProjectItemState(item, todo), "%s launched=%v needs_you=%v paused_at=%v", state, launched, needsYou, paused)
				}
			}
		}
	}
	fmt.Printf("C-STK-01 part A: %d projection inputs\n", inputs)
	require.Equal(t, 15*4+2*4, inputs)

	// §4.1.0: only queued gets the current-open-PR override. Executing
	// phases remain working; §4.1.0a makes blocked failed before PR facts.
	withPR := map[string]TodoState{
		"queued": TodoInReview, "skipped": TodoQueued,
		"running": TodoWorking, "retrying": TodoWorking, "delivering": TodoWorking,
		"integrating": TodoWorking, "verifying": TodoWorking, "proposing": TodoWorking,
		"waiting": TodoWorking, "proposed": TodoInReview, "blocked": TodoFailed,
		"landed": TodoMerged, "cancelled": TodoDropped, "rejected": TodoDropped, "declined": TodoDropped,
	}
	for state, want := range withPR {
		item := projectionItem(state, true)
		item.PRNumber = pgtype.Int8{Int64: 42, Valid: true}
		item.PRState = "open"
		require.Equal(t, want, ProjectItemState(item, db.Todo{State: string(TodoQueued)}), "%s with open PR", state)
	}

	// A null needs_you is no wait.
	require.Equal(t, TodoWorking, ProjectItemState(projectionItem("running", true), db.Todo{State: string(TodoWorking), NeedsYou: json.RawMessage("null")}))
}

// Terminal item states win: whatever needs_you and paused_at hold, landed
// projects merged and cancelled, rejected and declined project dropped
// (tech lead ruling 2026-10-02, §4.1.0).
func TestProjectItemStateTerminalStatesWin(t *testing.T) {
	open, _ := json.Marshal(map[string]any{"kind": TodoWaitForeignPush})
	for state, want := range map[string]TodoState{"landed": TodoMerged, "cancelled": TodoDropped, "rejected": TodoDropped, "declined": TodoDropped} {
		for _, current := range TodoStates {
			item := projectionItem(state, true)
			item.PausedAt = pgtype.Timestamptz{Time: todoTestNow, Valid: true}
			require.Equal(t, want, ProjectItemState(item, db.Todo{State: string(current), NeedsYou: open}), "%s while %s", state, current)
		}
	}
	// Learning doesn't change merged (§4.1.3 line 276). Non-terminal engine
	// writes likewise cannot reopen a merged TODO. Terminal item facts above
	// still win over an inconsistent stored TODO state (§4.1.0 line 255).
	for _, state := range mythicalItemStates {
		if state == "cancelled" || state == "rejected" || state == "declined" {
			continue
		}
		require.Equal(t, TodoMerged, ProjectItemState(projectionItem(state, true), db.Todo{State: string(TodoMerged)}), state)
	}
}

func TestProjectItemStateUsesCurrentFacts(t *testing.T) {
	cases := []struct {
		name      string
		item      db.MythicalItem
		todoState TodoState
		want      TodoState
	}{
		{"launched, no run reported yet", projectionItem("running", false), TodoQueued, TodoStarting},
		{"still starting", projectionItem("running", false), TodoStarting, TodoStarting},
		{"the run reported", projectionItem("running", true), TodoStarting, TodoWorking},
		{"an outage retry before the run reported stays starting", projectionItem("retrying", false), TodoStarting, TodoStarting},
		{"a relaunch after work began stays working", projectionItem("running", false), TodoWorking, TodoWorking},
		{"a new TODO for a launched item starts", projectionItem("running", false), "", TodoStarting},
		{"blocked before the first step", projectionItem("blocked", false), TodoStarting, TodoFailed},
		{"integrating with an open PR remains working", projectionItem("integrating", true), TodoInReview, TodoWorking},
		{"verifying with an open PR remains working", projectionItem("verifying", true), TodoInReview, TodoWorking},
		{"reworking an open PR reports working", projectionItem("running", true), TodoInReview, TodoWorking},
		{"a blocked rebuild fails even with an open PR", projectionItem("blocked", true), TodoInReview, TodoFailed},
		{"queued without an open PR ignores stored review", projectionItem("queued", false), TodoInReview, TodoQueued},
		{"retried after a failure", projectionItem("queued", false), TodoFailed, TodoQueued},
		{"a skipped item leaves a failed TODO failed", projectionItem("skipped", false), TodoFailed, TodoFailed},
		{"a skipped item leaves a dropped TODO dropped", projectionItem("skipped", false), TodoDropped, TodoDropped},
		{"re-admitted after a drop restarts", projectionItem("queued", false), TodoDropped, TodoQueued},
		{"merged in review", projectionItem("landed", true), TodoInReview, TodoMerged},
		{"closed in review", projectionItem("rejected", true), TodoInReview, TodoDropped},
	}
	for _, c := range cases {
		// §4.1.0: the current open PR, never stored review history, holds a rebuild.
		if c.todoState == TodoInReview && c.item.State != "queued" {
			c.item.PRNumber = pgtype.Int8{Int64: 17, Valid: true}
			c.item.PRState = "open"
		}
		require.Equal(t, c.want, ProjectItemState(c.item, db.Todo{State: string(c.todoState)}), c.name)
	}
}

func TestTodoItemPathCrossesOnlySpecEdges(t *testing.T) {
	// Every path the engine may take is a chain of allowed transitions.
	item := db.MythicalItem{State: "blocked", WorkspaceID: "w", CandidateVerified: true, PRMergeCommit: "m"}
	for _, from := range TodoStates {
		for _, to := range TodoStates {
			path := todoItemPath(from, to, item)
			if path == nil {
				continue
			}
			state := from
			for _, trigger := range path {
				event, err := Transition(state, trigger, satisfiedGuard())
				require.NoError(t, err, "%s -> %s via %v", from, to, path)
				state = event.To
			}
			require.Equal(t, to, state, "%s -> %s via %v", from, to, path)
		}
	}
	require.Equal(t, []TodoTrigger{TodoPRClosed}, todoItemPath(TodoInReview, TodoDropped,
		db.MythicalItem{State: "rejected", PRNumber: pgtype.Int8{Int64: 4, Valid: true}}))
	require.Equal(t, []TodoTrigger{TodoDrop}, todoItemPath(TodoInReview, TodoDropped, db.MythicalItem{State: "cancelled"}))
	require.Nil(t, todoItemPath(TodoDropped, TodoQueued, item), "a dropped TODO never restarts in place")
	require.Nil(t, todoItemPath(TodoMerged, TodoWorking, item))
}

// Runtime identity by itself never satisfies the first-step oracle. Old
// stored working rows remain working; a new generation needs new evidence.
func TestTodoStateFirstStepRequiresJournalEvidence(t *testing.T) {
	for _, receipt := range []db.MythicalItem{
		{State: "running", Generation: 2, RequestRunID: "request"},
		{State: "delivering", Generation: 2, VibeRunID: "vibe"},
		{State: "verifying", Generation: 2, VerifyRunID: "verify"},
	} {
		require.Equal(t, TodoStarting, ProjectItemState(receipt, db.Todo{State: string(TodoStarting)}))
		require.Equal(t, TodoWorking, ProjectItemState(receipt, db.Todo{State: string(TodoWorking)}), "old working state is not regressed")
		receipt.Checks = (mythicalChecks{FirstStep: &mythicalFirstStep{Generation: 1, Run: "old", Sequence: 1}}).encode()
		require.Equal(t, TodoStarting, ProjectItemState(receipt, db.Todo{State: string(TodoStarting)}))
		receipt.Checks = (mythicalChecks{FirstStep: &mythicalFirstStep{Generation: 2, Run: "new", Sequence: 2}}).encode()
		require.Equal(t, TodoWorking, ProjectItemState(receipt, db.Todo{State: string(TodoStarting)}))
	}
}

// §4.1 any unmerged -> needs_you; branch waits do not depend on the run phase.
func TestTodoTransitionBranchWaitsFromEveryUnmergedState(t *testing.T) {
	for _, from := range []TodoState{TodoQueued, TodoStarting, TodoWorking, TodoNeedsYou, TodoPaused, TodoFailed, TodoInReview} {
		for _, kind := range []string{TodoWaitConflict, TodoWaitMovedOff, TodoWaitForeignPush} {
			g := satisfiedGuard()
			g.WaitKind = kind
			e, err := Transition(from, TodoWaitOpened, g)
			require.NoError(t, err, "%s %s", from, kind)
			require.Equal(t, TodoNeedsYou, e.To)
		}
		if from != TodoWorking {
			for _, kind := range []string{TodoWaitQuestion, TodoWaitApproval} {
				g := satisfiedGuard()
				g.WaitKind = kind
				_, err := Transition(from, TodoWaitOpened, g)
				require.Error(t, err, "%s %s", from, kind)
			}
		}
	}
}

func TestProjectItemStateQueuedOpenPRIgnoresStoredPhase(t *testing.T) {
	// §4.1.0 (2026-10-02 ruling): queued with a current open PR -> in_review.
	for _, phase := range []TodoState{TodoQueued, TodoStarting, TodoWorking, TodoFailed, TodoInReview} {
		item := projectionItem("queued", false)
		item.PRNumber = pgtype.Int8{Int64: 17, Valid: true}
		item.PRState = "open"
		require.Equal(t, TodoInReview, ProjectItemState(item, db.Todo{State: string(phase)}))
		item.State = "blocked"
		require.Equal(t, TodoFailed, ProjectItemState(item, db.Todo{State: string(phase)}))
		item.State = "queued"
		item.PRState = "closed"
		require.Equal(t, TodoQueued, ProjectItemState(item, db.Todo{State: string(phase)}))
	}
}

// E-09: approval waits require a person's authenticated app session.
func TestTodoTransitionApprovalCLIRefused(t *testing.T) {
	g := satisfiedGuard()
	g.Actor = TodoPerson(7, "cli")
	g.OpenWaitKind = TodoWaitApproval
	_, err := Transition(TodoNeedsYou, TodoAnswer, g)
	require.Error(t, err)
}
func TestTodoTransitionApprovalSessionAccepted(t *testing.T) {
	g := satisfiedGuard()
	g.Actor = TodoPerson(7, "")
	g.Actor.Session = "session-7"
	g.Session = "session-7"
	g.OpenWaitKind = TodoWaitApproval
	event, err := Transition(TodoNeedsYou, TodoAnswer, g)
	require.NoError(t, err)
	require.Equal(t, TodoWorking, event.To)
}
func TestTodoTransitionApprovalAgentRefused(t *testing.T) {
	g := satisfiedGuard()
	g.Actor = TodoPerson(7, "agent")
	g.Actor.Session = "session-7"
	g.Session = "session-7"
	g.OpenWaitKind = TodoWaitApproval
	_, err := Transition(TodoNeedsYou, TodoAnswer, g)
	require.Error(t, err)
}

// §4.1.0a rank 5 requires a blocked provisioning failure to be failed even
// before admission. §3.2/§19.3 forbid manufacturing an unobserved grant.
func TestTodoTransitionPreAdmissionFailureHasNoGrant(t *testing.T) {
	g := satisfiedGuard()
	g.MachineGranted = false
	event, err := Transition(TodoQueued, TodoStartFailed, g)
	require.NoError(t, err)
	require.Equal(t, TodoFailed, event.To)
	require.Equal(t, TodoStartFailed, event.Kind)
	plan, err := planItemProjection(db.Todo{State: "queued"}, db.MythicalItem{State: "blocked", Reason: "provisioning failed"}, todoTestNow)
	require.NoError(t, err)
	require.Len(t, plan.events, 1)
	require.Equal(t, TodoStartFailed, plan.events[0].Kind)
	g.Failure = nil
	_, err = Transition(TodoQueued, TodoStartFailed, g)
	require.Error(t, err, "a failure needs an observed typed cause")
}
