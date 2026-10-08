package compose

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

// This drives the installed HTTP door, stack worker, check launcher and GitHub
// fake. The machine runtime is the existing rehearsal process boundary; it is
// not microVM or broker freeze evidence.
func TestRebaseNowRehearsal(t *testing.T) { testRebaseNowRehearsal(t, false) }

// Keep the complete person-initiated PR/card proof independently runnable;
// absence and checkpoint acceptance must not conceal its passing receipt.
func TestRebaseNowExplicitRehearsal(t *testing.T) { testRebaseNowRehearsal(t, true) }

func testRebaseNowRehearsal(t *testing.T, explicitOnly bool) {
	t.Setenv("TRACE_MESSAGES", "1")
	r := newRehearsal(t, "SMITHERS_REBASE_REHEARSAL", "C-J10-04", "rebase-now-")
	if !r.setupSource() || !r.setupMachine() {
		return
	}

	var n int64
	if !r.step("Reviewed TODO", "POST /api/todos; GET /api/todos/{n}", "In review with a pull request", "T-STK-08", func() error {
		var err error
		if err = r.waitStackActive(); err != nil {
			return err
		}
		n, err = r.file("First TODO", "Add a greeting to JOURNEY.md")
		if err != nil {
			return err
		}
		_, err = r.waitTodoWithin(n, j10RunWait, "in_review")
		return err
	}) {
		return
	}

	if !r.step("Rebase now with browser presence", "POST /api/branches/{b} {rebase:true}; GET /api/todos/{n}; GitHub fake", "one clean rebase, same PR, new head, checks rerun", "T-STK-08", func() error { _, err := r.rebaseNowBranch(n); return err }) {
		return
	}
	if explicitOnly {
		return
	}
	if !r.step("Rebase at a checkpoint without people", "GitHub main sync; GET /api/todos/{n}; GitHub fake", "clean rebase without a person acting, same PR, new head", "T-STK-08", func() error { return r.rebaseCheckpoint(n) }) {
		return
	}
	if !r.step("Rebase after browser departure", "POST /api/live presence; GitHub main sync", "hold while present, one clean rebase within 60 s of departure, same PR", "T-STK-08", func() error { _, err := r.rebaseBranch(n, false); return err }) {
		return
	}
}

func (r *rehearsal) rebaseCheckpoint(n int64) error {
	before, err := r.todo(n)
	if err != nil {
		return err
	}
	main, err := r.pushMain("CHECKPOINT-REBASE.md", "checkpoint main change\n", "Main moves at a checkpoint")
	if err != nil {
		return err
	}
	for deadline := time.Now().Add(j10RunWait); ; time.Sleep(time.Second) {
		card, err := r.todo(n)
		if err != nil {
			return err
		}
		if card.State == "failed" {
			return fmt.Errorf("checkpoint rebase failed: %+v", card)
		}
		if card.State == "in_review" && card.PR.Head != before.PR.Head && card.Merge.State == "ready" {
			pull, err := r.readFakePull(card.PR.Number)
			if err != nil {
				return err
			}
			parent, err := r.githubGit("rev-parse", pull.Head.SHA+"^")
			if err != nil {
				return err
			}
			if card.PR.Number != before.PR.Number || card.PR.Head != pull.Head.SHA || parent != main {
				return fmt.Errorf("checkpoint PR binding differs: %+v parent=%s main=%s", card.PR, parent, main)
			}
			// The preceding explicit press must not lend its requester to this
			// automatic rewrite. Observe committed activity independently of the
			// PR, which could otherwise conceal duplicate worker execution.
			var count int
			var system, requester string
			if err = r.pool.QueryRow(r.t.Context(), `SELECT count(*),COALESCE(MAX(data->'actor'->>'id'),''),COALESCE(MAX(data->'by'->>'person'),'')
 FROM product_job_events WHERE event_type='todo.rebased' AND (data->>'n')::bigint=$1 AND data->>'onto'=$2`, n, main).Scan(&count, &system, &requester); err != nil {
				return err
			}
			if count != 1 || system != "stack" || requester != "" {
				return fmt.Errorf("checkpoint activity: %d completions, system %q, requester %q", count, system, requester)
			}
			if card.Branch == nil {
				return fmt.Errorf("checkpoint TODO lost its branch")
			}
			data, err := r.expect("GET", "/api/branches/"+url.PathEscape(card.Branch.ID), "", 200)
			if err != nil {
				return err
			}
			var branch struct {
				Head string `json:"head"`
			}
			if err = json.Unmarshal(data, &branch); err != nil {
				return err
			}
			var candidate string
			if err = r.pool.QueryRow(r.t.Context(), `SELECT candidate_head FROM mythical_items WHERE number=$1 AND source IN ('todo','issue')`, n).Scan(&candidate); err != nil {
				return err
			}
			if branch.Head != candidate {
				return fmt.Errorf("checkpoint Branch head %s differs from candidate %s", branch.Head, candidate)
			}
			r.actual = fmt.Sprintf("T%d PR #%d %s → %s on %s; one system rebase; branch head %s", n, card.PR.Number, short7(before.PR.Head), short7(card.PR.Head), short7(main), short7(branch.Head))
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("checkpoint did not rebase: %+v", card)
		}
	}
}

