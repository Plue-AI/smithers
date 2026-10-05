package services

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// reviewAnswer is a review's whole answer by its contract
// (flows/review/change): the verdict, then the Changed:, Checks: and Risks:
// lines, as the projected run output.
func reviewAnswer(verdict string) string {
	out, _ := json.Marshal(verdict + "\nChanged: Appends a line.\nChecks: test passed.\nRisks: None.")
	return string(out)
}

// diffOf is one file's unified diff, as git diff writes it.
func diffOf(path, hunks string) string {
	return "diff --git a/" + path + " b/" + path + "\nindex 1111111..2222222 100644\n--- a/" + path + "\n+++ b/" + path + "\n" + hunks
}

// The M3 re-walk's merged change (defect 3): the agent rewrote the
// repository's only test file for its new greet function and dropped the
// existing "adds" test. flows/test/coding-kept-tests.test.ts reads the same
// cases through the coding flow's guard.
const dropsAdds = "diff --git a/test/smoke.test.mjs b/test/smoke.test.mjs\nindex 1111111..2222222 100644\n--- a/test/smoke.test.mjs\n+++ b/test/smoke.test.mjs\n" +
	"@@ -1,7 +1,10 @@\n import { test } from \"node:test\"\n import assert from \"node:assert/strict\"\n-import { add } from \"../src/index.mjs\"\n+import { greet } from \"../greet.mjs\"\n \n" +
	"-test(\"adds\", () => {\n-  assert.equal(add(1, 2), 3)\n+test(\"greets\", () => {\n+  assert.equal(greet(\"Ada\"), \"Hello, Ada!\")\n+})\n+\n+test(\"greets the world\", () => {\n+  assert.equal(greet(), \"Hello, world!\")\n })\n"

func TestMythicalRemovedTests(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, diff string
		want       []mythicalRemovedTest
	}{
		{"a rewrite that drops an existing test", dropsAdds, []mythicalRemovedTest{{"test/smoke.test.mjs", "adds", "deleted"}}},
		{"adding a test", diffOf("test/smoke.test.mjs", "@@ -5,3 +5,7 @@ test(\"adds\", () => {\n   assert.equal(add(1, 2), 3)\n })\n+\n+test(\"subtracts\", () => {\n+  assert.equal(sub(3, 2), 1)\n+})\n"), nil},
		{"a rewritten declaration line", diffOf("test/smoke.test.mjs", "@@ -1,3 +1,3 @@\n-test(\"adds\", () => {\n-  assert.equal(add(1, 2), 3)\n+test(\"adds\", async () => {\n+  assert.equal(await add(1, 2), 3)\n })\n"), nil},
		{"an emptied body", diffOf("src/math.test.ts", "@@ -3,6 +3,5 @@ import { add } from \"./math\"\n \n it(\"adds\", () => {\n-  expect(add(1, 2)).toBe(3)\n+  // covered elsewhere\n })\n it(\"keeps\", () => { expect(1).toBe(1) })\n"),
			[]mythicalRemovedTest{{"src/math.test.ts", "adds", "emptied"}}},
		{"a skip", diffOf("test/smoke.test.mjs", "@@ -1,3 +1,3 @@\n-test(\"adds\", () => {\n+test.skip(\"adds\", () => {\n   assert.equal(add(1, 2), 3)\n })\n"),
			[]mythicalRemovedTest{{"test/smoke.test.mjs", "adds", "skipped"}}},
		{"a deleted file", "diff --git a/tests/test_math.py b/tests/test_math.py\ndeleted file mode 100644\nindex 1111111..0000000\n--- a/tests/test_math.py\n+++ /dev/null\n@@ -1,6 +0,0 @@\n-from math_lib import add\n-\n-def test_adds():\n-    assert add(1, 2) == 3\n-\n-async def test_awaits(): assert True\n",
			[]mythicalRemovedTest{{"tests/test_math.py", "test_adds", "deleted"}, {"tests/test_math.py", "test_awaits", "deleted"}}},
		{"a Go body emptied in place", diffOf("math_test.go", "@@ -5,7 +5,6 @@ import \"testing\"\n \n func TestAdd(t *testing.T) {\n-\tif Add(1, 2) != 3 {\n-\t\tt.Fatal(\"1 + 2\")\n-\t}\n+\t// TODO\n }\n \n func TestMain(m *testing.M) {}\n"),
			[]mythicalRemovedTest{{"math_test.go", "TestAdd", "emptied"}}},
		{"a Python body emptied in place", diffOf("test_math.py", "@@ -1,5 +1,5 @@\n def test_adds():\n-    assert add(1, 2) == 3\n+    pass\n \n def test_subtracts():\n     assert sub(3, 2) == 1\n"),
			[]mythicalRemovedTest{{"test_math.py", "test_adds", "emptied"}}},
		{"a body that keeps a statement", diffOf("test/smoke.test.mjs", "@@ -1,3 +1,3 @@\n test(\"adds\", () => {\n-  assert.equal(add(1, 2), 3)\n+  assert.equal(add(2, 2), 4)\n })\n"), nil},
		{"a source file", diffOf("src/runner.mjs", "@@ -1,3 +1,0 @@\n-test(\"adds\", () => {\n-  assert.equal(add(1, 2), 3)\n-})\n"), nil},
		{"a file under spec/", diffOf("spec/runner.mjs", "@@ -1,3 +1,0 @@\n-test(\"adds\", () => {\n-  assert.equal(add(1, 2), 3)\n-})\n"),
			[]mythicalRemovedTest{{"spec/runner.mjs", "adds", "deleted"}}},
	} {
		assert.Equal(t, tc.want, mythicalRemovedTests(tc.diff), tc.name)
	}
}

