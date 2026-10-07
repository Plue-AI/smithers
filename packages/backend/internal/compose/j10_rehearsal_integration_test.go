package compose

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// j10ClosingKeyword is GitHub's closing keyword before an issue reference: a
// TODO's PR body never carries one, so GitHub never closes an issue at merge
// before Smithers' own comment (C-J10-01, C-J10-05).
var j10ClosingKeyword = regexp.MustCompile(`(?i)\b(close[sd]?|fix(e[sd])?|resolve[sd]?):?\s+(#|https://github\.com/\S+/issues/)\d+`)

// j10Card is what the J10 rows read of a TODO card beyond rehearsalTodo.
type j10Card struct {
	State  string `json:"state"`
	Steers []struct {
		Text string          `json:"text"`
		By   json.RawMessage `json:"by"`
	} `json:"steers"`
	Waits []struct {
		ID     string          `json:"id"`
		Kind   string          `json:"kind"`
		Prompt string          `json:"prompt"`
		SHA    string          `json:"sha"`
		By     json.RawMessage `json:"by"`
	} `json:"waits"`
	PR struct {
		Number int64  `json:"number"`
		Head   string `json:"head"`
		Draft  bool   `json:"draft"`
	} `json:"pr"`
	Merge struct {
		State string `json:"state"`
	} `json:"merge"`
	RebasePending *struct {
		Onto string `json:"onto"`
	} `json:"rebase_pending"`
}

func (r *rehearsal) j10Card(number int64) (j10Card, error) {
	var card j10Card
	data, err := r.expect("GET", fmt.Sprintf("/api/todos/%d", number), "", 200)
	if err == nil {
		err = json.Unmarshal(data, &card)
	}
	return card, err
}

// fakeControl is what a person does on github.com, through the GitHub fake's
// own controls (review, merge, outage): never an App write.
func (r *rehearsal) fakeControl(path string, body any) ([]byte, error) {
	data, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	response, err := r.fake.Client().Post(r.fake.URL+path, "application/json", bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	answer, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, err
	}
	if response.StatusCode >= 300 {
		return answer, fmt.Errorf("GitHub fake %s: HTTP %d %s", path, response.StatusCode, answer)
	}
	return answer, nil
}

// todoFromIssue is Make TODO on a GitHub issue, appended to the stack, as the
// owner's browser sends it (J2.2); fixes marks the issue the TODO closes.
func (r *rehearsal) todoFromIssue(issue int64, fixes bool, title, prompt string, acceptance []string) (int64, error) {
	snapshot, err := r.expect("GET", fmt.Sprintf("/api/issues/%d", issue), "", 200)
	if err != nil {
		return 0, err
	}
	var read struct {
		Digest string `json:"issue_digest"`
	}
	if err = json.Unmarshal(snapshot, &read); err != nil {
		return 0, err
	}
	body, _ := json.Marshal(map[string]any{"title": title, "prompt": prompt, "acceptance": acceptance, "place": map[string]string{"mode": "append"},
		"issue": issue, "issue_digest": read.Digest, "fixes": fixes})
	code, data, err := r.keyed("POST", "/api/todos", string(body), fmt.Sprintf("%sissue-%d", r.keyPrefix, issue))
	if err != nil {
		return 0, err
	}
	if code != 202 {
		return 0, fmt.Errorf("expected HTTP 202: %s", r.actual)
	}
	var receipt struct {
		N     int64  `json:"n"`
		State string `json:"state"`
	}
	if err = json.Unmarshal(data, &receipt); err != nil {
		return 0, err
	}
	if receipt.N <= 0 || receipt.State != "accepted" {
		return 0, fmt.Errorf("invalid TODO receipt: %s", data)
	}
	return receipt.N, nil
}

// syncHealth is GET /api/github/sync, kept whole so a row can refuse fields
// the contract does not name (§12.6: no precomputed age).
func (r *rehearsal) syncHealth() (map[string]any, time.Time, error) {
	data, err := r.expect("GET", "/api/github/sync", "", 200)
	if err != nil {
		return nil, time.Time{}, err
	}
	var health map[string]any
	if err = json.Unmarshal(data, &health); err != nil {
		return nil, time.Time{}, err
	}
	var at time.Time
	if raw, ok := health["last_success_at"].(string); ok {
		at, _ = time.Parse(time.RFC3339Nano, raw)
	}
	return health, at, nil
}

// githubMain is GitHub's main as the fake's Git holds it.
func (r *rehearsal) githubMain() (string, error) {
	return r.githubGit("rev-parse", "refs/heads/main")
}

// landedMain is the install's main as the stack has folded it.
func (r *rehearsal) landedMain() (string, error) {
	data, err := r.expect("GET", "/api/repos/rehearsal-owner/app/mythical", "", 200)
	if err != nil {
		return "", err
	}
	var stack struct {
		LandedMain string `json:"landedMain"`
	}
	return stack.LandedMain, json.Unmarshal(data, &stack)
}

// appMergeWrites counts the App's merge calls for pull request number.
func (r *rehearsal) appMergeWrites(number int64) int {
	merges := 0
	for _, write := range r.fake.Writes() {
		if write.Method == "PUT" && write.Path == fmt.Sprintf("/repos/rehearsal-owner/app/pulls/%d/merge", number) {
			merges++
		}
	}
	return merges
}

