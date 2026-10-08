package compose

import (
	"encoding/json"
	"fmt"
	"net/url"
	"testing"
	"time"
)

// Exercises the production poll, durable HTTP admission and stack checkpoint.
func TestForeignPushCheckpointRehearsal(t *testing.T) {
	r := newRehearsal(t, "SMITHERS_FOREIGN_PUSH_REHEARSAL", "C-J10-03", "foreign-push-")
	if !r.install("Install") {
		return
	}
	var n int64
	if !r.step("Reviewed TODO", "POST /api/todos", "In review", "T-GH-06", func() error {
		var err error
		n, err = r.file("Retry webhooks", "Add a greeting to JOURNEY.md")
		if err != nil {
			return err
		}
		_, err = r.waitTodoWithin(n, j10RunWait, "in_review")
		return err
	}) {
		return
	}
	r.step("Bring in", "Person push; POST /api/branches/{b}", "Same PR includes the person's commit", "T-GH-06", func() error {
		before, err := r.todo(n)
		if err != nil || before.Branch == nil {
			return fmt.Errorf("missing branch: %v", err)
		}
		sha, err := r.fake.PushAs("rehearsal-owner/app", before.Branch.Name, 202, "alice", "Log each retry", map[string]string{"alice.md": "log each retry\n"})
		if err != nil {
			return err
		}
		for deadline := time.Now().Add(2 * time.Minute); ; time.Sleep(time.Second) {
			card, err := r.j10Card(n)
			if err != nil {
				return err
			}
			for _, wait := range card.Waits {
				if wait.Kind == "foreign_push" && wait.SHA == sha {
					return r.foreignBringRecovery(n, before.Branch.Name, sha, wait.ID)
				}
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("foreign push did not reach T%d", n)
			}
		}
	})
}

// Fault a real PostgreSQL receipt after the real native daemon has rewritten.
// Sequence increments survive the failed transaction, making the fault observed
// rather than a timing-based guess. Recovery uses the persisted native result.
func (r *rehearsal) foreignBringRecovery(n int64, branch, sha, wait string) error {
	_, err := r.pool.Exec(r.ctx, `CREATE SEQUENCE foreign_bring_failures;
 CREATE FUNCTION fail_foreign_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.event_type='todo.foreign_brought-in' THEN PERFORM nextval('foreign_bring_failures'); RAISE EXCEPTION 'injected Bring in receipt outage'; END IF;
 RETURN NEW; END $$;
 CREATE TRIGGER fail_foreign_receipt BEFORE INSERT ON product_job_events FOR EACH ROW EXECUTE FUNCTION fail_foreign_receipt()`)
	if err != nil {
		return err
	}
	body, _ := json.Marshal(map[string]string{"op": "bring-in", "id": wait, "revision": sha})
	code, raw, err := r.keyed("POST", "/api/branches/"+url.PathEscape(branch), string(body), r.keyPrefix+"bring-"+sha)
	if err != nil || code != 202 {
		return fmt.Errorf("Bring in admission: %d %s %v", code, raw, err)
	}
	native := ""
	for deadline := time.Now().Add(j10RunWait); ; time.Sleep(time.Second) {
		var observed bool
		if err := r.pool.QueryRow(r.ctx, `SELECT is_called FROM foreign_bring_failures`).Scan(&observed); err != nil {
			return err
		}
		if observed {
			if err := r.pool.QueryRow(r.ctx, `SELECT COALESCE(checks->'foreignBring'->'native'->>'Head','') FROM mythical_items WHERE number=$1`, n).Scan(&native); err != nil {
				return err
			}
			if native == "" {
				return fmt.Errorf("receipt failed without a durable native checkpoint")
			}
			held, err := r.j10Card(n)
			if err != nil {
				return err
			}
			retained := false
			for _, row := range held.Waits {
				retained = retained || row.ID == wait && row.SHA == sha
			}
			if !retained {
				return fmt.Errorf("receipt failure settled the outside push")
			}
			head, err := r.githubGit("rev-parse", "refs/heads/"+branch)
			if err != nil || head != sha {
				return fmt.Errorf("receipt failure published over the person: %s %v", head, err)
			}
			break
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("native Bring in never reached receipt recovery")
		}
	}
	if _, err := r.pool.Exec(r.ctx, `DROP TRIGGER fail_foreign_receipt ON product_job_events; DROP FUNCTION fail_foreign_receipt()`); err != nil {
		return err
	}
	if err := r.bringInReleased(n, branch, sha, wait); err != nil {
		return err
	}
	card, err := r.j10Card(n)
	if err != nil {
		return err
	}
	if _, err := r.githubGit("merge-base", "--is-ancestor", sha, card.PR.Head); err != nil {
		return fmt.Errorf("recovered PR lost the accepted push: %w", err)
	}
	var candidate string
	if err := r.pool.QueryRow(r.ctx, `SELECT candidate_head FROM mythical_items WHERE number=$1`, n).Scan(&candidate); err != nil {
		return err
	}
	if candidate != native {
		return fmt.Errorf("recovery replaced checkpoint %s with %s", native, candidate)
	}
	r.actual += "; PostgreSQL receipt outage recovered the same native checkpoint"
	return nil
}