// The review's answer is its verdict, then the summary and its findings;
// Smithers adds every removed existing test the risks leave out, and keeps
// every finding (the 2026-10-05 M4 walk lost two of them).
func TestMythicalReviewSummary(t *testing.T) {
	t.Parallel()
	removed := []string{mythicalRemovedTestLine(mythicalRemovedTest{"test/smoke.test.mjs", "adds", "deleted"})}
	for _, tc := range []struct {
		name, output string
		removed      []string
		want         string
		findings     []string
		whole        bool
	}{
		{"the contract's three lines and a finding", `"approve\nChanged: Adds greet().\nChecks: test passed.\nRisks: None.\n- greet.mjs:1 name the export"`, nil,
			"Changed: Adds greet().\nChecks: test passed.\nRisks: None.", []string{"greet.mjs:1 name the export"}, true},
		{"the verdict alone", `"approve"`, nil, "", nil, false},
		{"the verdict and prose", `"approve\n\nThe change does what the TODO asks."`, nil, "", []string{"The change does what the TODO asks."}, false},
		// The M4 walk's answer: request-changes and two findings, no summary.
		{"the old contract's findings", `"request-changes\n- greet.mjs:1 add a JSDoc block to greet\n- greet.mjs:3 validate that name is a string"`, nil,
			"", []string{"greet.mjs:1 add a JSDoc block to greet", "greet.mjs:3 validate that name is a string"}, false},
		{"bold, bulleted and continued labels", "\"request-changes\\n- **Changed:** Adds greet().\\n**Checks**: test passed.\\nRisks:\\n- greet() throws on null\\n- no docs\\n\\n1. a.go:1 fix\\n```\\n2) b.go:2 fix\"", nil,
			"Changed: Adds greet().\nChecks: test passed.\nRisks: greet() throws on null; no docs", []string{"a.go:1 fix", "b.go:2 fix"}, true},
		{"a missing line", `"approve\nChanged: Adds greet().\nRisks: None."`, nil, "Changed: Adds greet().\nRisks: None.", nil, false},
		{"removed tests replace None", `"approve\nChanged: Adds greet().\nChecks: test passed.\nRisks: None."`, removed,
			"Changed: Adds greet().\nChecks: test passed.\nRisks: Removes the existing test \"adds\" in test/smoke.test.mjs (deleted).", nil, true},
		{"removed tests join other risks", `"approve\nChanged: Adds greet().\nChecks: test passed.\nRisks: greet() throws on null."`, removed,
			"Changed: Adds greet().\nChecks: test passed.\nRisks: greet() throws on null; removes the existing test \"adds\" in test/smoke.test.mjs (deleted).", nil, true},
		{"risks that name the test stand", `"approve\nChanged: Adds greet().\nChecks: test passed.\nRisks: The \"adds\" test is gone."`, removed,
			"Changed: Adds greet().\nChecks: test passed.\nRisks: The \"adds\" test is gone.", nil, true},
		{"a bare verdict still names removed tests", `"approve"`, removed, "Risks: Removes the existing test \"adds\" in test/smoke.test.mjs (deleted).", nil, false},
	} {
		summary, findings := mythicalReviewSummary(tc.output, tc.removed)
		assert.Equal(t, tc.want, summary, tc.name)
		assert.Equal(t, tc.findings, findings, tc.name)
		assert.Equal(t, tc.whole, mythicalReviewSummarized(summary), tc.name)
	}
}

