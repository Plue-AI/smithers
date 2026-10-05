package gitutil

import (
	"context"
	"github.com/stretchr/testify/require"
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestIsAncestorRealGraph(t *testing.T) {
	dir := t.TempDir()
	git := func(args ...string) string {
		cmd := exec.Command("git", append([]string{"--git-dir", dir}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=Fixture", "GIT_AUTHOR_EMAIL=fixture@example.com", "GIT_COMMITTER_NAME=Fixture", "GIT_COMMITTER_EMAIL=fixture@example.com", "GIT_AUTHOR_DATE=2000-01-01T00:00:00Z", "GIT_COMMITTER_DATE=2000-01-01T00:00:00Z")
		out, err := cmd.Output()
		require.NoError(t, err)
		return strings.TrimSpace(string(out))
	}
	git("init", "--bare", "--quiet", dir)
	tree := git("mktree")
	old := git("commit-tree", tree, "-m", "old")
	tip := git("commit-tree", tree, "-p", old, "-m", "tip")
	side := git("commit-tree", tree, "-p", old, "-m", "side")
	merge := git("commit-tree", tree, "-p", side, "-p", tip, "-m", "merge")
	for _, tc := range []struct {
		a, b string
		want bool
	}{{old, tip, true}, {tip, old, false}, {tip, tip, true}, {side, tip, false}, {tip, merge, true}} {
		actual, err := IsAncestor(t.Context(), dir, tc.a, tc.b, func(ctx context.Context, args ...string) *exec.Cmd { return exec.CommandContext(ctx, "git", args...) })
		require.NoError(t, err)
		require.Equal(t, tc.want, actual)
	}
	actual, err := IsAncestor(t.Context(), dir, "missing", tip, func(ctx context.Context, args ...string) *exec.Cmd { return exec.CommandContext(ctx, "git", args...) })
	require.Error(t, err)
	require.False(t, actual)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	actual, err = IsAncestor(ctx, dir, old, tip, func(ctx context.Context, args ...string) *exec.Cmd { return exec.CommandContext(ctx, "git", args...) })
	require.Error(t, err)
	require.False(t, actual)
	actual, err = IsAncestor(t.Context(), dir, old, tip, func(ctx context.Context, args ...string) *exec.Cmd {
		return exec.CommandContext(ctx, "/does-not-exist")
	})
	require.Error(t, err)
	require.False(t, actual)
}

// A replacement ref must not turn a rewrite into a fast-forward: with
// refs/replace/<rewrite> naming a commit whose parent is main, plain git
// reports main as an ancestor of the rewrite; the ancestry helper does not.
func TestIsAncestorIgnoresReplacementObjects(t *testing.T) {
	dir := t.TempDir()
	git := func(args ...string) string {
		cmd := exec.Command("git", append([]string{"--git-dir", dir}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=Fixture", "GIT_AUTHOR_EMAIL=fixture@example.com", "GIT_COMMITTER_NAME=Fixture", "GIT_COMMITTER_EMAIL=fixture@example.com", "GIT_AUTHOR_DATE=2000-01-01T00:00:00Z", "GIT_COMMITTER_DATE=2000-01-01T00:00:00Z")
		out, err := cmd.Output()
		require.NoError(t, err)
		return strings.TrimSpace(string(out))
	}
	git("init", "--bare", "--quiet", dir)
	tree := git("mktree")
	root := git("commit-tree", tree, "-m", "root")
	main := git("commit-tree", tree, "-p", root, "-m", "main")
	rewrite := git("commit-tree", tree, "-p", root, "-m", "rewritten on GitHub")
	graft := git("commit-tree", tree, "-p", main, "-m", "replacement")
	git("update-ref", "refs/replace/"+rewrite, graft)
	command := func(ctx context.Context, args ...string) *exec.Cmd { return exec.CommandContext(ctx, "git", args...) }

	plain := exec.Command("git", "--git-dir", dir, "merge-base", "--is-ancestor", main, rewrite)
	require.NoError(t, plain.Run(), "the fixture's replacement makes plain git see a fast-forward")
	actual, err := IsAncestor(t.Context(), dir, main, rewrite, command)
	require.NoError(t, err)
	require.False(t, actual, "the helper followed the replacement")
	actual, err = IsAncestor(t.Context(), dir, root, rewrite, command)
	require.NoError(t, err)
	require.True(t, actual)
}
