package compose

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
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

// j10RunWait bounds one scripted TODO run, start to In review, on a shared
// host where machine readiness alone can take minutes.
const j10RunWait = 15 * time.Minute

// j10BuiltinReviewActive is C-J10-09's setup row: with no flows/review of its
// own, the repository's Active review is the built-in version the install
// ships, and admission pins it at the main commit flow-load last settled.
func (r *rehearsal) j10BuiltinReviewActive() {
	r.step("0c Built-in review is Active", "GET /api/flows; flow_loads", "review: source builtin, system false, Active is the shipped digest; flow-load settled at a main commit", "T-FLW-13", func() error {
		shipped, err := builtinReviewDigest()
		if err != nil {
			return err
		}
		card, err := r.flowCard("review")
		if err != nil {
			return err
		}
		if !card.Source.Builtin || card.version("active") != shipped {
			return fmt.Errorf("review has source %+v, Active %q; want built in at %s", card.Source, card.version("active"), shipped)
		}
		for deadline := time.Now().Add(5 * time.Minute); ; time.Sleep(time.Second) {
			var loaded string
			if err := r.pool.QueryRow(r.ctx, `SELECT coalesce(max(loaded_commit),'') FROM flow_loads`).Scan(&loaded); err != nil {
				return err
			}
			if len(loaded) == 40 {
				r.actual = fmt.Sprintf("review built in, Active %s…; flow-load settled at %s", shipped[:12], loaded[:12])
				return nil
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("review built in, Active %s…; flow-load has not settled after 5 min", shipped[:12])
			}
		}
	})
}

// j10MemberReview is C-J10-09 S1 step 1: Alice pushes her own branch and opens
// a PR, and Ben runs /review on it. Admission pins the Active review before it
// asks for a machine; completion must deliver anchored findings and retire it.
func (r *rehearsal) j10MemberReview(ben http.CookieJar, repo string) {
	const memberPR = 901
	reviewRoute := fmt.Sprintf("git push alice/cache; GitHub fake: Alice's PR #%d → POST /api/reviews as Ben; GET /api/reviews/{id}", memberPR)
	reviewExpected := "202 pinned to the built-in review at the PR head; completed in an ephemeral machine with findings; no GitHub write; no TODO"
	reviewWrites, reviewItems := len(r.fake.Writes()), 0
	if err := r.pool.QueryRow(r.ctx, `SELECT count(*) FROM mythical_items`).Scan(&reviewItems); err != nil {
		r.t.Fatal(err)
	}
	reviewHead, reviewBase, reviewErr := r.pushMemberBranch("alice/cache", "Bound the cache", map[string]string{
		"src/cache.ts": "export const evict = (entries: string[], capacity: number) =>\n  entries.length > capacity ? entries.slice(entries.length - capacity - 1) : entries\n",
	})
	reviewCode, reviewData := 0, []byte(nil)
	if reviewErr == nil {
		r.fake.UpdatePull(repo, memberPR, func(p *githubfake.Pull) {
			p.Repository, p.Number, p.State, p.Title = repo, memberPR, "open", "Bound the cache"
			p.ID, p.NodeID, p.CreatedAt = memberPR, "PR_review_member", time.Now().UTC()
			p.User = &githubfake.PullAuthor{ID: 202, Login: "alice", Type: "User"}
			p.HTMLURL = fmt.Sprintf("https://github.com/%s/pull/%d", repo, memberPR)
			p.Head.Ref, p.Base.Ref = "alice/cache", "main"
			p.Head.SHA, p.Base.SHA = reviewHead, reviewBase
			p.Head.Repo.FullName, p.Base.Repo.FullName = repo, repo
		})
		reviewCode, reviewData, reviewErr = r.keyedAs(ben, "POST", "/api/reviews", fmt.Sprintf(`{"number":%d,"conversation":"main"}`, memberPR), r.keyPrefix+"review-member")
	}
	r.step("9 /review a teammate's PR", reviewRoute, reviewExpected, "T-FLW-13", func() error {
		if reviewErr != nil {
			return reviewErr
		}
		if reviewCode != 202 {
			return fmt.Errorf("HTTP %d %s", reviewCode, reviewData)
		}
		shipped, err := builtinReviewDigest()
		if err != nil {
			return err
		}
		var admission struct {
			Head        string `json:"head"`
			OperationID string `json:"operationId"`
			Pin         struct {
				Flow            string `json:"flow"`
				SourceCommit    string `json:"sourceCommit"`
				ExecutionDigest string `json:"executionDigest"`
			} `json:"pin"`
		}
		if err := json.Unmarshal(reviewData, &admission); err != nil {
			return err
		}
		if admission.Head != reviewHead || admission.Pin.Flow != "review" || admission.Pin.ExecutionDigest != shipped || len(admission.Pin.SourceCommit) != 40 {
			return fmt.Errorf("admitted %s", reviewData)
		}
		var status struct {
			State  string          `json:"state"`
			Change json.RawMessage `json:"change"`
			Error  string          `json:"error"`
		}
		for deadline := time.Now().Add(j10RunWait); status.State != "completed"; time.Sleep(2 * time.Second) {
			data, err := r.expectAs(ben, "GET", "/api/reviews/"+admission.OperationID, "", 200)
			if err != nil {
				return err
			}
			if err := json.Unmarshal(data, &status); err != nil {
				return err
			}
			if status.State == "failed" || status.State == "cancelled" || time.Now().After(deadline) {
				return fmt.Errorf("review %s: %s %s", admission.OperationID, status.State, status.Error)
			}
		}
		if len(status.Change) == 0 || string(status.Change) == "null" {
			return fmt.Errorf("review %s completed without findings", admission.OperationID)
		}

		var change struct {
			PullRequest struct {
				Number int    `json:"number"`
				URL    string `json:"url"`
			} `json:"pullRequest"`
			Findings []struct {
				Path     string `json:"path"`
				Line     int    `json:"line"`
				Severity string `json:"severity"`
			} `json:"findings"`
		}
		if err := json.Unmarshal(status.Change, &change); err != nil {
			return err
		}
		if change.PullRequest.Number != memberPR || change.PullRequest.URL != fmt.Sprintf("https://github.com/%s/pull/%d", repo, memberPR) {
			return fmt.Errorf("review findings lost their PR link: %s", status.Change)
		}
		anchored := false
		for _, finding := range change.Findings {
			anchored = anchored || finding.Path == "src/cache.ts" && finding.Line == 2 && finding.Severity == "fix"
		}
		if !anchored {
			return fmt.Errorf("cache finding missing: %s", status.Change)
		}
		conversation, err := r.expectAs(ben, "GET", "/api/conversations/main", "", 200)
		if err != nil {
			return err
		}
		if !strings.Contains(string(conversation), "Off by one") || !strings.Contains(string(conversation), fmt.Sprintf("/pull/%d", memberPR)) {
			return fmt.Errorf("conversation has no findings and PR link: %s", conversation)
		}
		var machines int
		if err := r.pool.QueryRow(r.ctx, `SELECT count(*) FROM workspaces WHERE id=$1`, reviewWorkspaceID(admission.OperationID)).Scan(&machines); err != nil {
			return err
		}
		if machines != 0 {
			return fmt.Errorf("completed review left its ephemeral machine")
		}
		for _, write := range r.fake.Writes()[reviewWrites:] {
			if strings.Contains(write.Path, fmt.Sprintf("/pulls/%d", memberPR)) || strings.Contains(write.Path, fmt.Sprintf("/issues/%d/", memberPR)) || strings.Contains(write.Path, "/statuses/"+reviewHead) {
				return fmt.Errorf("the review wrote %s %s", write.Method, write.Path)
			}
		}
		var items int
		if err := r.pool.QueryRow(r.ctx, `SELECT count(*) FROM mythical_items`).Scan(&items); err != nil {
			return err
		}
		if items != reviewItems {
			return fmt.Errorf("the review left %d stack items, was %d", items, reviewItems)
		}
		r.actual = fmt.Sprintf("202 pinned %s… at %s; completed with findings; no GitHub write; no TODO", shipped[:12], reviewHead[:12])
		return nil
	})
}