// Findings are bounded: at most mythicalReviewFindings, each clipped on a
// rune boundary to mythicalReviewFindingRunes.
func TestMythicalReviewFindingsAreBounded(t *testing.T) {
	t.Parallel()
	var answer []string
	for i := 0; i < mythicalReviewFindings+5; i++ {
		answer = append(answer, fmt.Sprintf("- f%d.go:1 %s", i, strings.Repeat("é", mythicalReviewFindingRunes)))
	}
	output, _ := json.Marshal("request-changes\n" + strings.Join(answer, "\n"))
	_, findings := mythicalReviewSummary(string(output), nil)
	require.Len(t, findings, mythicalReviewFindings)
	for _, finding := range findings {
		assert.True(t, utf8.ValidString(finding))
		assert.Equal(t, mythicalReviewFindingRunes, utf8.RuneCountInString(finding))
		assert.True(t, strings.HasSuffix(finding, "…"))
	}
	assert.True(t, strings.HasPrefix(findings[0], "f0.go:1 "))
}

// Fuzz: any answer reads without a panic; findings stay bounded and valid
// UTF-8; a summary is only ever its labeled lines, in order.
func FuzzMythicalReviewSummary(f *testing.F) {
	f.Add("approve\nChanged: a\nChecks: b\nRisks: c\n- x")
	f.Add("request-changes\n- greet.mjs:1 add a JSDoc block")
	f.Add("approve\nRisks:\n- a\n\n- b")
	f.Add("")
	f.Fuzz(func(t *testing.T, text string) {
		output, _ := json.Marshal(text)
		summary, findings := mythicalReviewSummary(string(output), []string{`"adds" in test/a.test.mjs (deleted)`})
		if len(findings) > mythicalReviewFindings {
			t.Fatalf("%d findings", len(findings))
		}
		for _, finding := range findings {
			if utf8.RuneCountInString(finding) > mythicalReviewFindingRunes || finding == "" {
				t.Fatalf("finding %q", finding)
			}
		}
		last := -1
		for _, line := range strings.Split(summary, "\n") {
			label, _, _ := strings.Cut(line, ": ")
			at := slices.Index(mythicalReviewLabels, label)
			if at <= last {
				t.Fatalf("summary %q out of order", summary)
			}
			last = at
		}
	})
}

// The card's evidence and the pull request body show the review's summary
// under its verdict, not the bare verdict.
func TestMythicalTodoReviewLineCarriesTheSummary(t *testing.T) {
	t.Parallel()
	summary := "Changed: Adds greet().\nChecks: test passed.\nRisks: None."
	item := db.MythicalItem{CandidateHead: "candidate", Checks: mythicalChecks{
		Review: &mythicalReview{Head: "published", Candidate: "candidate", Verdict: "approve", Summary: summary},
	}.encode()}
	assert.Equal(t, []map[string]any{{"kind": "review", "summary": "Approved\n" + summary}}, currentTodoEvidence(item).Items)
	_, review := mythicalTodoEvidenceText(item)
	assert.Equal(t, "Review: Approved\n"+summary, review)
	shape := mythicalPRShape{Branch: "smithers/greet", Title: "Greet", Prompt: "Add greet", URL: "http://mini.local:4000/o/r", Owner: "ben", Review: review}
	_, body, err := shape.render()
	require.NoError(t, err)
	assert.Contains(t, body, "\n\nReview: Approved\nChanged: Adds greet().\nChecks: test passed.\nRisks: None.\n\n")

	// Changes requested: the card and the body keep every finding; nothing
	// else changes, so a person still decides and Merge stays offered.
	requested := item
	requested.Checks = mythicalChecks{Review: &mythicalReview{Head: "published", Candidate: "candidate", Verdict: "request-changes", Summary: summary,
		Findings: []string{"greet.mjs:1 add a JSDoc block to greet", "greet.mjs:3 validate that name is a string"}}}.encode()
	shownRequested := "Changes requested\n" + summary + "\nFindings:\n- greet.mjs:1 add a JSDoc block to greet\n- greet.mjs:3 validate that name is a string"
	assert.Equal(t, []map[string]any{{"kind": "review", "summary": shownRequested}}, currentTodoEvidence(requested).Items)
	_, review = mythicalTodoEvidenceText(requested)
	shape.Review = review
	_, body, err = shape.render()
	require.NoError(t, err)
	assert.Contains(t, body, "\n\nReview: "+shownRequested+"\n\n")

	// A review running again for its summary shows no verdict yet.
	repairing := item
	repairing.Checks = mythicalChecks{Review: &mythicalReview{Head: "published", Candidate: "candidate", RunID: "run-1", Verdict: mythicalReviewRepair}}.encode()
	assert.Empty(t, currentTodoEvidence(repairing).Items)
	running := item
	running.Checks = mythicalChecks{Review: &mythicalReview{Head: "published", Candidate: "candidate", RunID: "run-1"}}.encode()
	assert.Equal(t, todoSteps(running), todoSteps(repairing), "the review step shows as running, not failed")
}

