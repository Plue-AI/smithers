package compose

import (
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/chat"
)

// TestJ4Rehearsal walks journey J4 (mvp.md §5, the team's work; C-J4-01..03)
// as the owner on the install J1 sets up. T1 goes straight to review, T2
// asks a question and T3 fails its checks (distribution/fake-todo-turns.mjs
// markers). The owner answers T2 and merges T1 while chatting; T4, filed
// once T3 failed, is the ready item a person moves above T3. Rows that wait
// on a lane are listed as pending.
func TestJ4Rehearsal(t *testing.T) {
	r := newRehearsal(t, "SMITHERS_J4_REHEARSAL", "C-J4", "j4-")
	if !r.install("0 Install through Machine ready") {
		return
	}
	var t1, t2, t3, t4 int64
	head1, wait2 := "", ""
	var pr1 int64
	const answer2 = "Say hello in French"
	if !r.step("1 File T1-T3", "POST /api/todos ×3", "202 ×3 with distinct numbers", "T-STK-01", func() error {
		for _, todo := range []struct {
			n             *int64
			title, prompt string
		}{
			{&t1, "T1 ready", "[PR] [FILE t1.md] Add a greeting to t1.md"},
			{&t2, "T2 asks", "[ASK] [FILE t2.md] Add a greeting to t2.md"},
			{&t3, "T3 fails", "[FAIL] [FILE t3.md] Add a greeting to t3.md"},
		} {
			n, err := r.file(todo.title, todo.prompt)
			if err != nil {
				return err
			}
			*todo.n = n
		}
		if t1 == t2 || t2 == t3 || t1 == t3 {
			return fmt.Errorf("TODO numbers repeat: %d %d %d", t1, t2, t3)
		}
		r.actual = fmt.Sprintf("202 T%d T%d T%d", t1, t2, t3)
		return nil
	}) {
		return
	}
	if !r.step("2 T1 in review", "GET /api/todos/{T1}; GitHub fake PR", "in_review; PR smithers/<slug> at the card's head, base main, not a draft", "T-STK-01", func() error {
		v, err := r.waitTodoWithin(t1, 8*time.Minute, "in_review")
		if err != nil {
			return err
		}
		p, err := r.checkPull(v.PR.Number, v.PR.Head)
		if err != nil {
			return err
		}
		if p.Draft {
			return fmt.Errorf("T1, first on the stack, has a draft PR")
		}
		head1, pr1 = v.PR.Head, v.PR.Number
		return nil
	}) {
		return
	}
	if !r.step("3 T2 needs you", "GET /api/todos/{T2}", "needs_you; one open question with Answer", "T-STK-01", func() error {
		v, err := r.waitTodoWithin(t2, 8*time.Minute, "needs_you")
		if err != nil {
			return err
		}
		answerable := false
		for _, wait := range v.Waits {
			for _, action := range wait.Actions {
				answerable = answerable || action.Tag == "todo.answer"
			}
		}
		if len(v.Waits) != 1 || v.Waits[0].Kind != "question" || v.Waits[0].Prompt != "Which greeting should the file carry?" || !answerable {
			return fmt.Errorf("T2's waits are not one question with Answer: %+v", v.Waits)
		}
		wait2 = v.Waits[0].ID
		return nil
	}) {
		return
	}
	if !r.step("4 T1 and T2 on their own branch machines", "GET /api/todos/{T1}; GET /api/todos/{T2}", "each has a branch; the branch ids differ", "T-MCH-04, T-STK-01", func() error {
		var branches []string
		for _, n := range []int64{t1, t2} {
			v, err := r.todo(n)
			if err != nil {
				return err
			}
			if v.Branch == nil || v.Branch.ID == "" {
				return fmt.Errorf("T%d has no branch", n)
			}
			branches = append(branches, v.Branch.ID)
		}
		if branches[0] == branches[1] {
			return fmt.Errorf("T%d and T%d share branch %s", t1, t2, branches[0])
		}
		r.actual = fmt.Sprintf("200 T%d branch %s; T%d branch %s", t1, branches[0], t2, branches[1])
		return nil
	}) {
		return
	}
	// Rows 5 and 6 are the served half of the Home card (lane home-role, which
	// landed its app half in eee936060f).
	r.step("5 Home rows and counts", "GET /api/todos; SQL mythical_items", "each unmerged TODO once, in place order; their count equals the stack's unmerged items", "T-APP-01", func() error {
		list, err := r.todoList()
		if err != nil {
			return err
		}
		var listed []int64
		counts := map[string]int{}
		place := int64(0)
		for _, todo := range list {
			if todo.State == "merged" || todo.State == "dropped" {
				continue
			}
			if slices.Contains(listed, todo.N) {
				return fmt.Errorf("T%d is listed twice", todo.N)
			}
			if todo.Place <= place {
				return fmt.Errorf("T%d has place %d after place %d", todo.N, todo.Place, place)
			}
			place = todo.Place
			listed = append(listed, todo.N)
			counts[todo.State]++
		}
		// mythical_items has no merged_at or dropped_at (C-J4-01's SQL): an
		// item is unmerged until its state is landed or dropped.
		rows, err := r.pool.Query(r.ctx, `SELECT number FROM mythical_items WHERE number IS NOT NULL AND state NOT IN ('landed', 'cancelled', 'rejected', 'declined') ORDER BY stack_position`)
		if err != nil {
			return err
		}
		var stored []int64
		for rows.Next() {
			var n int64
			if err = rows.Scan(&n); err != nil {
				rows.Close()
				return err
			}
			stored = append(stored, n)
		}
		rows.Close()
		if !slices.Equal(listed, stored) {
			return fmt.Errorf("GET /api/todos lists %v, the stack holds %v", listed, stored)
		}
		r.actual = fmt.Sprintf("200 %v by place; states %v", listed, counts)
		return nil
	})
	r.step("6 One Merge, on T1", "GET /api/todos", "exactly one in_review item at place 1 with merge ready and no draft PR, and it is T1; every later in_review item waits on order", "T-APP-01, T-STK-04", func() error {
		list, err := r.todoList()
		if err != nil {
			return err
		}
		var ready []int64
		for _, todo := range list {
			if todo.State != "in_review" {
				continue
			}
			if todo.Place == 1 && todo.Merge.State == "ready" && !todo.PR.Draft {
				ready = append(ready, todo.N)
			} else if todo.Merge.State == "ready" || todo.Merge.Reason != "order" {
				return fmt.Errorf("later in_review T%d: merge %s (%s), want waiting on order", todo.N, todo.Merge.State, todo.Merge.Reason)
			}
		}
		if !slices.Equal(ready, []int64{t1}) {
			return fmt.Errorf("mergeable in_review items %v, want [T%d]", ready, t1)
		}
		return nil
	})
	var chats []<-chan error
	if !r.step("7 Answer T2 while chatting", "POST /api/todos/{T2}/answer beside POST "+chat.TurnPath, "202 within 1 s; the same answer again 202; T2 leaves needs_you", "T-STK-01, T-APP-03", func() error {
		chats = append(chats, r.besideChat())
		began := time.Now()
		code, data, err := r.answer(t2, wait2, answer2)
		if err != nil {
			return err
		}
		took := time.Since(began)
		if code != 202 || took > time.Second {
			return fmt.Errorf("answer: HTTP %d after %s: %s", code, took, data)
		}
		if code, data, err = r.answer(t2, wait2, answer2); err != nil || code != 202 {
			return fmt.Errorf("the same answer again: HTTP %d %s %v", code, data, err)
		}
		v, err := r.waitTodoWithin(t2, time.Minute, "working", "in_review")
		if err != nil {
			return err
		}
		r.actual = fmt.Sprintf("202 in %s; T%d %s", took.Round(time.Millisecond), t2, v.State)
		return nil
	}) {
		return
	}
	if !r.step("9 Merge T1 while chatting", "POST /api/todos/{T1}/merge beside POST "+chat.TurnPath, "202 within 1 s; reviewed head; one session-bound checks.Land", "T-STK-04", func() error {
		chats = append(chats, r.besideChat())
		began := time.Now()
		if err := r.merge(t1, head1); err != nil {
			return err
		}
		if took := time.Since(began); took > time.Second {
			return fmt.Errorf("merge took %s", took)
		}
		return nil
	}) {
		return
	}
	if !r.step("8 Chat during answer and merge", "POST "+chat.TurnPath+" ×2", "both turns answer with JOURNEY.md's File card while the answer and the merge run", "T-APP-03", func() error {
		if len(chats) != 2 {
			return fmt.Errorf("%d chats ran beside the actions, want 2", len(chats))
		}
		for i, settled := range chats {
			select {
			case err := <-settled:
				if err != nil {
					return fmt.Errorf("chat %d: %w", i+1, err)
				}
			case <-time.After(time.Minute):
				return fmt.Errorf("chat %d did not settle within a minute", i+1)
			}
		}
		r.actual = "200 two File card answers beside the answer and the merge"
		return nil
	}) {
		return
	}
	if !r.step("10 T1 merged", "GET /api/todos/{T1}; GitHub fake; GET /api/github/sync", "merged only after GitHub's head-bound squash; the install's main follows it", "T-STK-04, T-GH-02", func() error {
		return r.waitMerged(t1, pr1, head1)
	}) {
		return
	}
	r.step("14a T3 failed", "GET /api/todos/{T3}", "failed: [FAIL] empties JOURNEY.md, so its checks fail on every attempt", "T-STK-01", func() error {
		v, err := r.waitTodoWithin(t3, 20*time.Minute, "failed")
		if err != nil {
			return err
		}
		var reason string
		var attempt int
		if err = r.pool.QueryRow(r.ctx, `SELECT reason, attempt FROM mythical_items WHERE number=$1`, t3).Scan(&reason, &attempt); err != nil {
			return err
		}
		r.actual = fmt.Sprintf("200 T%d %s after attempt %d: %s", t3, v.State, attempt, reason)
		return nil
	})
	// T2 started beside T1, so T1's candidate moved the stack under it: T2
	// reaches review only once the stack rebases it (lane rebase-onto-prefix).
	r.step("11 T2 in review with the answer", "GET /api/todos/{T2}; GitHub fake PR", "in_review; the question settled; t2.md at the PR head carries the answer", "T-STK-01, T-STK-08", func() error {
		v, err := r.waitTodoWithin(t2, 4*time.Minute, "in_review")
		if err != nil {
			if strings.Contains(r.logs.String(), "Rebase pending: validated branch rebase execution is unavailable") {
				return fmt.Errorf("%w; the stack logs \"Rebase pending: validated branch rebase execution is unavailable\" (todo_rebase.go, lane rebase-onto-prefix)", err)
			}
			return err
		}
		if len(v.Waits) > 0 {
			return fmt.Errorf("T2 still waits on %s %q", v.Waits[0].Kind, v.Waits[0].Prompt)
		}
		if len(v.PR.Head) != 40 {
			return fmt.Errorf("T2 in review has no PR head")
		}
		content, err := r.githubGit("show", v.PR.Head+":t2.md")
		if err != nil {
			return err
		}
		if !strings.Contains(content, answer2) {
			return fmt.Errorf("t2.md at %s does not carry the answer: %q", v.PR.Head, content)
		}
		r.actual = fmt.Sprintf("200 T%d in_review; t2.md %q", t2, content)
		return nil
	})
	r.step("11b T4 in review", "POST /api/todos; GET /api/todos/{T4}", "filed on the merged main; in_review: the ready item a person moves above the failing T3", "T-STK-01", func() error {
		var err error
		if t4, err = r.file("T4 ready", "[PR] [FILE t4.md] Add a greeting to t4.md"); err != nil {
			return err
		}
		_, err = r.waitTodoWithin(t4, 10*time.Minute, "in_review")
		return err
	})
	r.pending("12 Move T4 above T3", "POST /api/todos/{T4} {op: move}", "order T2, T4, T3; T4 reads 'Merges after T2'; T4 holds no bytes of T3", "T-STK-02", "stack-order")
	r.pending("13 Retry T3 with a steer", "POST /api/todos/{T3} {op: retry, steer: '[FIXED] …'}", "202 within 1 s; attempt 2 reaches working; a double press makes one attempt", "T-STK-05", "retry-steer")
	r.pending("14b The steer reaches attempt 2", "GET /api/todos/{T3}; model trace", "steers[0] is the steer; attempt 1 evidence kept; attempt 2's first message carries the steer", "T-STK-05", "retry-steer")
	r.pending("15 Receipts settle late", "GET /api/live (home)", "each toast settles from the served fact, not the 202", "T-APP-01", "live-slice")
	r.pending("16 Merged since last look", "PUT view state; GET /api/todos", "the browser derives [T1] after the merge and [] after a new look", "T-APP-01", "last-look")
	r.pending("17 T2 ready after T1 merges", "GitHub fake PR; GET /api/todos", "T2 rebases onto the merged main; one ready-for-review change on T2's PR; merge.state ready on T2 only", "T-STK-04, T-STK-08", "second-merge")
	r.pending("18 main row synced", "GET /api/github/sync; Home card", "last_success_at within one poll; 'synced N s ago'; machines in use of capacity", "T-GH-02", "sync-row")
	r.pending("19 Retry and dismiss failed background runs", "POST /api/runs/{id}", "Retry starts exactly one run; Dismiss removes the row for everyone; 403 without the role", "T-APP-01", "background-runs")
	r.pending("20 Ben merges, Alice answers", "POST /api/todos/{n}/merge and /answer as Ben and Alice", "maintainer Ben merges; member Alice answers and her merge is 403", "T-ACC-02", "members")
}