// TestJ10Rehearsal walks journey J10 (mvp.md §5, Work with GitHub; checks
// C-J10-01 to C-J10-09) on the install J1 sets up, through the composed
// install's routes, the GitHub fake (people act through its own controls,
// never the App's token) and real PostgreSQL. T1 "Add retry helper" fixes
// issue #I; T2 "Retry webhooks" refers to issue #J and is stacked after T1.
// T2's PR is read for its shape, Alice's review steers it, her push to its
// branch holds it, an unrelated merge moves main, the lead merges T1 and T2
// on GitHub, T3's PR is closed and reopened on GitHub, a teammate's and an
// outsider's PR are reviewed, the network drops, and main is force-pushed.
// A row whose product code is missing is pending and names its ticket.
func TestJ10Rehearsal(t *testing.T) {
	// The model trace keeps each turn's messages: the steer rows read them.
	t.Setenv("TRACE_MESSAGES", "1")
	// Public repositories support drafts: T2 opens as a draft behind T1.
	t.Setenv("REHEARSAL_PUBLIC_REPOSITORY", "1")
	r := newRehearsal(t, "SMITHERS_J10_REHEARSAL", "C-J10", "j10-")
	const repo = "rehearsal-owner/app"
	const branch2 = "smithers/retry-webhooks"
	r.fake.SetCollaborator(201, "ben", "maintain")
	fixed := r.fake.OpenIssue(repo, "ben", "Add retry helper", "Webhook deliveries need one retry helper.")
	referred := r.fake.OpenIssue(repo, "ben", "Retry webhooks", "Failed webhook deliveries should retry.")
	if !r.install("0 Install through Machine ready") {
		return
	}
	var ben, alice http.CookieJar
	if !r.step("0b Members", "POST /api/members ×2; GitHub sign-in", "maintainer Ben and member Alice signed in; Dana is no member", "T-ACC-02", func() error {
		var err error
		if ben, err = r.member("ben", 201, "maintain"); err != nil {
			return err
		}
		alice, err = r.member("alice", 202, "write")
		r.fake.SetCollaborator(203, "dana", "read")
		return err
	}) {
		return
	}
	var t1, t2, pr1, pr2 int64
	var pull1URL, head2 string
	if !r.step("1 File T1 and T2", "POST /api/todos {issue, issue_digest, fixes} ×2", "202 ×2; T1 fixes #I, T2 refers to #J and is placed after T1", "T-STK-01, T-STK-09", func() error {
		var err error
		if t1, err = r.todoFromIssue(fixed, true, "Add retry helper", "[PR] [FILE retry-helper.md] Add a retry helper for webhook deliveries.", []string{"retry-helper.md describes the helper"}); err != nil {
			return err
		}
		if t2, err = r.todoFromIssue(referred, false, "Retry webhooks", "[PR] [FILE retry-webhooks.md] Retry failed webhook deliveries.", []string{"retries 3 times with backoff"}); err != nil {
			return err
		}
		if t1 == t2 {
			return fmt.Errorf("both TODOs are T%d", t1)
		}
		r.actual = fmt.Sprintf("202 T%d from #%d (fixes), T%d from #%d", t1, fixed, t2, referred)
		return nil
	}) {
		return
	}
	if !r.step("1 T1 in review", "GET /api/todos/{T1}; GitHub fake PR", "in_review; PR smithers/add-retry-helper at the card's head, base main, ready", "T-STK-01, T-GH-03", func() error {
		v, err := r.waitTodoWithin(t1, 8*time.Minute, "in_review")
		if err != nil {
			return err
		}
		p, err := r.checkPull(v.PR.Number, v.PR.Head)
		if err != nil {
			return err
		}
		if p.Head.Ref != "smithers/add-retry-helper" || p.Draft {
			return fmt.Errorf("T1's PR is %s, draft=%t", p.Head.Ref, p.Draft)
		}
		pr1, pull1URL = v.PR.Number, p.HTMLURL
		return nil
	}) {
		return
	}
	if !r.step("1 T2's PR shape", "GET /api/todos/{T2}; GitHub fake GET /repos/{o}/{r}/pulls/{n}; git rev-list --parents; git ls-tree",
		"title 'Retry webhooks'; head smithers/retry-webhooks; base main; draft; opened once by the App; one parent, main's tip, with T1's and T2's files; body: prompt, acceptance, checks, diff stat, review, Includes [T1](PR), link back, Requested by @owner; no closing keyword",
		"T-GH-03, T-REL-02", func() error {
			v, err := r.waitTodoWithin(t2, 8*time.Minute, "in_review")
			if err != nil {
				return err
			}
			pull, err := r.checkPull(v.PR.Number, v.PR.Head)
			if err != nil {
				return err
			}
			pr2, head2 = v.PR.Number, v.PR.Head
			if pull.Title != "Retry webhooks" || pull.Head.Ref != branch2 || !pull.Draft {
				return fmt.Errorf("T2's PR %q on %s draft=%t", pull.Title, pull.Head.Ref, pull.Draft)
			}
			opened := 0
			for _, write := range r.fake.Writes() {
				if write.Method == "POST" && write.Path == "/repos/rehearsal-owner/app/pulls" && strings.Contains(string(write.Body), `"head":"`+branch2+`"`) {
					opened++
				}
			}
			if opened != 1 {
				return fmt.Errorf("the App opened %d PRs for %s", opened, branch2)
			}
			parents, err := r.githubGit("rev-list", "--parents", "-n", "1", pull.Head.SHA)
			if err != nil {
				return err
			}
			main, err := r.githubMain()
			if err != nil {
				return err
			}
			if fields := strings.Fields(parents); len(fields) != 2 || fields[1] != main {
				return fmt.Errorf("T2's head %s has parents %v, want main %s", short7(pull.Head.SHA), fields[1:], short7(main))
			}
			tree, err := r.githubGit("ls-tree", "--name-only", pull.Head.SHA)
			if err != nil {
				return err
			}
			for _, path := range []string{"retry-helper.md", "retry-webhooks.md"} {
				if !slices.Contains(strings.Fields(tree), path) {
					return fmt.Errorf("T2's head tree lacks %s: %s", path, tree)
				}
			}
			body := pull.Body
			for _, want := range []string{"Retry failed webhook deliveries.", "retries 3 times with backoff", "Checks:\n- ", " changed", "Review: ",
				"Includes [T" + fmt.Sprint(t1) + "](" + pull1URL + ")", r.origin, "Requested by @rehearsal-owner"} {
				if !strings.Contains(body, want) {
					return fmt.Errorf("T2's PR body lacks %q: %q", want, body)
				}
			}
			if match := j10ClosingKeyword.FindString(body); match != "" {
				return fmt.Errorf("T2's PR body carries the closing keyword %q", match)
			}
			r.actual = fmt.Sprintf("PR #%d %q %s→main draft; head %s on main %s; body %q", pr2, pull.Title, pull.Head.Ref, short7(pull.Head.SHA), short7(main), body)
			return nil
		}) {
		return
	}
	r.step("1 Item-only diff", "GET /api/branches/smithers%2Fretry-webhooks/diff", "200 {files}: only retry-webhooks.md, none of T1's paths", "T-GH-03", func() error {
		data, err := r.expect("GET", "/api/branches/"+url.PathEscape(branch2)+"/diff", "", 200)
		if err != nil {
			return err
		}
		var diff services.BranchDiff
		if err = json.Unmarshal(data, &diff); err != nil {
			return err
		}
		paths := []string{}
		for _, file := range diff.Files {
			paths = append(paths, file.Path)
		}
		if !slices.Equal(paths, []string{"retry-webhooks.md"}) {
			return fmt.Errorf("T2's item diff lists %v", paths)
		}
		r.actual = fmt.Sprintf("200 files %v", paths)
		return nil
	})
	r.pending("1 Amend updates the same PR", "POST /api/todos {place: amend T2}; GitHub fake PR", "the same PR shows revision 2's prompt, not revision 1's", "T-GH-03, T-STK-06", "amend")

	// J10.2: a teammate's review on GitHub steers the agent.
	if !r.step("2 Review comment becomes a steer", "GitHub fake: Alice requests changes with a line comment on T2's PR → GET /api/todos/{T2}; SQL product_job_events",
		"within 60 s T2 reads working with Alice's steer anchored retry-webhooks.md:1; one todo.github_input event for it", "T-GH-04", func() error {
			if pr2 <= 0 {
				return fmt.Errorf("blocked by T2's PR")
			}
			began := time.Now()
			if _, err := r.fakeControl("/_fake/reviews", map[string]any{"repo": repo, "number": pr2, "login": "alice", "state": "CHANGES_REQUESTED",
				"body": "Use the existing backoff helper", "path": "retry-webhooks.md", "line": 1}); err != nil {
				return err
			}
			for deadline := began.Add(3 * time.Minute); ; time.Sleep(250 * time.Millisecond) {
				card, err := r.j10Card(t2)
				if err != nil {
					return err
				}
				steered := false
				for _, steer := range card.Steers {
					steered = steered || strings.Contains(string(steer.By), `"alice"`) && strings.Contains(steer.Text, "Use the existing backoff helper")
				}
				if steered && card.State == "working" {
					took := time.Since(began)
					var events int
					if err := r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.github_input' AND data::text LIKE '%Use the existing backoff helper%'`).Scan(&events); err != nil {
						return err
					}
					r.actual = fmt.Sprintf("working with Alice's steer after %s; %d github_input events; steers %d", took.Round(time.Second), events, len(card.Steers))
					if took > time.Minute {
						return fmt.Errorf("the steer showed after %s, want within 60 s", took.Round(time.Second))
					}
					if events < 1 {
						return fmt.Errorf("no todo.github_input event records Alice's review")
					}
					return nil
				}
				if time.Now().After(deadline) {
					return fmt.Errorf("T%d %s with steers %+v 3 min after Alice's review", t2, card.State, card.Steers)
				}
			}
		}) {
		return
	}
	if !r.step("2 The agent's fix updates the PR", "GET /api/todos/{T2}; GitHub fake PR", "T2 back in review; a new PR head under the same PR number; one PR for the branch", "T-GH-04, T-STK-06", func() error {
		v, err := r.waitTodoWithin(t2, 8*time.Minute, "in_review")
		if err != nil {
			return err
		}
		if v.PR.Number != pr2 || v.PR.Head == head2 {
			return fmt.Errorf("T2's PR #%d head %s after the steer (was #%d at %s)", v.PR.Number, short7(v.PR.Head), pr2, short7(head2))
		}
		pull, err := r.readFakePull(pr2)
		if err != nil {
			return err
		}
		if pull.Head.SHA != v.PR.Head || pull.State != "open" {
			return fmt.Errorf("GitHub's PR #%d is %s at %s, card head %s", pr2, pull.State, short7(pull.Head.SHA), short7(v.PR.Head))
		}
		r.actual = fmt.Sprintf("in_review; PR #%d head %s → %s", pr2, short7(head2), short7(v.PR.Head))
		head2 = v.PR.Head
		return nil
	}) {
		return
	}
	r.step("2 An outsider's comment is activity only", "GitHub fake: Dana comments on T2's PR → GET /api/todos/{T2}/events; GET /api/todos/{T2}",
		"@dana with the GitHub mark in the activity; T2's state and steers unchanged; no steer job", "T-GH-04, C-SEC-03", func() error {
			before, err := r.j10Card(t2)
			if err != nil {
				return err
			}
			var steerJobs int
			if err := r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.steer'`).Scan(&steerJobs); err != nil {
				return err
			}
			const comment = "Outsider note on the retry change"
			if r.fake.CommentIssue(repo, pr2, "dana", comment) == 0 {
				return fmt.Errorf("Dana's comment was not posted")
			}
			for deadline := time.Now().Add(2 * time.Minute); ; time.Sleep(500 * time.Millisecond) {
				activity, err := r.expect("GET", fmt.Sprintf("/api/todos/%d/events", t2), "", 200)
				if err != nil {
					return err
				}
				if strings.Contains(string(activity), comment) && strings.Contains(string(activity), `"login":"dana"`) && strings.Contains(string(activity), `"kind":"github"`) {
					break
				}
				if time.Now().After(deadline) {
					return fmt.Errorf("Dana's comment did not reach T%d's activity in 2 min", t2)
				}
			}
			after, err := r.j10Card(t2)
			if err != nil {
				return err
			}
			var jobs int
			if err := r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.steer'`).Scan(&jobs); err != nil {
				return err
			}
			if after.State != before.State || len(after.Steers) != len(before.Steers) || jobs != steerJobs {
				return fmt.Errorf("Dana's comment moved T%d %s→%s, steers %d→%d, steer jobs %d→%d", t2, before.State, after.State, len(before.Steers), len(after.Steers), steerJobs, jobs)
			}
			r.actual = fmt.Sprintf("@dana (github) in activity; T%d %s, %d steers unchanged", t2, after.State, len(after.Steers))
			return nil
		})
	r.step("2 An approval on GitHub changes nothing", "GitHub fake: the owner approves T2's PR → SQL todo.github_input; GET /api/todos/{T2}",
		"the approval is recorded; T2's state and steers unchanged; no checks.Land", "T-GH-04", func() error {
			before, err := r.j10Card(t2)
			if err != nil {
				return err
			}
			review, err := r.fakeControl("/_fake/reviews", map[string]any{"repo": repo, "number": pr2, "login": "rehearsal-owner", "state": "APPROVED"})
			if err != nil {
				return err
			}
			var submitted githubfake.PullReview
			if err = json.Unmarshal(review, &submitted); err != nil {
				return err
			}
			if err = r.waitSQL(2*time.Minute, `SELECT count(*) FROM product_job_events WHERE event_type='todo.github_input' AND data->>'object'='review:'||$1::text`, submitted.ID); err != nil {
				return fmt.Errorf("the approval was not recorded: %w", err)
			}
			after, err := r.j10Card(t2)
			if err != nil {
				return err
			}
			var land bool
			if err := r.pool.QueryRow(r.ctx, `SELECT checks ? 'land' FROM mythical_items WHERE number=$1`, t2).Scan(&land); err != nil {
				return err
			}
			if after.State != before.State || len(after.Steers) != len(before.Steers) || land {
				return fmt.Errorf("the approval moved T%d %s→%s, steers %d→%d, checks.Land=%t", t2, before.State, after.State, len(before.Steers), len(after.Steers), land)
			}
			r.actual = fmt.Sprintf("review %d recorded; T%d %s; no checks.Land", submitted.ID, t2, after.State)
			return nil
		})
	r.pending("2 The PR card lists the approval", "GET /api/todos/{T2} pr.reviews", "the owner's approval listed on T2's PR card", "T-GH-04", "pr-card-reviews")

	// J10.3: a person's push to the TODO's branch is never overwritten.
	var a1, wait1 string
	if !r.step("3 Alice's push holds the TODO", "GitHub fake: Alice pushes to smithers/retry-webhooks → GET /api/todos/{T2}",
		"within 60 s Needs you 'alice pushed to `smithers/retry-webhooks` on GitHub' naming her commit, with Discard", "T-GH-06", func() error {
			if pr2 <= 0 {
				return fmt.Errorf("blocked by T2's PR")
			}
			var err error
			began := time.Now()
			if a1, err = r.fake.PushAs(repo, branch2, 202, "alice", "Log each retry", map[string]string{"alice.md": "log each retry\n"}); err != nil {
				return err
			}
			for deadline := began.Add(3 * time.Minute); ; time.Sleep(250 * time.Millisecond) {
				card, err := r.j10Card(t2)
				if err != nil {
					return err
				}
				for _, wait := range card.Waits {
					if wait.Kind == "foreign_push" && wait.SHA == a1 {
						wait1 = wait.ID
						took := time.Since(began)
						r.actual = fmt.Sprintf("%s after %s: %q by %s", card.State, took.Round(time.Second), wait.Prompt, wait.By)
						if card.State != "needs_you" || wait.Prompt != "alice pushed to `"+branch2+"` on GitHub" || !strings.Contains(string(wait.By), `"alice"`) {
							return fmt.Errorf("T%d's outside push reads wrong", t2)
						}
						if took > time.Minute {
							return fmt.Errorf("Needs you showed after %s, want within 60 s", took.Round(time.Second))
						}
						return nil
					}
				}
				if time.Now().After(deadline) {
					return fmt.Errorf("T%d %s with waits %+v 3 min after Alice's push %s", t2, card.State, card.Waits, short7(a1))
				}
			}
		}) {
		return
	}
	r.step("3 Nothing overwrites Alice's commit", "git ls-remote smithers/retry-webhooks on the GitHub fake every 1 s for 20 s", "the branch stays at Alice's commit while the Needs you is open", "T-GH-06", func() error {
		for end := time.Now().Add(20 * time.Second); time.Now().Before(end); time.Sleep(time.Second) {
			head, err := r.githubGit("rev-parse", "refs/heads/"+branch2)
			if err != nil {
				return err
			}
			if head != a1 {
				return fmt.Errorf("the branch moved from Alice's %s to %s", short7(a1), short7(head))
			}
		}
		r.actual = "20 samples at " + short7(a1)
		return nil
	})
	r.pending("3 Bring in Alice's commit", "POST /api/branches/{b} {op: bring-in, id, revision}", "T2 works on top of Alice's commit; her line in the item's diff; same PR", "T-GH-06, T-STK-08", "checkpoint-rebase")
	if !r.step("3 Discard Alice's commit", "POST /api/branches/smithers%2Fretry-webhooks {op: discard-foreign, id, revision} as Alice, then the owner; GitHub fake branch; SQL activity",
		"403 for member Alice; 202 for the owner; T2 back in review; Smithers' next push replaces Alice's commit, which stays kept and linked", "T-GH-06", func() error {
			if a1 == "" || wait1 == "" {
				return fmt.Errorf("blocked by Alice's push row")
			}
			path := "/api/branches/" + url.PathEscape(branch2)
			body, _ := json.Marshal(map[string]string{"op": "discard-foreign", "id": wait1, "revision": a1})
			if code, data, err := r.keyedAs(alice, "POST", path, string(body), r.keyPrefix+"discard-alice"); err != nil || code != 403 {
				return fmt.Errorf("member Alice's Discard: %d %s %v", code, data, err)
			}
			if code, data, err := r.keyed("POST", path, string(body), r.keyPrefix+"discard-owner"); err != nil || code != 202 {
				return fmt.Errorf("the owner's Discard: %d %s %v", code, data, err)
			}
			for deadline := time.Now().Add(3 * time.Minute); ; time.Sleep(500 * time.Millisecond) {
				card, err := r.j10Card(t2)
				if err != nil {
					return err
				}
				head, err := r.githubGit("rev-parse", "refs/heads/"+branch2)
				if err != nil {
					return err
				}
				if card.State == "in_review" && len(card.Waits) == 0 && head != a1 && card.PR.Head == head {
					if _, err := r.githubGit("merge-base", "--is-ancestor", a1, head); err == nil {
						return fmt.Errorf("the new head %s keeps Alice's discarded commit", short7(head))
					}
					if err := r.waitSQL(10*time.Second, `SELECT count(*) FROM product_job_events WHERE data::text LIKE '%kept/'||$1::text||'%'`, a1); err != nil {
						return fmt.Errorf("no activity links the kept commit: %w", err)
					}
					r.actual = fmt.Sprintf("403 Alice; 202 owner; T%d in_review; branch %s → %s; kept ref linked", t2, short7(a1), short7(head))
					return nil
				}
				if time.Now().After(deadline) {
					return fmt.Errorf("T%d %s waits %d, GitHub branch %s, card head %s, 3 min after Discard", t2, card.State, len(card.Waits), short7(head), short7(card.PR.Head))
				}
			}
		}) {
		return
	}

	// J10.4: someone merges an unrelated PR on GitHub.
	var m2 string
	r.step("4 main follows GitHub", "GitHub fake: an unrelated commit lands on main → GET /api/repos/{o}/{r}/mythical; GET /api/github/sync", "the install's main is M2 within 60 s, with no Sync now", "T-GH-07", func() error {
		var err error
		began := time.Now()
		if m2, err = r.pushMain("UNRELATED.md", "unrelated\n", "Unrelated docs change"); err != nil {
			return err
		}
		for deadline := began.Add(2 * time.Minute); ; time.Sleep(500 * time.Millisecond) {
			landed, err := r.landedMain()
			if err != nil {
				return err
			}
			if landed == m2 {
				took := time.Since(began)
				r.actual = fmt.Sprintf("main %s after %s", short7(m2), took.Round(time.Second))
				if took > time.Minute {
					return fmt.Errorf("main followed after %s, want within 60 s", took.Round(time.Second))
				}
				return nil
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("the install's main is %s 2 min after GitHub's %s", short7(landed), short7(m2))
			}
		}
	})
	r.pending("4 The main row shows M2 and its title", "GET /api/live (home) main", "main.sha = M2 with its commit title within 60 s", "T-GH-07, T-APP-01", "home-main-row")
	r.step("4 Branches without people rebase", "GET /api/todos/{T1,T2}; GitHub fake PRs", "T1 and T2 rebase onto M2 with no one acting; same PR numbers; each head's parent is M2", "T-STK-08", func() error {
		if m2 == "" {
			return fmt.Errorf("blocked by row 4")
		}
		for deadline := time.Now().Add(8 * time.Minute); ; time.Sleep(time.Second) {
			done := true
			var states []string
			for _, todo := range []struct{ n, pr int64 }{{t1, pr1}, {t2, pr2}} {
				card, err := r.j10Card(todo.n)
				if err != nil {
					return err
				}
				pull, err := r.readFakePull(todo.pr)
				if err != nil {
					return err
				}
				parent, _ := r.githubGit("rev-parse", pull.Head.SHA+"^")
				states = append(states, fmt.Sprintf("T%d %s PR #%d head %s parent %s", todo.n, card.State, card.PR.Number, short7(pull.Head.SHA), short7(parent)))
				done = done && card.State == "in_review" && card.PR.Number == todo.pr && card.PR.Head == pull.Head.SHA && parent == m2
			}
			r.actual = strings.Join(states, "; ")
			if done {
				return nil
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("not rebased onto %s after 8 min", short7(m2))
			}
		}
	})
	r.step("4 Rebase pending while a person is present", "Ben's live branch:<T1> presence; GitHub fake main moves → GET /api/todos/{T1}",
		"T1 reads rebase_pending and keeps its head while Ben is present; it rebases within 90 s of Ben leaving", "T-STK-08", func() error {
			v1, err := r.todo(t1)
			if err != nil {
				return err
			}
			if v1.Branch == nil || v1.Branch.ID == "" {
				return fmt.Errorf("T%d has no branch", t1)
			}
			socket, err := r.openLive(ben)
			if err != nil {
				return err
			}
			// Ben's Branch card announces where he is, as LiveChannel's
			// presence frame does, and heartbeats while he stays.
			present := func(branch string) error {
				frame, _ := json.Marshal(map[string]any{"t": "presence", "id": 9001, "where": map[string]string{"branch": branch}})
				return socket.send(frame)
			}
			if _, err = socket.subscribe("branch:" + v1.Branch.ID); err != nil {
				return err
			}
			if _, err = socket.wait("branch:"+v1.Branch.ID, 30*time.Second, func(liveFrame) bool { return true }); err != nil {
				return fmt.Errorf("Ben's branch card: %w", err)
			}
			if err = present(v1.Branch.ID); err != nil {
				return err
			}
			defer present("")
			m3, err := r.pushMain("UNRELATED2.md", "unrelated again\n", "Second unrelated docs change")
			if err != nil {
				return err
			}
			pending := false
			for end := time.Now().Add(60 * time.Second); time.Now().Before(end); time.Sleep(time.Second) {
				if time.Now().Unix()%10 == 0 {
					if err = present(v1.Branch.ID); err != nil {
						return err
					}
				}
				card, err := r.j10Card(t1)
				if err != nil {
					return err
				}
				if card.PR.Head != v1.PR.Head {
					return fmt.Errorf("T%d rebased to %s while Ben was present", t1, short7(card.PR.Head))
				}
				pending = pending || card.RebasePending != nil
			}
			if !pending {
				return fmt.Errorf("T%d never read rebase_pending while Ben was present", t1)
			}
			if err = present(""); err != nil {
				return err
			}
			left := time.Now()
			for deadline := left.Add(3 * time.Minute); ; time.Sleep(time.Second) {
				pull, err := r.readFakePull(pr1)
				if err != nil {
					return err
				}
				parent, _ := r.githubGit("rev-parse", pull.Head.SHA+"^")
				if parent == m3 {
					took := time.Since(left)
					r.actual = fmt.Sprintf("rebase_pending, head kept 60 s with Ben present; rebased onto %s %s after he left", short7(m3), took.Round(time.Second))
					if took > 90*time.Second {
						return fmt.Errorf("rebased %s after Ben left, want within 90 s", took.Round(time.Second))
					}
					return nil
				}
				if time.Now().After(deadline) {
					return fmt.Errorf("T%d's PR head %s (parent %s) 3 min after Ben left; main %s", t1, short7(pull.Head.SHA), short7(parent), short7(m3))
				}
			}
		})

	// J10.5: the lead merges on GitHub instead of in Smithers.
	r.step("5 Merge on GitHub turns T1 Merged", "GitHub fake: the owner merges T1's PR → GET /api/todos/{T1}; GET /api/repos/{o}/{r}/mythical; GitHub write log",
		"T1 merged within 60 s, never before the install's main holds the merge commit; no checks.Land; no App merge call", "T-GH-03", func() error {
			if pr1 <= 0 {
				return fmt.Errorf("blocked by T1's PR")
			}
			for deadline := time.Now().Add(8 * time.Minute); ; time.Sleep(time.Second) {
				card, err := r.j10Card(t1)
				if err != nil {
					return err
				}
				pull, err := r.readFakePull(pr1)
				if err != nil {
					return err
				}
				if card.State == "in_review" && card.PR.Head == pull.Head.SHA && !pull.Draft {
					break
				}
				if time.Now().After(deadline) {
					return fmt.Errorf("T%d %s, PR head %s draft=%t: not mergeable on GitHub", t1, card.State, short7(pull.Head.SHA), pull.Draft)
				}
			}
			began := time.Now()
			merged, err := r.fakeControl("/_fake/merge", map[string]any{"repo": repo, "number": pr1})
			if err != nil {
				return err
			}
			var receipt struct {
				SHA string `json:"sha"`
			}
			if err = json.Unmarshal(merged, &receipt); err != nil || len(receipt.SHA) != 40 {
				return fmt.Errorf("GitHub merge receipt %s: %v", merged, err)
			}
			for deadline := began.Add(2 * time.Minute); ; time.Sleep(200 * time.Millisecond) {
				card, err := r.j10Card(t1)
				if err != nil {
					return err
				}
				if card.State == "merged" {
					took := time.Since(began)
					landed, err := r.landedMain()
					if err != nil {
						return err
					}
					if landed != receipt.SHA {
						if _, err := r.githubGit("merge-base", "--is-ancestor", receipt.SHA, landed); err != nil {
							return fmt.Errorf("T%d merged while the install's main %s lacks GitHub's merge %s", t1, short7(landed), short7(receipt.SHA))
						}
					}
					var land bool
					if err := r.pool.QueryRow(r.ctx, `SELECT checks ? 'land' FROM mythical_items WHERE number=$1`, t1).Scan(&land); err != nil {
						return err
					}
					if land || r.appMergeWrites(pr1) != 0 {
						return fmt.Errorf("checks.Land=%t, App merge calls %d", land, r.appMergeWrites(pr1))
					}
					r.actual = fmt.Sprintf("merged %s after GitHub's %s; main %s; no checks.Land; no App merge", took.Round(time.Second), short7(receipt.SHA), short7(landed))
					if took > time.Minute {
						return fmt.Errorf("T%d merged %s after GitHub, want within 60 s", t1, took.Round(time.Second))
					}
					return nil
				}
				if time.Now().After(deadline) {
					return fmt.Errorf("T%d %s 2 min after GitHub merged its PR", t1, card.State)
				}
			}
		})
	r.step("5 T1's issue closes with a link", "GitHub fake issues #I and #J", "the App closes #I as completed with one comment linking the change on main; #J stays open", "T-GH-03, T-STK-09", func() error {
		for deadline := time.Now().Add(time.Minute); ; time.Sleep(250 * time.Millisecond) {
			view, _ := r.fake.Issue(repo, fixed)
			landed := 0
			for _, comment := range view.Comments {
				if comment.ViaApp && strings.Contains(comment.Body, "Landed on main: ") {
					landed++
				}
			}
			r.actual = fmt.Sprintf("#%d %s (%s), %d landed comments", fixed, view.State, view.StateReason, landed)
			if view.State == "closed" && view.StateReason == "completed" && landed == 1 {
				break
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("issue #%d is %s with %d landed comments", fixed, view.State, landed)
			}
		}
		if view, _ := r.fake.Issue(repo, referred); view.State != "open" {
			return fmt.Errorf("issue #%d, only referred to, is %s", referred, view.State)
		}
		return nil
	})
	r.step("5 T2 follows T1's merge", "GitHub fake T2 PR; GET /api/todos/{T2}", "the same PR rebases onto the new main, is ready, no longer names T1; merge ready", "T-GH-03, T-STK-08", func() error {
		for deadline := time.Now().Add(8 * time.Minute); ; time.Sleep(time.Second) {
			card, err := r.j10Card(t2)
			if err != nil {
				return err
			}
			pull, err := r.readFakePull(pr2)
			if err != nil {
				return err
			}
			main, err := r.githubMain()
			if err != nil {
				return err
			}
			parent, _ := r.githubGit("rev-parse", pull.Head.SHA+"^")
			r.actual = fmt.Sprintf("T%d %s merge=%s; PR #%d draft=%t head %s parent %s main %s", t2, card.State, card.Merge.State, pr2, pull.Draft, short7(pull.Head.SHA), short7(parent), short7(main))
			if card.State == "in_review" && card.Merge.State == "ready" && !pull.Draft && parent == main && card.PR.Head == pull.Head.SHA {
				if strings.Contains(pull.Body, fmt.Sprintf("[T%d]", t1)) {
					return fmt.Errorf("T2's body still names the merged T%d: %q", t1, pull.Body)
				}
				return nil
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("T%d did not follow T%d's merge in 8 min", t2, t1)
			}
		}
	})
	r.step("5 Merge T2 on GitHub", "GitHub fake: merge T2's PR → GET /api/todos/{T2}; issue #J", "T2 merged; no App merge call; issue #J still open", "T-GH-03", func() error {
		if _, err := r.fakeControl("/_fake/merge", map[string]any{"repo": repo, "number": pr2}); err != nil {
			return err
		}
		if _, err := r.waitTodoWithin(t2, time.Minute, "merged"); err != nil {
			return err
		}
		if merges := r.appMergeWrites(pr2); merges != 0 {
			return fmt.Errorf("the App called merge %d times", merges)
		}
		time.Sleep(5 * time.Second)
		if view, _ := r.fake.Issue(repo, referred); view.State != "open" {
			return fmt.Errorf("issue #%d closed after T%d merged", referred, t2)
		}
		r.actual = fmt.Sprintf("T%d merged; #%d open", t2, referred)
		return nil
	})

	// C-J10-08: a PR closed on GitHub drops its TODO; a reopen restores it.
	var t3, pr3 int64
	r.step("8 Closed on GitHub turns the TODO Dropped", "POST /api/todos; GitHub fake: close T3's PR → GET /api/todos/{T3}", "T3 dropped, 'closed on GitHub'; Smithers writes nothing to the PR", "T-GH-03, T-STK-05", func() error {
		var err error
		if t3, err = r.file("Close on GitHub", "[PR] [FILE t3.md] Add a note to t3.md."); err != nil {
			return err
		}
		v, err := r.waitTodoWithin(t3, 8*time.Minute, "in_review")
		if err != nil {
			return err
		}
		pr3 = v.PR.Number
		writes := len(r.fake.Writes())
		r.fake.UpdatePull(repo, pr3, func(p *githubfake.Pull) { p.State = "closed" })
		if _, err = r.waitTodoWithin(t3, 2*time.Minute, "dropped"); err != nil {
			return err
		}
		var reason string
		if err := r.pool.QueryRow(r.ctx, `SELECT reason FROM mythical_items WHERE number=$1`, t3).Scan(&reason); err != nil {
			return err
		}
		if !strings.HasPrefix(reason, "closed on GitHub") {
			return fmt.Errorf("T%d dropped for %q", t3, reason)
		}
		for _, write := range r.fake.Writes()[writes:] {
			if strings.Contains(write.Path, fmt.Sprintf("/pulls/%d", pr3)) || strings.Contains(write.Path, fmt.Sprintf("/issues/%d/", pr3)) {
				return fmt.Errorf("Smithers wrote %s %s after GitHub's close", write.Method, write.Path)
			}
		}
		r.actual = fmt.Sprintf("T%d dropped: %q; no write to PR #%d", t3, reason, pr3)
		return nil
	})
	r.pending("8 Dropped names who closed it", "GET /api/todos/{T3} reason", "'closed on GitHub by @alice': the closer is on the issue's closed_by, which the pulls stream does not carry", "T-GH-03", "closer-actor")
	r.step("8 Reopen restores it", "GitHub fake: reopen T3's PR → GET /api/todos/{T3}", "T3 back in review under the same PR", "T-GH-03", func() error {
		if pr3 <= 0 {
			return fmt.Errorf("blocked by row 8")
		}
		r.fake.UpdatePull(repo, pr3, func(p *githubfake.Pull) { p.State = "open" })
		v, err := r.waitTodoWithin(t3, 2*time.Minute, "in_review")
		if err != nil {
			return err
		}
		if v.PR.Number != pr3 {
			return fmt.Errorf("T%d reopened under PR #%d, was #%d", t3, v.PR.Number, pr3)
		}
		r.actual = fmt.Sprintf("T%d in_review under PR #%d", t3, pr3)
		return nil
	})

	// C-J10-09: /review on a teammate's PR.
	r.pending("9 /review a teammate's PR", "POST /api/reviews {number} for Alice's PR", "the Active review flow in an ephemeral machine at the PR head; findings to Ben; no GitHub write; no TODO", "T-FLW-13", "review-machine")
	r.step("9 An outsider's PR gets no machine", "GitHub fake: @outsider's PR #900 → POST /api/reviews {number: 900} as Ben", "refused with class permission; no machine requested", "T-FLW-13", func() error {
		r.fake.UpdatePull(repo, 900, func(p *githubfake.Pull) {
			p.Repository, p.Number, p.State, p.Title = repo, 900, "open", "Outsider cache change"
			p.User = &githubfake.PullAuthor{ID: 900, Login: "outsider", Type: "User"}
			p.HTMLURL = "https://github.com/" + repo + "/pull/900"
			p.Head.Ref, p.Base.Ref = "outsider:cache", "main"
			p.Head.SHA = strings.Repeat("9", 40)
		})
		code, data, err := r.keyedAs(ben, "POST", "/api/reviews", `{"number":900,"conversation":"main"}`, r.keyPrefix+"review-outsider")
		if err != nil {
			return err
		}
		if code != 403 || !strings.Contains(string(data), `"class":"permission"`) {
			return fmt.Errorf("outsider review: HTTP %d %s", code, data)
		}
		var machines int
		if err := r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_requests WHERE operation='install.review'`).Scan(&machines); err != nil {
			return err
		}
		if machines != 0 {
			return fmt.Errorf("the refused review left %d review jobs", machines)
		}
		r.actual = fmt.Sprintf("403 %s; no install.review job", data)
		return nil
	})

	// J10.6: the main row's sync, through a network drop.
	r.step("6 main reads synced", "GET /api/github/sync ×5 over 10 s", "{state, last_success_at} only, no precomputed age; fresh; last success within 60 s", "T-GH-07", func() error {
		for i := 0; i < 5; i++ {
			health, at, err := r.syncHealth()
			if err != nil {
				return err
			}
			for key := range health {
				if !slices.Contains([]string{"state", "last_success_at", "cause", "retry_at"}, key) {
					return fmt.Errorf("GET /api/github/sync carries %q", key)
				}
			}
			if health["state"] != "fresh" || at.IsZero() || time.Since(at) > time.Minute {
				return fmt.Errorf("sync %v, last success %s ago", health["state"], time.Since(at).Round(time.Second))
			}
			r.actual = fmt.Sprintf("fresh, synced %s ago", time.Since(at).Round(time.Second))
			time.Sleep(2 * time.Second)
		}
		return nil
	})
	r.step("6 Network drop turns stale past 120 s, Retry", "GitHub fake outage → GET /api/github/sync every 1 s; POST /api/github/sync as Alice; outage over → POST /api/github/sync",
		"never stale before last success + 120 s, stale at once after; Alice's Retry 202 at once and still stale while down; fresh within 10 s of a Retry after", "T-GH-07", func() error {
			if _, err := r.fakeControl("/_fake/outage", map[string]any{"down": true}); err != nil {
				return err
			}
			defer r.fakeControl("/_fake/outage", map[string]any{"down": false})
			var stale time.Time
			var last time.Time
			for deadline := time.Now().Add(4 * time.Minute); ; time.Sleep(time.Second) {
				health, at, err := r.syncHealth()
				if err != nil {
					return err
				}
				if !at.IsZero() {
					last = at
				}
				if health["state"] != "fresh" {
					stale = time.Now()
					if health["state"] != "stale" {
						return fmt.Errorf("sync %v during the outage, want stale", health["state"])
					}
					break
				}
				if time.Now().After(deadline) {
					return fmt.Errorf("still fresh 4 min into the outage, last success %s", last.Format(time.RFC3339))
				}
			}
			if gap := stale.Sub(last); gap < 118*time.Second || gap > 125*time.Second {
				return fmt.Errorf("stale %s after the last success, want 120 s", gap.Round(time.Second))
			}
			began := time.Now()
			if code, data, err := r.keyedAs(alice, "POST", "/api/github/sync", "", r.keyPrefix+"retry-down"); err != nil || code != 202 {
				return fmt.Errorf("Alice's Retry: %d %s %v", code, data, err)
			}
			if took := time.Since(began); took > time.Second {
				return fmt.Errorf("Retry answered in %s", took.Round(time.Millisecond))
			}
			time.Sleep(3 * time.Second)
			if health, _, err := r.syncHealth(); err != nil || health["state"] == "fresh" {
				return fmt.Errorf("sync %v while GitHub is down: %v", health["state"], err)
			}
			if _, err := r.fakeControl("/_fake/outage", map[string]any{"down": false}); err != nil {
				return err
			}
			retried := time.Now()
			if code, data, err := r.keyedAs(alice, "POST", "/api/github/sync", "", r.keyPrefix+"retry-up"); err != nil || code != 202 {
				return fmt.Errorf("Alice's Retry after the outage: %d %s %v", code, data, err)
			}
			for deadline := retried.Add(10 * time.Second); ; time.Sleep(250 * time.Millisecond) {
				health, at, err := r.syncHealth()
				if err != nil {
					return err
				}
				if health["state"] == "fresh" && at.After(retried.Add(-time.Second)) {
					r.actual = fmt.Sprintf("stale %s after the last success; Retry 202 while down; fresh %s after Retry", stale.Sub(last).Round(time.Second), time.Since(retried).Round(time.Second))
					return nil
				}
				if time.Now().After(deadline) {
					return fmt.Errorf("sync %v 10 s after Retry", health["state"])
				}
			}
		})
	r.pending("6 App agent retries the sync", "POST /api/agent/turn 'retry the GitHub sync'", "github.retry runs at once with no confirmation (agent: run); fresh within 10 s", "T-GH-07", "agent-retry")
	r.pending("6 Refusal names the App installation", "GitHub: the App's installation suspended → GET /api/github/sync; Home", "state refused with the installation as the cause and a link to Settings", "T-GH-07", "installation-refused")

	// C-J10-07: main rewritten on GitHub (last: it ends main following).
	r.step("7 A force-push to main changes nothing", "GitHub fake: main rewritten to a non-descendant → POST /api/github/sync; GET /api/repos/{o}/{r}/mythical; GitHub write log",
		"the install's main stays put; no write to GitHub's main; the sync is not fresh", "T-GH-07", func() error {
			before, err := r.landedMain()
			if err != nil {
				return err
			}
			main, err := r.githubMain()
			if err != nil {
				return err
			}
			tree, err := r.githubGit("rev-parse", main+"^{tree}")
			if err != nil {
				return err
			}
			parent, err := r.githubGit("rev-parse", main+"^")
			if err != nil {
				return err
			}
			rewritten, err := r.githubGit("commit-tree", tree, "-p", parent, "-m", "Rewritten on GitHub")
			if err != nil {
				return err
			}
			if _, err = r.githubGit("update-ref", "refs/heads/main", rewritten, main); err != nil {
				return err
			}
			writes := len(r.fake.Writes())
			if code, _, err := r.keyed("POST", "/api/github/sync", "", r.keyPrefix+"force-push"); err != nil || code != 202 {
				return fmt.Errorf("Sync now: %d %v", code, err)
			}
			time.Sleep(40 * time.Second)
			after, err := r.landedMain()
			if err != nil {
				return err
			}
			if after != before {
				return fmt.Errorf("the install's main moved %s → %s on a force-push", short7(before), short7(after))
			}
			if head, _ := r.githubMain(); head != rewritten {
				return fmt.Errorf("GitHub's main moved from the rewrite %s to %s", short7(rewritten), short7(head))
			}
			for _, write := range r.fake.Writes()[writes:] {
				if strings.Contains(write.Path, "refs/heads/main") {
					return fmt.Errorf("Smithers wrote GitHub's main: %s %s", write.Method, write.Path)
				}
			}
			r.actual = fmt.Sprintf("install main %s kept; GitHub main %s untouched", short7(after), short7(rewritten))
			return nil
		})
	r.pending("7 The owner confirms Reset to GitHub main", "Home attention force_push; POST /api/stack/attention/{id}", "one owner-only force_push attention row; merges held; Reset moves main to the rewrite once", "T-GH-07, T-ACC-03", "main-reset")
}
