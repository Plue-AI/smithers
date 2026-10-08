package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// drop is the owner's Drop of TODO n with the Idempotency-Key key.
func (h *mergeHarness) drop(n int64, key string) (TodoControlReceipt, error) {
	return h.service.ControlTodo(h.ctx, n, TodoControlInput{Op: "drop", Repository: h.repoID, Actor: h.userID, Request: key})
}

// comments are the comments GitHub received on issue or pull request n.
func (h *mergeHarness) comments(n int64) []string {
	var out []string
	for _, write := range h.fake.Writes() {
		if write.Method == http.MethodPost && write.Path == fmt.Sprintf("/repos/rehearsal-owner/app/issues/%d/comments", n) && write.Status < 300 {
			var body struct{ Body string }
			require.NoError(h.t, json.Unmarshal(write.Body, &body))
			out = append(out, body.Body)
		}
	}
	return out
}

// M3 (m3-walk-full defects 5 and 6), J7.3b: a failed T1 blocks T2's merge
// ("Merges after T1") until a person drops it. Drop answers 202 at once:
// T1 is dropped, with no pull request to close, and T2 merges.
func TestTodoDropFailedTodoUnblocksTheNextMerge(t *testing.T) {
	h := newMergeHarness(t)
	ctx := context.Background()
	failed := h.todo("Fails first", "Do fails first", h.main, "fails.md", "fails\n")
	failed.State, failed.Reason = "blocked", mythicalVeryHard+"the lane's request ended blocked"
	failed, err := h.q.SaveMythicalItem(ctx, failed)
	require.NoError(t, err)
	n1 := failed.Number.Int64
	n2, head2, _ := h.first("Second change")
	state, merge := h.mergeCard(n2)
	require.Equal(t, "in_review", state)
	require.Equal(t, map[string]any{"state": "waiting", "reason": "order", "detail": "T" + strconv.FormatInt(n1, 10), "on_github": true}, merge)
	refusal := refusalOf(t, h.press(h.ctx, n2, head2))
	require.Equal(t, "Merges after T"+strconv.FormatInt(n1, 10), refusal.Message)

	receipt, err := h.drop(n1, "drop-t1")
	require.NoError(t, err)
	require.Equal(t, TodoControlReceipt{State: "accepted"}, receipt)
	dropped := h.item(n1)
	require.Equal(t, "cancelled", dropped.State)
	require.Equal(t, "dropped", todoState(dropped))
	require.Empty(t, dropped.PendingOp, "a TODO with no pull request has none to close")
	require.Equal(t, "smithers-canary", mythicalChecksOf(dropped).Dropped.By)
	require.Equal(t, "dropped", h.card(n1)["state"])

	state, merge = h.mergeCard(n2)
	require.Equal(t, "in_review", state)
	require.Equal(t, map[string]any{"state": "ready", "on_github": true}, merge, "no later TODO waits on a dropped one")
	require.NoError(t, h.press(h.ctx, n2, head2))
	h.pass()
	require.Len(t, h.merges(), 1)
	state, _ = h.mergeCard(n2)
	require.Equal(t, "merged", state)
}

