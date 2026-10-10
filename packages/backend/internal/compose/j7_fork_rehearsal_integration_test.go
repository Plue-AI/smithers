package compose

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"slices"
	"strings"
	"testing"
	"time"
)

// j7Scratch is the scratch branch J7 row 10 forks from T2: its name, its
// machine, T2's verified head H2 it starts from, the base C1 that head is
// measured from, the Git door's token row 11 uses, and the commit S
// add-to-stack captures from its edited working tree.
type j7Scratch struct {
	name, machine, head, base, token, edit string
}

// j7Added is the TODO row 13 adds from the scratch branch: its number and
// its PR's head and tree in review, before row 15 drops T2.
type j7Added struct {
	n          int64
	head, tree string
}

// j7Branch is what GET and POST /api/branches answer about one branch.
type j7Branch struct {
	Name       string `json:"name"`
	Kind       string `json:"kind"`
	Head       string `json:"head"`
	ForkedFrom *struct {
		Kind   string `json:"kind"`
		Ref    string `json:"ref"`
		Commit string `json:"commit"`
		Base   string `json:"base"`
		Item   int64  `json:"item"`
	} `json:"forked_from"`
	Machine struct {
		ID string `json:"id"`
	} `json:"machine"`
}

// j7Run is the part of a TODO a fork must not touch: its attempt, run,
// state and candidate, and each lane machine the stack bound for it, by
// workspace, VM and provisioning generation (spec §8.5.2). The lanes'
// statuses are reported, not compared: the stack retires a lane at review.
type j7Run struct {
	attempt, generation               int64
	run, state, head, lanes, statuses string
}

func (r *rehearsal) j7Run(number int64) (j7Run, error) {
	var v j7Run
	err := r.pool.QueryRow(r.ctx, `SELECT i.attempt, i.generation, i.request_run_id, i.state, i.candidate_head,
		COALESCE((SELECT string_agg(l.workspace_id || ' vm=' || w.vm_id || ' g' || w.provisioning_generation, ', ' ORDER BY l.created_at)
			FROM mythical_lanes l JOIN workspaces w ON w.id::text = l.workspace_id WHERE l.item_id = i.id), ''),
		COALESCE((SELECT string_agg(w.status, ', ' ORDER BY l.created_at)
			FROM mythical_lanes l JOIN workspaces w ON w.id::text = l.workspace_id WHERE l.item_id = i.id), '')
		FROM mythical_items i WHERE i.number = $1`, number).
		Scan(&v.attempt, &v.generation, &v.run, &v.state, &v.head, &v.lanes, &v.statuses)
	return v, err
}

func (r *rehearsal) j7Branch(name string) (j7Branch, error) {
	var branch j7Branch
	data, err := r.expect("GET", "/api/branches/"+url.PathEscape(name), "", 200)
	if err == nil {
		err = json.Unmarshal(data, &branch)
	}
	return branch, err
}

