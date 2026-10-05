package services

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
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
	require.Equal(t, &TodoControlError{http.StatusConflict, "conflict", "conflict", "TODO is settled"}, refusal)
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

// Drop of a working TODO cancels its attempt's run in the same transaction
// (the dispatcher's worker then stops it), settles its open waits and
// clears its pause; the run's late updates never revive it, and the stack
// releases its lane.
func TestTodoDropCancelsTheRunAndReleasesTheLane(t *testing.T) {
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
	refusal := refusalOf(t, err)
	require.Equal(t, http.StatusForbidden, refusal.Status, "a run never drops a TODO")
	require.Empty(t, o.launcher.cancelled)

	receipt, err := o.service.ControlTodo(session, n, press)
	require.NoError(t, err)
	require.Equal(t, TodoControlReceipt{State: "accepted"}, receipt)
	require.Equal(t, []string{launches[0].RequestID}, o.launcher.cancelled, "the attempt's run is cancelled with the drop")
	dropped := o.byID(id)
	require.Equal(t, "dropped", todoState(dropped))
	require.Empty(t, todoOpenWaits(dropped))
	waits := mythicalChecksOf(dropped).Waits
	require.Len(t, waits, 1)
	require.NotNil(t, waits[0].SettledAt, "the open question is settled with the drop")
	require.False(t, dropped.PausedAt.Valid)

	facts := o.facts(dropped, "todo.dropped")
	require.Len(t, facts, 1)
	require.Equal(t, "needs_you", facts[0]["from"])
	require.Equal(t, "dropped", facts[0]["to"])
	require.Equal(t, false, facts[0]["pr"])

	// The cancelled run ends; its update changes nothing the drop decided.
	o.projectTodo(launches[0], jobs.StateCancelled, "todo-run-1", todoPinOne, "")
	o.wake()
	o.wake()
	released := o.byID(id)
	require.Equal(t, "cancelled", released.State)
	require.Empty(t, released.WorkspaceID, "a dropped TODO's lane is released")
	require.Len(t, o.launcher.byFlow("todo"), 1, "nothing starts again")
	require.Contains(t, o.lanes.deleted, working.WorkspaceID)
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
