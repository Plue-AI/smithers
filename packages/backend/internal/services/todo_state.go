package services

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// TodoState is a TODO's product state (spec §4.1). The nine stored states
// are the CHECK of todos.state; TodoDraft is the client-side source of the
// placement that creates a TODO and is never stored.
type TodoState string

const (
	TodoDraft    TodoState = "draft"
	TodoQueued   TodoState = "queued"
	TodoStarting TodoState = "starting"
	TodoWorking  TodoState = "working"
	TodoNeedsYou TodoState = "needs_you"
	TodoPaused   TodoState = "paused"
	TodoFailed   TodoState = "failed"
	TodoInReview TodoState = "in_review"
	TodoMerged   TodoState = "merged"
	TodoDropped  TodoState = "dropped"
)

// TodoStates is every stored state, in the order the Home card counts them.
var TodoStates = []TodoState{TodoQueued, TodoStarting, TodoWorking, TodoNeedsYou, TodoPaused, TodoFailed, TodoInReview, TodoMerged, TodoDropped}

// unmerged reports a stored state Drop applies to: every one but merged and
// dropped.
func (s TodoState) unmerged() bool {
	switch s {
	case TodoQueued, TodoStarting, TodoWorking, TodoNeedsYou, TodoPaused, TodoFailed, TodoInReview:
		return true
	}
	return false
}

// TodoTrigger is what moves a TODO: a command, a runtime event, a GitHub
// event or the stack engine's own step. Each allowed transition records its
// trigger as the todo_events kind.
type TodoTrigger string

const (
	TodoPlace            TodoTrigger = "place"
	TodoAdmit            TodoTrigger = "admit"
	TodoRunStarted       TodoTrigger = "run_started"
	TodoStartFailed      TodoTrigger = "start_failed"
	TodoWaitOpened       TodoTrigger = "wait_opened"
	TodoAnswer           TodoTrigger = "answer"
	TodoStop             TodoTrigger = "stop"
	TodoResume           TodoTrigger = "resume"
	TodoRunFailed        TodoTrigger = "run_failed"
	TodoRunUncertain     TodoTrigger = "run_uncertain"
	TodoRetry            TodoTrigger = "retry"
	TodoRetryCurrentFlow TodoTrigger = "retry_current_flow"
	TodoPROpened         TodoTrigger = "pr_opened"
	TodoChangesRequested TodoTrigger = "changes_requested"
	TodoReviewComment    TodoTrigger = "review_comment"
	TodoSteer            TodoTrigger = "steer"
	TodoChecksUpdated    TodoTrigger = "checks_updated"
	TodoRebased          TodoTrigger = "rebased"
	TodoPRMerged         TodoTrigger = "pr_merged"
	TodoMergedVia        TodoTrigger = "merged_via"
	TodoDrop             TodoTrigger = "drop"
	TodoPRClosed         TodoTrigger = "pr_closed"
	TodoPRReopened       TodoTrigger = "pr_reopened"
	TodoLearningDone     TodoTrigger = "learning_done"
)

// TodoTriggers is every trigger Transition knows.
var TodoTriggers = []TodoTrigger{TodoPlace, TodoAdmit, TodoRunStarted, TodoStartFailed, TodoWaitOpened, TodoAnswer, TodoStop,
	TodoResume, TodoRunFailed, TodoRunUncertain, TodoRetry, TodoRetryCurrentFlow, TodoPROpened, TodoChangesRequested,
	TodoReviewComment, TodoSteer, TodoChecksUpdated, TodoRebased, TodoPRMerged, TodoMergedVia, TodoDrop, TodoPRClosed,
	TodoPRReopened, TodoLearningDone}

// The needs_you kinds a TODO carries (§10.8.1). order and force_push are
// stack-level attention, never a TODO's (§4.1.2a).
const (
	TodoWaitQuestion    = "question"
	TodoWaitApproval    = "approval"
	TodoWaitConflict    = "conflict"
	TodoWaitMovedOff    = "moved_off"
	TodoWaitForeignPush = "foreign_push"
)

