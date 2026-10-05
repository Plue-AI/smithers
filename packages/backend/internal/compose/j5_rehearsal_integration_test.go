package compose

import (
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// TestJ5Rehearsal walks journey J5 (mvp.md §5, teach the factory; C-J5-01,
// C-J5-02) on the install J1 sets up. TODO A asks a question and waits
// (distribution/fake-todo-turns.mjs [ASK]); TODO B is the flow edit
// ([FLOWEDIT]): its PR changes exactly flows/todo/flow.ts, the built-in
// composition plus a changelog step. Ben merges B; flow-load runs on every
// main move (spec §11.3.1) and makes B's flow Active; a broken flow merged on
// GitHub leaves it Active. Every TODO pins the Active version when it starts
// (spec §11.4.1): A and R pin D1, C pins D2 and runs its changelog step, and
// A's continuation and R's retry keep D1.
func TestJ5Rehearsal(t *testing.T) {
	// The install loads its flows after every main move.
	t.Setenv("SMITHERS_FEATURE_FLAGS_FLOW_LOAD", "true")
	r := newRehearsal(t, "SMITHERS_J5_REHEARSAL", "C-J5", "j5-")
	if !r.install("0 Install through Machine ready") {
		return
	}
	r.step("1 The message reaches the app agent", "POST "+chat.TurnPath, "200; an answer with JOURNEY.md's File card", "T-APP-03", func() error {
		select {
		case err := <-r.besideChat():
			r.actual = "200 a File card answer quoting JOURNEY.md"
			return err
		case <-time.After(time.Minute):
			return fmt.Errorf("the turn did not settle within a minute")
		}
	})
	var a, b, fails int64
	if !r.step("2 TODO A asks and waits", "POST /api/todos; GET /api/todos/{A}", "202; needs_you with one question", "T-STK-01", func() error {
		var err error
		// B, the flow edit, is filed first: a TODO merges only after the
		// TODOs ahead of it on the stack, and B merges while A waits (step 9).
		// Both run at once on their own lanes.
		if b, err = r.file("B changes the TODO flow", "[FLOWEDIT] Every TODO must run `make test` and update the changelog."); err != nil {
			return err
		}
		if a, err = r.file("A asks first", "[ASK] [FILE a.md] Ask me which file to edit before editing"); err != nil {
			return err
		}
		// R pins D1 beside A and fails on every attempt ([FAIL] empties
		// JOURNEY.md); row 16 retries it once D2 is Active.
		if fails, err = r.file("R fails", "[FAIL] [FILE r.md] Add a greeting to r.md"); err != nil {
			return err
		}
		v, err := r.waitTodoWithin(a, 8*time.Minute, "needs_you")
		if err != nil {
			return err
		}
		if len(v.Waits) != 1 || v.Waits[0].Kind != "question" {
			return fmt.Errorf("A waits on %+v, want one question", v.Waits)
		}
		return nil
	}) {
		return
	}
	r.step("3 Edit TODO B in review", "POST /api/todos [FLOWEDIT]; GET /api/todos/{B}; GitHub fake PR", "in_review; the PR changes exactly flows/todo/flow.ts, the TODO flow plus its changelog step", "T-FLW-05", func() error {
		v, err := r.waitTodoWithin(b, 8*time.Minute, "in_review")
		if err != nil {
			return err
		}
		p, err := r.checkPull(v.PR.Number, v.PR.Head)
		if err != nil {
			return err
		}
		files, err := r.prFiles(p)
		if err != nil {
			return err
		}
		if !slices.Equal(files, []string{"flows/todo/flow.ts"}) {
			return fmt.Errorf("B's PR changes %v, want exactly flows/todo/flow.ts", files)
		}
		flow, err := r.githubGit("show", v.PR.Head+":flows/todo/flow.ts")
		if err != nil {
			return err
		}
		if !strings.Contains(flow, `Flow.make("todo"`) || !strings.Contains(flow, "[CHANGELOG]") {
			return fmt.Errorf("B's flows/todo/flow.ts is not the TODO flow with a changelog step")
		}
		r.actual = fmt.Sprintf("200 T%d in_review; PR #%d changes %v", b, p.Number, files)
		return nil
	})
	var d1 string
	r.step("4 Flows", "GET /api/flows", "todo: source builtin, system false, one active version D1; no system names", "T-APP-05", func() error {
		data, err := r.expect("GET", "/api/flows", "", 200)
		if err != nil {
			return err
		}
		var flows []struct {
			Name     string          `json:"name"`
			Source   json.RawMessage `json:"source"`
			System   *bool           `json:"system"`
			Versions []struct {
				ID    string `json:"id"`
				State string `json:"state"`
				Steps []struct {
					ID   string `json:"id"`
					Wait bool   `json:"wait"`
				} `json:"steps"`
			} `json:"versions"`
		}
		if err = json.Unmarshal(data, &flows); err != nil {
			return err
		}
		var names, active, steps []string
		todo := -1
		for i, flow := range flows {
			names = append(names, flow.Name)
			if !services.Overridable(flow.Name) {
				return fmt.Errorf("GET /api/flows lists the system flow %q", flow.Name)
			}
			if flow.Name == "todo" {
				todo = i
			}
		}
		if todo < 0 {
			return fmt.Errorf("GET /api/flows lists %v, no todo", names)
		}
		flow := flows[todo]
		if string(flow.Source) != `{"builtin":true}` || flow.System == nil || *flow.System {
			return fmt.Errorf("todo has source %s, system %v; want built in and not system", flow.Source, flow.System)
		}
		for _, version := range flow.Versions {
			if version.State == "active" {
				active = append(active, version.ID)
				for _, step := range version.Steps {
					steps = append(steps, step.ID+map[bool]string{true: " (wait)"}[step.Wait])
				}
			}
		}
		if len(active) != 1 || !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(active[0]) {
			return fmt.Errorf("todo has Active versions %v, want one digest", active)
		}
		if want := []string{"plan", "implement", "verify", "review", "propose", "merge (wait)"}; !slices.Equal(steps, want) {
			return fmt.Errorf("todo's Active steps are %v, want %v", steps, want)
		}
		d1 = active[0]
		r.actual = fmt.Sprintf("200 %v; todo built in, system false, Active D1 %s… with %d steps and the merge wait", names, active[0][:12], len(steps)-1)
		return nil
	})
	r.pending("5 App agent shows the TODO flow", "POST "+chat.TurnPath+" /flow todo", "the Flow card of the served todo flow", "T-FLW-05", "flow-agent-edit")
	r.pending("6 App agent proposes the edit", "POST "+chat.TurnPath+" /flow.edit todo", "one private Draft quoting the diff; the TODO count unchanged", "T-FLW-05", "flow-agent-edit")
	r.pending("7 System flow refused", "POST "+chat.TurnPath+" /flow.edit merge", "'Merge flow is built in'", "T-FLW-05", "flow-agent-edit")
	r.pending("8 Repository copy resolves", "coding host module resolver", "a repository flows/todo/flow.ts loads and has a digest", "T-FLW-04", "coding-steps-package")
	var squash string
	r.step("9 Merge B", "POST /api/todos/{B}/merge as maintainer Ben", "202 while A waits; merged after GitHub's squash", "T-STK-04, T-ACC-02", func() error {
		v, err := r.todo(b)
		if err != nil {
			return err
		}
		if v.State != "in_review" {
			return fmt.Errorf("blocked by 3 Edit TODO B: T%d is %q, not in review", b, v.State)
		}
		ben, err := r.member("ben", 201, "maintain")
		if err != nil {
			return err
		}
		if err = r.mergeAs(ben, b, v.PR.Head); err != nil {
			return err
		}
		waiting, err := r.todo(a)
		if err != nil {
			return err
		}
		if waiting.State != "needs_you" {
			return fmt.Errorf("A is %q while B merges, want needs_you", waiting.State)
		}
		if err = r.waitMerged(b, v.PR.Number, v.PR.Head); err != nil {
			return err
		}
		p, err := r.readFakePull(v.PR.Number)
		if err != nil {
			return err
		}
		squash = p.MergeCommitSHA
		r.actual = fmt.Sprintf("202 by maintainer ben while A needs_you; T%d merged; install main = GitHub's squash %s", b, squash[:12])
		return nil
	})
	var d2 string
	r.step("10 Active after load", "GET /api/flows", "merged-syncing, then Active D2 once workflow_definitions holds D2 loaded", "T-FLW-03", func() error {
		if squash == "" || d1 == "" {
			return fmt.Errorf("blocked by 4 Flows or 9 Merge B: no D1 or squash commit")
		}
		syncing := ""
		for deadline := time.Now().Add(5 * time.Minute); ; time.Sleep(500 * time.Millisecond) {
			card, err := r.flowCard("todo")
			if err != nil {
				return err
			}
			if id := card.version("merged-syncing"); id != "" && syncing == "" {
				syncing = id
			}
			if active := card.version("active"); active != "" && active != d1 {
				if syncing == "" {
					return fmt.Errorf("todo became Active %s without showing merged-syncing first", active)
				}
				var status, source string
				var isActive bool
				if err = r.pool.QueryRow(r.ctx, `SELECT status, source_commit, is_active FROM workflow_definitions WHERE name = 'todo' AND digest = $1`, active).
					Scan(&status, &source, &isActive); err != nil {
					return fmt.Errorf("workflow_definitions has no todo@%s: %w", active, err)
				}
				if status != "loaded" || source != squash || !isActive {
					return fmt.Errorf("todo@%s is %s at %s (active %t), want loaded at %s and Active", active, status, source, isActive, squash)
				}
				if card.Source.Path != "flows/todo/flow.ts" || card.version("previous") != d1 || syncing != active {
					return fmt.Errorf("todo's card: source %+v, previous %q, merged-syncing %q, Active %q", card.Source, card.version("previous"), syncing, active)
				}
				d2 = active
				r.actual = fmt.Sprintf("200 merged-syncing %s…, then Active D2 %s… from flows/todo/flow.ts, previous D1 %s…; workflow_definitions todo loaded at %s",
					syncing[:12], d2[:12], d1[:12], squash[:12])
				return nil
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("todo still Active at D1 5 minutes after the merge (merged-syncing seen %t); flow_loads %s", syncing != "", r.flowLoadState())
			}
		}
	})
	r.step("11 One load per main move", "SQL flow-load runs", "one coalesced flow-load run per main move", "T-FLW-03", func() error {
		loads, err := r.flowLoadCommits()
		if err != nil {
			return err
		}
		want := []string{r.mainCommit, squash}
		if !slices.Equal(loads, want) {
			return fmt.Errorf("flow-load ran at %v, want once at the setup main and once at B's squash %v", loads, want)
		}
		r.actual = fmt.Sprintf("2 runs: setup main %s, B's squash %s; none repeated", r.mainCommit[:12], squash[:12])
		return nil
	})
	r.step("12 Broken flow keeps previous", "GitHub fake: main gets a broken flows/todo/flow.ts; POST /api/github/sync; GET /api/flows", "merged-failed with the file's error; Active stays D2", "T-FLW-03", func() error {
		if d2 == "" {
			return fmt.Errorf("blocked by 10 Active after load: no D2")
		}
		flow, err := r.githubGit("show", "refs/heads/main:flows/todo/flow.ts")
		if err != nil {
			return err
		}
		broken := strings.Replace(flow, "Request.child(", "Request.child((", 1)
		if broken == flow {
			return fmt.Errorf("main's TODO flow has no Request.child call to break")
		}
		commit, err := r.pushGitHubMain("Break the TODO flow", map[string]string{"flows/todo/flow.ts": broken})
		if err != nil {
			return err
		}
		for deadline := time.Now().Add(5 * time.Minute); ; time.Sleep(500 * time.Millisecond) {
			card, err := r.flowCard("todo")
			if err != nil {
				return err
			}
			for _, version := range card.Versions {
				if version.State != "merged-failed" {
					continue
				}
				if active := card.version("active"); active != d2 {
					return fmt.Errorf("the broken flow moved Active to %q, want D2 %s", active, d2)
				}
				if !regexp.MustCompile(`^flows/todo/flow\.ts:\d+: `).MatchString(version.Error) {
					return fmt.Errorf("merged-failed error %q does not name the file and line", version.Error)
				}
				var status, source, loadError string
				var isActive bool
				if err = r.pool.QueryRow(r.ctx, `SELECT status, source_commit, load_error, is_active FROM workflow_definitions WHERE name = 'todo' AND digest = $1`, version.ID).
					Scan(&status, &source, &loadError, &isActive); err != nil {
					return fmt.Errorf("workflow_definitions has no failed todo@%s: %w", version.ID, err)
				}
				if status != "failed" || source != commit || loadError != version.Error || isActive {
					return fmt.Errorf("todo@%s is %s at %s (active %t, error %q)", version.ID, status, source, isActive, loadError)
				}
				r.actual = fmt.Sprintf("200 merged-failed %s… at %s: %q; Active stays D2 %s…", version.ID[:12], commit[:12], version.Error, d2[:12])
				return nil
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("no merged-failed version 5 minutes after the broken merge %s; flow_loads %s", commit[:12], r.flowLoadState())
			}
		}
	})
	r.step("13 TODO A pinned D1", "GET /api/todos/{A}", "A's evidence pins D1", "T-FLW-11", func() error {
		if d1 == "" || d2 == "" {
			return fmt.Errorf("blocked by 4 Flows or 10 Active after load: no D1 or D2")
		}
		v, err := r.todo(a)
		if err != nil {
			return err
		}
		if pin := todoFlowPin(v, 1); pin != d1 {
			return fmt.Errorf("T%d attempt 1 pins todo %q, want D1 %s", a, pin, d1)
		}
		r.actual = fmt.Sprintf("200 T%d %s; attempt 1 pins todo D1 %s… while D2 %s… is Active", a, v.State, d1[:12], d2[:12])
		return nil
	})
	var c int64
	r.step("14 TODO C pins D2", "POST /api/todos; GET /api/todos/{C}; GitHub fake PR", "C pins D2 at Starting; its evidence shows the changelog step", "T-FLW-11", func() error {
		if d2 == "" {
			return fmt.Errorf("blocked by 10 Active after load: no D2")
		}
		var err error
		if c, err = r.file("C after the edit", "[FILE c.md] Add a greeting to c.md"); err != nil {
			return err
		}
		started, err := r.waitTodoWithin(c, 3*time.Minute, "starting", "working", "needs_you", "in_review")
		if err != nil {
			return err
		}
		if pin := todoFlowPin(started, 1); pin != d2 {
			return fmt.Errorf("T%d is %s pinning todo %q, want D2 %s", c, started.State, pin, d2)
		}
		v, err := r.waitTodoWithin(c, 8*time.Minute, "in_review")
		if err != nil {
			return err
		}
		p, err := r.checkPull(v.PR.Number, v.PR.Head)
		if err != nil {
			return err
		}
		files, err := r.prFiles(p)
		if err != nil {
			return err
		}
		// D2's request asks every TODO for [CHANGELOG]: C's change carries it.
		if !slices.Contains(files, "CHANGELOG.md") || !slices.Contains(files, "c.md") {
			return fmt.Errorf("C's PR changes %v, want c.md and the changelog step's CHANGELOG.md", files)
		}
		if pin := todoFlowPin(v, 1); pin != d2 {
			return fmt.Errorf("T%d in review pins todo %q, want D2 %s", c, pin, d2)
		}
		r.actual = fmt.Sprintf("200 T%d %s pinning D2 %s…; in_review, PR #%d changes %v", c, started.State, d2[:12], p.Number, files)
		return nil
	})
	r.step("15 TODO A keeps D1", "POST /api/todos/{A}/answer; GET /api/todos/{A}; GitHub fake PR", "A continues on D1 with no changelog step", "T-FLW-11", func() error {
		if d1 == "" {
			return fmt.Errorf("blocked by 4 Flows: no D1")
		}
		v, err := r.todo(a)
		if err != nil {
			return err
		}
		if v.State != "needs_you" || len(v.Waits) != 1 {
			return fmt.Errorf("T%d is %s with waits %+v, want one open question", a, v.State, v.Waits)
		}
		if code, data, err := r.answer(a, v.Waits[0].ID, "a.md"); err != nil || code != 202 {
			return fmt.Errorf("answer T%d: HTTP %d %s %v", a, code, data, err)
		}
		if v, err = r.waitTodoWithin(a, 8*time.Minute, "in_review"); err != nil {
			return err
		}
		p, err := r.checkPull(v.PR.Number, v.PR.Head)
		if err != nil {
			return err
		}
		files, err := r.prFiles(p)
		if err != nil {
			return err
		}
		if !slices.Equal(files, []string{"a.md"}) {
			return fmt.Errorf("A's PR changes %v, want only a.md: D1 has no changelog step", files)
		}
		if v.Run == nil || v.Run.Attempt != 1 {
			return fmt.Errorf("T%d continued on run %+v, want attempt 1", a, v.Run)
		}
		if pin := todoFlowPin(v, 1); pin != d1 {
			return fmt.Errorf("T%d in review pins todo %q, want D1 %s", a, pin, d1)
		}
		r.actual = fmt.Sprintf("202; T%d in_review on attempt 1 pinning D1 %s…; PR #%d changes %v", a, d1[:12], p.Number, files)
		return nil
	})
	r.step("16 Retry keeps the pin", "POST /api/todos/{R} {op: retry}", "R failed on D1; its retry attempt pins D1 while D2 is Active", "T-FLW-11, T-STK-05", func() error {
		if d1 == "" || d2 == "" {
			return fmt.Errorf("blocked by 4 Flows or 10 Active after load: no D1 or D2")
		}
		failed, err := r.waitTodoWithin(fails, 15*time.Minute, "failed")
		if err != nil {
			return err
		}
		if failed.Run == nil {
			return fmt.Errorf("T%d failed with no run", fails)
		}
		attempt := failed.Run.Attempt
		if pin := todoFlowPin(failed, int32(attempt)); pin != d1 {
			return fmt.Errorf("T%d failed attempt %d pins todo %q, want D1 %s", fails, attempt, pin, d1)
		}
		code, data, err := r.keyed("POST", fmt.Sprintf("/api/todos/%d", fails), `{"op":"retry"}`, r.keyPrefix+"retry-r")
		if err != nil || code != 202 {
			return fmt.Errorf("retry T%d: HTTP %d %s %v", fails, code, data, err)
		}
		retried, err := r.waitTodoWithin(fails, 5*time.Minute, "starting", "working", "in_review", "failed")
		if err != nil {
			return err
		}
		for deadline := time.Now().Add(2 * time.Minute); retried.Run == nil || retried.Run.Attempt <= attempt; time.Sleep(500 * time.Millisecond) {
			if time.Now().After(deadline) {
				return fmt.Errorf("T%d has run %+v after the retry, want attempt %d", fails, retried.Run, attempt+1)
			}
			if retried, err = r.todo(fails); err != nil {
				return err
			}
		}
		if pin := todoFlowPin(retried, int32(retried.Run.Attempt)); pin != d1 {
			return fmt.Errorf("T%d retry attempt %d pins todo %q, want D1 %s (Active is D2 %s)", fails, retried.Run.Attempt, pin, d1, d2)
		}
		r.actual = fmt.Sprintf("202; T%d failed on attempt %d pinning D1 %s…, retry attempt %d pins D1 while D2 %s… is Active", fails, attempt, d1[:12], retried.Run.Attempt, d2[:12])
		return nil
	})
}

// todoFlowPin answers the todo flow version an attempt's evidence pins.
func todoFlowPin(v rehearsalTodo, attempt int32) string {
	for _, evidence := range v.Evidence {
		if evidence.Attempt != attempt {
			continue
		}
		for _, item := range evidence.Items {
			if item["kind"] == "flow" && item["name"] == "todo" {
				version, _ := item["version"].(string)
				return version
			}
		}
	}
	return ""
}

// rehearsalFlowCard is what the flow rows read of one GET /api/flows card.
type rehearsalFlowCard struct {
	Name   string `json:"name"`
	Source struct {
		Builtin bool   `json:"builtin"`
		Path    string `json:"path"`
	} `json:"source"`
	Versions []struct {
		ID    string `json:"id"`
		State string `json:"state"`
		Error string `json:"error"`
	} `json:"versions"`
}

// version answers the id of the card's first version in state.
func (c rehearsalFlowCard) version(state string) string {
	for _, version := range c.Versions {
		if version.State == state {
			return version.ID
		}
	}
	return ""
}

// flowCard reads one flow's card from GET /api/flows.
func (r *rehearsal) flowCard(name string) (rehearsalFlowCard, error) {
	data, err := r.expect("GET", "/api/flows", "", 200)
	if err != nil {
		return rehearsalFlowCard{}, err
	}
	var cards []rehearsalFlowCard
	if err = json.Unmarshal(data, &cards); err != nil {
		return rehearsalFlowCard{}, err
	}
	for _, card := range cards {
		if card.Name == name {
			return card, nil
		}
	}
	return rehearsalFlowCard{}, fmt.Errorf("GET /api/flows lists no %s", name)
}

// flowLoadCommits answers the main commit of every flow-load launch, in
// launch order (request ids flow-load:<repository>:<generation>:<commit>).
func (r *rehearsal) flowLoadCommits() ([]string, error) {
	rows, err := r.pool.Query(r.ctx, `SELECT request_id FROM product_job_requests WHERE request_id LIKE 'flow-load:%'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type launch struct {
		generation int
		commit     string
	}
	launches := []launch{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		parts := strings.Split(id, ":")
		if len(parts) != 4 {
			return nil, fmt.Errorf("flow-load request %q", id)
		}
		generation, err := strconv.Atoi(parts[2])
		if err != nil {
			return nil, err
		}
		launches = append(launches, launch{generation, parts[3]})
	}
	slices.SortFunc(launches, func(a, b launch) int { return a.generation - b.generation })
	commits := []string{}
	for _, launch := range launches {
		commits = append(commits, launch.commit)
	}
	return commits, rows.Err()
}

// flowLoadState is the install's flow_loads row, for a row's failure.
func (r *rehearsal) flowLoadState() string {
	var state, commit, loaded, outcome, failure string
	var attempt int
	if err := r.pool.QueryRow(r.ctx, `SELECT state, commit_id, loaded_commit, outcome, error, attempt FROM flow_loads`).
		Scan(&state, &commit, &loaded, &outcome, &failure, &attempt); err != nil {
		return err.Error()
	}
	return fmt.Sprintf("state=%s commit=%s loaded=%s attempt=%d outcome=%q error=%q", state, commit, loaded, attempt, outcome, failure)
}
