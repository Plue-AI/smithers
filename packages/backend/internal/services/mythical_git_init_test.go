package services

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

// A process killed inside `git init` leaves the scratch repository without
// HEAD but with HEAD.lock. The scratch repository is a cache rebuilt from the
// remote on every run, so init replaces the incomplete directory instead of
// failing every later stack run until someone deletes it.
func TestMythicalScratchInitReplacesAnInterruptedInit(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "repo-1.git")
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "refs", "heads"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "HEAD.lock"), nil, 0o644))
	g := mythicalGit{dir: dir}
	require.NoError(t, g.init(context.Background()))
	_, err := g.git(context.Background(), "rev-parse", "--git-dir")
	require.NoError(t, err)
	require.NoFileExists(t, filepath.Join(dir, "HEAD.lock"))

	// A valid repository is kept as it is.
	marker := filepath.Join(dir, "kept")
	require.NoError(t, os.WriteFile(marker, nil, 0o644))
	require.NoError(t, g.init(context.Background()))
	require.FileExists(t, marker)
}