// builtinReviewDigest is the review version the install ships (builtin_flows.json).
func builtinReviewDigest() (string, error) {
	cards, err := services.FlowCatalog()
	if err != nil {
		return "", err
	}
	for _, card := range cards {
		if card.Name == "review" && len(card.Versions) == 1 {
			return card.Versions[0].ID, nil
		}
	}
	return "", fmt.Errorf("the install ships no review")
}

// pushMemberBranch commits files onto a new branch from GitHub's main, as a
// member pushing their own branch would, and answers its head and base.
func (r *rehearsal) pushMemberBranch(branch, message string, files map[string]string) (string, string, error) {
	work := r.t.TempDir()
	run := func(args ...string) (string, error) {
		cmd := exec.Command("/usr/bin/git", args...)
		cmd.Dir = work
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=Alice", "GIT_AUTHOR_EMAIL=alice@example.test", "GIT_COMMITTER_NAME=Alice", "GIT_COMMITTER_EMAIL=alice@example.test")
		out, err := cmd.CombinedOutput()
		if err != nil {
			return "", fmt.Errorf("git %s: %v: %s", strings.Join(args, " "), err, out)
		}
		return strings.TrimSpace(string(out)), nil
	}
	if _, err := run("clone", "-q", "--branch", "main", filepath.Join(r.gitRoot, "rehearsal-owner/app.git"), "."); err != nil {
		return "", "", err
	}
	base, err := run("rev-parse", "HEAD")
	if err != nil {
		return "", "", err
	}
	for path, content := range files {
		if err := os.MkdirAll(filepath.Join(work, filepath.Dir(path)), 0700); err != nil {
			return "", "", err
		}
		if err := os.WriteFile(filepath.Join(work, path), []byte(content), 0600); err != nil {
			return "", "", err
		}
	}
	for _, args := range [][]string{{"add", "-A"}, {"commit", "-q", "-m", message}, {"push", "-q", "origin", "HEAD:refs/heads/" + branch}} {
		if _, err := run(args...); err != nil {
			return "", "", err
		}
	}
	head, err := run("rev-parse", "HEAD")
	return head, base, err
}

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

