package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
)

// TestJ2Rehearsal walks journey J2 (mvp.md §5, issue to merged PR) steps 2
// to 6 on the install J1 sets up: an issue on GitHub becomes a TODO through
// Make TODO and through the todo label, the TODO queues, starts and works,
// its PR opens with evidence, the owner merges it in Smithers, it turns
// Merged and the issue closes because the TODO fixes it. Setup runs as J1's
// rows and shows as one row. The state rows follow Make TODO at once, since
// the TODO starts on the stack's next pass; the label row runs last. The
// composed install and the shared rows are rehearsal_integration_test.go's.
func TestJ2Rehearsal(t *testing.T) {
	r := newRehearsal(t, "SMITHERS_J2_REHEARSAL", "C-J2", "j2-")
	const repo = "rehearsal-owner/app"
	// J2 step 1: Ben, a maintainer, opens the issues the team discusses on GitHub.
	r.fake.SetCollaborator(8, "ben", "write")
	made := r.fake.OpenIssue(repo, "ben", "Greet visitors", "JOURNEY.md should greet visitors.")
	labeled := r.fake.OpenIssue(repo, "ben", "Say goodbye", "JOURNEY.md should end with a farewell.")
	r.quiet = true
	ready := r.setupSource() && r.setupMachine()
	r.quiet = false
	if !r.step("Install ready", "J1 setup rows: setup URL token … 6 machine ready", "every J1 setup row passes; stack active", "T-INS-06", func() error {
		if len(r.quietFailed) > 0 {
			return errors.New(strings.Join(r.quietFailed, "; "))
		}
		return r.waitStackActive()
	}) || !ready {
		return
	}
	todos := func() ([]struct {
		N     int64 `json:"n"`
		Issue *struct {
			Number int64 `json:"number"`
		} `json:"issue"`
	}, error) {
		var list []struct {
			N     int64 `json:"n"`
			Issue *struct {
				Number int64 `json:"number"`
			} `json:"issue"`
		}
		data, err := r.expect("GET", "/api/todos", "", 200)
		if err == nil {
			err = json.Unmarshal(data, &list)
		}
		return list, err
	}
	// fromIssue counts the TODOs made from an issue.
	fromIssue := func(issue int64) (int, error) {
		list, err := todos()
		count := 0
		for _, todo := range list {
			if todo.Issue != nil && todo.Issue.Number == issue {
				count++
			}
		}
		return count, err
	}
	var number int64
	todoPath := "/api/todos/{n}"
	if !r.step("2 Make TODO", "POST /api/todos {issue, issue_digest, fixes}; GET /api/todos/{n}", "202 accepted; the TODO is the issue's and fixes it; the same press answers the same TODO", "T-STK-09", func() error {
		view, ok := r.fake.Issue(repo, made)
		if !ok {
			return fmt.Errorf("issue #%d is not on GitHub", made)
		}
		// The Draft carries the digest of the title and body its author read.
		digest := sha256.Sum256([]byte(view.Title + "\x00" + view.Body))
		body, _ := json.Marshal(map[string]any{"title": "Greet visitors", "prompt": "Add a greeting to JOURNEY.md, as the issue asks.",
			"acceptance": []string{"JOURNEY.md ends with a greeting"}, "place": map[string]string{"mode": "append"},
			"issue": made, "issue_digest": hex.EncodeToString(digest[:]), "fixes": true})
		var first int64
		for press := range 2 {
			code, data, err := r.keyed("POST", "/api/todos", string(body), "j2-make-todo")
			if err != nil {
				return err
			}
			if code != 202 {
				return fmt.Errorf("press %d: expected HTTP 202: %s", press+1, r.actual)
			}
			var receipt struct {
				N     int64  `json:"n"`
				State string `json:"state"`
			}
			if err = json.Unmarshal(data, &receipt); err != nil {
				return err
			}
			if receipt.N <= 0 || receipt.State != "accepted" || first != 0 && receipt.N != first {
				return fmt.Errorf("press %d: receipt %+v after T%d", press+1, receipt, first)
			}
			first = receipt.N
		}
		number = first
		todoPath = fmt.Sprintf("/api/todos/%d", number)
		data, err := r.expect("GET", todoPath, "", 200)
		if err != nil {
			return err
		}
		var todo rehearsalTodo
		if err = json.Unmarshal(data, &todo); err != nil {
			return err
		}
		if todo.Issue == nil || todo.Issue.Number != made || !todo.Issue.Fixes {
			return fmt.Errorf("T%d is not issue #%d's fixing TODO: %s", number, made, r.actual)
		}
		if count, err := fromIssue(made); err != nil || count != 1 {
			return fmt.Errorf("issue #%d has %d TODOs: %v", made, count, err)
		}
		return nil
	}) {
		return
	}
	head := ""
	var prNumber int64
	for _, state := range []string{"queued", "starting", "working"} {
		if !r.step("3 TODO "+state, "GET "+todoPath, "200 state="+state, "T-STK-01, T-STK-09", func() error {
			_, err := r.waitTodo(number, state)
			return err
		}) {
			return
		}
	}
	if !r.step("2 Committed as Tn", "GitHub fake issue labels, events and comments", "the App's todo label and one keyed comment \"Committed as Tn\"; no second TODO", "T-STK-09", func() error {
		marker := fmt.Sprintf("todo-committed:%d", number)
		var view githubfake.IssueView
		deadline := time.Now().Add(30 * time.Second)
		for {
			view, _ = r.fake.Issue(repo, made)
			labeledByApp, comments := false, 0
			for _, event := range view.Events {
				labeledByApp = labeledByApp || event.Event == "labeled" && event.Label == "todo" && event.ViaApp
			}
			for _, comment := range view.Comments {
				if comment.ViaApp && strings.HasPrefix(comment.Body, "Committed as ") && strings.Contains(comment.Body, fmt.Sprintf("T%d ↗", number)) && strings.Contains(comment.Body, marker) {
					comments++
				}
			}
			r.actual = fmt.Sprintf("labels=%v events=%d comments=%d", view.Labels, len(view.Events), len(view.Comments))
			if labeledByApp && comments == 1 && len(view.Comments) == 1 {
				break
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("issue #%d: App label %t, %d committed comments of %d", made, labeledByApp, comments, len(view.Comments))
			}
			time.Sleep(200 * time.Millisecond)
		}
		// The App's own label is no maintainer's label: it makes no TODO.
		if count, err := fromIssue(made); err != nil || count != 1 {
			return fmt.Errorf("issue #%d has %d TODOs after the App's label: %v", made, count, err)
		}
		return nil
	}) {
		return
	}
	r.step("4 Needs you", "coding host ask → GET "+todoPath+"; POST "+todoPath+"/answer", "state=needs_you; a member's answer settles it; the run continues", "lane needs-you", func() error {
		return fmt.Errorf("expected failure (lane needs-you): the coding host has no ask signal and no answer route exists, so a TODO never shows Needs you")
	})
	if !r.step("5 PR with evidence", "GET "+todoPath+"; GET GitHub fake /repos/"+repo+"/pulls/{n}; git diff main..head", "state=in_review; PR head smithers/<slug> at the TODO's head, base main; the head changes JOURNEY.md; the body lists the checks run on the machine", "T-STK-01, T-STK-09", func() error {
		todo, err := r.waitTodo(number, "in_review")
		if err != nil {
			return err
		}
		head, prNumber = todo.PR.Head, todo.PR.Number
		pull, err := r.checkPull(prNumber, head)
		if err != nil {
			return err
		}
		diff, err := exec.Command("/usr/bin/git", "--git-dir", filepath.Join(r.gitRoot, repo+".git"), "diff", "--stat", r.mainCommit, head).CombinedOutput()
		if err != nil || !strings.Contains(string(diff), "JOURNEY.md") {
			return fmt.Errorf("the PR head changes nothing on main: %v: %s", err, diff)
		}
		r.actual = fmt.Sprintf("head=%s base=%s body=%q", pull.Head.Ref, pull.Base.Ref, pull.Body)
		if !strings.Contains(pull.Body, "Checks:\n- ") {
			return fmt.Errorf("the PR body lists no checks")
		}
		return nil
	}) {
		return
	}
	// The review runs on the open PR; its summary is the TODO's evidence,
	// where the PR is reviewed.
	r.step("5 review summary", "GET "+todoPath, "the TODO's evidence holds the agent's review of the PR head", "T-STK-01, lane review-seat", func() error {
		deadline := time.Now().Add(time.Minute)
		for {
			todo, err := r.waitTodo(number, "in_review")
			if err != nil {
				return err
			}
			review := ""
			for _, attempt := range todo.Evidence {
				for _, item := range attempt.Items {
					if item["kind"] == "review" {
						review = fmt.Sprint(item["summary"])
					}
				}
			}
			if review != "" {
				return nil
			}
			if time.Now().After(deadline) {
				var reason string
				_ = r.pool.QueryRow(r.ctx, `SELECT reason FROM mythical_items WHERE number=$1`, number).Scan(&reason)
				return fmt.Errorf("no review verdict on the PR head after a minute (item reason %q): the review/change run never reached a model (lane review-seat)", reason)
			}
			time.Sleep(500 * time.Millisecond)
		}
	})
	if !r.step("6 Merge in Smithers", "POST "+todoPath+"/merge", "202; reviewed head; browser session; one checks.Land", "T-STK-04", func() error {
		return r.merge(number, head)
	}) {
		return
	}
	if !r.step("6 Merged", "GET "+todoPath+"; GET /api/repos/{o}/{r}/mythical; GET /api/github/sync", "merged only after GitHub merge receipt; the install's main follows GitHub's squash commit; sync fresh", "T-STK-04, T-GH-02", func() error {
		return r.waitMerged(number, prNumber, head)
	}) {
		return
	}
	r.step("6 issue closed", "GitHub fake issue state and comments", "the App closes the issue as completed with one comment linking the change on main", "T-STK-04, T-STK-09", func() error {
		deadline := time.Now().Add(30 * time.Second)
		for {
			view, _ := r.fake.Issue(repo, made)
			landed := 0
			for _, comment := range view.Comments {
				if comment.ViaApp && strings.Contains(comment.Body, "Landed on main: ") {
					landed++
				}
			}
			r.actual = fmt.Sprintf("state=%s reason=%s comments=%d", view.State, view.StateReason, len(view.Comments))
			if view.State == "closed" && view.StateReason == "completed" && landed == 1 {
				return nil
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("issue #%d is %s (%s) with %d landed comments", made, view.State, view.StateReason, landed)
			}
			time.Sleep(250 * time.Millisecond)
		}
	})
	// Last: a TODO the label makes starts on its own, and the rehearsal
	// rehearses one TODO on one machine at a time.
	r.step("2 todo label", "GitHub fake: Ben labels the issue todo → GET /api/todos", "one TODO from the issue's title and body; a redelivery adds none", "T-STK-09, T-GH-02", func() error {
		event := r.fake.LabelIssue(repo, labeled, "ben", "todo")
		if event == 0 {
			return fmt.Errorf("issue #%d is not on GitHub", labeled)
		}
		deadline := time.Now().Add(20 * time.Second)
		for {
			count, err := fromIssue(labeled)
			if err != nil {
				return err
			}
			if count == 1 {
				return nil
			}
			if count > 1 || time.Now().After(deadline) {
				return fmt.Errorf("issue #%d has %d TODOs 20 s after Ben's label event %d: no install door reads GitHub's issue events (T-GH-02)", labeled, count, event)
			}
			time.Sleep(250 * time.Millisecond)
		}
	})
}
