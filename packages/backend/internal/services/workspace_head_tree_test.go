package services

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// In a machine the workspace is root-owned and the command runs as another
// user. GIT_TEST_ASSUME_DIFFERENT_OWNER makes git see that split here.
func TestCandidateTreeCommandReadsADifferentOwnersWorkspace(t *testing.T) {
	gitPath, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git not installed")
	}
	root, err := filepath.EvalSymlinks(t.TempDir())
	require.NoError(t, err)
	run := func(env map[string]string, args ...string) (string, error) {
		cmd := exec.Command(gitPath, args...)
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "GIT_TEST_ASSUME_DIFFERENT_OWNER=1")
		for key, value := range env {
			cmd.Env = append(cmd.Env, key+"="+value)
		}
		out, err := cmd.CombinedOutput()
		return strings.TrimSpace(string(out)), err
	}
	trusted := map[string]string{"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.DevNull}
	_, err = run(trusted, "-c", "safe.directory="+root, "init", "-q")
	require.NoError(t, err)
	_, err = run(trusted, "-c", "safe.directory="+root, "-c", "user.email=t@example.test", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "candidate")
	require.NoError(t, err)
	head, err := run(trusted, "-c", "safe.directory="+root, "rev-parse", "HEAD")
	require.NoError(t, err)

	command := candidateTreeCommand(root, head)
	tree, err := run(command.Environment, command.Args[1:]...)
	require.NoError(t, err, tree)
	require.True(t, codingCommitID.MatchString(tree), tree)

	// Without the trust the same read fails the way it did on the real install.
	refused, err := run(command.Environment, "rev-parse", "--verify", head+"^{tree}")
	require.Error(t, err)
	require.Contains(t, refused, "dubious ownership")
	require.Equal(t, os.DevNull, command.Environment["GIT_CONFIG_GLOBAL"])
	require.Equal(t, "1", command.Environment["GIT_NO_REPLACE_OBJECTS"])
}