func (r *rehearsal) rebaseNowBranch(n int64) (string, error) {
	return r.rebaseBranch(n, true)
}

func TestRebaseConflictRehearsal(t *testing.T) {
	r := newRehearsal(t, "SMITHERS_REBASE_REHEARSAL", "C-J7-03", "rebase-conflict-")
	if !r.setupSource() || !r.setupMachine() {
		return
	}
	var n int64
	var run string
	var attempt int32
	if !r.step("Reviewed TODO", "POST /api/todos; GET /api/todos/{n}", "In review with a pull request", "T-STK-08", func() error {
		if err := r.waitStackActive(); err != nil {
			return err
		}
		var err error
		n, err = r.file("First TODO", "Add a greeting to JOURNEY.md")
		if err != nil {
			return err
		}
		if _, err = r.waitTodoWithin(n, j10RunWait, "in_review"); err != nil {
			return err
		}
		return r.pool.QueryRow(r.t.Context(), `SELECT request_run_id,attempt FROM mythical_items WHERE number=$1 AND source='todo'`, n).Scan(&run, &attempt)
	}) {
		return
	}
	r.step("Agent resolves the rebase in the same attempt", "POST /api/branches/{b} {rebase:true}; coding host; GitHub fake", "one repair in the same pinned attempt, both sides retained, same PR updated", "T-STK-08", func() error {
		if _, err := r.rebaseBranchWithMain(n, true, "JOURNEY.md", "Greeting from new main\n"); err != nil {
			return err
		}
		var currentRun string
		var currentAttempt int32
		if err := r.pool.QueryRow(r.t.Context(), `SELECT request_run_id,attempt FROM mythical_items WHERE number=$1 AND source='todo'`, n).Scan(&currentRun, &currentAttempt); err != nil {
			return err
		}
		if currentRun != run || currentAttempt != attempt {
			return fmt.Errorf("conflict replaced TODO run/attempt: %s/%d → %s/%d", run, attempt, currentRun, currentAttempt)
		}
		card, err := r.todo(n)
		if err != nil {
			return err
		}
		content, err := r.githubGit("show", card.PR.Head+":JOURNEY.md")
		if err != nil {
			return err
		}
		if !strings.Contains(content, "Greeting from new main") || !strings.Contains(content, "Hello from Smithers!") {
			return fmt.Errorf("conflict lost a side: %q", content)
		}
		var launches int
		if err := r.pool.QueryRow(r.t.Context(), `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.launch' AND payload->>'flowId'='coding/rebase-conflict'`).Scan(&launches); err != nil {
			return err
		}
		if launches != 1 {
			return fmt.Errorf("%d conflict launches, want one", launches)
		}
		return nil
	})
}

func (r *rehearsal) rebaseBranch(n int64, press bool) (string, error) {
	path := "REBASE-NOW.md"
	if !press {
		path = "PRESENCE-REBASE.md"
	}
	return r.rebaseBranchWithMain(n, press, path, "clean main change\n")
}