// J7.3b, §10.7.2: Drop on a TODO in review closes its pull request on GitHub
// with "Dropped in Smithers by @x" through the stack's pending_op: lookup,
// the comment and the close, then settlement on the next lookup. The same
// press again is the same drop; another press is 409; nothing reopens or
// republishes the pull request on later passes.
func TestTodoDropClosesThePullRequestWithItsComment(t *testing.T) {
	h := newMergeHarness(t)
	n, _, pr := h.first("Dropped change")
	receipt, err := h.drop(n, "drop-1")
	require.NoError(t, err)
	require.Equal(t, TodoControlReceipt{State: "accepted"}, receipt)
	again, err := h.drop(n, "drop-1")
	require.NoError(t, err)
	require.Equal(t, receipt, again, "the same press again is the same drop")
	refusal := refusalOf(t, func() error { _, err := h.drop(n, "drop-2"); return err }())
	require.Equal(t, &TodoControlError{http.StatusConflict, "todo_transition_refused", "conflict", "TODO is settled"}, refusal)
	require.Equal(t, MythicalOutboundOp{Kind: "close", Target: strconv.FormatInt(pr, 10), Desired: "closed", Precondition: "open", State: "intended"}, h.operation(n))
	require.Equal(t, "open", h.pull(pr).State, "the press itself never calls GitHub")
	require.Equal(t, "dropped", h.card(n)["state"])

	h.pass()
	require.Equal(t, "closed", h.pull(pr).State)
	require.False(t, h.pull(pr).Merged)
	comments := h.comments(pr)
	require.Len(t, comments, 1)
	require.True(t, strings.HasPrefix(comments[0], "Dropped in Smithers by @smithers-canary"), comments[0])
	h.pass()
	item := h.item(n)
	require.Empty(t, item.PendingOp, "the close settles from GitHub's own answer")
	require.Equal(t, "closed", item.PRState)
	require.Equal(t, "cancelled", item.State)
	h.pass()
	require.Len(t, h.comments(pr), 1, "the comment is said once")
	require.Equal(t, "closed", h.pull(pr).State)
	require.Empty(t, h.merges())
}

// A drop of a TODO whose merge is in flight is refused: the merge fence
// wins (§10.6.2b). A merged TODO cannot be dropped.
func TestTodoDropRefusedWhileMergingAndOnceMerged(t *testing.T) {
	h := newMergeHarness(t)
	n, head, _ := h.first("Merging change")
	require.NoError(t, h.press(h.ctx, n, head))
	refusal := refusalOf(t, func() error { _, err := h.drop(n, "drop-merging"); return err }())
	require.Equal(t, "merging", refusal.Code)
	h.pass()
	state, _ := h.mergeCard(n)
	require.Equal(t, "merged", state)
	refusal = refusalOf(t, func() error { _, err := h.drop(n, "drop-merged"); return err }())
	require.Equal(t, "TODO is settled", refusal.Message)
}

// A live composition needs a stopped-writer capture before Drop may cancel
// its launch, settle its waits, or remove its retained workspace.
func TestTodoDropRefusesLiveWriterWithoutCapture(t *testing.T) {
	o, session := newTodoAdmission(t)
	ctx := context.Background()
	o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
	item := o.fileTodo(session, "dropped")
	n, id := item.Number.Int64, uuidString(item.ID)
	o.wake()
	launches := o.launcher.byFlow("todo")
	require.Len(t, launches, 1)
	o.projectTodo(launches[0], jobs.StateWaiting, "todo-run-1", todoPinOne, "")
	working := o.byID(id)
	require.Equal(t, "working", todoState(working))
	require.NotEmpty(t, working.WorkspaceID)
	checks := mythicalChecksOf(working)
	checks.Waits = append(checks.Waits, TodoWait{ID: "q1", Kind: "question", Prompt: "Which file?", Since: time.Now().UTC()})
	working.Checks = checks.encode()
	working, err := o.service.queries().SaveMythicalItem(ctx, working)
	require.NoError(t, err)
	require.Equal(t, "needs_you", todoState(working))

	press := TodoControlInput{Op: "drop", Repository: o.repoID, Actor: o.userID, Request: "drop-working"}
	_, err = o.service.ControlTodo(mythicalRunContext(ctx, o.userID), n, press)
	var refusal *AccessError
	require.ErrorAs(t, err, &refusal)
	require.Equal(t, http.StatusForbidden, refusal.Status, "a run never drops a TODO")
	require.Empty(t, o.launcher.cancelled)

	_, err = o.service.ControlTodo(session, n, press)
	require.Equal(t, todoControlUnavailable(), err)
	require.Equal(t, working, o.byID(id), "a refused Drop leaves the run, waits, attempt and lane intact")
	require.Empty(t, o.launcher.cancelled)
	require.Empty(t, o.lanes.deleted)
	require.Empty(t, o.facts(working, "todo.dropped"))

}

