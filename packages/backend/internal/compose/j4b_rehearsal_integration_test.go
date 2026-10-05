package compose

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// TestJ4BRehearsal walks J4's "Drop unblocks a stuck item" (mvp.md §4.1 and
// §5 J4.2; M3's recovery from the m3-walk-full walk) on the install J1 sets
// up: T1 fails on every attempt, so T2 in review reads "Merges after T1"
// and cannot merge. A person drops T1, and T2 merges. Then a TODO in review
// is dropped: its pull request closes on GitHub with the Drop comment. The
// rest of the TODO controls follow on working TODOs (controls): Steer, Stop
// and Resume.
func TestJ4BRehearsal(t *testing.T) {
	// The model trace keeps each turn's messages: row 9 reads the steer in
	// the steered run's next planning turn.
	t.Setenv("TRACE_MESSAGES", "1")
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
	r.controls()
}

// controls walks Steer, Stop and Resume on working TODOs (mvp.md J3.6,
// §4.1 Paused; spec §10.7.1, §10.7.3): T4's edit is held while the owner
// steers it, and the run's next planning turn carries the steer; T5 is
// stopped while working, shows Paused with its run cancelled, and Resume
// runs it again until it is in review.
func (r *rehearsal) controls() {
	var t4, t5 int64
	const steer4 = "[STEER4] Also greet the reader in French"
	run4, traced4, delivered := "", 0, false
	r.step("8 Steer a working TODO", "POST /api/todos; POST /api/todos/{T4} {op: steer, text} ×2; SQL product_job_requests",
		"202 within 1 s; the same press again 202; steers[0] by the owner; the steer delivered to T4's live run", "T-STK-06", func() error {
			var err error
			if t4, err = r.file("T4 steered", "[HOLD c4] [FILE t4.md] Add a greeting to t4.md"); err != nil {
				return err
			}
			if err = r.waitHeld("c4", 8*time.Minute); err != nil {
				return err
			}
			v, err := r.waitTodoWithin(t4, time.Minute, "working")
			if err != nil {
				return err
			}
			if v.Run == nil || v.Run.ID == "" {
				return fmt.Errorf("T%d is working with no run on its card", t4)
			}
			run4 = v.Run.ID
			key := r.keyPrefix + "steer-t4"
			took, err := r.control(t4, `{"op":"steer","text":"`+steer4+`"}`, key)
			if err != nil {
				return err
			}
			card, err := r.j4Card(t4)
			if err != nil {
				return err
			}
			if len(card.Steers) != 1 || card.Steers[0].Text != steer4 || card.Steers[0].By.Kind != "person" {
				return fmt.Errorf("steers %+v, want one by the owner: %q", card.Steers, steer4)
			}
			if err = r.waitRequest("todo-steer:%:"+key, "completed", time.Minute); err != nil {
				return err
			}
			delivered = true
			turns, err := r.modelTurns()
			if err != nil {
				return err
			}
			traced4 = len(turns)
			r.actual = fmt.Sprintf("202 in %dms; again 202; steers[0] by %s; delivered to run %s while its edit is held", took.Milliseconds(), card.Steers[0].By.Login, run4)
			return nil
		})
	r.step("9 The steer reaches T4's run", "release [HOLD c4]; model trace; GET /api/todos/{T4}",
		"the same run's next planning turn carries the steer; T4 reaches review on attempt 1", "T-STK-06", func() error {
			if !delivered {
				return fmt.Errorf("blocked by row 8: no steer delivered")
			}
			if err := r.release("c4"); err != nil {
				return err
			}
			step := ""
			for deadline := time.Now().Add(6 * time.Minute); step == ""; time.Sleep(time.Second) {
				turns, err := r.modelTurns()
				if err != nil {
					return err
				}
				for _, turn := range turns[min(traced4, len(turns)):] {
					text := turnText(turn)
					if (turn["step"] == "coding/review-request" || turn["step"] == "coding/draft-plan") && strings.Contains(text, "t4.md") {
						if !strings.Contains(text, steer4) {
							return fmt.Errorf("T%d's next planning turn (%v) does not carry the steer", t4, turn["step"])
						}
						step = fmt.Sprint(turn["step"])
						break
					}
				}
				if step == "" && time.Now().After(deadline) {
					return fmt.Errorf("no planning turn of T%d after the steer in 6 min", t4)
				}
			}
			v, err := r.waitTodoWithin(t4, 8*time.Minute, "in_review")
			if err != nil {
				return err
			}
			if v.Run == nil || v.Run.ID != run4 || v.Run.Attempt != 1 {
				return fmt.Errorf("T%d in review on run %+v, want the steered run %s on attempt 1", t4, v.Run, run4)
			}
			r.actual = fmt.Sprintf("the next %s turn of run %s carries the steer; T%d in_review on attempt 1, PR #%d", step, run4, t4, v.PR.Number)
			return nil
		})
	run5, stopped := "", false
	r.step("10 Stop a working TODO", "POST /api/todos; POST /api/todos/{T5} {op: stop} ×2; SQL product_job_requests",
		"202 within 1 s; the same press again 202; T5 paused with its run cancelled and nothing restarted; a new press 409", "T-STK-05", func() error {
			var err error
			if t5, err = r.file("T5 stopped", "[HOLD c5] [FILE t5.md] Add a greeting to t5.md"); err != nil {
				return err
			}
			if err = r.waitHeld("c5", 8*time.Minute); err != nil {
				return err
			}
			v, err := r.waitTodoWithin(t5, time.Minute, "working")
			if err != nil {
				return err
			}
			if v.Run != nil {
				run5 = v.Run.ID
			}
			key := r.keyPrefix + "stop-t5"
			took, err := r.control(t5, `{"op":"stop"}`, key)
			if err != nil {
				return err
			}
			if _, err = r.waitTodoWithin(t5, 10*time.Second, "paused"); err != nil {
				return err
			}
			var live, cancelled int
			if err = r.pool.QueryRow(r.ctx, `SELECT count(*) FILTER (WHERE state IN ('accepted','dispatching','running','waiting') AND NOT cancellation_requested),
				count(*) FILTER (WHERE cancellation_requested OR state = 'cancelled')
				FROM product_job_requests WHERE request_id LIKE 'mythical:' || (SELECT id::text FROM mythical_items WHERE number = $1) || ':%'`, t5).Scan(&live, &cancelled); err != nil {
				return err
			}
			if live != 0 || cancelled == 0 {
				return fmt.Errorf("T%d paused with %d live runs and %d cancelled", t5, live, cancelled)
			}
			// The stack takes no step for a paused TODO.
			time.Sleep(10 * time.Second)
			if v, err = r.todo(t5); err != nil || v.State != "paused" {
				return fmt.Errorf("T%d is %s 10 s after Stop (%v), want paused", t5, v.State, err)
			}
			code, _, err := r.keyed("POST", fmt.Sprintf("/api/todos/%d", t5), `{"op":"stop"}`, key+"-again")
			if err != nil {
				return err
			}
			if code != 409 {
				return fmt.Errorf("a new Stop on a paused TODO: %s", r.actual)
			}
			stopped = true
			r.actual = fmt.Sprintf("202 in %dms; again 202; T%d paused; live runs 0, cancelled %d; still paused after 10 s; new press 409", took.Milliseconds(), t5, cancelled)
			return nil
		})
	r.step("11 Resume the paused TODO", "POST /api/todos/{T5} {op: resume} ×2; release [HOLD c5]; GET /api/todos/{T5}",
		"202 within 1 s; the same press again 202; T5 runs attempt 1 again on a new run and reaches review; a new press 409", "T-STK-05", func() error {
			if !stopped {
				return fmt.Errorf("blocked by row 10: T%d was not stopped", t5)
			}
			key := r.keyPrefix + "resume-t5"
			took, err := r.control(t5, `{"op":"resume"}`, key)
			if err != nil {
				return err
			}
			code, _, err := r.keyed("POST", fmt.Sprintf("/api/todos/%d", t5), `{"op":"resume"}`, key+"-again")
			if err != nil {
				return err
			}
			if code != 409 {
				return fmt.Errorf("a new Resume on a resumed TODO: %s", r.actual)
			}
			v, err := r.waitTodoWithin(t5, 2*time.Minute, "working")
			if err != nil {
				return err
			}
			if v.Run == nil || v.Run.ID == "" || v.Run.ID == run5 || v.Run.Attempt != 1 {
				return fmt.Errorf("T%d resumed on run %+v, want a new run of attempt 1 (stopped run %s)", t5, v.Run, run5)
			}
			resumed := v.Run.ID
			if err = r.release("c5"); err != nil {
				return err
			}
			if v, err = r.waitTodoWithin(t5, 8*time.Minute, "in_review"); err != nil {
				return err
			}
			r.actual = fmt.Sprintf("202 in %dms; again 202; new press 409; T%d working on run %s (attempt 1), then in_review, PR #%d", took.Milliseconds(), t5, resumed, v.PR.Number)
			return nil
		})
}