func (r *rehearsal) rebaseBranchWithMain(n int64, press bool, targetPath, targetContent string) (string, error) {
	before, err := r.todo(n)
	if err != nil {
		return "", err
	}
	if before.Branch == nil || before.PR.Head == "" {
		return "", fmt.Errorf("T%d has no branch/PR", n)
	}
	tab, err := r.openLive(r.jar)
	if err != nil {
		return "", err
	}
	defer tab.stop()
	if _, err = tab.subscribe("branch:" + before.Branch.ID); err != nil {
		return "", err
	}
	if err = tab.presence(map[string]any{"branch": before.Branch.ID}); err != nil {
		return "", err
	}
	main, err := r.pushMain(targetPath, targetContent, "Rebase target")
	if err != nil {
		return "", err
	}
	for deadline := time.Now().Add(2 * time.Minute); ; time.Sleep(time.Second) {
		if err := tab.presence(map[string]any{"branch": before.Branch.ID}); err != nil {
			return "", err
		}
		card, err := r.j10Card(n)
		if err != nil {
			return "", err
		}
		if card.RebasePending != nil && card.PR.Head == before.PR.Head {
			break
		}
		if time.Now().After(deadline) {
			return "", fmt.Errorf("T%d did not hold its pending rebase", n)
		}
	}
	// Keep a real browser lease alive across worker passes. A pending label
	// alone does not prove the person prevented a rewrite.
	for end := time.Now().Add(5 * time.Second); time.Now().Before(end); time.Sleep(time.Second) {
		if err := tab.presence(map[string]any{"branch": before.Branch.ID}); err != nil {
			return "", err
		}
		card, err := r.j10Card(n)
		if err != nil || card.RebasePending == nil || card.PR.Head != before.PR.Head {
			return "", fmt.Errorf("T%d moved while its browser lease was active: %+v %v", n, card, err)
		}
	}
	departed := time.Now()
	if press && os.Getenv("SMITHERS_REBASE_BROWSER_PRESS") == "1" {
		if err := r.pressRebaseInBrowser(n); err != nil {
			return "", err
		}
	} else if press {
		path := "/api/branches/" + url.PathEscape(before.Branch.Name)
		for range 2 {
			code, data, err := r.keyed("POST", path, `{"rebase":true}`, r.keyPrefix+"rebase-press")
			if err != nil || code != 202 {
				return "", fmt.Errorf("Rebase now: %d %s %v", code, data, err)
			}
		}
	} else if err := tab.presence(nil); err != nil {
		return "", err
	}
	for deadline := time.Now().Add(j10RunWait); ; time.Sleep(time.Second) {
		if press {
			if err := tab.presence(map[string]any{"branch": before.Branch.ID}); err != nil {
				return "", err
			}
		}
		card, err := r.todo(n)
		if err != nil {
			return "", err
		}
		if card.State == "failed" || card.State == "blocked" {
			return "", fmt.Errorf("T%d rebase verification blocked: %+v", n, card)
		}
		if card.State == "in_review" && card.PR.Head != before.PR.Head && card.Merge.State == "ready" {
			pull, err := r.readFakePull(card.PR.Number)
			if err != nil {
				return "", err
			}
			parent, err := r.githubGit("rev-parse", pull.Head.SHA+"^")
			if err != nil {
				return "", err
			}
			if card.PR.Number != before.PR.Number || pull.Head.SHA != card.PR.Head || parent != main {
				return "", fmt.Errorf("rebased PR binding differs: %+v parent %s", card.PR, parent)
			}
			var count int
			if err = r.pool.QueryRow(r.t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type='todo.rebased' AND (data->>'n')::bigint=$1 AND data->>'onto'=$2`, n, main).Scan(&count); err != nil {
				return "", err
			}
			if count != 1 {
				return "", fmt.Errorf("%d rebase completions, want one", count)
			}
			if press {
				var system, requester string
				if err := r.pool.QueryRow(r.t.Context(), `SELECT data->'actor'->>'id', data->'by'->>'person' FROM product_job_events WHERE event_type='todo.rebased' AND (data->>'n')::bigint=$1 AND data->>'onto'=$2`, n, main).Scan(&system, &requester); err != nil {
					return "", err
				}
				if system != "stack" || requester != "rehearsal-owner" {
					return "", fmt.Errorf("rebase attribution: system %q, requester %q", system, requester)
				}
			}
			if !press {
				var completed time.Time
				if err := r.pool.QueryRow(r.t.Context(), `SELECT recorded_at FROM product_job_events WHERE event_type='todo.rebased' AND (data->>'n')::bigint=$1 AND data->>'onto'=$2`, n, main).Scan(&completed); err != nil {
					return "", err
				}
				if completed.Sub(departed) > time.Minute {
					return "", fmt.Errorf("T%d rebased %s after departure, want within 60 s", n, completed.Sub(departed))
				}
			}
			if card.Branch == nil {
				return "", fmt.Errorf("rebased TODO lost its branch")
			}
			data, err := r.expect("GET", "/api/branches/"+url.PathEscape(card.Branch.ID), "", 200)
			if err != nil {
				return "", err
			}
			var branch struct {
				Head string `json:"head"`
			}
			if err = json.Unmarshal(data, &branch); err != nil {
				return "", err
			}
			var candidate string
			if err = r.pool.QueryRow(r.t.Context(), `SELECT candidate_head FROM mythical_items WHERE number=$1 AND source IN ('todo','issue')`, n).Scan(&candidate); err != nil {
				return "", err
			}
			if branch.Head != candidate {
				return "", fmt.Errorf("Branch card head %s differs from rebased candidate %s", branch.Head, candidate)
			}
			r.actual = fmt.Sprintf("T%d PR #%d %s → %s on %s; one rebase; branch head %s", n, card.PR.Number, short7(before.PR.Head), short7(card.PR.Head), short7(main), short7(branch.Head))
			return main, nil
		}
		if time.Now().After(deadline) {
			return "", fmt.Errorf("T%d did not publish its rebase: %s %+v", n, card.State, card.Merge)
		}
	}
}

func (r *rehearsal) bringInReleased(n int64, branch, foreign, wait string) error {
	before, err := r.j10Card(n)
	if err != nil {
		return err
	}
	body, _ := json.Marshal(map[string]string{"op": "bring-in", "id": wait, "revision": foreign})
	for range 2 {
		code, data, err := r.keyed("POST", "/api/branches/"+url.PathEscape(branch), string(body), r.keyPrefix+"bring-"+foreign)
		if err != nil || code != 202 {
			return fmt.Errorf("Bring in: %d %s %v", code, data, err)
		}
	}
	for deadline := time.Now().Add(j10RunWait); ; time.Sleep(time.Second) {
		card, err := r.j10Card(n)
		if err != nil {
			return err
		}
		if card.State == "in_review" && len(card.Waits) == 0 && card.PR.Head != before.PR.Head {
			pull, err := r.readFakePull(card.PR.Number)
			if err != nil {
				return err
			}
			if card.PR.Number != before.PR.Number || pull.Head.SHA != card.PR.Head {
				return fmt.Errorf("Bring in changed the PR binding: %+v", card.PR)
			}
			content, err := r.githubGit("show", pull.Head.SHA+":alice.md")
			if err != nil || content != "log each retry" {
				return fmt.Errorf("Alice's bytes were not brought in: %q %v", content, err)
			}
			var count int
			if err := r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.foreign_brought-in' AND (data->>'n')::bigint=$1 AND data->>'sha'=$2`, n, foreign).Scan(&count); err != nil {
				return err
			}
			if count != 1 {
				return fmt.Errorf("two Bring in presses recorded %d executions", count)
			}
			r.actual = fmt.Sprintf("T%d PR #%d head %s; Alice's bytes retained; one Bring in", n, card.PR.Number, short7(card.PR.Head))
			return nil
		}
		if card.State == "failed" || time.Now().After(deadline) {
			return fmt.Errorf("T%d did not publish Bring in: %s waits %+v", n, card.State, card.Waits)
		}
	}
}