// reviewingTodo files an owner's TODO, makes files its verified candidate on
// main and opens its pull request, as TestTodoReleasesItsCodingAndReviewLanes
// does, so the stack launches the review of its head.
func reviewingTodo(t *testing.T, files map[string]string) (*mythicalOrchestration, string) {
	t.Helper()
	return reviewingTodoAfter(t, func(*mythicalOrchestration) {}, files)
}

// reviewingTodoAfter is reviewingTodo on a main that setup changed first.
func reviewingTodoAfter(t *testing.T, setup func(*mythicalOrchestration), files map[string]string) (*mythicalOrchestration, string) {
	t.Helper()
	o, session := newTodoAdmission(t)
	setup(o)
	ctx := context.Background()
	id := uuidString(o.fileTodo(session, "first").ID)
	o.wake()
	item := o.byID(id)
	require.Equal(t, "running", item.State, item.Reason)
	tip := o.hostRef("refs/heads/main")
	candidate := o.laneResult(item.WorkspaceID, tip, files, "✨ feat: greet the reader")
	_, err := o.pool.Exec(ctx, `UPDATE mythical_items SET state='integrating', candidate_base=$2, candidate_head=$3, candidate_verified=true,
		summary='✨ feat: greet the reader' WHERE id=$1`, item.ID, tip, candidate)
	require.NoError(t, err)
	o.wake()
	require.Equal(t, "proposing", o.byID(id).State)
	_, err = o.pool.Exec(ctx, `UPDATE mythical_items SET state='proposed', pr_number=41, pr_head=$2, pr_state='open', reason='' WHERE id=$1`, item.ID, candidate)
	require.NoError(t, err)
	o.github.mu.Lock()
	if o.github.pulls == nil {
		o.github.pulls = map[int64]*mythicalPull{}
	}
	o.github.pulls[41] = &mythicalPull{Number: 41, State: "open", HeadSHA: candidate, HeadRef: "smithers/todo-1", MergeableState: "clean"}
	o.github.mu.Unlock()
	o.wake()
	require.Len(t, o.launcher.byFlow(mythicalReviewFlow), 1, "the review of the head launched")
	return o, id
}

// reviewArgs is the review launch's arguments.
func reviewArgs(t *testing.T, o *mythicalOrchestration, index int) string {
	t.Helper()
	var args struct {
		Args string `json:"args"`
	}
	require.NoError(t, json.Unmarshal(o.launcher.byFlow(mythicalReviewFlow)[index].Payload, &args))
	return args.Args
}

