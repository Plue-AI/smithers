package compose

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// TestJ4BRehearsal walks J4's "Drop unblocks a stuck item" (mvp.md §4.1 and
// §5 J4.2; M3's recovery from the m3-walk-full walk) on the install J1 sets
// up: T1 fails on every attempt, so T2 in review reads "Merges after T1"
// and cannot merge. A person drops T1, and T2 merges. Then a TODO in review
// is dropped: its pull request closes on GitHub with the Drop comment.
func TestJ4BRehearsal(t *testing.T) {
	r := newRehearsal(t, "SMITHERS_J4B_REHEARSAL", "C-J4", "j4b-")
	if !r.install("0 Install through Machine ready") {
		return
	}
	var t1, t2, t3, pr2 int64
	head2 := ""
	if !r.step("1 File T1 and T2", "POST /api/todos ×2", "202 ×2; T1 fails, T2 opens a PR", "T-STK-01", func() error {
		var err error
		if t1, err = r.file("T1 fails", "[FAIL] [FILE t1.md] Add a greeting to t1.md"); err != nil {
			return err
		}
		if t2, err = r.file("T2 ready", "[PR] [FILE t2.md] Add a greeting to t2.md"); err != nil {
			return err
		}
		r.actual = fmt.Sprintf("202 T%d T%d", t1, t2)
		return nil
	}) {
		return
	}
	if !r.step("2 T2 in review behind T1", "GET /api/todos/{T2}; GitHub fake PR", "in_review; PR smithers/<slug> at the card's head; merge waits: Merges after T1", "T-STK-01, T-STK-04", func() error {
		v, err := r.waitTodoWithin(t2, 8*time.Minute, "in_review")
		if err != nil {
			return err
		}
		if _, err = r.checkPull(v.PR.Number, v.PR.Head); err != nil {
			return err
		}
		head2, pr2 = v.PR.Head, v.PR.Number
		if v.Merge.State == "ready" || v.Merge.Reason != "order" {
			return fmt.Errorf("T%d merge is %s/%s, want waiting on order", t2, v.Merge.State, v.Merge.Reason)
		}
		r.actual = fmt.Sprintf("200 T%d in_review, PR #%d, merge %s (%s)", t2, pr2, v.Merge.State, v.Merge.Reason)
		return nil
	}) {
		return
	}
	if !r.step("3 T1 failed", "GET /api/todos/{T1}", "failed: [FAIL] empties JOURNEY.md, so its checks fail on every attempt", "T-STK-01", func() error {
		v, err := r.waitTodoWithin(t1, 12*time.Minute, "failed")
		if err != nil {
			return err
		}
		attempt := 0
		if v.Run != nil {
			attempt = v.Run.Attempt
		}
		r.actual = fmt.Sprintf("200 T%d failed after attempt %d", t1, attempt)
		return nil
	}) {
		return
	}
	if !r.step("4 Merge T2 waits on the failed T1", "POST /api/todos/{T2}/merge", "409 order: Merges after T1", "T-STK-04", func() error {
		body := fmt.Sprintf(`{"reviewed_head_sha":%q}`, head2)
		code, data, err := r.keyed("POST", fmt.Sprintf("/api/todos/%d/merge", t2), body, r.keyPrefix+"merge-blocked")
		if err != nil {
			return err
		}
		if code != 409 || !strings.Contains(string(data), fmt.Sprintf("Merges after T%d", t1)) {
			return fmt.Errorf("expected 409 Merges after T%d: %s", t1, r.actual)
		}
		return nil
	}) {
		return
	}
	if !r.step("5 Drop the failed T1", "POST /api/todos/{T1} {op: drop}", "202 within 1 s; T1 dropped; no run of it live; its lane released; a new press 409", "T-STK-05", func() error {
		return r.drop(t1)
	}) {
		return
	}
	if !r.step("6 T2 merges after the drop", "GET /api/todos/{T2}; POST /api/todos/{T2}/merge; GitHub fake", "merge ready; merged after GitHub's head-bound squash; the install's main follows it", "T-STK-04, T-GH-02", func() error {
		v, err := r.todo(t2)
		if err != nil {
			return err
		}
		if v.Merge.State != "ready" {
			return fmt.Errorf("T%d merge is %s/%s after T%d was dropped, want ready", t2, v.Merge.State, v.Merge.Reason, t1)
		}
		if err = r.merge(t2, head2); err != nil {
			return err
		}
		return r.waitMerged(t2, pr2, head2)
	}) {
		return
	}
	r.step("7 Drop a TODO in review", "POST /api/todos; POST /api/todos/{T3} {op: drop}; GitHub fake", "T3 in review; dropped; its PR closed, unmerged, with 'Dropped in Smithers by @x'; its lane released", "T-STK-05, T-GH-09", func() error {
		var err error
		if t3, err = r.file("T3 dropped", "[PR] [FILE t3.md] Add a greeting to t3.md"); err != nil {
			return err
		}
		v, err := r.waitTodoWithin(t3, 8*time.Minute, "in_review")
		if err != nil {
			return err
		}
		if _, err = r.checkPull(v.PR.Number, v.PR.Head); err != nil {
			return err
		}
		return r.drop(t3)
	})
}