// mythicalDropped closes only an open pull request and keeps every other
// fact of the item.
func TestMythicalDroppedClosesOnlyAnOpenPullRequest(t *testing.T) {
	at := time.Date(2026, 10, 5, 7, 0, 0, 0, time.UTC)
	drop := todoDrop{Request: "k", By: "ada", At: at}
	none := mythicalDropped(db.MythicalItem{State: "blocked", Attempt: 3}, drop)
	assert.Equal(t, "cancelled", none.State)
	assert.Empty(t, none.PendingOp)
	assert.EqualValues(t, 3, none.Attempt)
	closed := mythicalDropped(db.MythicalItem{State: "proposed", PRNumber: pgtype.Int8{Int64: 4, Valid: true}, PRState: "closed"}, drop)
	assert.Empty(t, closed.PendingOp, "a pull request closed on GitHub stays closed")
	open := mythicalDropped(db.MythicalItem{State: "proposed", PRNumber: pgtype.Int8{Int64: 4, Valid: true}, PRState: "open"}, drop)
	op, err := decodeMythicalOutbound(open.PendingOp)
	require.NoError(t, err)
	assert.Equal(t, MythicalOutboundOp{Kind: "close", Target: "4", Desired: "closed", Precondition: "open", State: "intended"}, op)
	assert.Equal(t, "Dropped in Smithers by @ada", mythicalDropComment(mythicalChecksOf(open).Dropped))
	assert.Equal(t, "Dropped in Smithers", mythicalDropComment(nil))
}

// The stack settles Drop's close on its own schedule, seconds after the
// press: send, then lookup and settlement, never at the stale sweep (J4b
// run 1: the close was sent, then nothing ran for minutes).
func TestTodoDropSettlesItsCloseWithinSeconds(t *testing.T) {
	h := newMergeHarness(t)
	n, _, pr := h.first("Dropped on schedule")
	h.startWorker()
	_, err := h.drop(n, "drop-scheduled")
	require.NoError(t, err)
	require.Eventually(t, func() bool {
		item := h.item(n)
		return len(item.PendingOp) == 0 && item.PRState == "closed"
	}, 20*time.Second, 100*time.Millisecond, "the dropped TODO's close settles without a sweep")
	require.Equal(t, "closed", h.pull(pr).State)
	require.Len(t, h.comments(pr), 1)
}

// A lost close response followed by a person's reopen settles the original
// Drop from the App event. Recovery never sends a second close.
func TestTodoDropRecoveryPreservesPersonsReopen(t *testing.T) {
	h := newMergeHarness(t)
	n, _, pr := h.first("Reopened change")
	_, err := h.drop(n, "drop-reopen")
	require.NoError(t, err)
	h.fake.LoseNextResponses(fmt.Sprintf("/repos/rehearsal-owner/app/pulls/%d", pr), 1)
	h.pass()
	require.Equal(t, "unknown", h.operation(n).State)
	require.Equal(t, "closed", h.pull(pr).State)
	h.fake.UpdatePull("rehearsal-owner/app", pr, func(p *githubfake.Pull) { p.State = "open" })
	h.pass()
	require.Empty(t, h.item(n).PendingOp)
	require.Equal(t, "open", h.pull(pr).State)
	closes := 0
	for _, write := range h.fake.Writes() {
		if write.Method == http.MethodPatch && write.Path == fmt.Sprintf("/repos/rehearsal-owner/app/pulls/%d", pr) && strings.Contains(string(write.Body), `"state":"closed"`) {
			closes++
		}
	}
	require.Equal(t, 1, closes)
}

