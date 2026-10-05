package compose

import (
	"fmt"
	"testing"
	"time"
)

// TestJ11Rehearsal walks journey J11 (mvp.md §5, look under the hood;
// C-J11-01) on the install J1 sets up: T5 asks one question
// (distribution/fake-todo-turns.mjs [ASK]), the owner answers it, and T5
// merges. Its run and its lane stay readable after the merge. The monitor's
// rows wait on their lanes and are listed as pending.
func TestJ11Rehearsal(t *testing.T) {
	r := newRehearsal(t, "SMITHERS_J11_REHEARSAL", "C-J11", "j11-")
	if !r.install("0 Install through Machine ready") {
		return
	}
	var t5, pr int64
	head, branch := "", ""
	if !r.step("1 T5 asks", "POST /api/todos; GET /api/todos/{T5}", "202; needs_you with one question", "T-STK-01", func() error {
		var err error
		if t5, err = r.file("T5 greets", "[ASK] [FILE t5.md] Add a greeting to t5.md"); err != nil {
			return err
		}
		v, err := r.waitTodoWithin(t5, 8*time.Minute, "needs_you")
		if err != nil {
			return err
		}
		if len(v.Waits) != 1 || v.Waits[0].Kind != "question" {
			return fmt.Errorf("T%d waits on %+v, want one question", t5, v.Waits)
		}
		code, data, err := r.answer(t5, v.Waits[0].ID, "Say hello in Spanish")
		if err != nil || code != 202 {
			return fmt.Errorf("answer: HTTP %d %s %v", code, data, err)
		}
		return nil
	}) {
		return
	}
	if !r.step("2 T5 in review after the answer", "GET /api/todos/{T5}; GitHub fake PR", "in_review; PR smithers/<slug> at the card's head, base main", "T-STK-01", func() error {
		v, err := r.waitTodoWithin(t5, 8*time.Minute, "in_review")
		if err != nil {
			return err
		}
		if _, err = r.checkPull(v.PR.Number, v.PR.Head); err != nil {
			return err
		}
		if v.Branch == nil || v.Branch.ID == "" {
			return fmt.Errorf("T%d in review has no branch", t5)
		}
		head, pr, branch = v.PR.Head, v.PR.Number, v.Branch.ID
		return nil
	}) {
		return
	}
	if !r.step("3 T5 merged", "POST /api/todos/{T5}/merge; GET /api/todos/{T5}", "202; merged only after GitHub's head-bound squash", "T-STK-04", func() error {
		if err := r.merge(t5, head); err != nil {
			return err
		}
		return r.waitMerged(t5, pr, head)
	}) {
		return
	}
	r.step("4 Run of the TODO", "GET /api/todos/{T5}; SQL mythical_items", "the merged card names its run: the stack's request run, attempt 1 or later", "T-FLW-07", func() error {
		v, err := r.todo(t5)
		if err != nil {
			return err
		}
		var stored string
		if err = r.pool.QueryRow(r.ctx, `SELECT request_run_id FROM mythical_items WHERE number=$1`, t5).Scan(&stored); err != nil {
			return err
		}
		if v.State != "merged" || v.Run == nil || v.Run.ID == "" || v.Run.ID != stored || v.Run.Attempt < 1 {
			return fmt.Errorf("merged T%d's card run %+v, stored run %q", t5, v.Run, stored)
		}
		r.actual = fmt.Sprintf("200 T%d merged; run %s attempt %d", t5, v.Run.ID, v.Run.Attempt)
		return nil
	})
	r.step("5 Lane kept after merge", "GET /api/todos/{T5}; SQL workspaces", "the lane's branch machine is retained after the merge, not deleted", "T-MCH-14", func() error {
		var status string
		var deleted bool
		if err := r.pool.QueryRow(r.ctx, `SELECT status, deleted_at IS NOT NULL FROM workspaces WHERE id=$1`, branch).Scan(&status, &deleted); err != nil {
			return fmt.Errorf("T%d's branch %s: %w", t5, branch, err)
		}
		if deleted || status == "deleted" || status == "destroyed" {
			return fmt.Errorf("T%d's branch %s is %s (deleted=%t) after the merge", t5, branch, status, deleted)
		}
		v, err := r.todo(t5)
		if err != nil {
			return err
		}
		card := "none"
		if v.Branch != nil {
			card = v.Branch.ID + " " + v.Branch.Machine.State
		}
		r.actual = fmt.Sprintf("workspace %s %s; card branch %s", branch, status, card)
		return nil
	})
	r.pending("6 Run summary", "browser flow relay: run summary of T5's lane box", "200 summary of the TODO run", "T-FLW-07", "relay-lane-box")
	r.pending("7 Run journal", "browser flow relay: journal", "the run's events in order, read-only", "T-FLW-07", "relay-lane-box")
	r.pending("8 Read-only", "browser flow relay: a write", "403 todo_requires_stack_admission", "T-FLW-07", "relay-lane-box")
	r.pending("9 No cross-repository read", "browser flow relay: another repository's box", "refused", "T-FLW-07", "relay-lane-box")
	r.pending("10 Graph", "Inspect → RunTraceCard", "every step with its final state", "T-FLW-07", "inspect-run-trace")
	r.pending("11 Step I/O and transcript", "Inspect → implement", "input, output and the agent transcript", "T-FLW-07", "inspect-run-trace")
	r.pending("12 Retries", "Inspect → timeline", "both check attempts, the first failed", "T-FLW-07", "inspect-run-trace")
	r.pending("13 Tokens and time", "Inspect → steps", "tokens and time per step", "T-FLW-07", "inspect-run-trace")
	r.pending("14 Wait for the answer", "Inspect → waits", "the question with since, answered_by and its settle time", "T-FLW-07", "monitor-waits")
	r.pending("15 Titles and /monitor", "Inspect; /monitor", "Appendix C step titles, one Engine row; /monitor lists the TODO run with Inspect", "T-FLW-07", "monitor-labels")
	r.pending("16 Per-step cost", "Inspect → steps; model proxy usage", "each step's cost sums to the run's metered total", "T-FLW-07", "step-cost")
	r.pending("17 Live step states", "GET /api/live run:<id>", "a step state change arrives within 1 s", "T-FLW-07", "live-slice")
}
