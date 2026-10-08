package compose

import (
	"fmt"
	"testing"
	"time"
)

// Multiple retained branches must all follow main, including a later TODO
// whose logical candidate also includes its predecessor's verified change.
func TestRebaseStackCheckpointRehearsal(t *testing.T) {
	r := newRehearsal(t, "SMITHERS_REBASE_REHEARSAL", "C-J10-04", "stack-rebase-")
	if !r.setupSource() || !r.setupMachine() {
		return
	}
	var first, second int64
	if !r.step("Two reviewed TODOs", "POST /api/todos", "Two published PRs", "T-STK-08", func() error {
		if err := r.waitStackActive(); err != nil {
			return err
		}
		var err error
		first, err = r.file("Greeting", "Add a greeting to JOURNEY.md")
		if err != nil {
			return err
		}
		if _, err = r.waitTodoWithin(first, j10RunWait, "in_review"); err != nil {
			return err
		}
		second, err = r.file("Retry", "[FILE retry.ts] Add retries to webhook delivery in retry.ts")
		if err != nil {
			return err
		}
		_, err = r.waitTodoWithin(second, j10RunWait, "in_review")
		return err
	}) {
		return
	}
	r.step("Both branches follow main", "GitHub main sync; TODO cards; GitHub fake PRs", "Both PR parents are the new main", "T-STK-08", func() error {
		before, err := r.todo(second)
		if err != nil {
			return err
		}
		if err = r.rebaseCheckpoint(first); err != nil {
			return err
		}
		main, err := r.landedMain()
		if err != nil {
			return err
		}
		for deadline := time.Now().Add(3 * time.Minute); ; time.Sleep(time.Second) {
			card, err := r.todo(second)
			if err != nil {
				return err
			}
			pull, err := r.readFakePull(card.PR.Number)
			if err != nil {
				return err
			}
			parent, _ := r.githubGit("rev-parse", pull.Head.SHA+"^")
			if card.State == "in_review" && card.PR.Number == before.PR.Number && card.PR.Head == pull.Head.SHA && parent == main {
				return nil
			}
			if time.Now().After(deadline) {
				var state, reason, base, head string
				if err := r.pool.QueryRow(r.ctx, `SELECT state,reason,candidate_base,candidate_head FROM mythical_items WHERE number=$1`, second).Scan(&state, &reason, &base, &head); err != nil {
					return err
				}
				return fmt.Errorf("T%d %s/%s candidate %s on %s; PR parent %s, want main %s", second, state, reason, short7(head), short7(base), short7(parent), short7(main))
			}
		}
	})
}
