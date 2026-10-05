package services

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestGitHubMainPullDoesNotDiscoverBackendCheckout(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	repo := filepath.Join(t.TempDir(), "backend-checkout")
	jj := func(args ...string) string {
		t.Helper()
		cmd := exec.CommandContext(ctx, "jj", args...)
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, "%s", out)
		return strings.TrimSpace(string(out))
	}
	jj("git", "init", "--colocate", repo)
	t.Chdir(repo)
	require.NoError(t, os.WriteFile(filepath.Join(repo, "fixture.txt"), []byte("ref read fixture\n"), 0o600))
	jj("describe", "-m", "ref read fixture")
	jj("bookmark", "create", "main", "-r", "@")
	head := jj("log", "-r", "main", "--no-graph", "-T", "commit_id")
	require.Len(t, head, 40)

	// A backend launched inside a real checkout must not discover that
	// checkout. This uses repository discovery itself, without executing any
	// repository-controlled hook or helper.
	cmd := gitHubMainPullCommand(ctx, "rev-parse", "--show-toplevel")
	require.Equal(t, string(os.PathSeparator), cmd.Dir)
	out, err := cmd.CombinedOutput()
	require.Error(t, err, "unexpected repository discovery: %s", out)
	require.NotContains(t, string(out), repo)

	// Explicit repository paths still work, as required by scratch transfers
	// and ref reads. Their behavior cannot depend on the backend's cwd.
	gitDir := filepath.Join(repo, ".git")
	cmd = gitHubMainPullCommand(ctx, "--git-dir", gitDir, "rev-parse", "refs/heads/main")
	out, err = cmd.CombinedOutput()
	require.NoError(t, err, "%s", out)
	require.Equal(t, head, strings.TrimSpace(string(out)))
	actual, err := defaultLsRemoteRef(ctx, gitDir, "refs/heads/main")
	require.NoError(t, err)
	require.Equal(t, head, actual)
}
