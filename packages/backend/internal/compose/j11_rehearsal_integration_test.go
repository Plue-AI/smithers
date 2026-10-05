package compose

import (
	"bytes"
	"encoding/json"
	"fmt"
	"slices"
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
func (r *rehearsal) runJournal(repo, box, run string) (string, int64, error) {
	code, data, err := r.relay(repo, box, "Projection.Snapshot", fmt.Sprintf(`{"selector":{"_tag":"run-events","runId":%q}}`, run))
	if err != nil {
		return "", 0, err
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
		return "", 0, fmt.Errorf("journal of run %q on box %s: want its events", run, box)
	}
	rows := answer.Payload.Rows
	for n, row := range rows {
		if row.RunID != "" && row.RunID != run {
			return "", 0, fmt.Errorf("journal of run %s holds run %s's event %d", run, row.RunID, row.Sequence)
		}
		if n > 0 && row.Sequence <= rows[n-1].Sequence {
			return "", 0, fmt.Errorf("journal of run %s out of order: %d after %d", run, row.Sequence, rows[n-1].Sequence)
		}
	}
	last := rows[len(rows)-1]
	return fmt.Sprintf("200 %d events, %d %s .. %d %s", len(rows), rows[0].Sequence, rows[0].Kind, last.Sequence, last.Kind), last.Sequence, nil
}

// laneStatus is a lane's machine state as the install records it.
func (r *rehearsal) laneStatus(box string) (string, error) {
	var status string
	err := r.pool.QueryRow(r.ctx, `SELECT status FROM workspaces WHERE id=$1`, box).Scan(&status)
	return status, err
}

// liveRun is what row 17 reads of a run:<lane>:<run> snapshot.
type liveRun struct {
	Run struct {
		Status string `json:"status"`
	} `json:"run"`
	Steps []struct {
		NodeID    string   `json:"nodeId"`
		Status    string   `json:"status"`
		StartedAt float64  `json:"startedAt"`
		EndedAt   *float64 `json:"endedAt"`
	} `json:"steps"`
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
		return nil
	}) {
		return
	}
	// The owner's browser follows T5's run over /api/live from here on;
	// row 17 reads what it received while the answer resumed the run.
	runTopic := fmt.Sprintf("run:%s:%s", branch, run)
	owner, liveErr := r.openLive(r.jar)
	if liveErr == nil {
		_, liveErr = owner.subscribe(runTopic)
	}
	// The source: the lane's host, read through the relay as the app reads
	// it, every 100 ms until the merge.
	stopWatching := r.watchSteps(rehearsalRepository, branch, run)
	var source map[string]time.Time
	var journal1b int64
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
			journal, through, err := r.runJournal(rehearsalRepository, branch, run)
			if err != nil {
				return err
			}
			journal1b = through
			refused, err := r.refusedOnRun(rehearsalRepository, branch, "Run", fmt.Sprintf(`{"_tag":"Resume","runId":%q,"idempotencyKey":"j11-resume"}`, run))
			if err != nil {
				return err
			}
			r.actual = strings.Join([]string{summary, journal, refused}, "; ")
			return nil
		})
	if !r.step("2 T5 in review after the answer", "POST /api/todos/{T5}/answer; GET /api/todos/{T5}; GitHub fake PR", "202; in_review; PR smithers/<slug> at the card's head, base main", "T-STK-01", func() error {
		code, data, err := r.answer(t5, wait, "Say hello in Spanish")
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
	source = stopWatching()
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
	// The install kept the run's projections while its lane ran (and as the
	// stack stopped it), so the stopped lane's run reads without waking it.
	// The merged card names the lane its run ran on (row 1's, not the
	// review's machine row 2 saw), as Inspect reads it.
	lane := ""
	r.step("6 Run summary", "browser flow relay: run summary of T5's lane, stopped at the merge", "200 summary of the TODO run", "T-FLW-07", func() error {
		v, err := r.todo(t5)
		if err != nil {
			return err
		}
		if v.Branch == nil || v.Branch.ID == "" {
			return fmt.Errorf("merged T%d names no branch", t5)
		}
		lane = v.Branch.ID
		status, err := r.laneStatus(lane)
		if err != nil {
			return err
		}
		if status == "running" {
			return fmt.Errorf("T%d's lane %s still runs after the merge", t5, lane)
		}
		summary, err := r.runSummary(rehearsalRepository, lane, run)
		if err != nil {
			return err
		}
		r.actual = fmt.Sprintf("lane %s %s; %s", lane, status, summary)
		return nil
	})
	r.step("7 Run journal", "browser flow relay: journal of T5's lane, stopped at the merge", "the run's events in order, read-only", "T-FLW-07", func() error {
		if lane == "" {
			return fmt.Errorf("blocked by row 6: no lane")
		}
		journal, through, err := r.runJournal(rehearsalRepository, lane, run)
		if err != nil {
			return err
		}
		// Kept at the lane's stop, after the answer: later than row 1b's read.
		if through <= journal1b {
			return fmt.Errorf("journal ends at %d, no later than the read while T%d needed you (%d)", through, t5, journal1b)
		}
		r.actual = journal
		return nil
	})
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
	r.pending("14 Wait for the answer", "Inspect → waits", "the question with since, answered_by and its settle time", "T-FLW-07", "monitor-waits")
	r.pending("15 Titles and /monitor", "Inspect; /monitor", "Appendix C step titles, one Engine row; /monitor lists the TODO run with Inspect", "T-FLW-07", "monitor-labels")
	r.pending("16 Per-step cost", "Inspect → steps; model proxy usage", "each step's cost sums to the run's metered total", "T-FLW-07", "step-cost")
	r.step("17 Live step states", "GET /api/live run:<lane>:<run> while the answer resumes T5's run; the lane's run-tree through the relay every 100 ms", "a step state change arrives within 1 s of its source", "T-FLW-07, T-COL-02", func() error {
		if liveErr != nil {
			return liveErr
		}
		// A step state change is a step that starts or ends after the first
		// snapshot. Its lag is its arrival on run:<lane>:<run> minus when the
		// lane's host first answered it (C-PERF-02: from the committed fact
		// to the subscriber); the host's own time is reported beside it.
		seen := map[string]bool{}
		var lags, hostLags []time.Duration
		snaps, changes := 0, 0
		for _, frame := range owner.received(runTopic) {
			if frame.T == "err" {
				return fmt.Errorf("%s refused: %s", runTopic, frame.Code)
			}
			if frame.T != "snap" {
				continue
			}
			var model liveRun
			if err := json.Unmarshal(frame.Data, &model); err != nil {
				return err
			}
			for _, row := range model.Steps {
				key := stepKey(row.NodeID, row.Status, row.EndedAt != nil)
				if seen[key] {
					continue
				}
				seen[key] = true
				if snaps == 0 {
					continue
				}
				changes++
				at := row.StartedAt
				if row.EndedAt != nil {
					at = *row.EndedAt
				}
				hostLags = append(hostLags, frame.At.Sub(time.UnixMilli(int64(at))))
				if first, ok := source[key]; ok {
					lags = append(lags, frame.At.Sub(first))
				}
			}
			snaps++
		}
		if len(lags) == 0 {
			return fmt.Errorf("%d snapshots of %s, %d step changes, none the source poll saw", snaps, runTopic, changes)
		}
		pct := func(values []time.Duration, p int) time.Duration {
			sorted := slices.Clone(values)
			slices.Sort(sorted)
			return sorted[(len(sorted)*p+99)/100-1].Round(time.Millisecond)
		}
		r.actual = fmt.Sprintf("%d snapshots, %d step changes; after the source: p50 %s p95 %s max %s; after the step's own time: p50 %s p95 %s",
			snaps, len(lags), pct(lags, 50), pct(lags, 95), pct(lags, 100), pct(hostLags, 50), pct(hostLags, 95))
		if p95 := pct(lags, 95); p95 > time.Second {
			return fmt.Errorf("step changes reach %s at p95 %s after the source, want within 1 s", runTopic, p95)
		}
		return nil
	})
}
