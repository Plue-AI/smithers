package repohostserver

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// restoreFixture is a bare git repository holding one commit pair and a large
// number of refs/jj/keep/* pins, the shape jj leaves in a long-lived repo.
type restoreFixture struct {
	gitDir   string
	oldOID   string
	newOID   string
	keepRefs int
}

func newRestoreFixture(t *testing.T, keepRefs int) restoreFixture {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	gitDir := t.TempDir()
	run := func(stdin string, args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"--git-dir", gitDir}, args...)...)
		cmd.Stdin = strings.NewReader(stdin)
		cmd.Env = append(cmd.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com")
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, "git %v: %s", args, out)
		return strings.TrimSpace(string(out))
	}
	run("", "init", "--bare", "--quiet")
	tree := run("", "mktree")
	oldOID := run("", "commit-tree", tree, "-m", "old")
	newOID := run("", "commit-tree", tree, "-p", oldOID, "-m", "new")
	var updates strings.Builder
	fmt.Fprintf(&updates, "create refs/heads/main %s\n", oldOID)
	for i := 0; i < keepRefs; i++ {
		fmt.Fprintf(&updates, "create refs/jj/keep/%040d %s\n", i, oldOID)
	}
	run(updates.String(), "update-ref", "--stdin")
	return restoreFixture{gitDir: gitDir, oldOID: oldOID, newOID: newOID, keepRefs: keepRefs}
}

func (f restoreFixture) refs(t *testing.T) map[string]string {
	t.Helper()
	refs, err := listGitRefs(context.Background(), f.gitDir)
	require.NoError(t, err)
	return refs
}

func TestRestoreGitRefsFinishesWithinDeadlineOnRepoWithManyRefs(t *testing.T) {
	f := newRestoreFixture(t, 1000)
	before := f.refs(t)
	require.Len(t, before, f.keepRefs+1)

	// The push fast-forwarded main and created a feature branch.
	cmd := exec.Command("git", "--git-dir", f.gitDir, "update-ref", "--stdin")
	cmd.Stdin = strings.NewReader(fmt.Sprintf("update refs/heads/main %s\ncreate refs/heads/feature %s\n", f.newOID, f.newOID))
	out, err := cmd.CombinedOutput()
	require.NoError(t, err, string(out))
	after := f.refs(t)

	// Rolling back one changed ref must not cost one git process per ref in
	// the repository: a deadline that a handful of processes meet easily
	// must be enough.
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	require.NoError(t, restoreGitRefs(ctx, f.gitDir, before, after))
	require.Equal(t, before, f.refs(t))
}

func TestRestoreGitRefsRestoresDeletedRef(t *testing.T) {
	f := newRestoreFixture(t, 2)
	before := f.refs(t)
	out, err := exec.Command("git", "--git-dir", f.gitDir, "update-ref", "-d", "refs/heads/main").CombinedOutput()
	require.NoError(t, err, string(out))
	after := f.refs(t)

	require.NoError(t, restoreGitRefs(context.Background(), f.gitDir, before, after))
	require.Equal(t, before, f.refs(t))
}

func TestRestoreGitRefsRefusesToClobberRefChangedSinceListing(t *testing.T) {
	f := newRestoreFixture(t, 2)
	before := f.refs(t)
	after := map[string]string{}
	for name, oid := range before {
		after[name] = oid
	}
	after["refs/heads/main"] = f.newOID

	// Nothing actually moved main to newOID: the listing is stale, so the
	// rollback must abort instead of blindly rewriting the ref.
	require.Error(t, restoreGitRefs(context.Background(), f.gitDir, before, after))
	require.Equal(t, before, f.refs(t))
}

func TestReceivePackAdvertisementHidesJJRefs(t *testing.T) {
	f := newRestoreFixture(t, 1)
	cmd := exec.Command("git", "receive-pack", "--stateless-rpc", "--advertise-refs", f.gitDir)
	cmd.Env = gitServiceEnv("receive-pack", maxDecompressedGitRequestSize, 0)
	out, err := cmd.Output()
	require.NoError(t, err)
	// A `git push --mirror` prunes every advertised ref its source lacks, so
	// jj's retention pins must never be offered to a pusher.
	require.Contains(t, string(out), "refs/heads/main")
	require.NotContains(t, string(out), "refs/jj/")
}
