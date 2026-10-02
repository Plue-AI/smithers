package compose

import (
	"io/fs"

	"os"
	"os/exec"
	"path/filepath"

	"strings"

	"testing"

	"github.com/stretchr/testify/require"
)

func pushIdentityGit(t *testing.T, args ...string) string {
	t.Helper()
	command := exec.Command("git", args...)
	command.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	out, err := command.CombinedOutput()
	require.NoError(t, err, "git %v: %s", args, out)
	return strings.TrimSpace(string(out))
}

func pushIdentityOutboxFiles(t *testing.T, storage string) []string {
	t.Helper()
	root := filepath.Join(storage, ".push-hook-outbox@")
	var paths []string
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		if !entry.IsDir() && strings.HasSuffix(path, ".json") {
			paths = append(paths, path)
		}
		return nil
	})
	require.NoError(t, err)
	return paths
}