// forkT2 is row 10: Fork T2 into scratch/<owner>/try-retry. The fork starts
// from T2's last verified head H2 (S1, spec §8.5.0), whose base is T1's
// verified head C1 once T2 rebuilt on its prefix (row 9), and touches
// neither T2's run nor its machine.
func (r *rehearsal) forkT2(t1, t2 int64, scratch *j7Scratch) error {
	// Row 9 releases T2 and waits for its review; this row needs only its
	// verified head.
	if err := r.release("t2"); err != nil {
		return err
	}
	var c2 j7Candidate
	for deadline := time.Now().Add(8 * time.Minute); ; time.Sleep(time.Second) {
		var err error
		if c2, err = r.candidate(t2); err != nil {
			return err
		}
		if c2.Verified && c2.Head != "" {
			break
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("T%d has no verified head to fork (%s %q)", t2, c2.State, c2.Reason)
		}
	}
	c1, err := r.candidate(t1)
	if err != nil {
		return err
	}
	if !c1.Verified || c2.Base != c1.Head {
		return fmt.Errorf("T%d's verified head %s is built on %s, not T%d's verified head %s", t2, short7(c2.Head), short7(c2.Base), t1, short7(c1.Head))
	}
	before, err := r.j7Run(t2)
	if err != nil {
		return err
	}
	data, err := r.expect("POST", "/api/branches", fmt.Sprintf(`{"from":"T%d","name":"try-retry"}`, t2), 201)
	if err != nil {
		return err
	}
	var created j7Branch
	if err := json.Unmarshal(data, &created); err != nil {
		return err
	}
	scratch.name, scratch.machine, scratch.head, scratch.base = "scratch/rehearsal-owner/try-retry", created.Machine.ID, c2.Head, c2.Base
	read, err := r.j7Branch(scratch.name)
	if err != nil {
		return err
	}
	for _, branch := range []j7Branch{created, read} {
		from := branch.ForkedFrom
		if branch.Name != scratch.name || branch.Kind != "scratch" || from == nil || from.Kind != "item" || from.Item != t2 ||
			from.Ref != fmt.Sprintf("T%d", t2) || from.Commit != c2.Head || from.Base != c1.Head || branch.Head != c2.Head || branch.Machine.ID == "" {
			raw, _ := json.Marshal(branch)
			return fmt.Errorf("branch %s, want %s forked from {T%d, H2 %s, C1 %s} at H2", raw, scratch.name, t2, short7(c2.Head), short7(c1.Head))
		}
	}
	after, err := r.j7Run(t2)
	if err != nil {
		return err
	}
	// Only the stack moves T2's lanes (it retires one at review); a fork
	// never restarts their machines or T2's run.
	unchanged := before
	unchanged.statuses, unchanged.state = after.statuses, after.state
	if after != unchanged || after.lanes == "" {
		return fmt.Errorf("the fork changed T%d's run or machines: %+v, was %+v", t2, after, before)
	}
	var parent string
	if err := r.pool.QueryRow(r.ctx, `SELECT COALESCE(parent_workspace_id::text, '') FROM workspaces WHERE id = $1`, created.Machine.ID).Scan(&parent); err != nil {
		return err
	}
	if parent == "" || !strings.Contains(after.lanes, parent) {
		return fmt.Errorf("the scratch machine's parent %q is not one of T%d's lanes (%s)", parent, t2, after.lanes)
	}
	r.actual = fmt.Sprintf("201 %s forked_from {T%d, H2 %s, C1 %s = T%d's verified head}; parent %s; T%d %s attempt %d %s unchanged, lanes [%s] (%s)",
		created.Name, t2, short7(c2.Head), short7(c1.Head), t1, short7(parent), t2, after.state, after.attempt, after.run, after.lanes, after.statuses)
	return nil
}

// gitDoor runs git as the owner through the install's Git door.
func (r *rehearsal) gitDoor(token string, args ...string) (string, error) {
	cmd := exec.Command("/usr/bin/git", append([]string{"-c", "http.extraHeader=Authorization: Bearer " + token,
		"-c", "user.name=Owner", "-c", "user.email=owner@example.test"}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+os.DevNull)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s: %v: %s", args[0], err, out)
	}
	return strings.TrimSpace(string(out)), nil
}

// scratchOffGitHub is row 11: the scratch branch is a branch of the
// install's repository only (M-22).
func (r *rehearsal) scratchOffGitHub(scratch *j7Scratch) error {
	if scratch.name == "" {
		return fmt.Errorf("row 10 forked no scratch branch")
	}
	token, err := r.token("write:repository")
	if err != nil {
		return err
	}
	scratch.token = token
	listed, err := r.gitDoor(token, "ls-remote", r.origin+"/rehearsal-owner/app.git", "refs/heads/"+scratch.name)
	if err != nil {
		return err
	}
	if !strings.HasPrefix(listed, scratch.head+"\t") {
		return fmt.Errorf("the install's repository lists %q for %s, want H2 %s", listed, scratch.name, short7(scratch.head))
	}
	refs, err := r.githubGit("for-each-ref", "--format=%(refname)")
	if err != nil {
		return err
	}
	var smithers []string
	for _, ref := range strings.Fields(refs) {
		if strings.Contains(ref, "scratch") || strings.Contains(ref, "try-retry") {
			return fmt.Errorf("GitHub has %s", ref)
		}
		if strings.HasPrefix(ref, "refs/heads/smithers/") {
			smithers = append(smithers, strings.TrimPrefix(ref, "refs/heads/"))
		}
	}
	r.actual = fmt.Sprintf("install %s at %s; GitHub has no scratch ref (its smithers/ branches: %s)", scratch.name, short7(scratch.head), strings.Join(smithers, ", "))
	return nil
}