func TestTodoDropRetainsUncertainBodyThenCloses(t *testing.T) {
	h := newMergeHarness(t)
	n, _, pr := h.first("Uncertain body")
	item := h.item(n)
	op := MythicalOutboundOp{Kind: "body", Target: strconv.FormatInt(pr, 10), Desired: mythicalBodyDigest(h.pull(pr).Body), Precondition: "old-digest", State: "unknown"}
	raw, err := json.Marshal(op)
	require.NoError(t, err)
	h.exec(`UPDATE mythical_items SET pending_op=$2 WHERE id=$1`, item.ID, raw)
	_, err = h.drop(n, "drop-body")
	require.NoError(t, err)
	require.Equal(t, op, h.operation(n), "Drop cannot replace the uncertain slot")
	h.fake.LoseNextResponses(fmt.Sprintf("/repos/rehearsal-owner/app/pulls/%d", pr), 1)
	h.pass()
	h.pass()
	h.pass()
	require.Empty(t, h.item(n).PendingOp)
	require.Equal(t, "closed", h.pull(pr).State)
	require.Len(t, h.comments(pr), 1)
}

func TestTodoDropClosesLateDiscoveredPull(t *testing.T) {
	h := newMergeHarness(t)
	item := h.todo("Late pull", "Create late pull", h.main, "late.md", "late\n")
	h.fake.LoseNextResponses("/repos/rehearsal-owner/app/pulls", 1)
	h.wake()
	pending := h.item(item.Number.Int64)
	require.Equal(t, "open", h.operation(item.Number.Int64).Kind)
	require.False(t, pending.PRNumber.Valid, "lost CreatePull response has not bound a PR")
	_, err := h.drop(item.Number.Int64, "drop-late")
	require.NoError(t, err)
	require.Equal(t, "open", h.operation(item.Number.Int64).Kind)
	h.wake()
	h.wake()
	h.wake()
	dropped := h.item(item.Number.Int64)
	require.True(t, dropped.PRNumber.Valid)
	require.Empty(t, dropped.PendingOp)
	require.Equal(t, "cancelled", dropped.State)
	require.Equal(t, "closed", h.pull(dropped.PRNumber.Int64).State)
	require.Len(t, h.pullCreates(), 1)
	require.Len(t, h.comments(dropped.PRNumber.Int64), 1)
}

// Fault injection supplements TestTodoLiveDropBundledHost's production path.
type dropCaptureFault struct {
	*fakeMythicalLanes
	failure  error
	captures int
}

// Inject only retirement's transient failure; admission, Drop and the worker
// still use their real PostgreSQL transactions and scheduling.
type dropReleaseFault struct {
	*fakeMythicalLanes
	failure error
}

func (f *dropReleaseFault) Delete(ctx context.Context, repository, actor int64, branch string) error {
	if f.failure != nil {
		return f.failure
	}
	return f.fakeMythicalLanes.Delete(ctx, repository, actor, branch)
}

func TestTodoDropRetainedCaptureReleaseRetries(t *testing.T) {
	o, session := newTodoAdmission(t)
	ctx := context.Background()
	item := o.fileTodo(session, "drop-retained-capture")
	o.wake()
	item = o.byID(uuidString(item.ID))
	branch := item.WorkspaceID
	require.NotEmpty(t, branch)
	// An ended attempt still owns captured edits, as in J7's source refusal.
	item.State, item.RequestOutcome = "blocked", "stopped: source_refused"
	checks := mythicalChecksOf(item)
	checks.Capture = &MachineCapturePending{Head: item.BaseCommit, Tree: strings.Repeat("b", 40), Base: item.BaseCommit, Onto: item.BaseCommit}
	item.Checks = checks.encode()
	_, err := db.New(o.pool).SaveMythicalItem(ctx, item)
	require.NoError(t, err)
	fault := &dropReleaseFault{fakeMythicalLanes: o.lanes, failure: errors.New("final capture disconnected")}
	o.service.lanes = fault
	_, err = o.service.ControlTodo(session, item.Number.Int64, TodoControlInput{Op: "drop", Repository: o.repoID, Actor: o.userID, Request: "drop-retained"})
	require.NoError(t, err)
	started := time.Now()
	stack := o.wake()
	pending := o.byID(uuidString(item.ID))
	require.Equal(t, "dropped", todoState(pending))
	require.Equal(t, branch, pending.WorkspaceID)
	require.NotContains(t, o.lanes.deleted, branch)
	require.Equal(t, checks.Capture, mythicalChecksOf(pending).Capture)
	require.WithinDuration(t, started.Add(3*time.Second), stack.NextAttemptAt.Time, time.Second)
	fault.failure = nil
	time.Sleep(time.Until(stack.NextAttemptAt.Time) + 100*time.Millisecond)
	require.NoError(t, o.service.PollOnce(ctx))
	saved := o.byID(uuidString(item.ID))
	require.Empty(t, saved.WorkspaceID)
	require.Contains(t, o.lanes.deleted, branch)
	require.Equal(t, checks.Capture, mythicalChecksOf(saved).Capture, "release retains captured-change history")
}

