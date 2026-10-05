package compose

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

// rehearsalRepository is the install's repository (newRehearsal).
const rehearsalRepository = "rehearsal-owner/app"

// relay sends one browser flow relay call as the owner's browser, naming the
// box, with its own Idempotency-Key. A read of a box whose coding host is
// starting answers "provisioning"; it is polled as the app polls it
// (gateway.ts), for up to two minutes.
func (r *rehearsal) relay(repo, box, procedure, payload string) (int, []byte, error) {
	body := fmt.Sprintf(`{"repo":%q,"workspaceId":%q,"procedure":%q,"payload":%s}`, repo, box, procedure, payload)
	deadline := time.Now().Add(2 * time.Minute)
	for attempt := 1; ; attempt++ {
		code, data, err := r.keyed("POST", "/api/workflow/rpc", body, fmt.Sprintf("%srelay-%s-%d-%d", r.keyPrefix, procedure, time.Now().UnixNano(), attempt))
		if err != nil || code != 200 || !bytes.Contains(data, []byte(`"status":"provisioning"`)) || time.Now().After(deadline) {
			return code, data, err
		}
		time.Sleep(2 * time.Second)
	}
}

// runSummary reads run's summary on box through the relay: one row, naming
// run and its flow.
func (r *rehearsal) runSummary(repo, box, run string) (string, error) {
	code, data, err := r.relay(repo, box, "Projection.Snapshot", fmt.Sprintf(`{"selector":{"_tag":"run-summary","runId":%q}}`, run))
	if err != nil {
		return "", err
	}
	var answer struct {
		OK      bool `json:"ok"`
		Payload struct {
			Rows []struct {
				RunID  string `json:"runId"`
				FlowID string `json:"flowId"`
				Status string `json:"status"`
				Turns  int    `json:"turns"`
			} `json:"rows"`
		} `json:"payload"`
	}
	if code != 200 || json.Unmarshal(data, &answer) != nil || !answer.OK || len(answer.Payload.Rows) != 1 {
		return "", fmt.Errorf("summary of run %q on box %s: want one row", run, box)
	}
	row := answer.Payload.Rows[0]
	if row.RunID != run || row.FlowID == "" {
		return "", fmt.Errorf("summary of run %q names run %s of flow %s", run, row.RunID, row.FlowID)
	}
	return fmt.Sprintf("200 run %s flow %s %s, %d turns", row.RunID, row.FlowID, row.Status, row.Turns), nil
}

// runJournal reads run's journal on box through the relay: its events, of
// that run alone, in sequence order.
func (r *rehearsal) runJournal(repo, box, run string) (string, error) {
	code, data, err := r.relay(repo, box, "Projection.Snapshot", fmt.Sprintf(`{"selector":{"_tag":"run-events","runId":%q}}`, run))
	if err != nil {
		return "", err
	}
	var answer struct {
		OK      bool `json:"ok"`
		Payload struct {
			Rows []struct {
				Sequence int64  `json:"sequence"`
				Kind     string `json:"kind"`
				RunID    string `json:"runId"`
			} `json:"rows"`
		} `json:"payload"`
	}
	if code != 200 || json.Unmarshal(data, &answer) != nil || !answer.OK || len(answer.Payload.Rows) == 0 {
		return "", fmt.Errorf("journal of run %q on box %s: want its events", run, box)
	}
	rows := answer.Payload.Rows
	for n, row := range rows {
		if row.RunID != "" && row.RunID != run {
			return "", fmt.Errorf("journal of run %s holds run %s's event %d", run, row.RunID, row.Sequence)
		}
		if n > 0 && row.Sequence <= rows[n-1].Sequence {
			return "", fmt.Errorf("journal of run %s out of order: %d after %d", run, row.Sequence, rows[n-1].Sequence)
		}
	}
	return fmt.Sprintf("200 %d events, %d %s .. %d %s", len(rows), rows[0].Sequence, rows[0].Kind, rows[len(rows)-1].Sequence, rows[len(rows)-1].Kind), nil
}

