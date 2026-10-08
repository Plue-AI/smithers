package compose

import (
	"encoding/json"
	"fmt"
	"net/url"
	"testing"
	"time"
)

// A native Bring-in keeps the live TODO composition. Its later steer must
// deliver through the real stack door after capture advances engine phases.
func TestLiveCapturedSteerAfterForeignRehearsal(t *testing.T) {
	r := newRehearsal(t, "SMITHERS_LIVE_STEER_REHEARSAL", "C-J10-live-steer", "live-steer-")
	if !r.install("Install") {
		return
	}
	var n int64
	var branch string
	var pr int64
	if !r.step("Reviewed TODO", "POST /api/todos", "In review", "T-STK-08", func() error {
		var err error
		n, err = r.file("Retry webhooks", "[PR] [FILE retry-webhooks.md] Retry failed webhook deliveries.")
		if err != nil {
			return err
		}
		card, err := r.waitTodoWithin(n, j10RunWait, "in_review")
		if err != nil {
			return err
		}
		if card.Branch == nil || card.PR.Number == 0 {
			return fmt.Errorf("missing reviewed branch")
		}
		branch, pr = card.Branch.Name, card.PR.Number
		return nil
	}) {
		return
	}
	pushWait := func(path string) (string, string, error) {
		sha, err := r.fake.PushAs("rehearsal-owner/app", branch, 202, "alice", "Person change", map[string]string{path: "log each retry\n"})
		if err != nil {
			return "", "", err
		}
		for deadline := time.Now().Add(time.Minute); ; time.Sleep(time.Second) {
			card, err := r.j10Card(n)
			if err != nil {
				return "", "", err
			}
			for _, w := range card.Waits {
				if w.Kind == "foreign_push" && w.SHA == sha {
					return sha, w.ID, nil
				}
			}
			if time.Now().After(deadline) {
				return "", "", fmt.Errorf("person push did not reach its wait")
			}
		}
	}
	if !r.step("Bring in", "POST /api/branches/{b}", "Same PR retains Alice's bytes", "T-STK-08", func() error {
		sha, wait, err := pushWait("alice.md")
		if err != nil {
			return err
		}
		return r.bringInReleased(n, branch, sha, wait)
	}) {
		return
	}
	r.step("Discard then steer", "POST /api/branches/{b}; POST /api/todos/{n}", "Same live attempt publishes its new captured source", "T-STK-08", func() error {
		sha, wait, err := pushWait("ALICE-DISCARD.md")
		if err != nil {
			return err
		}
		body, _ := json.Marshal(map[string]string{"op": "discard-foreign", "id": wait, "revision": sha})
		code, raw, err := r.keyed("POST", "/api/branches/"+url.PathEscape(branch), string(body), r.keyPrefix+"discard")
		if err != nil || code != 202 {
			return fmt.Errorf("Discard: %d %s %v", code, raw, err)
		}
		for deadline := time.Now().Add(time.Minute); ; time.Sleep(time.Second) {
			card, err := r.j10Card(n)
			if err != nil {
				return err
			}
			if card.State == "in_review" && len(card.Waits) == 0 {
				break
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("Discard did not settle its wait")
			}
		}
		code, raw, err = r.keyed("POST", fmt.Sprintf("/api/todos/%d", n), `{"steer":"Also log each retry."}`, r.keyPrefix+"steer")
		if err != nil || code != 202 {
			return fmt.Errorf("Steer: %d %s %v", code, raw, err)
		}
		for deadline := time.Now().Add(5 * time.Minute); ; time.Sleep(time.Second) {
			card, err := r.j10Card(n)
			if err != nil {
				return err
			}
			head, err := r.githubGit("rev-parse", "refs/heads/"+branch)
			if err != nil {
				return err
			}
			if card.State == "in_review" && head != sha && card.PR.Head == head {
				if card.PR.Number != pr {
					return fmt.Errorf("Steer replaced PR #%d", pr)
				}
				if _, err = r.githubGit("merge-base", "--is-ancestor", sha, head); err == nil {
					return fmt.Errorf("Steer retained the discarded commit")
				}
				bytes, err := r.githubGit("show", head+":alice.md")
				if err != nil || bytes != "log each retry" {
					return fmt.Errorf("Bring-in bytes lost: %q %v", bytes, err)
				}
				r.actual = fmt.Sprintf("T%d PR #%d replaced the discarded head; retained Alice's brought-in bytes", n, pr)
				return nil
			}
			if card.State == "failed" || time.Now().After(deadline) {
				return fmt.Errorf("steered T%d is %s at %s", n, card.State, short7(head))
			}
		}
	})
}
