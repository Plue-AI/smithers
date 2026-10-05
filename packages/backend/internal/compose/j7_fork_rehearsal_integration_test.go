package compose

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// j7Scratch is the scratch branch J7 row 10 forks from T2: its name, T2's
// verified head H2 it starts from, the base C1 that head is measured from,
// and the Git door's token rows 11 and 12 use.
type j7Scratch struct {
	name, head, base, token string
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
	scratch.name, scratch.head, scratch.base = "scratch/rehearsal-owner/try-retry", c2.Head, c2.Base
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

// editScratch is row 12, the rehearsal's stand-in for a terminal edit: the
// owner pushes a commit S on the scratch branch through the Git door, and
// the branch's head moves to S, a descendant of H2.
func (r *rehearsal) editScratch(scratch *j7Scratch) error {
	if scratch.token == "" {
		return fmt.Errorf("row 11 minted no Git door token")
	}
	work := filepath.Join(r.t.TempDir(), "scratch")
	if _, err := r.gitDoor(scratch.token, "clone", "-q", "--branch", scratch.name, r.origin+"/rehearsal-owner/app.git", work); err != nil {
		return err
	}
	if head, err := r.gitDoor(scratch.token, "-C", work, "rev-parse", "HEAD"); err != nil || head != scratch.head {
		return fmt.Errorf("the scratch branch checks out %s, want H2 %s: %v", short7(head), short7(scratch.head), err)
	}
	if err := os.MkdirAll(filepath.Join(work, "src"), 0700); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(work, "src", "retry.ts"), []byte("export const backoff = (n: number) => 2 ** n * 100\n"), 0600); err != nil {
		return err
	}
	for _, args := range [][]string{{"add", "src/retry.ts"}, {"commit", "-q", "-m", "try exponential backoff"}, {"push", "-q", "origin", "HEAD:refs/heads/" + scratch.name}} {
		if _, err := r.gitDoor(scratch.token, append([]string{"-C", work}, args...)...); err != nil {
			return err
		}
	}
	s, err := r.gitDoor(scratch.token, "-C", work, "rev-parse", "HEAD")
	if err != nil {
		return err
	}
	if _, err := r.gitDoor(scratch.token, "-C", work, "merge-base", "--is-ancestor", scratch.head, s); err != nil {
		return fmt.Errorf("S %s does not descend from H2 %s: %w", short7(s), short7(scratch.head), err)
	}
	branch, err := r.j7Branch(scratch.name)
	if err != nil {
		return err
	}
	if branch.Head != s || branch.ForkedFrom == nil || branch.ForkedFrom.Commit != scratch.head {
		return fmt.Errorf("%s's head is %s (forked from %+v), want S %s", scratch.name, short7(branch.Head), branch.ForkedFrom, short7(s))
	}
	if refs, err := r.githubGit("for-each-ref", "--format=%(refname)", "refs/heads/scratch"); err != nil || refs != "" {
		return fmt.Errorf("GitHub has %q after the push: %v", refs, err)
	}
	r.actual = fmt.Sprintf("200 %s head %s -> S %s (parent H2); forked_from.commit stays %s; GitHub still has no scratch ref",
		scratch.name, short7(scratch.head), short7(s), short7(branch.ForkedFrom.Commit))
	return nil
}
