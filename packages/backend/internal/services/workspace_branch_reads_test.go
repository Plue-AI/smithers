package services

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// Every member reads every branch of the install's repository (spec §6.3,
// M-17), whoever started it: the owner's TODO's branch, under the name its
// card gives it, and a scratch branch another member forked. A TODO's
// branch is found by that name, merged or not; merged and dropped TODOs
// leave the list; a lane is never a branch of its own; a person off the
// roster, or suspended from it, reads none.
func TestBranchReadsShowEveryMemberEveryBranchRealPostgres(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	owner, repo := setupTestUserAndRepo(t, pool)
	installBranchOwner(t, pool, owner)
	q := db.New(pool)
	_, err := q.RequestMythicalBootstrap(ctx, repo, owner, 1, false)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state='active' WHERE repository_id=$1`, repo)
	require.NoError(t, err)
	var ben, maya, stranger int64
	for name, id := range map[string]*int64{"ben-branches": &ben, "maya-branches": &maya, "stranger-branches": &stranger} {
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES($1,$1) RETURNING id`, name).Scan(id))
	}
	for _, member := range []int64{ben, maya} {
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, repo, member)
		require.NoError(t, err)
	}
	svc := NewWorkspaceService(q, WithWorkspaceTransactions(pool), WithBranchMachineProviders(InstallBranchMachineProviders(everyMember{},
		guestRuntime{installRuntime{level: workspaceapi.IsolationSandboxed}, "agent", 19999})))
	machines, err := q.GetBranchMachineOwner(ctx)
	require.NoError(t, err)

	// The owner files T1 and T2; each holds a lane machine of the stack's.
	stack := NewMythicalService(pool, nil)
	asOwner := middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &db.User{ID: owner}, SessionHash: "session"})
	for _, title := range []string{"Add a greeting", "Say goodbye"} {
		_, err = stack.FileTodo(asOwner, repo, owner, MythicalTodoInput{Title: title, Prompt: "Change " + title, Request: title})
		require.NoError(t, err)
	}
	lane := func(n int64) string {
		item, err := q.GetMythicalItemByNumber(ctx, repo, n)
		require.NoError(t, err)
		name := fmt.Sprintf("TODO %d attempt 1 g1", n)
		row, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: machines, Name: name, Kind: "agent",
			Status: "running", TargetBookmark: MythicalBookmark, EnvironmentSource: defaultWorkspaceEnvironmentSource})
		require.NoError(t, err)
		_, _, err = q.BindMythicalLane(ctx, db.MythicalLane{WorkspaceID: row.ID, RepositoryID: repo, ItemID: item.ID, Name: name})
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='running', workspace_id=$2 WHERE id=$1`, item.ID, row.ID)
		require.NoError(t, err)
		return row.ID
	}
	t1Lane, _ := lane(1), lane(2)
	// T2 merged: its card still names its branch, the list no longer does.
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='landed', workspace_id='', checks = COALESCE(checks,'{}'::jsonb) || '{"branch":"smithers/say-goodbye"}'::jsonb
		WHERE repository_id=$1 AND number=2`, repo)
	require.NoError(t, err)

	// Ben forks T1 into a scratch branch; the machine service owns it.
	h1, c0 := strings.Repeat("1", 40), strings.Repeat("0", 40)
	t1, err := q.GetMythicalItemByNumber(ctx, repo, 1)
	require.NoError(t, err)
	scratch, err := svc.createWorkspaceRow(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: ben, TargetBookmark: "scratch/ben-branches/try-retry",
		Kind: "container", Status: "starting", IsFork: true, SourceCommit: h1, ForkedFromItem: t1.ID, ForkedFromBase: c0,
		ParentWorkspaceID: pgUUIDFromString(t1Lane), EnvironmentSource: defaultWorkspaceEnvironmentSource})
	require.NoError(t, err)
	require.Equal(t, machines, scratch.UserID)
	// The owner's own legacy workspace is no branch of the install's.
	_, err = q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: owner, Name: "mine", Kind: "container",
		Status: "running", TargetBookmark: "main", EnvironmentSource: defaultWorkspaceEnvironmentSource})
	require.NoError(t, err)

	names := func(branches []BranchMachineResponse) []string {
		out := []string{}
		for _, branch := range branches {
			out = append(out, branch.Kind+" "+branch.Name)
		}
		return out
	}
	for _, reader := range []int64{maya, owner, ben} {
		listed, total, err := svc.ListBranches(ctx, repo, reader, 1, 30)
		require.NoError(t, err)
		require.Equal(t, []string{"item TODO 1 attempt 1 g1", "scratch scratch/ben-branches/try-retry"}, names(listed), "reader %d", reader)
		require.EqualValues(t, 2, total)
		require.Equal(t, &BranchItem{N: 1, Title: "Add a greeting", State: "working", Place: t1.StackPosition.Int64}, listed[0].Item)
		require.Equal(t, t1Lane, listed[0].Machine.ID)
		require.Equal(t, &BranchForkedFrom{Kind: "item", Ref: "T1", Commit: h1, Base: c0, Item: 1}, listed[1].ForkedFrom)
		require.Equal(t, h1, listed[1].Head)
	}
	page, total, err := svc.ListBranches(ctx, repo, maya, 2, 1)
	require.NoError(t, err)
	require.Equal(t, []string{"scratch scratch/ben-branches/try-retry"}, names(page))
	require.EqualValues(t, 2, total)

	// Published, T1's branch goes by its pull request's head branch.
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET pr_head=$2, candidate_head=$2, checks = COALESCE(checks,'{}'::jsonb) || '{"branch":"smithers/add-a-greeting"}'::jsonb
		WHERE id=$1`, t1.ID, h1)
	require.NoError(t, err)
	read, err := svc.GetBranch(ctx, "smithers/add-a-greeting", repo, maya)
	require.NoError(t, err)
	require.Equal(t, "item", read.Kind)
	require.Equal(t, h1, read.Head)
	require.Equal(t, t1Lane, read.Machine.ID)
	read, err = svc.GetBranch(ctx, "scratch/ben-branches/try-retry", repo, maya)
	require.NoError(t, err, "a member reads a branch another member forked")
	require.Equal(t, scratch.ID, read.Machine.ID)
	read, err = svc.GetBranch(ctx, "smithers/say-goodbye", repo, maya)
	require.NoError(t, err, "a merged TODO's card still opens its branch")
	require.Equal(t, &BranchItem{N: 2, Title: "Say goodbye", State: "merged"}, read.Item)
	for _, missing := range []string{MythicalBookmark, "TODO 1 attempt 1 g1", "smithers/nope"} {
		_, err = svc.GetBranch(ctx, missing, repo, maya)
		requireBranchStatus(t, err, 404)
	}

	// Off the roster, or suspended from it, a person reads no branch.
	_, _, err = svc.ListBranches(ctx, repo, stranger, 1, 30)
	requireBranchStatus(t, err, 403)
	_, err = pool.Exec(ctx, `UPDATE collaborators SET suspended_at=NOW() WHERE user_id=$1`, maya)
	require.NoError(t, err)
	_, err = svc.GetBranch(ctx, "scratch/ben-branches/try-retry", repo, maya)
	requireBranchStatus(t, err, 403)
}

// A branch's diff is its change from the revision it is measured from, one
// DiffCard model per file (added, modified, deleted, renamed, binary with
// its blob sizes), and the commits between, oldest first.
func TestBranchDiffFilesAndCommitsFromGit(t *testing.T) {
	dir := t.TempDir()
	run := func(args ...string) string {
		cmd := exec.Command("git", append([]string{"-C", dir, "-c", "user.name=Smithers", "-c", "user.email=noreply@smithers.sh"}, args...)...)
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, string(out))
		return strings.TrimSpace(string(out))
	}
	write := func(path, content string) {
		require.NoError(t, os.MkdirAll(filepath.Dir(filepath.Join(dir, path)), 0o755))
		require.NoError(t, os.WriteFile(filepath.Join(dir, path), []byte(content), 0o644))
	}
	run("init", "--quiet", "-b", "main")
	write("keep.txt", "one\ntwo\nthree\n")
	write("gone.txt", "bye\n")
	write("old/name.txt", "a file that moves\nwith enough lines\nto be found as a rename\n")
	write("logo.bin", "\x00\x01\x02")
	run("add", "-A")
	run("commit", "--quiet", "-m", "base")
	base := run("rev-parse", "HEAD")
	write("keep.txt", "one\n2\nthree\n")
	run("rm", "--quiet", "gone.txt")
	run("commit", "--quiet", "-am", "fix: change two")
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "new"), 0o755))
	run("mv", "old/name.txt", "new/name.txt")
	write("greet.mjs", "export const greet = () => 'hi'\n")
	write("logo.bin", "\x00\x01\x02\x03\x04")
	run("add", "-A")
	run("commit", "--quiet", "-m", "feat: add greet")
	head := run("rev-parse", "HEAD")
	g := mythicalGit{dir: filepath.Join(dir, ".git")}
	ctx := context.Background()

	files, sizes, err := branchDiffFiles(ctx, g, base, head)
	require.NoError(t, err)
	diff, err := ProjectTODOBranchDiff("smithers/greet", base, files, sizes)
	require.NoError(t, err)
	byPath := map[string]BranchDiffModel{}
	for _, file := range diff.Files {
		require.Equal(t, "smithers/greet", file.Branch)
		require.Equal(t, BranchDiffAgainst{Kind: "item_base", Rev: base}, file.Against)
		byPath[file.Path] = file
	}
	require.Len(t, byPath, 5)
	require.Equal(t, "added", byPath["greet.mjs"].Change)
	require.Equal(t, []BranchDiffHunk{{OldStart: 0, NewStart: 1, Lines: []BranchDiffLine{{Op: "+", Text: "export const greet = () => 'hi'"}}}}, byPath["greet.mjs"].Hunks)
	require.Equal(t, "deleted", byPath["gone.txt"].Change)
	require.Equal(t, "modified", byPath["keep.txt"].Change)
	require.Equal(t, []BranchDiffLine{{Op: " ", Text: "one"}, {Op: "-", Text: "two"}, {Op: "+", Text: "2"}, {Op: " ", Text: "three"}}, byPath["keep.txt"].Hunks[0].Lines)
	require.Equal(t, "renamed", byPath["old/name.txt"].Change)
	require.Equal(t, "new/name.txt", byPath["old/name.txt"].RenamedTo)
	require.Equal(t, &BranchDiffBinary{BeforeBytes: 3, AfterBytes: 5}, byPath["logo.bin"].Binary)
	require.Empty(t, byPath["logo.bin"].Hunks)

	commits, err := branchDiffCommits(ctx, g, base, head)
	require.NoError(t, err)
	require.Len(t, commits, 2)
	require.Equal(t, []string{"fix: change two", "feat: add greet"}, []string{commits[0].Subject, commits[1].Subject})
	require.Equal(t, head, commits[1].SHA)
	require.Equal(t, "Smithers", commits[1].Author)
	require.NotEmpty(t, commits[1].At)

	none, _, err := branchDiffFiles(ctx, g, head, head)
	require.NoError(t, err)
	require.Empty(t, none)
	empty, err := branchDiffCommits(ctx, g, head, head)
	require.NoError(t, err)
	require.Empty(t, empty)
}