func (f *dropCaptureFault) DropCaptureReady(context.Context, pgx.Tx, db.MythicalItem) error {
	return nil
}
func (f *dropCaptureFault) CaptureDroppedTodo(_ context.Context, _ db.MythicalItem, finish func() error) error {
	f.captures++
	if f.failure != nil {
		return f.failure
	}
	return finish()
}
func TestTodoDropCaptureFailureRecovery(t *testing.T) {
	o, session := newTodoAdmission(t)
	ctx := context.Background()
	o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
	item := o.fileTodo(session, "capture recovery")
	o.wake()
	launches := o.launcher.byFlow("todo")
	require.Len(t, launches, 1)
	o.projectTodo(launches[0], jobs.StateWaiting, "drop-run", todoPinOne, "")
	item = o.byID(uuidString(item.ID))
	fault := &dropCaptureFault{fakeMythicalLanes: o.lanes, failure: errors.New("capture disconnected")}
	o.service.lanes = fault
	press := TodoControlInput{Op: "drop", Repository: o.repoID, Actor: o.userID, Request: "deferred-drop"}
	for range 2 {
		receipt, err := o.service.ControlTodo(session, item.Number.Int64, press)
		require.NoError(t, err)
		require.Equal(t, "accepted", receipt.State)
	}
	pending := o.byID(uuidString(item.ID))
	require.NotNil(t, mythicalChecksOf(pending).DropRequested)
	require.Equal(t, item.StackPosition, pending.StackPosition)
	require.Empty(t, o.facts(item, "todo.dropped"))
	require.Zero(t, fault.captures)
	stack, err := o.service.queries().GetMythicalStack(ctx, o.repoID)
	require.NoError(t, err)
	require.ErrorContains(t, o.service.advanceTodoDrop(ctx, stack, pending), "capture disconnected")
	require.Equal(t, pending, o.byID(uuidString(item.ID)))
	// The cancelled checkpoint cannot turn the admitted Drop into failed.
	o.projectTodo(launches[0], jobs.StateCancelled, "drop-run", todoPinOne, "")
	require.Equal(t, pending, o.byID(uuidString(item.ID)))
	// Simulate worker reconstruction: the obligation lives on the item, not
	// an in-memory cancellation callback.
	recovered := *o.service
	fault.failure = nil
	require.NoError(t, recovered.advanceTodoDrop(ctx, stack, o.byID(uuidString(item.ID))))
	saved := o.byID(uuidString(item.ID))
	require.Equal(t, "dropped", todoState(saved))
	require.False(t, saved.StackPosition.Valid)
	require.Nil(t, mythicalChecksOf(saved).DropRequested)
	require.Len(t, o.facts(item, "todo.dropped"), 1)
	receipt, err := recovered.ControlTodo(session, item.Number.Int64, press)
	require.NoError(t, err)
	require.Equal(t, "accepted", receipt.State)
}
