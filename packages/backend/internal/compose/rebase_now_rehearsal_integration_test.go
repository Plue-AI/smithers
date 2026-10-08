package compose

import (
	"encoding/json"
	"fmt"
	"net/url"
	"testing"
	"time"
)

// This drives the installed HTTP door, stack worker, check launcher and GitHub
// fake. The machine runtime is the existing rehearsal process boundary; it is
// not microVM or broker freeze evidence.
func TestRebaseNowRehearsal(t *testing.T) {
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
	r.step("Rebase now with browser presence", "POST /api/branches/{b} {rebase:true}; GET /api/todos/{n}; GitHub fake", "one clean rebase, same PR, new head, checks rerun", "T-STK-08", func() error { _, err := r.rebaseNowReleased(n); return err })
}

func (r *rehearsal) rebaseNowReleased(n int64) (string, error) {
	// A completed review releases its lane. The retained candidate then uses
	// the existing host rebase path, with checks on a fresh machine.
	for deadline := time.Now().Add(3 * time.Minute); ; time.Sleep(time.Second) {
		var workspace string
		if err := r.pool.QueryRow(r.t.Context(), `SELECT workspace_id FROM mythical_items WHERE number=$1 AND source='todo'`, n).Scan(&workspace); err != nil {
			return "", err
		}
		if workspace == "" {
			break
		}
		if time.Now().After(deadline) {
			return "", fmt.Errorf("T%d's review has not released its lane", n)
		}
	}
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
	main, err := r.pushMain("REBASE-NOW.md", "clean main change\n", "Clean rebase target")
	if err != nil {
		return "", err
	}
	for deadline := time.Now().Add(2 * time.Minute); ; time.Sleep(time.Second) {
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
	path := "/api/branches/" + url.PathEscape(before.Branch.Name)
	for range 2 {
		code, data, err := r.keyed("POST", path, `{"rebase":true}`, r.keyPrefix+"rebase-press")
		if err != nil || code != 202 {
			return "", fmt.Errorf("Rebase now: %d %s %v", code, data, err)
		}
	}
	for deadline := time.Now().Add(j10RunWait); ; time.Sleep(time.Second) {
		card, err := r.todo(n)
		if err != nil {
			return "", err
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
				return "", fmt.Errorf("%d rebase completions for two presses", count)
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
			if err = r.pool.QueryRow(r.t.Context(), `SELECT candidate_head FROM mythical_items WHERE number=$1 AND source='todo'`, n).Scan(&candidate); err != nil {
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