// todoReopenWindow is how long after a drop a PR reopened on GitHub brings
// its TODO back to in_review (§4.1).
const todoReopenWindow = 7 * 24 * time.Hour

// TodoActor is who caused a change, in the spec's actor notation (§2):
// {person, via?, session?} for people and agents acting for them,
// {agent: "coding", run, todo?} for the coding agent, and {system} for the
// stack engine's own steps and imported rows.
type TodoActor struct {
	Person  *int64 `json:"person,omitempty"`
	Via     string `json:"via,omitempty"`
	Session string `json:"session,omitempty"`
	Agent   string `json:"agent,omitempty"`
	Run     string `json:"run,omitempty"`
	Todo    int64  `json:"todo,omitempty"`
	System  string `json:"system,omitempty"`
}

// TodoPerson is a member acting, directly or through an agent (via).
func TodoPerson(memberID int64, via string) TodoActor {
	return TodoActor{Person: &memberID, Via: via}
}

// todoStackActor is the stack engine.
var todoStackActor = TodoActor{System: "stack"}

func (a TodoActor) member() bool      { return a.Person != nil && a.Agent == "" }
func (a TodoActor) codingAgent() bool { return a.Agent == "coding" }

func (a TodoActor) encode() json.RawMessage {
	out, _ := json.Marshal(a)
	return out
}