// editScratch writes through the editor door, so capture observes the working tree.
func (r *rehearsal) editScratch(scratch *j7Scratch) error {
	path := "/api/repos/" + rehearsalRepository + "/workspaces/" + scratch.machine + "/files/content?path=src/retry.ts"
	body, _ := json.Marshal(map[string]string{"base_digest": "absent", "content": "export const backoff = (n: number) => 2 ** n * 100\n"})
	if _, err := r.expect("PUT", path, string(body), 200); err != nil {
		return err
	}
	r.actual = "200 scratch editor write; src/retry.ts awaits capture"
	return nil
}

// diffPaths are the paths a git diff names in its "diff --git a/<p> b/<p>"
// headers.
func diffPaths(diff string) []string {
	var paths []string
	for _, line := range strings.Split(diff, "\n") {
		if rest, ok := strings.CutPrefix(line, "diff --git a/"); ok {
			if at := strings.Index(rest, " b/"); at >= 0 {
				paths = append(paths, rest[:at])
			}
		}
	}
	return paths
}

// addScratch is row 13: Add to stack (/branch.add-to-stack's door) with the
// default placement puts a new TODO directly after T2, the scratch branch's
// source, with no PR yet. Its revision 1 seeds the diff from C1 to the
// scratch head S: T2's change plus the src/retry.ts edit (spec §8.5.3). The
// branch becomes the TODO's smithers/ branch on the same machine. The TODO
// then reaches review with a PR holding that change; row 15 drops T2 only
// once the TODO's run has ended.
func (r *rehearsal) addScratch(t1, t2, tn, t3 int64, scratch *j7Scratch, added *j7Added) error {
	if scratch.machine == "" {
		return fmt.Errorf("rows 10-12 left no edited scratch branch")
	}
	var status, head string
	if err := r.pool.QueryRow(r.ctx, `SELECT status, head_commit_id FROM workspaces WHERE id::text = $1`, scratch.machine).Scan(&status, &head); err != nil {
		return err
	}
	body, _ := json.Marshal(map[string]string{"text": "[FILE ta.md] Keep the exponential backoff in src/retry.ts"})
	code, data, err := r.keyed("POST", "/api/branches/"+url.PathEscape(scratch.name)+"/add-to-stack", string(body), r.keyPrefix+"add-try-retry")
	if err != nil {
		return err
	}
	var receipt struct {
		State string `json:"state"`
		N     int64  `json:"n"`
	}
	if code != 202 || json.Unmarshal(data, &receipt) != nil || receipt.State != "accepted" || receipt.N <= 0 {
		return fmt.Errorf("Add to stack: HTTP %d %s (the scratch machine %s is %s at %s)", code, data, scratch.machine, status, short7(head))
	}
	added.n = receipt.N
	want := []int64{}
	if t1 > 0 {
		want = append(want, t1)
	}
	want = append(want, t2, added.n)
	if tn > 0 {
		want = append(want, tn)
	}
	if t3 > 0 {
		want = append(want, t3)
	}
	list, err := r.todoList()
	if err != nil {
		return err
	}
	var placed []int64
	for _, todo := range list {
		if todo.State != "merged" && todo.State != "dropped" {
			placed = append(placed, todo.N)
		}
	}
	if !slices.Equal(placed, want) {
		return fmt.Errorf("GET /api/todos lists %v, want %v: T%d directly after T%d", placed, want, added.n, t2)
	}
	if data, err = r.expect("GET", fmt.Sprintf("/api/todos/%d", added.n), "", 200); err != nil {
		return err
	}
	var card struct {
		Branch *struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"branch"`
		PR *struct {
			Number int64 `json:"number"`
		} `json:"pr"`
		PromptRevisions []struct {
			Reason string `json:"reason"`
			Seed   *struct {
				Base     string `json:"base"`
				Captured string `json:"captured"`
				Diff     string `json:"diff"`
			} `json:"seed"`
		} `json:"prompt_revisions"`
	}
	if err := json.Unmarshal(data, &card); err != nil {
		return err
	}
	if len(card.PromptRevisions) != 1 || card.PromptRevisions[0].Reason != "add-to-stack" || card.PromptRevisions[0].Seed == nil {
		return fmt.Errorf("T%d's revisions are %s, want one add-to-stack revision with a seed", added.n, data)
	}
	seed := card.PromptRevisions[0].Seed
	scratch.edit = seed.Captured
	paths := diffPaths(seed.Diff)
	if seed.Base != scratch.base || (seed.Captured == "" || seed.Captured == scratch.head) || !slices.Contains(paths, "t2.md") || !slices.Contains(paths, "src/retry.ts") {
		return fmt.Errorf("T%d's seed is base %s, captured %s, paths %v; want C1 %s, S %s, t2.md and src/retry.ts", added.n, short7(seed.Base), short7(seed.Captured), paths, short7(scratch.base), short7(scratch.edit))
	}
	if card.Branch == nil || card.Branch.ID != scratch.machine || !strings.HasPrefix(card.Branch.Name, "smithers/") {
		return fmt.Errorf("T%d's branch is %+v, want smithers/<slug> on the scratch machine %s", added.n, card.Branch, scratch.machine)
	}
	if card.PR != nil && card.PR.Number > 0 {
		return fmt.Errorf("T%d has PR #%d as it is added", added.n, card.PR.Number)
	}
	v, err := r.waitTodoWithin(added.n, 8*time.Minute, "in_review")
	if err != nil {
		return fmt.Errorf("T%d: %w", added.n, err)
	}
	pull, err := r.checkPull(v.PR.Number, v.PR.Head)
	if err != nil {
		return err
	}
	files, err := r.prFiles(pull)
	if err != nil {
		return err
	}
	for _, file := range []string{"t2.md", "src/retry.ts", "ta.md"} {
		if !slices.Contains(files, file) {
			return fmt.Errorf("T%d's PR #%d changes %v, want t2.md, src/retry.ts and ta.md", added.n, pull.Number, files)
		}
	}
	if added.tree, err = r.githubGit("rev-parse", pull.Head.SHA+"^{tree}"); err != nil {
		return err
	}
	if content, err := r.githubGit("show", pull.Head.SHA+":src/retry.ts"); err != nil || content != "export const backoff = (n: number) => 2 ** n * 100" {
		return fmt.Errorf("PR lost scratch content: %q: %v", content, err)
	}
	added.head = pull.Head.SHA
	r.actual = fmt.Sprintf("202 T%d; order %v; revision 1 add-to-stack seeds %v from C1 %s (S %s); %s on machine %s, no PR at once; in review, PR #%d head %s changes %v",
		added.n, placed, paths, short7(seed.Base), short7(seed.Captured), card.Branch.Name, card.Branch.ID, pull.Number, short7(pull.Head.SHA), files)
	return nil
}

// keepsT2 is row 14, read after row 15 drops T2: the added TODO's tree is
// the one it had in review, now measured from T1's verified head C1, so its
// item diff and its PR still carry T2's file and the scratch edit (J7.3,
// spec §8.5.3a), and its PR no longer includes T2.
func (r *rehearsal) keepsT2(t1, t2 int64, added *j7Added) error {
	if added.n == 0 || added.tree == "" {
		return fmt.Errorf("row 13 left no added TODO in review")
	}
	var c1 j7Candidate
	var err error
	if t1 > 0 {
		c1, err = r.candidate(t1)
	} else {
		err = r.pool.QueryRow(r.ctx, `SELECT landed_main FROM mythical_stacks`).Scan(&c1.Head)
	}
	if err != nil {
		return err
	}
	var card j7Card
	var ca j7Candidate
	for deadline := time.Now().Add(8 * time.Minute); ; time.Sleep(time.Second) {
		if card, err = r.j7Card(added.n); err != nil {
			return err
		}
		if ca, err = r.candidate(added.n); err != nil {
			return err
		}
		if card.State == "in_review" && ca.Base == c1.Head && ca.Head != "" && card.PR.Head == ca.Head {
			break
		}
		if card.State == "dropped" || card.State == "merged" || time.Now().After(deadline) {
			return fmt.Errorf("T%d %s, candidate %s on %s (item %s %q), PR head %s; want its candidate on C1 %s in review", added.n, card.State, short7(ca.Head), short7(ca.Base), ca.State, ca.Reason, short7(card.PR.Head), short7(c1.Head))
		}
	}
	tree, err := r.githubGit("rev-parse", card.PR.Head+"^{tree}")
	if err != nil {
		return err
	}
	if tree != added.tree {
		return fmt.Errorf("T%d's tree moved from %s to %s when T%d was dropped", added.n, short7(added.tree), short7(tree), t2)
	}
	diff, err := r.githubGit("diff", "--name-only", c1.Head, card.PR.Head)
	if err != nil {
		return err
	}
	items := strings.Fields(diff)
	if !slices.Contains(items, "t2.md") || !slices.Contains(items, "src/retry.ts") {
		return fmt.Errorf("T%d's item diff from C1 %s lists %v, want t2.md and src/retry.ts", added.n, short7(c1.Head), items)
	}
	pull, err := r.readFakePull(card.PR.Number)
	if err != nil {
		return err
	}
	files, err := r.prFiles(pull)
	if err != nil {
		return err
	}
	if pull.State != "open" || pull.Head.SHA != card.PR.Head || !slices.Contains(files, "t2.md") || !slices.Contains(files, "src/retry.ts") {
		return fmt.Errorf("T%d's PR #%d is %s at %s changing %v, want open at %s with t2.md and src/retry.ts", added.n, pull.Number, pull.State, short7(pull.Head.SHA), files, short7(card.PR.Head))
	}
	if slices.Contains(card.PR.IncludedItems, t2) {
		return fmt.Errorf("T%d's PR still includes dropped T%d: %v", added.n, t2, card.PR.IncludedItems)
	}
	r.actual = fmt.Sprintf("200 T%d in_review on C1 %s, tree %s unchanged (head %s -> %s); item diff %v; PR #%d includes %v, changes %v",
		added.n, short7(c1.Head), short7(tree), short7(added.head), short7(card.PR.Head), items, pull.Number, card.PR.IncludedItems, files)
	return nil
}

// The capture/adoption boundary also runs independently of J7's placement and
// conflict scenarios, so a failure cannot hide behind a held predecessor.
func TestJ7ScratchCaptureRehearsal(t *testing.T) {
	r := newRehearsal(t, "SMITHERS_J7_REHEARSAL", "C-J7-capture", "j7-capture-")
	if !r.install("Install") {
		return
	}
	var source int64
	var scratch j7Scratch
	var added j7Added
	if !r.step("Source in review", "POST TODO; GET TODO", "source reaches review", "T-MCH-08", func() error {
		var err error
		source, err = r.file("Source retry", "[FILE t2.md] Keep the source retry note")
		if err != nil {
			return err
		}
		_, err = r.waitTodoWithin(source, 8*time.Minute, "in_review")
		return err
	}) {
		return
	}
	if !r.step("Fork and edit", "POST branches; PUT files/content", "forked machine captures an editor file", "T-MCH-08", func() error {
		candidate, err := r.candidate(source)
		if err != nil {
			return err
		}
		raw, err := r.expect("POST", "/api/branches", fmt.Sprintf(`{"from":"T%d","name":"try-retry"}`, source), 201)
		if err != nil {
			return err
		}
		var branch j7Branch
		if err := json.Unmarshal(raw, &branch); err != nil {
			return err
		}
		scratch = j7Scratch{name: branch.Name, machine: branch.Machine.ID, head: candidate.Head, base: candidate.Base}
		return r.editScratch(&scratch)
	}) {
		return
	}
	r.step("Add to stack", "POST add-to-stack; GET TODO; GitHub PR", "reviewed PR retains the source and captured editor file", "T-MCH-08", func() error {
		return r.addScratch(0, source, 0, 0, &scratch, &added)
	})
}