// A review that answers with its verdict alone runs once more on the same
// head, told so; the second answer's summary is the review's. A second bare
// answer stands with its verdict: nothing holds the TODO for it.
func TestMythicalBareVerdictGetsOneRepairTurn(t *testing.T) {
	for name, second := range map[string]string{"summarized": reviewAnswer("approve"), "bare again": `"approve"`} {
		t.Run(name, func(t *testing.T) {
			o, id := reviewingTodo(t, map[string]string{"JOURNEY.md": "Hello, reader.\n"})
			assert.NotContains(t, reviewArgs(t, o, 0), "Your last answer gave only its verdict.")
			o.answerReviews(`"approve"`)
			require.Len(t, o.launcher.byFlow(mythicalReviewFlow), 2, "the bare verdict asks the review once more")
			assert.Contains(t, reviewArgs(t, o, 1), "Your last answer gave only its verdict.")
			review := mythicalChecksOf(o.byID(id)).Review
			require.NotNil(t, review)
			assert.True(t, review.Repaired)
			assert.Empty(t, review.Verdict, "the head is being reviewed again")

			o.answerReviews(second)
			item := o.byID(id)
			review = mythicalChecksOf(item).Review
			assert.Equal(t, "approve", review.Verdict)
			o.wake()
			assert.Len(t, o.launcher.byFlow(mythicalReviewFlow), 2, "one repair turn, never a third run")
			assert.Empty(t, o.byID(id).Reason, "nothing holds the TODO")
			if name == "bare again" {
				assert.Empty(t, review.Summary, "a second bare answer stands with its verdict")
				return
			}
			assert.Equal(t, "Changed: Appends a line.\nChecks: test passed.\nRisks: None.", review.Summary)
			assert.Contains(t, currentTodoEvidence(item).Items, map[string]any{"kind": "review", "summary": "Approved\n" + review.Summary})
		})
	}
}

// The review reads which checks ran and every existing test the diff takes
// away, and its summary names each removed test as a risk; the verdict still
// stands, so a person decides.
func TestMythicalReviewReadsRemovedTestsAndNamesThemAsRisks(t *testing.T) {
	o, id := reviewingTodoAfter(t, func(o *mythicalOrchestration) {
		o.commitFile("✅ test: smoke", "test/smoke.test.mjs", "import { test } from \"node:test\"\n\ntest(\"adds\", () => {\n  assert.equal(1 + 2, 3)\n})\n")
	}, map[string]string{"test/smoke.test.mjs": "import { test } from \"node:test\"\n\ntest(\"greets\", () => {\n  assert.equal(greet(), \"Hi\")\n})\n"})
	args := reviewArgs(t, o, 0)
	assert.Contains(t, args, "<untrusted-removed-tests>\n- \"adds\" in test/smoke.test.mjs (deleted)\n</untrusted-removed-tests>")
	assert.True(t, strings.Contains(args, "The checks Smithers ran on this change:") || strings.Contains(args, "Smithers ran no checks on this change."), args)
	assert.Less(t, strings.Index(args, "</untrusted-removed-tests>"), strings.Index(args, "<untrusted-diff>"))

	o.answerReviews(reviewAnswer("approve"))
	review := mythicalChecksOf(o.byID(id)).Review
	assert.Equal(t, []string{`"adds" in test/smoke.test.mjs (deleted)`}, review.Removed)
	assert.Equal(t, "Changed: Appends a line.\nChecks: test passed.\nRisks: Removes the existing test \"adds\" in test/smoke.test.mjs (deleted).", review.Summary)
	assert.Equal(t, "approve", review.Verdict, "a removed test is a risk, never a merge block")
}

// Property: for a test file whose cases are each kept, changed, deleted,
// emptied or skipped, the diff git writes between the two versions names
// exactly the deleted, emptied and skipped cases. The seed reproduces a
// failure; flows/test/coding-kept-tests.test.ts draws the same kinds of files.
func TestMythicalRemovedTestsProperty(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	for _, dir := range []string{"a/test", "b/test"} {
		require.NoError(t, os.MkdirAll(filepath.Join(root, dir), 0o755))
	}
	fates := []string{"kept", "changed", "deleted", "emptied", "skipped"}
	for seed := int64(1); seed <= 150; seed++ {
		next := rand.New(rand.NewSource(seed))
		before := []string{`import { test } from "node:test"`, `import assert from "node:assert/strict"`, ""}
		after := append([]string(nil), before...)
		var expected []string
		count := 1 + next.Intn(6)
		for index := 0; index < count; index++ {
			name := fmt.Sprintf("case %d-%d", seed, index)
			fate := fates[next.Intn(len(fates))]
			var body []string
			lines := 1 + next.Intn(3)
			for line := 0; line < lines; line++ {
				body = append(body, fmt.Sprintf("  assert.equal(f(%d, %d), %d)", index, line, seed))
			}
			before = append(append(append(before, `test("`+name+`", () => {`), body...), "})", "")
			switch fate {
			case "deleted":
				expected = append(expected, "deleted "+name)
			case "emptied":
				after = append(after, `test("`+name+`", () => {`, "})", "")
				expected = append(expected, "emptied "+name)
			case "skipped":
				after = append(append(append(after, `test.skip("`+name+`", () => {`), body...), "})", "")
				expected = append(expected, "skipped "+name)
			case "changed":
				after = append(after, `test("`+name+`", () => {`, fmt.Sprintf("  assert.ok(%d)", seed), "})", "")
			default:
				after = append(append(append(after, `test("`+name+`", () => {`), body...), "})", "")
			}
		}
		require.NoError(t, os.WriteFile(filepath.Join(root, "a/test/smoke.test.mjs"), []byte(strings.Join(before, "\n")), 0o600))
		require.NoError(t, os.WriteFile(filepath.Join(root, "b/test/smoke.test.mjs"), []byte(strings.Join(after, "\n")), 0o600))
		cmd := exec.Command("git", "diff", "--no-index", "--no-color", "a/test/smoke.test.mjs", "b/test/smoke.test.mjs")
		cmd.Dir = root
		out, _ := cmd.Output()
		var found []string
		for _, test := range mythicalRemovedTests(string(out)) {
			found = append(found, test.How+" "+test.Name)
		}
		sort.Strings(found)
		sort.Strings(expected)
		assert.Equal(t, expected, found, "seed %d", seed)
	}
}

