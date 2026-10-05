package services

import (
	"encoding/json"
	"os"
	"slices"
	"strings"
	"testing"
)

func TestSystemFlowsAreNeverOverridable(t *testing.T) {
	// Required names are drawn from engineering spec §11.1.1 and product
	// Appendix A. This is a contract minimum, not a snapshot of SystemFlows.
	want := []string{
		"stack", "stack.move", "stack.candidate", "stack.propose",
		"todo.preapprove", "todo.unapprove",
		"todo.new", "todo.from-issue", "todo.answer", "todo.steer", "todo.amend", "todo.stop", "todo.resume", "todo.retry", "todo.retry-current-flow", "todo.drop",
		"branch.fork", "branch.add-to-stack", "branch.rebase",
		"merge", "members", "settings", "secrets", "sync", "admission", "setup", "flow-load", "summarizer",
	}
	seen := make(map[string]bool)
	for _, name := range SystemFlows {
		if seen[name] {
			t.Errorf("duplicate system name %q", name)
		}
		seen[name] = true
		if Overridable(name) {
			t.Errorf("system name %q is overridable", name)
		}
	}
	for _, name := range want {
		t.Run(name, func(t *testing.T) {
			if !slices.Contains(SystemFlows, name) {
				t.Fatalf("missing system name %q", name)
			}
			if Overridable(name) {
				t.Fatalf("system name %q is overridable", name)
			}
		})
	}
}

func TestSystemFlowsIncludeExplicitInstallOperationsFromProductSpec(t *testing.T) {
	// Read the normative rows themselves, including abbreviated .operation
	// spellings. Prefix wildcards never turn exact-match reservation into a
	// namespace ban. Appendix B.2 calls /review an install command, but §11.1.2
	// explicitly makes its body overridable; only §11.1.1 system families apply.
	product, err := os.ReadFile("../../../../.specs/product/mvp.md")
	if err != nil {
		t.Fatal(err)
	}
	section := strings.SplitN(string(product), "### B.2 Install flows", 2)
	if len(section) != 2 {
		t.Fatal("missing product Appendix B.2")
	}
	rows := strings.SplitN(section[1], "### B.3", 2)[0]
	for _, subject := range []string{
		"The stack", "Commit a TODO", "Draft a TODO from an issue", "Steer the coding agent",
		"What needs you", "Answer an approval", "Answer the coding agent's question",
		"Take over a removed member's TODO (in-card control)", "Retry a failed TODO",
		"Merge the next item", "Parallel-work count", "Stack plumbing",
		"People and roles", "Repository secrets", "Subscription and environment connections",
		"GitHub App and sync health", "Mirror plumbing", "Mirror the repository",
	} {
		t.Run(subject, func(t *testing.T) {
			var cell string
			for _, row := range strings.Split(rows, "\n") {
				columns := strings.Split(row, "|")
				if len(columns) > 3 && strings.TrimSpace(columns[2]) == subject {
					cell = columns[1]
					break
				}
			}
			if cell == "" {
				t.Fatal("missing normative operation row")
			}
			prefix := ""
			for i, token := range strings.Split(cell, "`") {
				if i%2 == 0 || strings.Contains(token, "*") {
					continue
				}
				name := token
				if strings.HasPrefix(name, ".") {
					name = prefix + name
				} else {
					prefix = strings.SplitN(name, ".", 2)[0]
				}
				if Overridable(name) {
					t.Errorf("Appendix B.2 system operation %q is overridable", name)
				}
				for _, near := range []string{name + "/custom", name + ".custom", strings.ToUpper(name)} {
					if !Overridable(near) {
						t.Errorf("unlisted near-name %q is reserved", near)
					}
				}
			}
		})
	}
}

func TestOverridableFlowMatchingIsExact(t *testing.T) {
	for _, name := range []string{"todo", "learning", "review", "release-notes", "Merge", "merge/x", "merger", "stack.propose/x", "repository-jobs/custom", "repository/setup/x", " merge", "merge "} {
		t.Run(name, func(t *testing.T) {
			if !Overridable(name) {
				t.Fatalf("non-system name %q is not overridable", name)
			}
		})
	}
}

// GET /api/flows lists the TODO flow the install ships, built in and not
// system, with one Active version and the merge wait; no system name.
func TestFlowCatalogServesTheBuiltinTodoFlow(t *testing.T) {
	cards, err := FlowCatalog()
	if err != nil {
		t.Fatal(err)
	}
	served, err := json.Marshal(cards)
	if err != nil {
		t.Fatal(err)
	}
	var digests map[string]string
	if err := json.Unmarshal(builtinFlowsJSON, &digests); err != nil {
		t.Fatal(err)
	}
	want := `[{"name":"todo","source":{"builtin":true},"system":false,"versions":[{"id":"` + digests["todo"] + `","state":"active","steps":[` +
		`{"id":"plan","label":"Plan"},{"id":"implement","label":"Implement"},{"id":"verify","label":"Verify"},` +
		`{"id":"review","label":"Review"},{"id":"propose","label":"Propose"},` +
		`{"id":"merge","wait":true,"signals":[{"on":"rebase","to":"Verify"},{"on":"steer","to":"Implement"}]}]}]}]`
	if string(served) != want {
		t.Fatalf("catalog\n got %s\nwant %s", served, want)
	}
	if len(digests["todo"]) != 64 {
		t.Fatalf("todo digest %q is not a sha256 hex digest", digests["todo"])
	}
	for _, card := range cards {
		if !Overridable(card.Name) {
			t.Errorf("catalog lists system flow %q", card.Name)
		}
	}
}

func TestFlowCatalogRefusesABuiltinWithoutADigest(t *testing.T) {
	saved := builtinFlowsJSON
	t.Cleanup(func() { builtinFlowsJSON = saved })
	for _, body := range []string{`{}`, `{"todo":"D1"}`, `{"todo":"` + strings.Repeat("A", 64) + `"}`, `not json`} {
		builtinFlowsJSON = []byte(body)
		if _, err := FlowCatalog(); err == nil {
			t.Errorf("catalog with digests %s served", body)
		}
	}
}

func TestBuiltinFlowDefaultsNameOnlyOverridableFlows(t *testing.T) {
	want := map[string]string{
		"todo":     "flows/todo/flow.ts",
		"learning": "flows/learning/flow.ts",
		"review":   "flows/review/flow.ts",
	}
	if len(BuiltinFlowDefaults) != len(want) {
		t.Fatalf("builtin catalog has %d entries, want %d", len(BuiltinFlowDefaults), len(want))
	}
	for name, path := range want {
		if BuiltinFlowDefaults[name] != path {
			t.Errorf("default %q = %q, want %q", name, BuiltinFlowDefaults[name], path)
		}
		if !Overridable(name) {
			t.Errorf("builtin default %q is reserved", name)
		}
	}
}
