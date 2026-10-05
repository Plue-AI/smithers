package compose

import (
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
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
// composition plus a changelog step. Loading and pinning the flow
// wait on their lanes and are listed as pending.
func TestJ5Rehearsal(t *testing.T) {
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
	var a, b int64
	if !r.step("2 TODO A asks and waits", "POST /api/todos; GET /api/todos/{A}", "202; needs_you with one question", "T-STK-01", func() error {
		var err error
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
		var err error
		if b, err = r.file("B changes the TODO flow", "[FLOWEDIT] Every TODO must run `make test` and update the changelog."); err != nil {
			return err
		}
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
		r.actual = fmt.Sprintf("200 %v; todo built in, system false, Active D1 %s… with %d steps and the merge wait", names, active[0][:12], len(steps)-1)
		return nil
	})
	r.pending("5 App agent shows the TODO flow", "POST "+chat.TurnPath+" /flow todo", "the Flow card of the served todo flow", "T-FLW-05", "flow-agent-edit")
	r.pending("6 App agent proposes the edit", "POST "+chat.TurnPath+" /flow.edit todo", "one private Draft quoting the diff; the TODO count unchanged", "T-FLW-05", "flow-agent-edit")
	r.pending("7 System flow refused", "POST "+chat.TurnPath+" /flow.edit merge", "'Merge flow is built in'", "T-FLW-05", "flow-agent-edit")
	r.pending("8 Repository copy resolves", "coding host module resolver", "a repository flows/todo/flow.ts loads and has a digest", "T-FLW-04", "coding-steps-package")
	r.pending("9 Merge B", "POST /api/todos/{B}/merge as maintainer Ben", "202 while A waits; merged after GitHub's squash", "T-STK-04, T-ACC-02", "flow-load")
	r.pending("10 Active after load", "GET /api/flows", "merged-syncing, then Active D2 once workflow_definitions holds D2 loaded", "T-FLW-03", "flow-load")
	r.pending("11 One load per main move", "SQL flow-load runs", "one coalesced flow-load run per main move", "T-FLW-03", "flow-load")
	r.pending("12 Broken flow keeps previous", "merge a broken flow", "merged-failed; Active stays D2", "T-FLW-03", "flow-load")
	r.pending("13 TODO A pinned D1", "GET /api/todos/{A}", "A's evidence pins D1", "T-FLW-11", "pinned-todo-flow")
	r.pending("14 TODO C pins D2", "POST /api/todos; GET /api/todos/{C}", "C pins D2 at Starting; its evidence shows the changelog step", "T-FLW-11", "pinned-todo-flow")
	r.pending("15 TODO A keeps D1", "answer A; GET /api/todos/{A}", "A continues on D1 with no changelog step", "T-FLW-11", "pinned-todo-flow")
	r.pending("16 Retry keeps the pin", "POST /api/todos/{A} {op: retry}", "the retry attempt pins D1", "T-FLW-11, T-STK-05", "pinned-todo-flow")
}