// control posts a TODO control twice under one Idempotency-Key, as the
// owner's browser does: 202 accepted within 1 s, and 202 again.
func (r *rehearsal) control(number int64, body, key string) (time.Duration, error) {
	path := fmt.Sprintf("/api/todos/%d", number)
	began := time.Now()
	code, data, err := r.keyed("POST", path, body, key)
	took := time.Since(began)
	if err != nil {
		return took, err
	}
	if code != 202 || !strings.Contains(string(data), `"accepted"`) {
		return took, fmt.Errorf("expected 202 accepted: %s", r.actual)
	}
	if took > time.Second {
		return took, fmt.Errorf("answered in %s, want within 1 s", took)
	}
	if code, _, err = r.keyed("POST", path, body, key); err != nil || code != 202 {
		return took, fmt.Errorf("the same press again: %s", r.actual)
	}
	return took, nil
}

// waitRequest waits until the dispatcher request whose id is like pattern
// reaches state; a failed one ends the wait with its receipt.
func (r *rehearsal) waitRequest(pattern, state string, within time.Duration) error {
	for deadline := time.Now().Add(within); ; time.Sleep(250 * time.Millisecond) {
		var got, receipt string
		err := r.pool.QueryRow(r.ctx, `SELECT state, coalesce(terminal_receipt::text, '') FROM product_job_requests WHERE request_id LIKE $1 ORDER BY created_at DESC LIMIT 1`, pattern).Scan(&got, &receipt)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if got == state {
			return nil
		}
		if got == "failed" || got == "cancelled" || got == "uncertain" {
			return fmt.Errorf("request %s ended %s: %s", pattern, got, receipt)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("request %s is %q after %s, want %s", pattern, got, within, state)
		}
	}
}
