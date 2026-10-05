package services

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/hostexec"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// mythicalFixture is a real git repository with a working tree; the engine
// runs against its .git directory exactly as it runs against the scratch.
type mythicalFixture struct {
	t    *testing.T
	root string
	git  mythicalGit
}

func newMythicalFixture(t *testing.T) *mythicalFixture {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	root := t.TempDir()
	f := &mythicalFixture{t: t, root: root, git: mythicalGit{dir: filepath.Join(root, ".git")}}
	f.run("init", "--quiet", "-b", "main")
	return f
}

func (f *mythicalFixture) run(args ...string) string {
	f.t.Helper()
	cmd := exec.Command("git", append([]string{"-C", f.root}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+os.DevNull,
		"GIT_AUTHOR_NAME=Ada", "GIT_AUTHOR_EMAIL=ada@example.com", "GIT_COMMITTER_NAME=Ada", "GIT_COMMITTER_EMAIL=ada@example.com",
		"GIT_AUTHOR_DATE=2026-09-01T00:00:00Z", "GIT_COMMITTER_DATE=2026-09-01T00:00:00Z")
	out, err := cmd.CombinedOutput()
	require.NoError(f.t, err, "git %v: %s", args, out)
	return strings.TrimSpace(string(out))
}

// commit writes files (an empty content deletes) and commits them on HEAD.
func (f *mythicalFixture) commit(message string, files map[string]string) string {
	f.t.Helper()
	for path, content := range files {
		full := filepath.Join(f.root, path)
		if content == "" {
			require.NoError(f.t, os.Remove(full))
			continue
		}
		require.NoError(f.t, os.MkdirAll(filepath.Dir(full), 0o755))
		require.NoError(f.t, os.WriteFile(full, []byte(content), 0o644))
	}
	f.run("add", "-A")
	f.run("commit", "--quiet", "--allow-empty", "-m", message)
	return f.run("rev-parse", "HEAD")
}

func (f *mythicalFixture) tree(commit string) string {
	return f.run("rev-parse", commit+"^{tree}")
}

func (f *mythicalFixture) file(commit, path string) string {
	return f.run("show", commit+":"+path)
}

// treeWith is base's tree (or an empty tree) with files written, built
// with a private index so the working tree is never touched.
func (f *mythicalFixture) treeWith(base string, files map[string]string) string {
	f.t.Helper()
	index := filepath.Join(f.t.TempDir(), "index")
	env := append(os.Environ(), "GIT_INDEX_FILE="+index)
	git := func(stdin string, args ...string) string {
		cmd := exec.Command("git", append([]string{"-C", f.root}, args...)...)
		cmd.Env = env
		cmd.Stdin = strings.NewReader(stdin)
		out, err := cmd.CombinedOutput()
		require.NoError(f.t, err, "git %v: %s", args, out)
		return strings.TrimSpace(string(out))
	}
	if base != "" {
		git("", "read-tree", base)
	}
	for path, content := range files {
		blob := git(content, "hash-object", "-w", "--stdin")
		git("", "update-index", "--add", "--cacheinfo", "100644,"+blob+","+path)
	}
	return git("", "write-tree")
}

// laneCommit writes a lane change on parent, standing in for a workspace's
// native history: an ordinary commit with a jj change-id header.
func (f *mythicalFixture) laneCommit(parent, message string, files map[string]string, changeID string) string {
	f.t.Helper()
	id, err := f.git.writeCommit(context.Background(), mythicalCommit{Tree: f.treeWith(parent, files), Parents: []string{parent},
		Author: "Lane <lane@example.com> 1790000000 +0000", Committer: "Lane <lane@example.com> 1790000000 +0000",
		ChangeID: changeID, Message: message + "\n"})
	require.NoError(f.t, err)
	return id
}

// laneRewrite edits an existing stack change in place as jj does: the new
// parent (or none), the original's own diff re-applied, then files written,
// keeping the original's change id.
func (f *mythicalFixture) laneRewrite(original mythicalCommit, parent string, files map[string]string) string {
	f.t.Helper()
	ctx := context.Background()
	tree := original.Tree
	if parent != "" && original.Parent() != parent {
		merged, err := f.git.merge3(ctx, original.Parent(), parent, original.ID)
		require.NoError(f.t, err)
		tree = merged
	}
	if len(files) > 0 {
		tree = f.treeWith(tree, files)
	}
	commit := mythicalCommit{Tree: tree, Author: original.Author, Committer: "Lane <lane@example.com> 1790000000 +0000",
		ChangeID: original.ChangeID, Message: original.Message}
	if parent != "" {
		commit.Parents = []string{parent}
	}
	id, err := f.git.writeCommit(ctx, commit)
	require.NoError(f.t, err)
	return id
}

func stackIDs(commits []mythicalStackCommit) []string {
	out := make([]string, len(commits))
	for i, commit := range commits {
		out[i] = commit.ID
	}
	return out
}

func TestMythicalBootstrapLinearizesMainWithStableIdentities(t *testing.T) {
	f := newMythicalFixture(t)
	ctx := context.Background()
	f.commit("✨ feat: one", map[string]string{"a.txt": "1\n"})
	f.commit("✨ feat: two", map[string]string{"b.txt": "2\n"})
	// A merge on main becomes one change with its first-parent diff.
	f.run("checkout", "--quiet", "-b", "side")
	f.commit("🐛 fix: side", map[string]string{"c.txt": "3\n"})
	f.run("checkout", "--quiet", "main")
	f.commit("✨ feat: three", map[string]string{"d.txt": "4\n"})
	f.run("merge", "--quiet", "--no-ff", "-m", "Merge side", "side")
	main := f.run("rev-parse", "HEAD")

	// A window larger than history starts from the root commit.
	all, err := f.git.bootstrap(ctx, main, 100)
	require.NoError(t, err)
	require.Len(t, all, 4)
	assert.Equal(t, "✨ feat: one", all[0].Title)
	assert.Equal(t, "Merge side", all[3].Title)
	assert.Equal(t, f.tree(main), all[3].Tree)
	root, err := f.git.readCommit(ctx, all[0].ID)
	require.NoError(t, err)
	assert.Empty(t, root.Parents)
	for i, commit := range all {
		read, err := f.git.readCommit(ctx, commit.ID)
		require.NoError(t, err)
		assert.Equal(t, commit.ChangeID, read.ChangeID)
		assert.Regexp(t, mythicalChangeID, read.ChangeID)
		if i > 0 {
			assert.Equal(t, []string{all[i-1].ID}, read.Parents, "linear chain")
		}
	}

	// A shorter window snapshots everything before it into a parentless base.
	window, err := f.git.bootstrap(ctx, main, 2)
	require.NoError(t, err)
	require.Len(t, window, 3)
	assert.Equal(t, "bootstrap", window[0].Kind)
	assert.Contains(t, window[0].Title, "📦 history through")
	assert.Equal(t, f.tree(main), window[2].Tree)

	// Deterministic: a retry writes the identical objects.
	again, err := f.git.bootstrap(ctx, main, 100)
	require.NoError(t, err)
	assert.Equal(t, stackIDs(all), stackIDs(again))
}

func TestMythicalGitAdoptsACandidateAndFoldsFlat(t *testing.T) {
	f := newMythicalFixture(t)
	ctx := context.Background()
	f.commit("✨ feat: config", map[string]string{"config.txt": "x=0\n"})
	f.commit("✨ feat: api", map[string]string{"api.txt": "v1\n"})
	main := f.run("rev-parse", "HEAD")
	stack, err := f.git.bootstrap(ctx, main, 100)
	require.NoError(t, err)
	tip := stack[len(stack)-1].ID
	configChange, err := f.git.readCommit(ctx, stack[0].ID)
	require.NoError(t, err)

	// Lane A amends the config change (deep in the stack) and appends a change.
	amendedConfig := f.laneRewrite(configChange, "", map[string]string{"config.txt": "x=1\n"})
	apiChange, err := f.git.readCommit(ctx, stack[1].ID)
	require.NoError(t, err)
	restackedAPI := f.laneRewrite(apiChange, amendedConfig, nil)
	laneHead := f.laneCommit(restackedAPI, "✨ feat: docs", map[string]string{"docs.txt": "hello\n"}, mythicalChangeIDFor("lane", "docs"))
	candidate := mythicalCandidate{ItemID: "item-a", Issue: 7, Base: tip, Head: laneHead}

	// The owner merges it on GitHub: main's tree becomes the candidate's.
	f.commit("Merge #7", map[string]string{"config.txt": "x=1\n", "docs.txt": "hello\n"})
	merged := f.run("rev-parse", "HEAD")
	require.Equal(t, f.tree(merged), f.tree(laneHead))

	adopted, ok, err := f.git.adopt(ctx, tip, candidate, 100)
	require.NoError(t, err)
	require.True(t, ok)
	require.Len(t, adopted, 3, "the amended change, the restacked descendant and the appended change")
	assert.Equal(t, f.tree(merged), adopted[2].Tree)
	first, err := f.git.readCommit(ctx, adopted[0].ID)
	require.NoError(t, err)
	assert.Empty(t, first.Parents, "the amendment lands where the plan put it: at the stack's root change")
	for _, commit := range adopted {
		assert.NotEqual(t, commit.Predecessor, commit.ChangeID, "the stack never reuses a lane's change id")
		assert.Equal(t, "item-a", commit.ItemID)
		assert.EqualValues(t, 7, commit.Issue)
	}
	assert.Equal(t, configChange.ChangeID, adopted[0].Predecessor)

	// An outside commit on main is folded flat with exactly its tree.
	f.commit("🔧 chore: outside", map[string]string{"outside.txt": "o\n"})
	outside := f.run("rev-parse", "HEAD")
	outsideCommit, err := f.git.readCommit(ctx, outside)
	require.NoError(t, err)
	folded, err := f.git.flatFold(ctx, adopted[2].ID, outsideCommit, "fold")
	require.NoError(t, err)
	assert.Equal(t, f.tree(outside), folded.Tree)
	assert.Equal(t, outside, folded.FoldedFrom)
}

func TestMythicalAppendedCandidatesRebaseAndRewritesDoNot(t *testing.T) {
	f := newMythicalFixture(t)
	ctx := context.Background()
	f.commit("✨ feat: base", map[string]string{"a.txt": "a\n", "b.txt": "b\n"})
	main := f.run("rev-parse", "HEAD")
	stack, err := f.git.bootstrap(ctx, main, 100)
	require.NoError(t, err)
	oldTip := stack[len(stack)-1].ID

	// An appended candidate with an empty working-copy change at its base.
	empty := f.laneCommit(oldTip, "", nil, mythicalChangeIDFor("lane", "empty"))
	appended := f.laneCommit(empty, "✨ feat: touch a", map[string]string{"a.txt": "a2\n"}, mythicalChangeIDFor("lane", "a"))
	candidate := mythicalCandidate{ItemID: "item-b", Base: oldTip, Head: appended}
	fork, commits, isAppend, err := f.git.candidateShape(ctx, candidate, 100)
	require.NoError(t, err)
	assert.Equal(t, oldTip, fork)
	assert.True(t, isAppend)
	require.Len(t, commits, 1, "the empty working-copy change is dropped")

	// Main moves (an outside commit touching b); the stack folds it.
	f.commit("🔧 chore: b", map[string]string{"b.txt": "b2\n"})
	outside, err := f.git.readCommit(ctx, f.run("rev-parse", "HEAD"))
	require.NoError(t, err)
	folded, err := f.git.flatFold(ctx, oldTip, outside, "fold")
	require.NoError(t, err)

	rebased, err := f.git.rebaseCandidate(ctx, folded.ID, candidate, 100)
	require.NoError(t, err)
	assert.Equal(t, "a2\n", f.file(rebased, "a.txt")+"\n")
	assert.Equal(t, "b2\n", f.file(rebased, "b.txt")+"\n")
	again, err := f.git.rebaseCandidate(ctx, folded.ID, candidate, 100)
	require.NoError(t, err)
	assert.Equal(t, rebased, again, "rebasing is deterministic")

	// A conflicting append refuses adoption instead of guessing.
	conflicting := f.laneCommit(oldTip, "✨ feat: touch b", map[string]string{"b.txt": "b3\n"}, mythicalChangeIDFor("lane", "b"))
	_, ok, err := f.git.adopt(ctx, folded.ID, mythicalCandidate{Base: oldTip, Head: conflicting}, 100)
	require.NoError(t, err)
	assert.False(t, ok)
	_, err = f.git.rebaseCandidate(ctx, folded.ID, mythicalCandidate{Base: oldTip, Head: conflicting}, 100)
	var conflict *errMythicalConflict
	require.ErrorAs(t, err, &conflict)
	assert.Equal(t, []string{"b.txt"}, conflict.Paths)

	// A candidate that rewrote a stack change cannot be rebased server-side.
	base, err := f.git.readCommit(ctx, oldTip)
	require.NoError(t, err)
	rewrite := f.laneRewrite(base, "", map[string]string{"a.txt": "a9\n"})
	_, err = f.git.rebaseCandidate(ctx, folded.ID, mythicalCandidate{Base: oldTip, Head: rewrite}, 100)
	require.ErrorIs(t, err, errMythicalRewrite)
}

func TestMythicalMergeTreatsIdenticalChangesAsClean(t *testing.T) {
	f := newMythicalFixture(t)
	ctx := context.Background()
	base := f.commit("base", map[string]string{"x.txt": "0\n"})
	f.run("checkout", "--quiet", "-b", "left")
	left := f.commit("left", map[string]string{"x.txt": "1\n"})
	f.run("checkout", "--quiet", "-b", "right", base)
	right := f.commit("right", map[string]string{"x.txt": "1\n"})
	tree, err := f.git.merge3(ctx, base, left, right)
	require.NoError(t, err)
	assert.Equal(t, f.tree(left), tree)
}

// An install's bundled git is Xcode's 2.39, which has merge-tree --write-tree
// but not --merge-base (2.40): every adopt after a merge failed there with
// "unknown option `merge-base=...'". merge3 runs on such a git: a shim that
// refuses the option, as 2.39 does, gives the same clean merge and conflict.
func TestMythicalMergeRunsWithoutMergeBaseOption(t *testing.T) {
	f := newMythicalFixture(t)
	ctx := context.Background()
	real, err := exec.LookPath("git")
	require.NoError(t, err)
	shim := filepath.Join(t.TempDir(), "git")
	require.NoError(t, os.WriteFile(shim, []byte("#!/bin/sh\nfor arg in \"$@\"; do case \"$arg\" in --merge-base*) echo \"error: unknown option \\`${arg#--}'\" >&2; exit 129;; esac; done\nexec "+real+" \"$@\"\n"), 0o755))
	restore, err := hostexec.Configure(hostexec.Config{Git: shim, Environment: hostexec.Environment()})
	require.NoError(t, err)
	t.Cleanup(restore)

	base := f.commit("base", map[string]string{"a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n"})
	f.run("checkout", "--quiet", "-b", "left")
	left := f.commit("left", map[string]string{"a.txt": "a1\n", "c.txt": "c1\n"})
	f.run("checkout", "--quiet", "-b", "right", base)
	right := f.commit("right", map[string]string{"b.txt": "b2\n"})
	// A history below base never makes it the merge base: the merge is base's tree with both sides.
	tree, err := f.git.merge3(ctx, base, left, right)
	require.NoError(t, err)
	f.run("checkout", "--quiet", "-b", "both", left)
	f.run("merge", "--quiet", "--no-edit", right)
	assert.Equal(t, f.tree("HEAD"), tree)

	f.run("checkout", "--quiet", "-b", "clash", base)
	clash := f.commit("clash", map[string]string{"c.txt": "c2\n"})
	_, err = f.git.merge3(ctx, base, left, clash)
	var conflict *errMythicalConflict
	require.ErrorAs(t, err, &conflict)
	assert.Equal(t, []string{"c.txt"}, conflict.Paths)
}

func TestMythicalNotesAndIdsAreDeterministic(t *testing.T) {
	f := newMythicalFixture(t)
	ctx := context.Background()
	commit := mythicalStackCommit{ID: strings.Repeat("a", 40), ChangeID: mythicalChangeIDFor("x"), Kind: "item", ItemID: "i", Issue: 3,
		Predecessor: mythicalChangeIDFor("lane"), Title: "✨ feat: x"}
	note := mythicalNote(commit)
	assert.Contains(t, note, "version: 2")
	assert.Contains(t, note, "issue: 3")
	first, err := f.git.writeNotes(ctx, map[string]string{commit.ID: note}, "1790000000 +0000")
	require.NoError(t, err)
	second, err := f.git.writeNotes(ctx, map[string]string{commit.ID: note}, "1790000000 +0000")
	require.NoError(t, err)
	assert.Equal(t, first, second)
	assert.Equal(t, note, f.run("cat-file", "-p", first+":"+commit.ID)+"\n")
	assert.NotEqual(t, mythicalChangeIDFor("fold", "a", "b"), mythicalChangeIDFor("fold", "a", "c"))
	assert.Regexp(t, mythicalChangeID, mythicalChangeIDFor("anything"))
}

func TestMythicalNoteRecordsDriversFromItemChecks(t *testing.T) {
	drivers := mythicalDrivers([]byte(`{"route":"bug","drivers":[{"by":"will","run":"run_8f3","from":"2026-09-28T14:02:00Z","to":"2026-09-28T14:09:00Z","messages":3}]}`))
	require.Len(t, drivers, 1)
	commit := mythicalStackCommit{ChangeID: mythicalChangeIDFor("x"), Kind: "item", ItemID: "i", Drivers: drivers}
	note := mythicalNote(commit)
	assert.Contains(t, note, "drivers:\n  - by: \"will\"\n    run: \"run_8f3\"\n    from: \"2026-09-28T14:02:00Z\"\n    to: \"2026-09-28T14:09:00Z\"\n    messages: 3\n---\n")
	assert.NotContains(t, mythicalNote(mythicalStackCommit{ChangeID: mythicalChangeIDFor("x"), Kind: "item"}), "drivers:")
	assert.Nil(t, mythicalDrivers([]byte(`{}`)))
	assert.Nil(t, mythicalDrivers([]byte(`{"drivers":[{"by":"","from":"x"}]}`)))
	assert.Nil(t, mythicalDrivers([]byte(`not json`)))
}