// mirroredMain observes the install's actual main bookmark. The stack's fold
// checkpoint may still lag after GitHub sync has imported a person's merge.
func (r *rehearsal) mirroredMain() (string, error) {
	data, err := r.expect("GET", "/api/repos/rehearsal-owner/app/bookmarks", "", 200)
	if err != nil {
		return "", err
	}
	var bookmarks struct {
		Items []struct {
			Name string `json:"name"`
			Head string `json:"target_commit_id"`
		} `json:"items"`
	}
	if err := json.Unmarshal(data, &bookmarks); err != nil {
		return "", err
	}
	for _, bookmark := range bookmarks.Items {
		if bookmark.Name == "main" && len(bookmark.Head) == 40 {
			return bookmark.Head, nil
		}
	}
	return "", fmt.Errorf("install main bookmark missing: %s", data)
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

// E-19 ends route-to-deliver rather than keeping a permanent review loop.
// Only a completed composition may resume on one new attempt; its item and
// pinned version remain the authority. An unfinished run continues in place.
func (r *rehearsal) j10ContinuesTodo(n int64, before, after j3Lane) error {
	if before == after {
		return nil
	}
	if after.attempt != before.attempt+1 || before.run == after.run {
		return fmt.Errorf("TODO continuation changed an unfinished attempt: %+v → %+v", before, after)
	}
	var completed int
	err := r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_dispatches d
 JOIN product_job_requests j ON j.id=d.operation_id
 JOIN mythical_items i ON i.number=$2
 WHERE d.operation_id::text=$1 AND j.state='completed'
 AND d.external_receipt->'run'->>'status'='completed'
 AND d.external_receipt->>'executionDigest'=i.flow_digest
 AND d.external_receipt->'projection'->>'itemId'=i.id::text`, strings.TrimPrefix(before.run, "dispatch:"), n).Scan(&completed)
	if err != nil {
		return err
	}
	if completed != 1 {
		return fmt.Errorf("TODO continuation has %d completed same-item, same-pin receipts for %s", completed, before.run)
	}
	return nil
}

func (r *rehearsal) j10AgentRetry(alice http.CookieJar) {
	r.step("6 App agent retries the sync", "POST /api/conversations/main/prompt as Alice", "github runs without confirmation; fresh within 10 s", "T-GH-07", func() error {
		var before int
		if err := r.pool.QueryRow(r.ctx, `SELECT count(*) FROM approvals`).Scan(&before); err != nil {
			return err
		}
		retries := func() int {
			count := 0
			for _, line := range strings.Split(r.logs.String(), "\n") {
				var entry struct {
					Request struct {
						Method string `json:"requestMethod"`
						URL    string `json:"requestUrl"`
						Status int    `json:"status"`
					} `json:"httpRequest"`
				}
				if json.Unmarshal([]byte(line), &entry) == nil && entry.Request.Method == "POST" && entry.Request.URL == "/api/github/sync" && entry.Request.Status == 202 {
					count++
				}
			}
			return count
		}
		requests := retries()
		began := time.Now()
		reply, _, err := r.askAs(alice, `retry the GitHub sync
Run /github {"operation":"retry"}`)
		if err != nil {
			return err
		}
		if retries() != requests+1 {
			return fmt.Errorf("agent Retry made %d accepted sync requests; reply %q", retries()-requests, reply)
		}
		if j9Confirmation.MatchString(reply) {
			return fmt.Errorf("Retry asked for confirmation: %s", reply)
		}
		var after int
		if err := r.pool.QueryRow(r.ctx, `SELECT count(*) FROM approvals`).Scan(&after); err != nil {
			return err
		}
		if after != before {
			return fmt.Errorf("Retry created a confirmation")
		}
		for deadline := began.Add(10 * time.Second); ; time.Sleep(100 * time.Millisecond) {
			health, at, err := r.syncHealth()
			if err != nil {
				return err
			}
			if health["state"] == "fresh" && at.After(began) {
				r.actual = "agent Retry refreshed sync without Confirm"
				return nil
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("agent Retry did not refresh: %s; health %v", reply, health)
			}
		}
	})
}

func (r *rehearsal) j10InstallationRefusal() {
	r.step("6 Refusal names the App installation", "GitHub App installation suspended; Retry; GET /api/github/sync; Home", "refused with permission cause; Home names GitHub App and Settings", "T-GH-07", func() error {
		r.fake.SetInstallationSuspended(r.installationID, true)
		defer r.fake.SetInstallationSuspended(r.installationID, false)
		if _, err := r.expect("POST", "/api/github/sync", "{}", 202); err != nil {
			return err
		}
		for deadline := time.Now().Add(30 * time.Second); ; time.Sleep(100 * time.Millisecond) {
			health, _, err := r.syncHealth()
			if err != nil {
				return err
			}
			if health["state"] == "refused" {
				if health["cause"] != "permission" {
					return fmt.Errorf("unexpected installation cause %v", health)
				}
				live, err := r.openLive(r.jar)
				if err != nil {
					return err
				}
				defer live.stop()
				if _, err = live.subscribe("home"); err != nil {
					return err
				}
				_, err = live.latest("home", 5*time.Second, func(frame liveFrame) bool {
					return strings.Contains(string(frame.Data), "GitHub App permission missing")
				})
				if err != nil {
					return err
				}
				wire := []map[string]string{}
				for _, cookie := range r.jar.Cookies(mustRehearsalURL(r.origin)) {
					wire = append(wire, map[string]string{"name": cookie.Name, "value": cookie.Value})
				}
				cookies, _ := json.Marshal(wire)
				cmd := exec.CommandContext(r.ctx, "bun", "e2e/real/github-refusal.browser.ts")
				cmd.Dir = filepath.Join(r.root, "apps/app")
				cmd.Env = append(os.Environ(), "SMITHERS_GITHUB_BROWSER_ORIGIN="+r.origin, "SMITHERS_GITHUB_BROWSER_COOKIES="+string(cookies), "SMITHERS_GITHUB_BROWSER_EVIDENCE="+r.evidence)
				output, err := cmd.CombinedOutput()
				if writeErr := os.WriteFile(filepath.Join(r.evidence, "github-refusal-browser.log"), output, 0600); writeErr != nil {
					return writeErr
				}
				if err != nil {
					return fmt.Errorf("refused Home browser: %w: %s", err, output)
				}
				r.fake.SetInstallationSuspended(r.installationID, false)
				resumed := time.Now()
				if _, err := r.expect("POST", "/api/github/sync", "{}", 202); err != nil {
					return err
				}
				for deadline := resumed.Add(10 * time.Second); ; time.Sleep(100 * time.Millisecond) {
					recovered, at, err := r.syncHealth()
					if err != nil {
						return err
					}
					if recovered["state"] == "fresh" && at.After(resumed) {
						break
					}
					if time.Now().After(deadline) {
						return fmt.Errorf("sync did not recover after unsuspend: %v", recovered)
					}
				}
				r.actual = "refused: GitHub App permission missing; Fix opens Settings; unsuspend and Retry recover"
				return nil
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("installation permission refusal not projected: %v", health)
			}
		}
	})

}

func (r *rehearsal) j10NetworkDrop(alice http.CookieJar) {
	r.step("6 Network drop turns stale past 120 s, Retry", "GitHub fake outage → GET /api/github/sync every 1 s; POST /api/github/sync as Alice; outage over → POST /api/github/sync",
		"never stale before last success + 120 s, stale at once after; Alice's Retry 202 at once and still stale while down; fresh within 10 s of a Retry after", "T-GH-07", func() error {
			if _, err := r.fakeControl("/_fake/outage", map[string]any{"down": true}); err != nil {
				return err
			}
			defer r.fakeControl("/_fake/outage", map[string]any{"down": false})
			// Recover health from the install's persisted receipts before the
			// stale boundary. No successful upstream read can refresh them.
			_, persisted, err := r.syncHealth()
			if err != nil || persisted.IsZero() {
				return fmt.Errorf("pre-restart receipt: %s %v", persisted, err)
			}
			r.restartBackend()
			health, recovered, err := r.syncHealth()
			if err != nil || health["state"] != "fresh" || !recovered.Equal(persisted) {
				return fmt.Errorf("recovered health %v at %s, want fresh at %s: %v", health, recovered, persisted, err)
			}
			home, err := r.openLive(alice)
			if err != nil {
				return err
			}
			defer home.stop()
			if _, err = home.subscribe("home"); err != nil {
				return err
			}
			mainHealth := func(frame liveFrame) string {
				var payload struct {
					Main struct {
						Health string `json:"health"`
					} `json:"main"`
				}
				_ = json.Unmarshal(frame.Data, &payload)
				return payload.Main.Health
			}
			if _, err = home.latest("home", 5*time.Second, func(frame liveFrame) bool { return mainHealth(frame) == "fresh" }); err != nil {
				return err
			}
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
			frame, err := home.latest("home", 3*time.Second, func(frame liveFrame) bool { return mainHealth(frame) == "stale" })
			if err != nil {
				return err
			}
			if age := frame.At.Sub(persisted); age < 120*time.Second || age > 123*time.Second {
				return fmt.Errorf("restarted Home became stale after %s, want (120 s, 123 s]", age)
			}
			transitions, prior := 0, "fresh"
			for _, observed := range home.received("home") {
				if observed.T != "snap" {
					continue
				}
				state := mainHealth(observed)
				if state != prior {
					transitions++
					prior = state
				}
			}
			if transitions != 1 {
				return fmt.Errorf("Home health changed %d times during the outage, want one fresh to stale transition", transitions)
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
}

// The focused sync rows reach the same composed command doors without waiting for
// the preceding TODO review and rebase runs.
func TestJ10SyncRehearsal(t *testing.T) {
	r := newRehearsal(t, "SMITHERS_J10_REHEARSAL", "C-J10-sync", "j10-sync-")
	if !r.setupSource() {
		return
	}
	alice, err := r.member("alice", 202, "write")
	if err != nil {
		t.Fatal(err)
	}
	r.j10AgentRetry(alice)
	r.j10NetworkDrop(alice)
	r.j10InstallationRefusal()
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
	r.j10BuiltinReviewActive()
	// Independent member PR review does not depend on the TODO coding rows.
	r.j10MemberReview(ben, repo)
	var t1, t2, pr1, pr2 int64
	var pull1URL, head2 string
	if !r.step("1 File T1", "POST /api/todos {issue, issue_digest, fixes}", "202; T1 fixes #I", "T-STK-01, T-STK-09", func() error {
		var err error
		if t1, err = r.todoFromIssue(fixed, true, "Add retry helper", "[PR] [FILE retry-helper.md] Add a retry helper for webhook deliveries.", []string{"retry-helper.md describes the helper"}); err != nil {
			return err
		}
		r.actual = fmt.Sprintf("202 T%d from #%d (fixes)", t1, fixed)
		return nil
	}) {
		return
	}
	if !r.step("1 T1 in review", "GET /api/todos/{T1}; GitHub fake PR", "in_review; PR smithers/add-retry-helper at the card's head, base main, ready", "T-STK-01, T-GH-03", func() error {
		v, err := r.waitTodoWithin(t1, j10RunWait, "in_review")
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
	// T2 is filed once T1 is in review, so it builds on T1's verified head.
	if !r.step("1 File T2 behind T1", "POST /api/todos {issue, issue_digest}", "202; T2 refers to #J and is placed after T1", "T-STK-01, T-STK-09", func() error {
		var err error
		if t2, err = r.todoFromIssue(referred, false, "Retry webhooks", "[PR] [FILE retry-webhooks.md] Retry failed webhook deliveries.", []string{"retries 3 times with backoff"}); err != nil {
			return err
		}
		if t2 == t1 {
			return fmt.Errorf("both TODOs are T%d", t1)
		}
		r.actual = fmt.Sprintf("202 T%d from #%d after T%d", t2, referred, t1)
		return nil
	}) {
		return
	}
	if !r.step("1 T2's PR shape", "GET /api/todos/{T2}; GitHub fake GET /repos/{o}/{r}/pulls/{n}; git rev-list --parents; git ls-tree",
		"title 'Retry webhooks'; head smithers/retry-webhooks; base main; draft; opened once by the App; one parent, main's tip, with T1's and T2's files; body: prompt, acceptance, checks, diff stat, review, Includes [T1](PR), link back, Requested by @owner; no closing keyword",
		"T-GH-03, T-REL-02", func() error {
			v, err := r.waitTodoWithin(t2, j10RunWait, "in_review")
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
			// The review of the open PR adds its summary line to the body.
			body := pull.Body
			for deadline := time.Now().Add(5 * time.Minute); !strings.Contains(body, "\n\nReview: approve\n\n"); time.Sleep(500 * time.Millisecond) {
				if time.Now().After(deadline) {
					return fmt.Errorf("T2's PR body has no review summary 5 min after In review: %q", body)
				}
				reread, err := r.readFakePull(pr2)
				if err != nil {
					return err
				}
				body = reread.Body
			}
			for _, want := range []string{"Retry failed webhook deliveries.", "retries 3 times with backoff", "Checks:\n- ", " changed",
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
	if !r.step("1 Amend updates the same PR", "PATCH /api/todos/{T2} ×2; GitHub fake PR",
		"revision 2 replaces the PR prompt; same TODO, branch, PR and flow pin; one amendment", "T-GH-03, T-STK-06", func() error {
			before, err := r.j3Lane(t2)
			if err != nil {
				return err
			}
			const prompt = "[PR] [FILE retry-webhooks.md] Retry webhook deliveries and log each retry."
			body, err := json.Marshal(map[string]string{"prompt": prompt})
			if err != nil {
				return err
			}
			for range 2 {
				code, data, err := r.keyed("PATCH", fmt.Sprintf("/api/todos/%d", t2), string(body), r.keyPrefix+"amend-review")
				if err != nil {
					return err
				}
				var receipt struct {
					N   int64 `json:"n"`
					Rev int   `json:"rev"`
				}
				if code != 202 || json.Unmarshal(data, &receipt) != nil || receipt.N != t2 || receipt.Rev != 2 {
					return fmt.Errorf("Amend: HTTP %d %s, want 202 {n: %d, rev: 2}", code, data, t2)
				}
			}
			v, err := r.waitTodoWithin(t2, j10RunWait, "in_review")
			if err != nil {
				return err
			}
			after, err := r.j3Lane(t2)
			if err != nil {
				return err
			}
			if err := r.j10ContinuesTodo(t2, before, after); err != nil {
				return err
			}
			if v.PR.Number != pr2 || v.Branch == nil || v.Branch.Name != branch2 {
				return fmt.Errorf("Amend replaced its branch or PR: %+v", v)
			}
			pull, err := r.checkPull(pr2, v.PR.Head)
			if err != nil {
				return err
			}
			if !strings.Contains(pull.Body, "Retry webhook deliveries and log each retry.") || strings.Contains(pull.Body, "Retry failed webhook deliveries.") {
				return fmt.Errorf("PR body does not replace revision 1 with revision 2: %q", pull.Body)
			}
			var revisions, events int
			if err := r.pool.QueryRow(r.ctx, `SELECT jsonb_array_length(revisions) FROM mythical_items WHERE number=$1`, t2).Scan(&revisions); err != nil {
				return err
			}
			if err := r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.amended' AND data->>'n'=$1`, fmt.Sprint(t2)).Scan(&events); err != nil {
				return err
			}
			if revisions != 2 || events != 1 {
				return fmt.Errorf("Amend revisions=%d events=%d, want 2 and 1", revisions, events)
			}
			head2 = v.PR.Head
			r.actual = fmt.Sprintf("PR #%d revision 2 on run %s; one amendment", pr2, after.run)
			return nil
		}) {
		return
	}

	// J10.2: a teammate's review on GitHub steers the same attempt.
	var reviewLane j3Lane
	if !r.step("2 Review comment becomes a steer", "GitHub fake: Alice requests changes with a line comment on T2's PR → GET /api/todos/{T2}; SQL product_job_events",
		"within 60 s T2 reads working with Alice's steer anchored retry-webhooks.md:1; one todo.github_input event for it", "T-GH-04", func() error {
			if pr2 <= 0 {
				return fmt.Errorf("blocked by T2's PR")
			}
			var err error
			if reviewLane, err = r.j3Lane(t2); err != nil {
				return err
			}
			began := time.Now()
			// [CHANGELOG] makes the scripted fix (fake-todo-turns.mjs) change the
			// tree, so the steered attempt has a new head to push.
			if _, err := r.fakeControl("/_fake/reviews", map[string]any{"repo": repo, "number": pr2, "login": "alice", "state": "CHANGES_REQUESTED",
				"body": "Use the existing backoff helper [CHANGELOG]", "path": "retry-webhooks.md", "line": 1}); err != nil {
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
		// The steer continues the TODO; In review counts only with its new head.
		var v rehearsalTodo
		for deadline := time.Now().Add(j10RunWait); ; time.Sleep(time.Second) {
			var err error
			if v, err = r.todo(t2); err != nil {
				return err
			}
			if v.State == "in_review" && v.PR.Head != head2 {
				break
			}
			if v.State == "failed" || v.State == "dropped" || time.Now().After(deadline) {
				return fmt.Errorf("T2 %s with PR #%d at %s after the steer (was %s)", v.State, v.PR.Number, short7(v.PR.Head), short7(head2))
			}
		}
		lane, err := r.j3Lane(t2)
		if err != nil {
			return err
		}
		if err := r.j10ContinuesTodo(t2, reviewLane, lane); err != nil {
			return err
		}
		if v.PR.Number != pr2 {
			return fmt.Errorf("the fix opened PR #%d, not #%d", v.PR.Number, pr2)
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
	var approval int64
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
			approval = submitted.ID
			if err = r.waitSQL(2*time.Minute, `SELECT count(*) FROM product_job_events WHERE event_type='todo.github_input' AND data->>'object'='review:'||$1::text`, fmt.Sprint(submitted.ID)); err != nil {
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
	r.step("2 The PR card lists the approval", "GET /api/todos/{T2} pr.reviews", "the owner's APPROVED review on T2's PR card, by the owner; never a Smithers approval", "T-GH-04", func() error {
		if approval == 0 {
			return fmt.Errorf("blocked by the approval row")
		}
		data, err := r.expect("GET", fmt.Sprintf("/api/todos/%d", t2), "", 200)
		if err != nil {
			return err
		}
		var card struct {
			PR struct {
				Reviews []struct {
					ID    string          `json:"id"`
					State string          `json:"state"`
					By    json.RawMessage `json:"by"`
				} `json:"reviews"`
			} `json:"pr"`
		}
		if err = json.Unmarshal(data, &card); err != nil {
			return err
		}
		for _, review := range card.PR.Reviews {
			if review.ID == fmt.Sprint(approval) && review.State == "APPROVED" && strings.Contains(string(review.By), `"rehearsal-owner"`) {
				r.actual = fmt.Sprintf("pr.reviews lists review %s APPROVED by %s", review.ID, review.By)
				return nil
			}
		}
		return fmt.Errorf("T%d's PR card lists reviews %+v, not approval %d", t2, card.PR.Reviews, approval)
	})

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
	if !r.step("3 Bring in Alice's commit", "POST /api/branches/{b} {op: bring-in, id, revision}", "Alice's bytes join T2's change; same PR; checks rerun once", "T-GH-06, T-STK-08", func() error {
		return r.bringInReleased(t2, branch2, a1, wait1)
	}) {
		return
	}
	// Discard exercises a separate later push, so Bringing in Alice's first
	// commit cannot remove the existing person-decision proof.
	if !r.step("3 A later push waits for Discard", "GitHub fake: Alice pushes again → GET /api/todos/{T2}", "a new foreign-push wait binds Alice's later commit", "T-GH-06", func() error {
		var err error
		a1, err = r.fake.PushAs(repo, branch2, 202, "alice", "A later laptop change", map[string]string{"ALICE-DISCARD.md": "discard this later push\n"})
		if err != nil {
			return err
		}
		for deadline := time.Now().Add(2 * time.Minute); ; time.Sleep(time.Second) {
			card, err := r.j10Card(t2)
			if err != nil {
				return err
			}
			for _, wait := range card.Waits {
				if wait.Kind == "foreign_push" && wait.SHA == a1 {
					wait1 = wait.ID
					return nil
				}
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("T%d did not hold Alice's later push", t2)
			}
		}
	}) {
		return
	}
	if !r.step("3 Discard Alice's commit", "POST /api/branches/smithers%2Fretry-webhooks {op: discard-foreign, id, revision} as Alice, then the owner; SQL activity",
		"403 for member Alice; 202 for the owner; the Needs you settles, T2 reads In review, and activity links Alice's kept commit", "T-GH-06", func() error {
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
			for deadline := time.Now().Add(time.Minute); ; time.Sleep(500 * time.Millisecond) {
				card, err := r.j10Card(t2)
				if err != nil {
					return err
				}
				if card.State == "in_review" && len(card.Waits) == 0 {
					break
				}
				if time.Now().After(deadline) {
					return fmt.Errorf("T%d %s with waits %+v a minute after Discard", t2, card.State, card.Waits)
				}
			}
			if err := r.waitSQL(10*time.Second, `SELECT count(*) FROM product_job_events WHERE data::text LIKE '%kept/'||$1::text||'%'`, a1); err != nil {
				return fmt.Errorf("no activity links the kept commit: %w", err)
			}
			r.actual = fmt.Sprintf("403 Alice; 202 owner; T%d in_review; activity links refs/smithers/kept/%s", t2, short7(a1))
			return nil
		}) {
		return
	}
	r.step("3 The next verified push replaces Alice's commit", "POST /api/todos/{T2} {steer}; GitHub fake branch",
		"the owner's steer runs the next attempt; its verified head replaces Alice's discarded commit, leased against it, under the same PR", "T-GH-06, T-STK-06", func() error {
			body, _ := json.Marshal(map[string]string{"steer": "Also log each retry."})
			if code, data, err := r.keyed("POST", fmt.Sprintf("/api/todos/%d", t2), string(body), r.keyPrefix+"steer-after-discard"); err != nil || code != 202 {
				return fmt.Errorf("the owner's steer: %d %s %v", code, data, err)
			}
			for deadline := time.Now().Add(j10RunWait); ; time.Sleep(time.Second) {
				card, err := r.j10Card(t2)
				if err != nil {
					return err
				}
				head, err := r.githubGit("rev-parse", "refs/heads/"+branch2)
				if err != nil {
					return err
				}
				if card.State == "in_review" && head != a1 && card.PR.Head == head {
					if _, err := r.githubGit("merge-base", "--is-ancestor", a1, head); err == nil {
						return fmt.Errorf("the new head %s keeps Alice's discarded commit", short7(head))
					}
					if card.PR.Number != pr2 {
						return fmt.Errorf("the push opened PR #%d, not #%d", card.PR.Number, pr2)
					}
					r.actual = fmt.Sprintf("T%d in_review; branch %s → %s; PR #%d", t2, short7(a1), short7(head), pr2)
					head2 = head
					return nil
				}
				if card.State == "failed" || time.Now().After(deadline) {
					return fmt.Errorf("T%d %s, GitHub branch %s, card head %s after the steer", t2, card.State, short7(head), short7(card.PR.Head))
				}
			}
		})

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
	r.step("4 The main row shows M2 and its title", "GET /api/live home", "main sha M2 and title Unrelated docs change", "T-GH-07, T-APP-01", func() error {
		live, err := r.openLive(r.jar)
		if err != nil {
			return err
		}
		defer live.stop()
		if _, err = live.subscribe("home"); err != nil {
			return err
		}
		_, err = live.latest("home", time.Minute, func(frame liveFrame) bool {
			var home struct {
				Main struct {
					SHA   string `json:"sha"`
					Title string `json:"title"`
				} `json:"main"`
			}
			return json.Unmarshal(frame.Data, &home) == nil && home.Main.SHA == m2 && home.Main.Title == "Unrelated docs change"
		})
		if err == nil {
			r.actual = fmt.Sprintf("Home main %s: Unrelated docs change", short7(m2))
		}
		return err
	})
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
	if !r.step("4 Rebase pending while a person is present", "Branch browser presence; GitHub fake main moves; GET /api/todos/{T1}",
		"T1 keeps its head while present; one rebase within 60 s of departure; same PR", "T-STK-08", func() error {
			_, err := r.rebaseBranch(t1, false)
			return err
		}) {
		return
	}

	// J10.5: the lead merges on GitHub instead of in Smithers.
	r.step("5 Merge on GitHub turns T1 Merged", "GitHub fake: the owner merges T1's PR → GET /api/todos/{T1}; GET /api/repos/{o}/{r}/bookmarks; GitHub write log",
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
					landed, err := r.mirroredMain()
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
	// This long journey can exhaust the attempt's retained launch allowance.
	// Only a person may reset it (§10.7.1); following main must not silently
	// reset counters or turn the policy stop into an automatic retry.
	var personRetryAttempt int32
	r.step("5 Retry T2 if its run limit stopped it", "GET /api/todos/{T2}; POST /api/todos/{T2} {op: retry} as owner when stopped", "only launch_bound permits one person Retry; same PR and pinned flow; otherwise no Retry", "T-STK-03, T-STK-08", func() error {
		for deadline := time.Now().Add(8 * time.Minute); ; time.Sleep(time.Second) {
			card, err := r.j10Card(t2)
			if err != nil {
				return err
			}
			if card.State == "failed" {
				var before struct {
					Attempt    int32
					FlowDigest string
					Tag        string
				}
				if err := r.pool.QueryRow(r.ctx, `SELECT attempt, flow_digest, checks->'fault'->>'tag' FROM mythical_items WHERE number=$1`, t2).Scan(&before.Attempt, &before.FlowDigest, &before.Tag); err != nil {
					return err
				}
				if before.Tag != "launch_bound" {
					return fmt.Errorf("T%d failed with %q, not the retained run limit", t2, before.Tag)
				}
				code, data, err := r.keyed("POST", fmt.Sprintf("/api/todos/%d", t2), `{"op":"retry"}`, r.keyPrefix+"follow-main-person-retry")
				if err != nil || code != 202 {
					return fmt.Errorf("person Retry HTTP %d %s: %v", code, data, err)
				}
				var receipt struct {
					Attempt int32 `json:"attempt"`
				}
				if err := json.Unmarshal(data, &receipt); err != nil {
					return err
				}
				var afterAttempt int32
				var afterPin string
				if err := r.pool.QueryRow(r.ctx, `SELECT attempt, flow_digest FROM mythical_items WHERE number=$1`, t2).Scan(&afterAttempt, &afterPin); err != nil {
					return err
				}
				if receipt.Attempt != before.Attempt+1 || (afterAttempt != before.Attempt && afterAttempt != receipt.Attempt) || afterPin != before.FlowDigest || card.PR.Number != pr2 {
					return fmt.Errorf("Retry changed identity/pin: attempt %d → %d, pin %q → %q, PR %d", before.Attempt, afterAttempt, before.FlowDigest, afterPin, card.PR.Number)
				}
				r.actual = fmt.Sprintf("owner retried launch_bound: upcoming attempt %d, same pinned flow and PR #%d", receipt.Attempt, pr2)
				personRetryAttempt = receipt.Attempt
				return nil
			}
			if card.State == "in_review" && card.Merge.State == "ready" {
				r.actual = "T2 ready without Retry"
				return nil
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("T%d neither ready nor stopped at its run limit: %s", t2, card.State)
			}
		}
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
				if card.PR.Number != pr2 {
					return fmt.Errorf("T2 changed PR: %d → %d", pr2, card.PR.Number)
				}
				if personRetryAttempt > 0 {
					var attempt int32
					if err := r.pool.QueryRow(r.ctx, `SELECT attempt FROM mythical_items WHERE number=$1`, t2).Scan(&attempt); err != nil {
						return err
					}
					if attempt != personRetryAttempt {
						return fmt.Errorf("Retry promised attempt %d but proposal belongs to attempt %d", personRetryAttempt, attempt)
					}
					alice, err := r.githubGit("show", pull.Head.SHA+":alice.md")
					if err != nil || strings.TrimSpace(alice) != "log each retry" {
						return fmt.Errorf("Retry lost brought-in Alice bytes: %q: %v", alice, err)
					}
				}
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
		// The person has already merged upstream. A launch-bound stop can
		// race the next refs/PR observation; it stops coding, not GitHub sync.
		// Wait for the fetched merge receipt without retrying the TODO.
		for deadline := time.Now().Add(time.Minute); ; time.Sleep(500 * time.Millisecond) {
			card, err := r.todo(t2)
			if err != nil {
				return err
			}
			if card.State == "merged" {
				break
			}
			if card.State == "failed" {
				var tag string
				if err := r.pool.QueryRow(r.ctx, `SELECT coalesce(checks->'fault'->>'tag','') FROM mythical_items WHERE number=$1`, t2).Scan(&tag); err != nil {
					return err
				}
				if tag != "launch_bound" {
					return fmt.Errorf("T2 failed with %q after the GitHub merge", tag)
				}
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("T2 remains %s one minute after the GitHub merge", card.State)
			}
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
		v, err := r.waitTodoWithin(t3, j10RunWait, "in_review")
		if err != nil {
			return err
		}
		pr3 = v.PR.Number
		writes := len(r.fake.Writes())
		r.fake.UpdatePull(repo, pr3, func(p *githubfake.Pull) {
			p.State = "closed"
			p.ClosedBy = &githubfake.PullAuthor{ID: 202, Login: "alice", Type: "User"}
		})
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
	r.step("8 Dropped names who closed it", "GET /api/todos/{T3}; product_job_events", "closed on GitHub by @alice; one attributed event", "T-GH-03", func() error {
		card, err := r.j10Card(t3)
		if err != nil {
			return err
		}
		var reason, actor string
		if err := r.pool.QueryRow(r.ctx, `SELECT reason FROM mythical_items WHERE number=$1`, t3).Scan(&reason); err != nil {
			return err
		}
		if reason != "closed on GitHub by @alice" {
			return fmt.Errorf("closer projection: %q", reason)
		}
		if card.State != "dropped" {
			return fmt.Errorf("close state: %q", card.State)
		}
		if err := r.pool.QueryRow(r.ctx, `SELECT data->'actor'->>'login' FROM product_job_events WHERE event_type='todo.github_dropped' AND data->>'n'=$1`, fmt.Sprint(t3)).Scan(&actor); err != nil {
			return err
		}
		if actor != "alice" {
			return fmt.Errorf("close actor: %q", actor)
		}
		r.actual = reason
		return nil
	})
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

	r.step("9 An outsider's PR gets no machine", "GitHub fake: @outsider's PR #900 → POST /api/reviews {number: 900} as Ben", "refused with class permission; no machine requested", "T-FLW-13", func() error {
		r.fake.UpdatePull(repo, 900, func(p *githubfake.Pull) {
			p.Repository, p.Number, p.State, p.Title = repo, 900, "open", "Outsider cache change"
			p.User = &githubfake.PullAuthor{ID: 900, Login: "outsider", Type: "User"}
			p.HTMLURL = "https://github.com/" + repo + "/pull/900"
			p.Head.Ref, p.Base.Ref = "outsider:cache", "main"
			p.Head.SHA = strings.Repeat("9", 40)
		})
		var before, machines int
		if err := r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_requests WHERE operation='install.review'`).Scan(&before); err != nil {
			return err
		}
		code, data, err := r.keyedAs(ben, "POST", "/api/reviews", `{"number":900,"conversation":"main"}`, r.keyPrefix+"review-outsider")
		if err != nil {
			return err
		}
		if code != 403 || !strings.Contains(string(data), `"class":"permission"`) {
			return fmt.Errorf("outsider review: HTTP %d %s", code, data)
		}
		if err := r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_requests WHERE operation='install.review'`).Scan(&machines); err != nil {
			return err
		}
		if machines != before {
			return fmt.Errorf("the refused review left %d review jobs", machines-before)
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
	r.j10NetworkDrop(alice)
	r.j10AgentRetry(alice)
	r.j10InstallationRefusal()

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
			rewritten, err := r.githubGit("-c", "user.name=GitHub", "-c", "user.email=noreply@github.test", "commit-tree", tree, "-p", parent, "-m", "Rewritten on GitHub")
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
	r.step("7 The owner confirms Reset to GitHub main", "Home attention; POST /api/stack/attention/{id}", "owner attention; non-owner and delegated 403; stale 409; owner Reset settles once", "T-GH-07, T-ACC-03", func() error {
		var attention struct {
			ID  string `json:"id"`
			Old string `json:"old"`
			New string `json:"new"`
		}
		var raw []byte
		if err := r.pool.QueryRow(r.ctx, `SELECT a FROM mythical_stacks,jsonb_array_elements(attention) a WHERE a->>'kind'='force_push' AND a->>'settled_at' IS NULL`).Scan(&raw); err != nil {
			return err
		}
		if err := json.Unmarshal(raw, &attention); err != nil {
			return err
		}
		route := "/api/stack/attention/" + attention.ID
		card, err := r.j10Card(t3)
		if err != nil {
			return err
		}
		held, err := r.expectAs(ben, "POST", fmt.Sprintf("/api/todos/%d/merge", t3), fmt.Sprintf(`{"reviewed_head_sha":%q}`, card.PR.Head), 409)
		if err != nil {
			return err
		}
		if !strings.Contains(string(held), `"class":"conflict"`) {
			return fmt.Errorf("merge not held: %s", held)
		}
		body := fmt.Sprintf(`{"old":%q,"new":%q}`, attention.Old, attention.New)
		for _, jar := range []http.CookieJar{ben, alice} {
			refused, err := r.expectAs(jar, "POST", route, body, 403)
			if err != nil {
				return err
			}
			if !strings.Contains(string(refused), `"code":"permission"`) {
				return fmt.Errorf("non-owner refusal: %s", refused)
			}
		}
		token, err := r.token("write:repository")
		if err != nil {
			return err
		}
		request, err := http.NewRequestWithContext(r.ctx, "POST", r.origin+route, strings.NewReader(body))
		if err != nil {
			return err
		}
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Content-Type", "application/json")
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			return err
		}
		refused, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil {
			return err
		}
		if response.StatusCode != 403 || !strings.Contains(string(refused), `"code":"never"`) {
			return fmt.Errorf("delegated Reset: HTTP %d %s", response.StatusCode, refused)
		}
		owner, err := r.openLive(r.jar)
		if err != nil {
			return err
		}
		defer owner.stop()
		if _, err = owner.subscribe("home"); err != nil {
			return err
		}
		if _, err = owner.latest("home", 5*time.Second, func(frame liveFrame) bool {
			return strings.Contains(string(frame.Data), attention.ID) && strings.Contains(string(frame.Data), "main.reset-to-github")
		}); err != nil {
			return err
		}
		if main, err := r.mirroredMain(); err != nil || main != attention.Old {
			return fmt.Errorf("refused Reset moved main: %s %v", main, err)
		}
		tree, err := r.githubGit("rev-parse", attention.New+"^{tree}")
		if err != nil {
			return err
		}
		latest, err := r.githubGit("-c", "user.name=GitHub", "-c", "user.email=noreply@github.test", "commit-tree", tree, "-m", "Second rewrite")
		if err != nil {
			return err
		}
		if _, err = r.githubGit("update-ref", "refs/heads/main", latest, attention.New); err != nil {
			return err
		}
		stale, err := r.expect("POST", route, body, 409)
		if err != nil {
			return err
		}
		if !strings.Contains(string(stale), "stale_attention") {
			return fmt.Errorf("stale Reset: %s", stale)
		}
		body = fmt.Sprintf(`{"old":%q,"new":%q}`, attention.Old, latest)
		if _, err = r.expect("POST", route, body, 200); err != nil {
			return err
		}
		if main, err := r.mirroredMain(); err != nil || main != latest {
			return fmt.Errorf("Reset main %s, want %s: %v", main, latest, err)
		}
		var settled int
		if err := r.pool.QueryRow(r.ctx, `SELECT count(*) FROM mythical_stacks,jsonb_array_elements(attention) a WHERE a->>'id'=$1 AND a->>'settled_at' IS NOT NULL AND a->>'settled_by'=(SELECT user_id::text FROM self_host_owners)`, attention.ID).Scan(&settled); err != nil {
			return err
		}
		if settled != 1 {
			return fmt.Errorf("Reset settled %d owner rows", settled)
		}
		if _, err = r.expect("POST", route, body, 200); err != nil {
			return err
		}
		if main, err := r.githubMain(); err != nil || main != latest {
			return fmt.Errorf("Reset wrote GitHub main: %s %v", main, err)
		}
		r.actual = "owner Reset settled once; people and delegated refused; stale tip refused; GitHub main untouched"
		return nil
	})
}
