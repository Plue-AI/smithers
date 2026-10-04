package services

import (
	"github.com/smithersai/smithers/packages/backend/internal/gitutil"
	"github.com/stretchr/testify/require"
	"path/filepath"
	"testing"
)

func TestGitHubAncestryCallersAgreeOnRealGraph(t *testing.T) {
	root := t.TempDir()
	f := &gitFixture{t: t, root: root, work: filepath.Join(root, "work")}
	f.git(root, "init", "-q", "--initial-branch=main", f.work)
	old := f.commit("old", "old.txt", "old")
	tip := f.commit("tip", "tip.txt", "tip")
	f.git(f.work, "checkout", "-q", "-b", "side", old)
	side := f.commit("side", "side.txt", "side")
	dir := f.bare("graph.git")
	f.git(f.work, "push", "-q", dir, tip+":refs/heads/main", side+":refs/heads/side")
	for _, tc := range []struct {
		old, new string
		want     bool
	}{{old, tip, true}, {tip, old, false}, {tip, tip, true}, {side, tip, false}} {
		actual, err := (cliGitHubMainPullGit{}).IsAncestor(t.Context(), dir, tc.old, tc.new)
		require.NoError(t, err)
		require.Equal(t, tc.want, actual)
		actual, err = (mythicalGit{dir: dir}).isAncestor(t.Context(), tc.old, tc.new)
		require.NoError(t, err)
		require.Equal(t, tc.want, actual)
		actual, err = gitutil.IsAncestor(t.Context(), dir, tc.old, tc.new, gitHubMainPullCommand)
		require.NoError(t, err)
		require.Equal(t, tc.want, actual)
	}
	for _, run := range []func() (bool, error){
		func() (bool, error) { return (cliGitHubMainPullGit{}).IsAncestor(t.Context(), dir, "missing", tip) },
		func() (bool, error) { return (mythicalGit{dir: dir}).isAncestor(t.Context(), "missing", tip) },
	} {
		actual, err := run()
		require.Error(t, err)
		require.False(t, actual)
	}
}