// TodoFailure is a failed TODO's typed failure (§4.1, §14.3).
type TodoFailure struct {
	Step      string `json:"step"`
	Class     string `json:"class"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

// TodoGuard is everything a transition's guard reads, supplied by the
// caller: the function itself reads no database, network or clock.
type TodoGuard struct {
	Actor TodoActor
	// Session is the authenticated person session for an approval answer (E-09).
	Session string
	// Cause says why, in the writer's words; it is recorded on the event.
	Cause string
	Now   time.Time
	// MachineGranted: admission granted the branch's machine (admit).
	MachineGranted bool
	// Failure is the typed failure of start_failed (Step "start"),
	// run_failed and run_uncertain.
	Failure *TodoFailure
	// WaitKind is the kind of the durable wait a run raised (wait_opened).
	WaitKind string
	// OpenWaitKind is the kind of the needs_you an answer settles.
	OpenWaitKind string
	// NoNewWork: the answer needs no new work (Discard after an outside
	// push, or another such answer), so the TODO returns to in_review.
	NoNewWork bool
	// MachineReleased: the answer came after the TODO's machine was released
	// at safe-idle, so the TODO queues for it again (§4.1 needs_you → queued).
	MachineReleased bool
	// PRHeadVerified: the PR head is the verified candidate (pr_opened, and
	// an answer that returns to in_review).
	PRHeadVerified bool
	// HasPR: the TODO has a PR (pr_closed).
	HasPR bool
	// OnMain: GitHub reports the PR merged (for merged_via, the later
	// item's squash commit that contains this one) and main contains it.
	OnMain bool
	// DroppedAt and HeadCaptured decide pr_reopened: smithers/<slug> is
	// recreated from the head the repo store captured (§12.3).
	DroppedAt    time.Time
	HeadCaptured bool
}

// TodoEvent is one allowed transition: the todo_events row it appends.
type TodoEvent struct {
	Kind  TodoTrigger `json:"kind"`
	From  TodoState   `json:"from"`
	To    TodoState   `json:"to"`
	Actor TodoActor   `json:"actor"`
	Cause string      `json:"cause,omitempty"`
	// VoidApprovals: the approvals recorded for the old PR head no longer
	// count (in_review → working).
	VoidApprovals bool `json:"void_approvals,omitempty"`
	// Lessons is how many lessons the change adds (learning_done, §4.1.3).
	Lessons int `json:"lessons,omitempty"`
	// Failure is the failure a transition into failed records.
	Failure *TodoFailure `json:"failure,omitempty"`
	// EndsWork: the TODO merged or dropped. The same transaction cancels the
	// attempt's run, settles every open wait and clears needs_you and
	// paused_at (§4.1).
	EndsWork bool `json:"ends_work,omitempty"`
	// SteerHeld: the steer waits for the run (held while queued or starting
	// until the first step, delivered on resume while paused) instead of
	// reaching it now (§10.7.3).
	SteerHeld bool `json:"steer_held,omitempty"`
}

// TodoTransitionRefused is every transition §4.1 does not allow, typed
// todo_transition_refused. It names the state and the trigger.
type TodoTransitionRefused struct {
	From    TodoState
	Trigger TodoTrigger
	Reason  string
}

func (e *TodoTransitionRefused) Error() string {
	return fmt.Sprintf("todo_transition_refused: %s from %s: %s", e.Trigger, e.From, e.Reason)
}

// Transition decides one trigger against spec §4.1: the event to append, or
// TodoTransitionRefused. It is the only place the table lives; every writer
// of todos.state calls it (spec §10.1).
func Transition(from TodoState, trigger TodoTrigger, guard TodoGuard) (TodoEvent, error) {
	to, reason := todoTransitionTarget(from, trigger, guard)
	if reason != "" {
		return TodoEvent{}, &TodoTransitionRefused{From: from, Trigger: trigger, Reason: reason}
	}
	event := TodoEvent{Kind: trigger, From: from, To: to, Actor: guard.Actor, Cause: guard.Cause}
	switch {
	case trigger == TodoLearningDone:
		event.Lessons = 1
	case from == TodoInReview && to == TodoWorking:
		event.VoidApprovals = true
	case trigger == TodoSteer && (from == TodoQueued || from == TodoStarting || from == TodoPaused):
		// Held until the run's first step (queued, starting) or its resume
		// (paused); delivered at once otherwise (§10.7.3).
		event.SteerHeld = true
	}
	switch to {
	case TodoFailed:
		event.Failure = guard.Failure
	case TodoMerged, TodoDropped:
		event.EndsWork = from != to
	}
	return event, nil
}

// todoTransitionTarget is the §4.1 table: the state a trigger moves from to,
// or why it is refused.
func todoTransitionTarget(from TodoState, trigger TodoTrigger, g TodoGuard) (TodoState, string) {
	const notFrom = "not allowed from this state"
	switch trigger {
	case TodoPlace:
		if from == TodoDraft {
			return TodoQueued, ""
		}
	case TodoAdmit:
		if from == TodoQueued {
			if !g.MachineGranted {
				return "", "no machine was granted"
			}
			return TodoStarting, ""
		}
	case TodoRunStarted:
		if from == TodoStarting {
			return TodoWorking, ""
		}
	case TodoStartFailed:
		// §4.1.0a: a provisioning failure can precede a machine grant.
		// Record that failure directly; never fabricate an admission.
		if from == TodoStarting || from == TodoQueued {
			if g.Failure == nil || g.Failure.Step != "start" {
				return "", `a start failure names step "start"`
			}
			return TodoFailed, ""
		}
	case TodoWaitOpened:
		if from.unmerged() {
			switch g.WaitKind {
			case TodoWaitConflict, TodoWaitMovedOff, TodoWaitForeignPush:
				return TodoNeedsYou, ""
			case TodoWaitQuestion, TodoWaitApproval:
				if from == TodoWorking {
					return TodoNeedsYou, ""
				}
			}
			return "", "a run wait requires working; a branch wait requires unmerged work"
		}
	case TodoAnswer:
		if from == TodoNeedsYou {
			if g.OpenWaitKind == TodoWaitApproval && (!g.Actor.member() || g.Actor.Via != "" || (g.Session == "" && g.Actor.Session == "")) {
				return "", "approval answers require a person session"
			}
			if !g.Actor.member() && !(g.Actor.codingAgent() && g.OpenWaitKind == TodoWaitConflict) {
				return "", "only a member answers; the coding agent settles only its own conflict"
			}
			switch {
			case g.NoNewWork:
				if !g.PRHeadVerified {
					return "", "returning to review needs the PR head to be the verified candidate"
				}
				return TodoInReview, ""
			case g.MachineReleased:
				return TodoQueued, ""
			}
			return TodoWorking, ""
		}
	case TodoStop:
		if from == TodoWorking {
			return TodoPaused, ""
		}
	case TodoResume:
		if from == TodoPaused {
			return TodoQueued, ""
		}
	case TodoRunFailed, TodoRunUncertain:
		if from == TodoWorking {
			if g.Failure == nil {
				return "", "a failed run names its failure"
			}
			return TodoFailed, ""
		}
	case TodoRetry, TodoRetryCurrentFlow:
		if from == TodoFailed {
			return TodoQueued, ""
		}
	case TodoPROpened:
		if from == TodoWorking {
			if !g.PRHeadVerified {
				return "", "the PR head is not the verified candidate"
			}
			return TodoInReview, ""
		}
	case TodoChangesRequested:
		if from == TodoInReview {
			// §12.3: a non-member's review is activity only, never a steer.
			if !g.Actor.member() {
				return "", "only a member's review returns a TODO to work"
			}
			return TodoWorking, ""
		}
	case TodoReviewComment:
		if from == TodoInReview {
			if !g.Actor.member() {
				return "", "only a member's review comment returns a TODO to work"
			}
			return TodoWorking, ""
		}
	case TodoSteer:
		switch from {
		case TodoInReview:
			return TodoWorking, ""
		case TodoQueued, TodoStarting, TodoWorking, TodoNeedsYou, TodoPaused:
			// Held or delivered (§10.7.3); a steer never settles an open question.
			return from, ""
		}
	case TodoChecksUpdated, TodoRebased:
		switch from {
		case TodoWorking, TodoNeedsYou, TodoPaused, TodoInReview:
			// The PR stays ready while work or an overlay is active (§4.1).
			// Evidence updates and rebases preserve that state (§12.3).
			return from, ""
		}
	case TodoPRMerged:
		if from.unmerged() {
			// A merge on GitHub counts from every unmerged state (M-22).
			if !g.OnMain {
				return "", "main does not contain the merge yet"
			}
			return TodoMerged, ""
		}
	case TodoMergedVia:
		if from.unmerged() {
			// A later item's squash commit contains this one (§10.6.4).
			if !g.OnMain {
				return "", "main does not contain the merge yet"
			}
			return TodoMerged, ""
		}
	case TodoDrop:
		if from.unmerged() {
			return TodoDropped, ""
		}
	case TodoPRClosed:
		if from.unmerged() {
			if !g.HasPR {
				return "", "the TODO has no PR"
			}
			return TodoDropped, ""
		}
	case TodoPRReopened:
		if from == TodoDropped {
			if !g.HeadCaptured {
				return "", "the repo store holds no captured head to recreate the branch from"
			}
			if g.DroppedAt.IsZero() || g.Now.Sub(g.DroppedAt) > todoReopenWindow {
				return "", "the PR was reopened more than 7 days after the drop"
			}
			return TodoInReview, ""
		}
	case TodoLearningDone:
		if from == TodoMerged {
			return TodoMerged, ""
		}
	default:
		return "", "unknown trigger"
	}
	return "", notFrom
}

// ProjectItemState projects current engine facts (§4.1.0). Terminal item
// facts win, followed by open waits, pause, failure, then the item phase.
// An open PR holds a rebuild in review; stored review history never does.
// Terminal TODOs survive late item receipts; skipped preserves terminal facts.
func ProjectItemState(item db.MythicalItem, todo db.Todo) TodoState {
	current := TodoState(todo.State)
	// Terminal item facts win even over an inconsistent stored TODO state,
	// as well as needs_you and paused_at (§4.1.0).
	switch item.State {
	case "landed":
		return TodoMerged
	case "cancelled", "rejected", "declined":
		return TodoDropped
	}
	if current == TodoMerged {
		// A non-terminal item write cannot reopen a merged TODO (§4.1.3).
		return TodoMerged
	}
	if todoNeedsYouOpen(todo) {
		return TodoNeedsYou
	}
	if item.PausedAt.Valid {
		return TodoPaused
	}
	switch item.State {
	case "proposed":
		return TodoInReview
	case "skipped":
		if current == "" || current == TodoQueued {
			return TodoQueued
		}
		return current
	}
	// §4.1.0a rank 5 precedes the open-PR phase at rank 6.
	if item.State == "blocked" {
		return TodoFailed
	}
	if item.PRNumber.Valid && item.PRState == "open" && item.State == "queued" {
		return TodoInReview
	}
	// A runtime receipt for any lane phase cannot release an existing start.
	if current == TodoStarting && mythicalLaneStates[item.State] && !mythicalRunReported(item) {
		return TodoStarting
	}
	switch item.State {
	case "queued":
		return TodoQueued
	case "blocked":
		return TodoFailed
	case "running", "retrying":
		if !mythicalRunReported(item) && (current == "" || current == TodoQueued || current == TodoStarting) {
			return TodoStarting
		}
		return TodoWorking
	}
	// delivering, integrating, verifying, proposing, waiting
	return TodoWorking
}

// mythicalRunReported requires a persisted first ActionCall in this generation.
func mythicalRunReported(item db.MythicalItem) bool {
	step := mythicalChecksOf(item).FirstStep
	return step != nil && step.Generation == item.Generation
}

func todoNeedsYouOpen(todo db.Todo) bool {
	return len(todo.NeedsYou) > 0 && string(todo.NeedsYou) != "null"
}

// todoItemPath is the chain of triggers the engine's item change stands for
// when the TODO moves from one projected state to another: one trigger for
// a §4.1 edge, two when one engine step crossed two edges (a launch that
// failed to start, a chat result handed in already worked). Any other pair
// has no path and the item write is refused.
func todoItemPath(from, to TodoState, item db.MythicalItem) []TodoTrigger {
	switch {
	case from == TodoQueued && to == TodoStarting:
		return []TodoTrigger{TodoAdmit}
	case from == TodoQueued && to == TodoWorking:
		return []TodoTrigger{TodoAdmit, TodoRunStarted}
	case from == TodoQueued && to == TodoFailed:
		return []TodoTrigger{TodoStartFailed}
	case from == TodoStarting && to == TodoWorking:
		return []TodoTrigger{TodoRunStarted}
	case from == TodoStarting && to == TodoFailed:
		return []TodoTrigger{TodoStartFailed}
	case from == TodoInReview && to == TodoWorking:
		return []TodoTrigger{TodoSteer}
	case from == TodoInReview && to == TodoFailed:
		return []TodoTrigger{TodoSteer, TodoRunFailed}
	case from == TodoWorking && to == TodoFailed:
		return []TodoTrigger{TodoRunFailed}
	case from == TodoWorking && to == TodoInReview:
		return []TodoTrigger{TodoPROpened}
	case to == TodoMerged && from.unmerged():
		return []TodoTrigger{TodoPRMerged}
	case from == TodoFailed && to == TodoQueued:
		return []TodoTrigger{TodoRetry}
	case from == TodoDropped && to == TodoInReview:
		// The PR reopened on GitHub within 7 days (§4.1, §12.3).
		return []TodoTrigger{TodoPRReopened}
	case from.unmerged() && to == TodoDropped:
		if item.State == "rejected" && item.PRNumber.Valid {
			return []TodoTrigger{TodoPRClosed}
		}
		return []TodoTrigger{TodoDrop}
	}
	return nil
}
