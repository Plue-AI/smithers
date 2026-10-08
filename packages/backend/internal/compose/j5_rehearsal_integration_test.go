package compose

import (
	"encoding/json"
	"fmt"
	"reflect"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// TestJ5Rehearsal walks journey J5 (mvp.md §5, teach the factory; C-J5-01,
// C-J5-02) on the install J1 sets up. TODO A asks a question and waits
// (distribution/fake-todo-turns.mjs [ASK]); TODO B is the flow edit
// ([FLOWEDIT]): its PR changes exactly flows/todo/flow.ts, the built-in
// composition plus a changelog step. Ben merges B; flow-load runs on every
// main move (spec §11.3.1) and makes B's flow Active; a broken flow merged on
// GitHub leaves it Active. A resumes its original D1 while new C executes
// the changelog requirement from D2. A failed TODO retries on D1, then
// explicitly retries with the current flow on D2, retaining earlier evidence.
func TestJ5Rehearsal(t *testing.T) {
	runJ5Rehearsal(t, "SMITHERS_J5_REHEARSAL")
}

// Reference-host qualification uses the approved installed coding host and
// real guest capture/outbox. The process rehearsal above remains component
// evidence and cannot qualify machine isolation or branch retirement.
// Run with SMITHERS_J5_MICROVM_REHEARSAL=1 and SMITHERS_CHECK_BUNDLE.
func TestJ5MicroVMRehearsal(t *testing.T) {
	runJ5Rehearsal(t, "SMITHERS_J5_MICROVM_REHEARSAL")
}

func runJ5Rehearsal(t *testing.T, enable string) {
	t.Helper()
	// The install loads its flows after every main move.
	t.Setenv("SMITHERS_FEATURE_FLAGS_FLOW_LOAD", "true")
	r := newRehearsal(t, enable, "C-J5", "j5-")
	if !r.install("0 Install through Machine ready") {
		return
	}
	// This expanded pinning journey retains A's question, B's proposal and
	// R's pre-activation failure concurrently. Ask the owner for three TODO
	// slots through Settings, within the fixture's detected capacity of three.
	// The trusted-process adapter does not compose automatic safe-idle release;
	// default-parallel and idle-release evidence belong to their own checks.
	if !r.step("0b Owner sets three parallel TODOs", "PUT /api/install; GET /api/install", "parallel 3, capacity 3", "T-FLW-11", func() error {
		if _, err := r.expect("PUT", "/api/install", `{"parallel":3}`, 200); err != nil {
			return err
		}
		data, err := r.expect("GET", "/api/install", "", 200)
		if err != nil {
			return err
		}
		var settings struct {
			Parallel int `json:"parallel"`
			Capacity int `json:"capacity"`
		}
		if err := json.Unmarshal(data, &settings); err != nil {
			return err
		}
		if settings.Parallel != 3 || settings.Capacity != 3 {
			return fmt.Errorf("install Settings %+v, want parallel 3 within capacity 3", settings)
		}
		r.actual = "200; owner-requested parallel 3, detected capacity 3"
		return nil
	}) {
		return
	}
	r.step("1 The message reaches the app agent", "POST "+"/api/conversations/main/prompt", "200; an answer with JOURNEY.md's File card", "T-APP-03", func() error {
		select {
		case err := <-r.besideChat():
			r.actual = "200 a File card answer quoting JOURNEY.md"
			return err
		case <-time.After(time.Minute):
			return fmt.Errorf("the turn did not settle within a minute")
		}
	})
	var a, b int64
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
	var retryTodo int64
	var failedRetry rehearsalTodo
	if !r.step("4b A failed TODO predates activation", "POST /api/todos [FAIL]; GET /api/todos/{R}", "R fails repository checks on D1 before B merges", "T-FLW-11", func() error {
		var err error
		retryTodo, err = r.file("R retries across activation", "[FAIL] [FILE retry.md] Add a greeting to retry.md")
		if err != nil {
			return err
		}
		failedRetry, err = r.waitTodoWithin(retryTodo, 8*time.Minute, "failed")
		if err != nil {
			return err
		}
		if failedRetry.Run == nil || failedRetry.FlowVersion == nil || failedRetry.FlowVersion.Digest != d1 || failedRetry.FlowVersion.SourceCommit != r.mainCommit {
			return fmt.Errorf("R failed with run %+v and pin %+v, want D1 at original main", failedRetry.Run, failedRetry.FlowVersion)
		}
		var reason string
		if err := r.pool.QueryRow(r.ctx, `SELECT reason FROM mythical_items WHERE number=$1`, retryTodo).Scan(&reason); err != nil {
			return err
		}
		if !strings.Contains(reason, "failed: coding/Error/fast_gate") {
			return fmt.Errorf("R failed for %q, want its repository check gate", reason)
		}
		return nil
	}) {
		return
	}
	r.step("5 App agent shows the TODO flow", "POST "+"/api/conversations/main/prompt"+" /flow todo", "the Flow card of the served todo flow", "T-FLW-05", func() error {
		_, frames, terminal, err := r.ask("", "Run /flow todo")
		if err != nil {
			return err
		}
		if !terminal {
			return fmt.Errorf("flow show did not settle")
		}
		for _, frame := range frames {
			if frame.Type == "card" && frame.Card.Kind == "flow" && frame.Card.ID == "flow:todo" {
				return nil
			}
		}
		return fmt.Errorf("flow show delivered no TODO flow card")
	})
	r.step("6 App agent proposes the edit", "POST "+"/api/conversations/main/prompt"+" /flow.edit todo", "author confirmation quoting the diff; the TODO count unchanged", "T-FLW-05", func() error {
		var before, after int
		if err := r.pool.QueryRow(r.ctx, `SELECT count(*) FROM mythical_items`).Scan(&before); err != nil {
			return err
		}
		answer, frames, terminal, err := r.ask("", `Run /flow.edit {"name":"todo","request":"Run tests","diff":"+pnpm test"}`)
		if err != nil {
			return err
		}
		if !terminal {
			return fmt.Errorf("flow edit did not settle")
		}
		if !strings.Contains(answer, `"state":"pending"`) {
			return fmt.Errorf("flow edit did not request confirmation: %q", answer)
		}
		for _, frame := range frames {
			if frame.Type == "card" && frame.Card.Kind == "draft" {
				return fmt.Errorf("private Draft in shared conversation")
			}
		}
		var proposals int
		if err := r.pool.QueryRow(r.ctx, `SELECT count(*) FROM approvals WHERE command='todo.new' AND state='pending' AND payload::text LIKE '%+pnpm test%'`).Scan(&proposals); err != nil {
			return err
		}
		if err := r.pool.QueryRow(r.ctx, `SELECT count(*) FROM mythical_items`).Scan(&after); err != nil {
			return err
		}
		if proposals != 1 || before != after {
			return fmt.Errorf("flow edit showed %d proposals and changed TODO count %d to %d", proposals, before, after)
		}
		return nil
	})
	r.step("7 System flow refused", "POST "+"/api/conversations/main/prompt"+" /flow.edit merge", "Merge flow is built in", "T-FLW-05", func() error {
		answer, frames, terminal, err := r.ask("", "Run /flow.edit merge Add a step")
		if err != nil {
			return err
		}
		if !terminal || !strings.Contains(answer, "Merge flow is built in") {
			return fmt.Errorf("system edit did not refuse: %s", answer)
		}
		for _, frame := range frames {
			if frame.Type == "card" {
				return fmt.Errorf("system edit created a card")
			}
		}
		return nil
	})
	// Repository-copy loading is proved by 10; its packaged steps execute
	// through the pinned TODO in 15b. No separate pending resolver remains.
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
				// Pending metadata measures the entry file. Only the guest load
				// can measure its complete execution closure; correlate by main.
				var commit string
				if err := r.pool.QueryRow(r.ctx, `SELECT commit_id FROM flow_loads`).Scan(&commit); err != nil {
					return err
				}
				if commit != squash || card.version("active") != d1 {
					return fmt.Errorf("pending flow at %s with Active %s, want squash %s and D1 %s", commit, card.version("active"), squash, d1)
				}
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
				if card.Source.Path != "flows/todo/flow.ts" || card.version("previous") != d1 {
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
	if d2 != "" && !r.flowLoadBrowser(d2, false) {
		return
	}
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
		// A literal syntax error exercises failed loading regardless of which
		// coding steps the current composition calls.
		broken := flow + "\n)\n"
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
	if d2 != "" && !r.flowLoadBrowser(d2, true) {
		return
	}
	checkPin := func(number int64, digest, source string) error {
		v, err := r.todo(number)
		if err != nil {
			return err
		}
		if v.FlowVersion == nil || v.FlowVersion.Digest != digest || v.FlowVersion.SourceCommit != source {
			return fmt.Errorf("T%d pin %+v, want %s at %s", number, v.FlowVersion, digest, source)
		}
		if v.Run == nil {
			return fmt.Errorf("T%d has no admitted run", number)
		}
		current := 0
		for _, evidence := range v.Evidence {
			if int(evidence.Attempt) != v.Run.Attempt {
				continue
			}
			current++
			if evidence.FlowDigest != digest || evidence.SourceCommit != source {
				return fmt.Errorf("T%d attempt %d evidence pin %+v, want %s at %s", number, v.Run.Attempt, evidence, digest, source)
			}
		}
		if current != 1 {
			return fmt.Errorf("T%d has %d evidence entries for current attempt %d", number, current, v.Run.Attempt)
		}
		return nil
	}
	r.step("13 TODO A pinned D1", "GET /api/todos/{A}", "A's card and evidence keep D1 at original main", "T-FLW-11", func() error {
		return checkPin(a, d1, r.mainCommit)
	})
	var c int64
	r.step("14 TODO C pins D2", "POST /api/todos; GET /api/todos/{C}", "C starts on Active D2 at the flow-edit merge, despite the later broken main", "T-FLW-11", func() error {
		if d2 == "" {
			return fmt.Errorf("blocked by Active after load: no D2")
		}
		var err error
		c, err = r.file("C uses the new flow", "[FILE c.md] Add a greeting to c.md")
		if err != nil {
			return err
		}
		if _, err = r.waitTodoWithin(c, 2*time.Minute, "working", "in_review"); err != nil {
			return err
		}
		return checkPin(c, d2, squash)
	})
	r.step("15 TODO A keeps D1", "answer A; GET /api/todos/{A}; PR files", "A resumes D1 and adds only a.md, without the new changelog requirement", "T-FLW-11", func() error {
		v, err := r.todo(a)
		if err != nil {
			return err
		}
		if len(v.Waits) != 1 {
			return fmt.Errorf("A has %d waits", len(v.Waits))
		}
		code, data, err := r.answer(a, v.Waits[0].ID, "Add a greeting to a.md")
		if err != nil || code != 202 {
			return fmt.Errorf("answer A: HTTP %d %s: %v", code, data, err)
		}
		v, err = r.waitTodoWithin(a, 3*time.Minute, "in_review")
		if err != nil {
			return err
		}
		if err = checkPin(a, d1, r.mainCommit); err != nil {
			return err
		}
		pr, err := r.checkPull(v.PR.Number, v.PR.Head)
		if err != nil {
			return err
		}
		files, err := r.prFiles(pr)
		if err != nil {
			return err
		}
		if !slices.Equal(files, []string{"a.md"}) {
			return fmt.Errorf("A changes %v, want only a.md", files)
		}
		return nil
	})
	r.step("15b Repository copy executes D2", "GET /api/todos/{C}; PR files and changelog", "C's repository flow imports the packaged steps and adds c.md and a changelog entry", "T-FLW-04, T-FLW-11", func() error {
		v, err := r.waitTodoWithin(c, 3*time.Minute, "in_review")
		if err != nil {
			return err
		}
		if err = checkPin(c, d2, squash); err != nil {
			return err
		}
		pr, err := r.checkPull(v.PR.Number, v.PR.Head)
		if err != nil {
			return err
		}
		files, err := r.prFiles(pr)
		if err != nil {
			return err
		}
		if !slices.Contains(files, "c.md") || !slices.Contains(files, "CHANGELOG.md") {
			return fmt.Errorf("C changes %v, missing c.md or CHANGELOG.md", files)
		}
		content, err := r.githubGit("show", v.PR.Head+":CHANGELOG.md")
		if err != nil {
			return err
		}
		if strings.TrimSpace(content) == "" {
			return fmt.Errorf("C produced an empty changelog")
		}
		return nil
	})
	// Compare the public evidence, including each attempt's source and digest.
	// Model-access availability is a live card projection, not recorded evidence.
	checkEarlier := func(before, after rehearsalTodo) error {
		if len(before.Evidence) == 0 {
			return fmt.Errorf("R has no earlier evidence to retain")
		}
		for _, old := range before.Evidence {
			found := false
			for _, kept := range after.Evidence {
				if kept.Attempt != old.Attempt {
					continue
				}
				found = true
				if kept.FlowDigest != old.FlowDigest || kept.SourceCommit != old.SourceCommit || !reflect.DeepEqual(recordedEvidence(kept.Items), recordedEvidence(old.Items)) {
					return fmt.Errorf("R attempt %d evidence changed: before %+v, after %+v", old.Attempt, old, kept)
				}
			}
			if !found {
				return fmt.Errorf("R lost attempt %d evidence", old.Attempt)
			}
		}
		return nil
	}
	var ordinaryRetry rehearsalTodo
	if !r.step("16 Retry keeps the pin", "POST /api/todos/{R} {op: retry}; GET /api/todos/{R}", "a new attempt executes D1 after D2 activation; the failure and earlier evidence remain readable", "T-FLW-11, T-STK-05", func() error {
		if failedRetry.Run == nil || d2 == "" {
			return fmt.Errorf("blocked by failed D1 attempt or D2 activation")
		}
		code, data, err := r.keyed("POST", fmt.Sprintf("/api/todos/%d", retryTodo), `{"op":"retry"}`, r.keyPrefix+"retry-original")
		if err != nil || code != 202 {
			return fmt.Errorf("ordinary retry: HTTP %d %s: %v", code, data, err)
		}
		var accepted struct {
			Attempt int `json:"attempt"`
		}
		if err := json.Unmarshal(data, &accepted); err != nil || accepted.Attempt != failedRetry.Run.Attempt+1 {
			return fmt.Errorf("ordinary retry receipt %s, want attempt %d", data, failedRetry.Run.Attempt+1)
		}
		// The repository still fails. Its bounded automatic replans may spend
		// more than one attempt, and every one must retain D1.
		ordinaryRetry, err = r.waitTodoWithin(retryTodo, 8*time.Minute, "failed")
		if err != nil {
			return err
		}
		if ordinaryRetry.Run == nil || ordinaryRetry.Run.Attempt < accepted.Attempt {
			return fmt.Errorf("ordinary retry run %+v, want attempt at least %d", ordinaryRetry.Run, accepted.Attempt)
		}
		for _, evidence := range ordinaryRetry.Evidence {
			if evidence.FlowDigest != d1 || evidence.SourceCommit != r.mainCommit {
				return fmt.Errorf("ordinary retry changed an attempt's original pin: %+v", evidence)
			}
		}
		if err = checkPin(retryTodo, d1, r.mainCommit); err != nil {
			return err
		}
		return checkEarlier(failedRetry, ordinaryRetry)
	}) {
		return
	}
	r.step("17 Retry current flow adopts D2", "POST /api/todos/{R} {op: retry-current-flow, steer: '[FIXED] …'}; PR diff against A", "a new D2 attempt adds retry.md and CHANGELOG.md over its unmerged predecessor; earlier D1 attempts stay readable", "T-FLW-11, T-STK-05", func() error {
		body := `{"op":"retry-current-flow","steer":"[FIXED] Keep JOURNEY.md as it is and add the greeting to retry.md"}`
		code, data, err := r.keyed("POST", fmt.Sprintf("/api/todos/%d", retryTodo), body, r.keyPrefix+"retry-current")
		if err != nil || code != 202 {
			return fmt.Errorf("retry current flow: HTTP %d %s: %v", code, data, err)
		}
		v, err := r.waitTodoWithin(retryTodo, 3*time.Minute, "in_review")
		if err != nil {
			return err
		}
		if v.Run == nil || v.Run.Attempt != ordinaryRetry.Run.Attempt+1 {
			return fmt.Errorf("current flow retry run %+v, want new run after %+v", v.Run, ordinaryRetry.Run)
		}
		if err = checkPin(retryTodo, d2, squash); err != nil {
			return err
		}
		if err = checkEarlier(ordinaryRetry, v); err != nil {
			return err
		}
		if _, err := r.checkPull(v.PR.Number, v.PR.Head); err != nil {
			return err
		}
		// A precedes R and has not merged: GitHub's diff against main
		// includes A too. Measure R's own contribution against that prefix.
		predecessor, err := r.todo(a)
		if err != nil {
			return err
		}
		if len(predecessor.PR.Head) != 40 {
			return fmt.Errorf("A has no reviewed predecessor head")
		}
		diff, err := r.githubGit("diff", "--name-only", predecessor.PR.Head, v.PR.Head)
		if err != nil {
			return err
		}
		files := strings.Fields(diff)
		if !slices.Equal(files, []string{"CHANGELOG.md", "retry.md"}) {
			return fmt.Errorf("R changes %v, want exactly CHANGELOG.md and retry.md", files)
		}
		return nil
	})
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