// Fuzz: any diff text parses without a panic; every removed test is in a
// test file; a diff that only adds lines deletes and skips nothing.
func FuzzMythicalRemovedTests(f *testing.F) {
	f.Add(dropsAdds)
	f.Add(diffOf("math_test.go", "@@ -5,7 +5,6 @@\n \n func TestAdd(t *testing.T) {\n-\tif Add(1, 2) != 3 {\n+\t// TODO\n }\n"))
	f.Add(diffOf("test_math.py", "@@ -1,5 +1,5 @@\n def test_adds():\n-    assert add(1, 2) == 3\n+    pass\n"))
	f.Add("diff --git a/x b/x\n--- a/x\n+++ /dev/null\n@@\n-test(\"a\", () => {\n")
	f.Add("@@ -1 +1 @@\n-test(`a`)\n+")
	f.Fuzz(func(t *testing.T, diff string) {
		for _, test := range mythicalRemovedTests(diff) {
			if !mythicalIsTestPath(test.Path) {
				t.Fatalf("%q is not a test file", test.Path)
			}
		}
		var added []string
		for _, line := range strings.Split(diff, "\n") {
			if !strings.HasPrefix(line, "-") || strings.HasPrefix(line, "--- ") {
				added = append(added, line)
			}
		}
		for _, test := range mythicalRemovedTests(strings.Join(added, "\n")) {
			if test.How != "emptied" {
				t.Fatalf("a diff without removed lines %s %q", test.How, test.Name)
			}
		}
	})
}

// Integration (real PostgreSQL and git, the GitHub fake): a review that
// requests changes reaches the pull request body and the card with its
// summary and every finding, and the merge stays ready, because people decide.
func TestTodoPublicationShowsRequestedChangesWithEveryFinding(t *testing.T) {
	f := newPublicationFixture(t, false)
	item, _ := f.inReview()
	checks := mythicalChecksOf(item)
	checks.Review = &mythicalReview{Head: item.PRHead, Candidate: item.CandidateHead, RunID: "run-review", Verdict: "request-changes",
		Summary:  "Changed: Adds greet().\nChecks: test passed.\nRisks: Removes the existing test \"adds\" in test/smoke.test.mjs (deleted).",
		Findings: []string{"greet.mjs:1 add a JSDoc block to greet", "greet.mjs:3 validate that name is a string"}}
	item.Checks = checks.encode()
	_, err := db.New(f.pool).SaveMythicalItem(context.Background(), item)
	require.NoError(t, err)
	f.wake()
	shown := "Changes requested\nChanged: Adds greet().\nChecks: test passed.\nRisks: Removes the existing test \"adds\" in test/smoke.test.mjs (deleted).\n" +
		"Findings:\n- greet.mjs:1 add a JSDoc block to greet\n- greet.mjs:3 validate that name is a string"
	assert.Contains(t, f.pull(item.PRNumber.Int64).Body, "\n\nReview: "+shown+"\n\n")
	card := f.card(item.Number.Int64)
	assert.Contains(t, fmtJSON(t, card["evidence"]), fmtJSON(t, map[string]any{"kind": "review", "summary": shown}))
	assert.Equal(t, "in_review", card["state"])
	assert.Equal(t, "ready", card["merge"].(map[string]any)["state"], "a person decides: Merge stays offered")
}
