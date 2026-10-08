package compose

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
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
// C-J11-01) on the install J1 sets up: T5 asks one question and fails its
// first check attempt (distribution/fake-todo-turns.mjs [ASK] [FAILONCE]),
// its run is read through its lane while it waits, the owner answers it, and
// T5 merges. Its run stays readable after the merge stops its lane: the
// monitor's graph, step I/O, transcript, retries, wait, titles and metered
// cost are read from the install as Inspect reads them.
func TestJ11Rehearsal(t *testing.T) {
	r := newRehearsal(t, "SMITHERS_J11_REHEARSAL", "C-J11", "j11-")
	if !r.install("0 Install through Machine ready") {
		return
	}
	var t5, pr int64
	head, branch, run, wait := "", "", "", ""
	if !r.step("1 T5 asks", "POST /api/todos; GET /api/todos/{T5}", "202; needs_you with one question", "T-STK-01", func() error {
		var err error
		if t5, err = r.file("T5 greets", "[ASK] [FAILONCE] [FILE t5.md] Add a greeting to t5.md"); err != nil {
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
	var answeredAt time.Time
	if !r.step("2 T5 in review after the answer", "POST /api/todos/{T5}/answer; GET /api/todos/{T5}; GitHub fake PR", "202; in_review; PR smithers/<slug> at the card's head, base main", "T-STK-01", func() error {
		answeredAt = time.Now()
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
	// read never wakes a sleeping branch (mvp.md §6 Sleep). The run is read
	// from its host's own answers, retained while the host was live
	// (run_archives); a todo plan is refused before any box wakes.
	r.step("6 Run summary", "POST /api/workflow/rpc on T5's stopped lane: Projection.Snapshot run-summary", "200 summary of the TODO run, finished", "T-FLW-07", func() error {
		summary, err := r.runSummary(rehearsalRepository, branch, run)
		if err != nil {
			return err
		}
		if !strings.Contains(summary, " completed, ") {
			return fmt.Errorf("the merged TODO's run is not finished: %s", summary)
		}
		r.actual = summary
		return nil
	})
	r.step("7 Run journal", "POST /api/workflow/rpc on T5's stopped lane: Projection.Snapshot run-events; SQL workspaces", "the run's events in order, read-only: the lane stays stopped", "T-FLW-07", func() error {
		journal, err := r.runJournal(rehearsalRepository, branch, run)
		if err != nil {
			return err
		}
		var status string
		if err := r.pool.QueryRow(r.ctx, `SELECT status FROM workspaces WHERE id=$1`, branch).Scan(&status); err != nil {
			return err
		}
		if status == "running" || status == "starting" || status == "resuming" {
			return fmt.Errorf("reading T%d's run woke its lane: %s", t5, status)
		}
		r.actual = fmt.Sprintf("%s; lane %s", journal, status)
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
		// The install serves one repository: the access check refuses any
		// other before the relay resolves a box, so nothing of T5's run leaks.
		var refusal struct {
			Code string `json:"code"`
		}
		if code != 403 || json.Unmarshal(data, &refusal) != nil || refusal.Code != "permission" || strings.Contains(string(data), run) {
			return fmt.Errorf("T%d's box read through %s: want 403 permission without the run", t5, other)
		}
		r.actual = fmt.Sprintf("%s: %s", other, r.actual)
		return nil
	})
	var inspected j11Monitor
	inspectedOK := r.step("10 Graph", "GET /api/runs/{lane}:{run} (Inspect → RunTraceCard)", "every step with its final state", "T-FLW-07", func() error {
		var err error
		if inspected, err = r.inspect(branch, run); err != nil {
			return err
		}
		if inspected.State != "done" || len(inspected.Attempts) == 0 || len(inspected.Attempts[0].Graph) == 0 || len(inspected.Attempts[0].Steps) == 0 {
			return fmt.Errorf("run %s is %s with %d attempts", inspected.ID, inspected.State, len(inspected.Attempts))
		}
		states := map[string]int{}
		for _, node := range inspected.Attempts[0].Graph {
			if node.State == "current" || node.State == "waiting" {
				return fmt.Errorf("finished run's node %q is still %s", node.Label, node.State)
			}
			states[node.State]++
		}
		for _, step := range inspected.Attempts[0].Steps {
			if step.EndedAt == "" || (step.State != "completed" && step.State != "failed" && step.State != "skipped") {
				return fmt.Errorf("step %s (%s) is %s, ended %q", step.Key, step.Label, step.State, step.EndedAt)
			}
		}
		r.actual = fmt.Sprintf("200 %s %s: %d steps, graph %v", inspected.ID, inspected.State, len(inspected.Attempts[0].Steps), states)
		return nil
	})
	r.step("11 Step I/O and transcript", "Inspect → the edit step", "its input, output and the agent transcript", "T-FLW-07", func() error {
		if !inspectedOK {
			return fmt.Errorf("blocked by row 10")
		}
		step, phase, ok := inspected.step("Edited the files")
		if !ok {
			return fmt.Errorf("no edit step among %v", inspected.labels())
		}
		if len(step.Input) == 0 || string(step.Input) == "null" || len(step.Output) == 0 || string(step.Output) == "null" {
			return fmt.Errorf("edit step %s has input %s and output %s", step.Key, step.Input, step.Output)
		}
		var thought, wrote int
		for _, cell := range phase.Cells {
			if cell.Kind == "think" && cell.Tokens > 0 && strings.Contains(cell.Quote, "```cell") {
				thought++
			}
			if cell.Kind == "edit" && cell.Label == "Wrote t5.md" && cell.Tone == "ok" {
				wrote++
			}
		}
		if thought == 0 || wrote == 0 {
			return fmt.Errorf("edit step's transcript %+v: want a model reply and 'Wrote t5.md'", phase.Cells)
		}
		r.actual = fmt.Sprintf("%s: input %s; output %s; %d cells, %d model replies, %d writes", step.Key, j11Excerpt(step.Input), j11Excerpt(step.Output), len(phase.Cells), thought, wrote)
		return nil
	})
	r.step("12 Retries", "Inspect → timeline ([FAILONCE]: the first edit leaves JOURNEY.md blank, so the slow check fails; its repair restores it)", "both check attempts, the first failed", "T-FLW-07", func() error {
		if !inspectedOK {
			return fmt.Errorf("blocked by row 10")
		}
		type attempt struct {
			title, status string
		}
		byCheck := map[string][]attempt{}
		for i, step := range inspected.Attempts[0].Steps {
			// A check step's output is its receipt, a preview the engine may
			// cut short after the leading fields.
			var preview string
			if step.Label != "Ran checks" || json.Unmarshal(step.Output, &preview) != nil {
				continue
			}
			receipt := j11Receipt.FindStringSubmatch(preview)
			if receipt == nil {
				continue
			}
			byCheck[receipt[1]] = append(byCheck[receipt[1]], attempt{inspected.Attempts[0].Phases[i].Title, receipt[2]})
		}
		for check, attempts := range byCheck {
			if len(attempts) >= 2 && attempts[0].status == "failed" && attempts[0].title == "Ran checks · 1 failed" && attempts[len(attempts)-1].status == "passed" {
				r.actual = fmt.Sprintf("check %s ran %d times: %+v", check, len(attempts), attempts)
				return nil
			}
		}
		return fmt.Errorf("no check failed first and passed later: %+v", byCheck)
	})
	r.step("13 Tokens and time", "Inspect → steps", "tokens and time per step", "T-FLW-07", func() error {
		if !inspectedOK {
			return fmt.Errorf("blocked by row 10")
		}
		priced := 0
		for _, step := range inspected.Attempts[0].Steps {
			if step.TookS == nil {
				return fmt.Errorf("step %s (%s) shows no time", step.Key, step.Label)
			}
			if step.Usage != nil {
				if step.Usage.Tokens <= 0 {
					return fmt.Errorf("step %s shows usage without tokens", step.Key)
				}
				priced++
			}
		}
		edit, _, _ := inspected.step("Edited the files")
		if edit.Usage == nil || priced == 0 || inspected.Tokens <= 0 {
			return fmt.Errorf("model steps show no tokens: edit %+v, %d priced, run %d tokens", edit.Usage, priced, inspected.Tokens)
		}
		r.actual = fmt.Sprintf("%d steps timed; %d with tokens; edit %d tokens in %.3fs; run %d tokens in %.1fs", len(inspected.Attempts[0].Steps), priced, edit.Usage.Tokens, *edit.TookS, inspected.Tokens, inspected.TimeS)
		return nil
	})
	r.step("14 Wait for the answer", "Inspect → waits", "the question with since, answered_by and its settle time", "T-FLW-07", func() error {
		if !inspectedOK {
			return fmt.Errorf("blocked by row 10")
		}
		for _, w := range inspected.Waits {
			if w.Kind != "question" || w.ID != wait {
				continue
			}
			since, err := time.Parse(time.RFC3339Nano, w.Since)
			if err != nil || w.Settled == nil {
				return fmt.Errorf("question %s: since %q, settled %+v", w.ID, w.Since, w.Settled)
			}
			settled, err := time.Parse(time.RFC3339Nano, w.Settled.At)
			if err != nil || !since.Before(answeredAt) || settled.Before(answeredAt.Add(-time.Second)) || settled.After(answeredAt.Add(30*time.Second)) {
				return fmt.Errorf("question since %s settled %s; answered at %s", w.Since, w.Settled.At, answeredAt.UTC().Format(time.RFC3339Nano))
			}
			if w.Settled.By["kind"] == "system" || len(w.Settled.By) == 0 {
				return fmt.Errorf("question settled by %v, want the owner", w.Settled.By)
			}
			r.actual = fmt.Sprintf("%q since %s; answered by %v at %s (%s later)", w.Label, w.Since, w.Settled.By, w.Settled.At, settled.Sub(since).Round(time.Second))
			return nil
		}
		return fmt.Errorf("no question %s among waits %+v", wait, inspected.Waits)
	})
	r.step("15 Titles and /monitor", "Inspect; GET /api/runs (/monitor)", "Appendix C step titles, one Engine row; /monitor lists the TODO run with Inspect", "T-FLW-07", func() error {
		if !inspectedOK {
			return fmt.Errorf("blocked by row 10")
		}
		for _, label := range inspected.labels() {
			if strings.HasPrefix(label, "<") || strings.Contains(label, "/") || label == "" {
				return fmt.Errorf("a step shows its raw tag %q", label)
			}
		}
		for _, want := range []string{"Edited the files"} {
			if !slices.Contains(inspected.labels(), want) {
				return fmt.Errorf("no step titled %q among %v", want, inspected.labels())
			}
		}
		if len(inspected.Engine) == 0 {
			return fmt.Errorf("no Engine row")
		}
		data, err := r.expect("GET", "/api/runs", "", 200)
		if err != nil {
			return err
		}
		var listed []struct {
			ID          string `json:"id"`
			Title       string `json:"title"`
			State       string `json:"state"`
			Unavailable bool   `json:"unavailable"`
		}
		if err := json.Unmarshal(data, &listed); err != nil {
			return err
		}
		for _, row := range listed {
			if row.ID == branch+":"+run {
				if row.Unavailable || row.State != "done" || row.Title == "" {
					return fmt.Errorf("/monitor lists T%d's run as %+v", t5, row)
				}
				r.actual = fmt.Sprintf("titles %v; Engine row of %d entries; /monitor lists %d runs, %s %s %q", inspected.labels(), len(inspected.Engine), len(listed), row.ID, row.State, row.Title)
				return nil
			}
		}
		return fmt.Errorf("/monitor lists %d runs, not %s:%s", len(listed), branch, run)
	})
	r.step("16 Per-step cost", "Inspect → steps; SQL model_usage (the proxy's metered rows on T5's lane)", "each step's cost sums to the run's metered total", "T-FLW-07", func() error {
		if !inspectedOK {
			return fmt.Errorf("blocked by row 10")
		}
		var steps float64
		priced := 0
		for _, step := range inspected.Attempts[0].Steps {
			if step.Usage != nil {
				steps += step.Usage.CostUSD
				priced++
			}
		}
		var metered int64
		var calls, unattributed int
		if err := r.pool.QueryRow(r.ctx, `SELECT COALESCE(SUM(cost_nanos),0)::bigint, count(*), count(*) FILTER (WHERE native_step IS NULL)
			FROM model_usage WHERE workspace_id=$1 AND source='flow_host'`, branch).Scan(&metered, &calls, &unattributed); err != nil {
			return err
		}
		if inspected.CostUSD == nil || priced == 0 || metered <= 0 || unattributed != 0 ||
			math.Round(steps*1e9) != float64(metered) || math.Round(*inspected.CostUSD*1e9) != float64(metered) {
			return fmt.Errorf("steps sum to $%.9f over %d steps, run $%v; the proxy metered %d nanodollars over %d calls (%d unattributed)", steps, priced, inspected.CostUSD, metered, calls, unattributed)
		}
		r.actual = fmt.Sprintf("%d priced steps sum to $%.6f = run total = %d metered nanodollars over %d proxy calls", priced, steps, metered, calls)
		return nil
	})
	r.step("17 Live step states", "GET /api/live run:<id> → browser LiveChannel (SQLite host journal)", "50 step changes after a 24 MB transcript; append-to-frame p95 <= 1 s", "T-FLW-07", func() error {
		actual, err := liveJournalLatency(t)
		r.actual = actual
		return err
	})
}

// j11Receipt reads a check receipt's id and status from its leading fields.
var j11Receipt = regexp.MustCompile(`^\{"checkId":"([^"\\]*)"(?:,"[A-Za-z]+":(?:"[^"\\]*"|-?\d+))*,"status":"(passed|failed|superseded)"`)

// j11Monitor is the install monitor of one run (GET /api/runs/{id}), as the
// Run View reads it (packages/rpc/src/MonitorCard.ts).
type j11Monitor struct {
	ID       string `json:"id"`
	State    string `json:"state"`
	Attempts []struct {
		N     int    `json:"n"`
		RunID string `json:"run_id"`
		Graph []struct {
			ID    string `json:"id"`
			Label string `json:"label"`
			State string `json:"state"`
		} `json:"graph"`
		Steps  []j11Step  `json:"steps"`
		Phases []j11Phase `json:"phases"`
	} `json:"attempts"`
	Waits []struct {
		ID      string `json:"id"`
		Kind    string `json:"kind"`
		Label   string `json:"label"`
		Since   string `json:"since"`
		Settled *struct {
			By map[string]any `json:"by"`
			At string         `json:"at"`
		} `json:"settled"`
	} `json:"waits"`
	Tokens  int64    `json:"tokens"`
	TimeS   float64  `json:"time_s"`
	CostUSD *float64 `json:"cost_usd"`
	Engine  []struct {
		Label string `json:"label"`
	} `json:"engine"`
}

type j11Step struct {
	Key     string          `json:"key"`
	Label   string          `json:"label"`
	State   string          `json:"state"`
	EndedAt string          `json:"ended_at"`
	TookS   *float64        `json:"took_s"`
	Input   json.RawMessage `json:"input"`
	Output  json.RawMessage `json:"output"`
	Usage   *struct {
		Tokens  int64   `json:"tokens"`
		CostUSD float64 `json:"cost_usd"`
	} `json:"usage"`
}

type j11Phase struct {
	Step  string `json:"step"`
	Title string `json:"title"`
	Cells []struct {
		Kind   string `json:"kind"`
		Label  string `json:"label"`
		Quote  string `json:"quote"`
		Tokens int64  `json:"tokens"`
		Tone   string `json:"tone"`
	} `json:"cells"`
}

// inspect reads one run's monitor as the owner's Inspect does.
func (r *rehearsal) inspect(lane, run string) (j11Monitor, error) {
	var monitor j11Monitor
	request, err := http.NewRequest("GET", r.origin+"/api/runs/"+lane+":"+run, nil)
	if err != nil {
		return monitor, err
	}
	request.Header.Set("Origin", r.origin)
	response, err := r.client.Do(request)
	if err != nil {
		return monitor, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 32<<20))
	if err != nil {
		return monitor, err
	}
	r.actual = fmt.Sprintf("%d %d bytes", response.StatusCode, len(data))
	if response.StatusCode != 200 {
		return monitor, fmt.Errorf("inspect %s:%s: HTTP %d %s", lane, run, response.StatusCode, j11Excerpt(data))
	}
	_ = os.WriteFile(filepath.Join(r.evidence, "inspect-"+run+".json"), data, 0600)
	if err := json.Unmarshal(data, &monitor); err != nil {
		return monitor, err
	}
	if monitor.ID != lane+":"+run {
		return monitor, fmt.Errorf("monitor of %s:%s names %s", lane, run, monitor.ID)
	}
	return monitor, nil
}

// step is the first attempt's step titled label, with its phase.
func (m j11Monitor) step(label string) (j11Step, j11Phase, bool) {
	if len(m.Attempts) == 0 {
		return j11Step{}, j11Phase{}, false
	}
	for _, step := range m.Attempts[0].Steps {
		if step.Label != label {
			continue
		}
		for _, phase := range m.Attempts[0].Phases {
			if phase.Step == step.Key {
				return step, phase, true
			}
		}
	}
	return j11Step{}, j11Phase{}, false
}

// labels are the first attempt's step titles, in order.
func (m j11Monitor) labels() []string {
	labels := []string{}
	if len(m.Attempts) > 0 {
		for _, step := range m.Attempts[0].Steps {
			labels = append(labels, step.Label)
		}
	}
	return labels
}

func j11Excerpt(raw json.RawMessage) string {
	text := string(raw)
	if len(text) > 60 {
		return text[:60] + "…"
	}
	return text
}
