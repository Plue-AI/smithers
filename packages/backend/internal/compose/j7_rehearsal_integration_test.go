package compose

import (
	"fmt"
	"slices"
	"testing"
	"time"
)

// TestJ7Rehearsal walks journey J7 (mvp.md §5, plan and fork; C-J7-01..03)
// on the install J1 sets up. Its setup is C-J7-01's stack at the default
// parallel of 2: T1 in review, T2 working and held at its edit, T3 behind
// it and held too ([HOLD key] markers of distribution/fake-todo-turns.mjs).
// The insert, amend, fork, add-to-stack, drop, rebase and conflict rows wait
// on their lanes and are listed as pending.
func TestJ7Rehearsal(t *testing.T) {
	r := newRehearsal(t, "SMITHERS_J7_REHEARSAL", "C-J7", "j7-")
	if !r.install("0 Install through Machine ready") {
		return
	}
	// Held turns are answered before the install stops.
	defer func() {
		_ = r.release("t2")
		_ = r.release("t3")
	}()
	if !r.step("1 Parallel defaults to 2", "SQL mythical_stacks.max_parallel", "2, with no PUT /api/install", "T-STK-03", func() error {
		var parallel int
		if err := r.pool.QueryRow(r.ctx, `SELECT max_parallel FROM mythical_stacks`).Scan(&parallel); err != nil {
			return err
		}
		r.actual = fmt.Sprintf("max_parallel=%d", parallel)
		if parallel != 2 {
			return fmt.Errorf("the stack's parallel is %d, want 2", parallel)
		}
		return nil
	}) {
		return
	}
	var t1, t2, t3 int64
	if !r.step("2 File T1, T2, T3", "POST /api/todos ×3; GET /api/todos", "202 ×3; place order T1, T2, T3", "T-STK-01", func() error {
		var err error
		if t1, err = r.file("T1 ready", "[PR] [FILE t1.md] Add a greeting to t1.md"); err != nil {
			return err
		}
		if t2, err = r.file("T2 retries", "[HOLD t2] [FILE t2.md] Add a retry helper note to t2.md"); err != nil {
			return err
		}
		if t3, err = r.file("T3 jitter", "[HOLD t3] [FILE t3.md] Add a jitter note to t3.md"); err != nil {
			return err
		}
		list, err := r.todoList()
		if err != nil {
			return err
		}
		var placed []int64
		for _, todo := range list {
			placed = append(placed, todo.N)
		}
		if !slices.Equal(placed, []int64{t1, t2, t3}) {
			return fmt.Errorf("GET /api/todos lists %v, want %v", placed, []int64{t1, t2, t3})
		}
		return nil
	}) {
		return
	}
	if !r.step("3 T1 in review", "GET /api/todos/{T1}; GitHub fake PR", "in_review; PR smithers/<slug> at the card's head, base main", "T-STK-01", func() error {
		v, err := r.waitTodoWithin(t1, 8*time.Minute, "in_review")
		if err != nil {
			return err
		}
		_, err = r.checkPull(v.PR.Number, v.PR.Head)
		return err
	}) {
		return
	}
	if !r.step("4 T2 held in Working", "GET /api/todos/{T2}; scripted model /held", "working with its own branch; its edit turn held on [HOLD t2]", "T-STK-01", func() error {
		if err := r.waitHeld("t2", 8*time.Minute); err != nil {
			return err
		}
		v, err := r.waitTodoWithin(t2, time.Minute, "working")
		if err != nil {
			return err
		}
		if v.Branch == nil || v.Branch.ID == "" {
			return fmt.Errorf("working T%d has no branch", t2)
		}
		r.actual = fmt.Sprintf("200 T%d working on branch %s; edit held", t2, v.Branch.ID)
		return nil
	}) {
		return
	}
	r.step("5 T3 after T2", "GET /api/todos/{T3}", "T3 is placed after T2 and not in review", "T-STK-01", func() error {
		v, err := r.todo(t3)
		if err != nil {
			return err
		}
		v2, err := r.todo(t2)
		if err != nil {
			return err
		}
		if v.Place <= v2.Place || v.State == "in_review" || v.State == "merged" {
			return fmt.Errorf("T%d at place %d is %s; T%d at place %d", t3, v.Place, v.State, t2, v2.Place)
		}
		r.actual = fmt.Sprintf("200 T%d %s at place %d", t3, v.State, v.Place)
		return nil
	})
	r.pending("6 Insert TN before T3", "POST /api/todos {place: before T3}", "order T1, T2, TN, T3; T3 is not admitted before TN; one product_job_events row", "T-STK-02", "stack-order")
	r.pending("7 Amend T2", "POST /api/todos {place: amend T2}", "revision 2 with reason amend; T2 shows +1; same run, no new TODO", "T-STK-06", "amend")
	r.pending("8 The amendment reaches T2's run", "release [HOLD t2]; model trace", "T2's next implement turn carries the amendment as a steer", "T-STK-06", "amend")
	r.pending("9 TN builds on T2's verified head", "GET /api/todos/{TN}; GitHub fake PR", "TN's base is T2's verified head; TN's draft PR includes T2", "T-STK-12, T-STK-08", "rebase-onto-prefix")
	r.pending("10 Fork T2", "POST /api/branches {from: T2}", "201; forked_from {T2, H2, C1}; T2's run and workspace unchanged", "T-MCH-08", "fork")
	r.pending("11 Scratch stays off GitHub", "GitHub fake refs", "no smithers/ branch or PR for the scratch branch", "T-MCH-08", "fork")
	r.pending("12 Edit on scratch", "Git push to the scratch branch", "the head moves to S, a descendant of H2", "T-MCH-08", "fork")
	r.pending("13 Add to stack after T2", "POST /api/todos from the scratch branch", "a new TODO after T2 holding the scratch branch's change", "T-MCH-08", "add-to-stack")
	r.pending("14 The new TODO keeps T2's work", "GitHub fake PR diff", "dropping T2 leaves its tree unchanged; the PR has T2's file and the scratch edit", "T-MCH-08", "add-to-stack")
	r.pending("15 Drop T2", "POST /api/todos/{T2} {op: drop}", "dropped; the PR closed with the comment; the run cancelled", "T-STK-02, T-STK-05", "drop")
	r.pending("16 main moves cleanly", "GitHub fake main push; GET /api/todos", "one verify run; the PR head updated; checks.Land cleared", "T-STK-08", "rebase-onto-prefix")
	r.pending("17 Conflict, agent resolves once", "conflicting main push; [RESOLVE]", "the agent resolves the conflict once and shows what it did", "T-STK-08", "conflict-once")
	r.pending("18 Conflict, agent fails", "conflicting main push; [NORESOLVE]", "needs_you with Resolve; no further attempts", "T-STK-08", "conflict-once")
	r.pending("19 Done while conflicted", "POST /api/todos/{n} {op: done}", "409", "T-STK-08", "conflict-once")
	r.pending("20 Done after resolve", "POST /api/todos/{n} {op: done}", "202; a check run admitted", "T-STK-08", "conflict-once")
}