// refusedOnRun sends one write through the relay on box and wants it refused
// as 403 todo_requires_stack_admission: a TODO's lane is the stack's, and the
// todo composition runs only from the stack's pinned launch.
func (r *rehearsal) refusedOnRun(repo, box, procedure, payload string) (string, error) {
	code, data, err := r.relay(repo, box, procedure, payload)
	if err != nil {
		return "", err
	}
	var refusal struct {
		Code string `json:"code"`
	}
	if code != 403 || json.Unmarshal(data, &refusal) != nil || refusal.Code != "todo_requires_stack_admission" {
		return "", fmt.Errorf("%s on box %s: want 403 todo_requires_stack_admission", procedure, box)
	}
	return procedure + " 403 " + refusal.Code, nil
}

// TestJ11Rehearsal walks journey J11 (mvp.md §5, look under the hood;
// C-J11-01) on the install J1 sets up: T5 asks one question
// (distribution/fake-todo-turns.mjs [ASK]), its run is read through its
// lane while it waits, the owner answers it, and T5 merges. Its run and its
// lane stay readable after the merge. The monitor's rows wait on their lanes
// and are listed as pending.
func TestJ11Rehearsal(t *testing.T) {
	r := newRehearsal(t, "SMITHERS_J11_REHEARSAL", "C-J11", "j11-")
	if !r.install("0 Install through Machine ready") {
		return
	}
	var t5, pr int64
	head, branch, run, wait := "", "", "", ""
	var since, observed, answeredAt time.Time
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
		if v.Branch == nil || v.Branch.ID == "" || v.Run == nil || v.Run.ID == "" {
			return fmt.Errorf("T%d needs you with branch %+v and run %+v", t5, v.Branch, v.Run)
		}
		wait, branch, run = v.Waits[0].ID, v.Branch.ID, v.Run.ID
		since, observed = v.Waits[0].Since, time.Now()
		return nil
	}) {
		return
	}
	// T5's run lives on its lane: a branch machine the machine service owns,
	// shared with the owner alone. While the lane is awake (here, while T5
	// waits on its question) the app reads the run through the browser flow
	// relay, as the owner, naming that box. The relay only reads a lane: a
	// write on the run is refused before it reaches the host.
	r.step("1b Run through its lane's relay", "POST /api/workflow/rpc on T5's lane while it needs you: Projection.Snapshot run-summary and run-events; Run resume of the run",
		"200 summary of the TODO run; its events in order; 403 todo_requires_stack_admission", "T-FLW-07", func() error {
			summary, err := r.runSummary(rehearsalRepository, branch, run)
			if err != nil {
				return err
			}
			journal, err := r.runJournal(rehearsalRepository, branch, run)
			if err != nil {
				return err
			}
			refused, err := r.refusedOnRun(rehearsalRepository, branch, "Run", fmt.Sprintf(`{"_tag":"Resume","runId":%q,"idempotencyKey":"j11-resume"}`, run))
			if err != nil {
				return err
			}
			r.actual = strings.Join([]string{summary, journal, refused}, "; ")
			return nil
		})
	if !r.step("2 T5 in review after the answer", "POST /api/todos/{T5}/answer; GET /api/todos/{T5}; GitHub fake PR", "202; in_review; PR smithers/<slug> at the card's head, base main", "T-STK-01", func() error {
		alice, err := r.member("alice", 202, "pull")
		if err != nil {
			return err
		}
		time.Sleep(2 * time.Second)
		answeredAt = time.Now()
		code, data, err := r.keyedAs(alice, "POST", fmt.Sprintf("/api/todos/%d/answer", t5), fmt.Sprintf(`{"wait":%q,"answer":"Say hello in Spanish"}`, wait), "j11-alice-answer")
		if err != nil || code != 202 {
			return fmt.Errorf("answer: HTTP %d %s %v", code, data, err)
		}
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
		run = v.Run.ID
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
	// The merge retires T5's lane and stops its machine (releaseLane), and a
	// read never wakes a sleeping branch (mvp.md §6 Sleep): reading the run
	// after the merge needs a source other than the lane's host. A todo plan
	// is refused before any box wakes.
	r.pending("6 Run summary", "browser flow relay: run summary of T5's lane, stopped at the merge", "200 summary of the TODO run", "T-FLW-07", "live-slice")
	r.pending("7 Run journal", "browser flow relay: journal of T5's lane, stopped at the merge", "the run's events in order, read-only", "T-FLW-07", "live-slice")
	r.step("8 Read-only", "POST /api/workflow/rpc Plan todo on T5's lane after the merge", "403 todo_requires_stack_admission", "T-FLW-07", func() error {
		refused, err := r.refusedOnRun(rehearsalRepository, branch, "Plan", `{"flowId":"todo","input":{}}`)
		r.actual = refused
		return err
	})
	r.step("9 No cross-repository read", "SQL: a second repository of the owner; POST /api/workflow/rpc naming it with T5's lane box", "refused", "T-FLW-07", func() error {
		if _, err := r.pool.Exec(r.ctx, `INSERT INTO repositories(user_id,org_id,name,lower_name,is_public,default_bookmark)
			SELECT user_id,org_id,'other','other',false,'main' FROM repositories WHERE id=(SELECT repository_id FROM workspaces WHERE id=$1)
			ON CONFLICT DO NOTHING`, branch); err != nil {
			return err
		}
		other := strings.Split(rehearsalRepository, "/")[0] + "/other"
		code, data, err := r.relay(other, branch, "Projection.Snapshot", fmt.Sprintf(`{"selector":{"_tag":"run-summary","runId":%q}}`, run))
		if err != nil {
			return err
		}
		if code != 404 || !strings.Contains(string(data), "Box unavailable.") {
			return fmt.Errorf("T%d's box read through %s: want 404 Box unavailable.", t5, other)
		}
		r.actual = fmt.Sprintf("%s: %s", other, r.actual)
		return nil
	})
	r.pending("10 Graph", "Inspect → RunTraceCard", "every step with its final state", "T-FLW-07", "inspect-run-trace")
	r.pending("11 Step I/O and transcript", "Inspect → implement", "input, output and the agent transcript", "T-FLW-07", "inspect-run-trace")
	r.pending("12 Retries", "Inspect → timeline", "both check attempts, the first failed", "T-FLW-07", "inspect-run-trace")
	r.pending("13 Tokens and time", "Inspect → steps", "tokens and time per step", "T-FLW-07", "inspect-run-trace")
	r.step("14 Wait for the answer", "GET /api/todos/{T5} after merge", "original since; answered_by alice; settled duration within 5 s of the observed delay; no Answer", "T-FLW-07", func() error {
		v, err := r.todo(t5)
		if err != nil {
			return err
		}
		for _, w := range v.Waits {
			if w.ID != wait {
				continue
			}
			if !w.Since.Equal(since) || w.SettledAt == nil || w.AnsweredBy != "alice" || len(w.Actions) != 0 {
				return fmt.Errorf("settled question: %+v", w)
			}
			duration := w.SettledAt.Sub(w.Since)
			delta := duration - answeredAt.Sub(observed)
			if delta < -5*time.Second || delta > 5*time.Second || duration < 2*time.Second {
				return fmt.Errorf("duration %s; observed %s", duration, answeredAt.Sub(observed))
			}
			r.actual = fmt.Sprintf("alice; since %s; settled %s; duration %s; observed delay %s; no Answer", w.Since.Format(time.RFC3339Nano), w.SettledAt.Format(time.RFC3339Nano), duration, answeredAt.Sub(observed))
			return nil
		}
		return fmt.Errorf("merged T%d lost wait %s", t5, wait)
	})
	r.pending("15 Titles and /monitor", "Inspect; /monitor", "Appendix C step titles, one Engine row; /monitor lists the TODO run with Inspect", "T-FLW-07", "monitor-labels")
	r.pending("16 Per-step cost", "Inspect → steps; model proxy usage", "each step's cost sums to the run's metered total", "T-FLW-07", "step-cost")
	r.pending("17 Live step states", "GET /api/live run:<id>", "a step state change arrives within 1 s", "T-FLW-07", "live-slice")
}
