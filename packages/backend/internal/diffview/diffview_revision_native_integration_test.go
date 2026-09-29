//go:build cgo

package diffview

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
)

type nativeRevisionClient struct {
	ffi   *repohostffi.Client
	store string
}

func (c nativeRevisionClient) GetRevisionDiff(_ context.Context, _, _, _, from, to, path string) (repohost.ChangeDiff, error) {
	return c.ffi.GetRevisionDiff(c.store, from, to, path)
}

// Exercise the native immutable interdiff through the product patch builder.
func TestRevisionDiffIgnoreWhitespaceNativeMixedEdits(t *testing.T) {
	library := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	if library == "" {
		t.Skip("set SMITHERS_FFI_LIBRARY_PATH to a built libsmithers_ffi")
	}
	if _, err := exec.LookPath("jj"); err != nil {
		t.Skip("jj is not installed")
	}
	root := filepath.Join(t.TempDir(), "repo")
	run := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("jj", append([]string{
			"--config", "user.name=Revision Test",
			"--config", "user.email=revision@example.invalid",
			"-R", root,
		}, args...)...)
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, "jj %v: %s", args, out)
		return strings.TrimSpace(string(out))
	}
	out, err := exec.Command("jj", "git", "init", "--no-colocate", root).CombinedOutput()
	require.NoError(t, err, "jj init: %s", out)
	file := filepath.Join(root, "main.go")
	require.NoError(t, os.WriteFile(file, []byte("func a() {\n    x := 1\n    y := 2\n    z := 3\n}\n"), 0o644))
	run("describe", "-m", "revision")
	from := run("log", "-r", "@", "--no-graph", "-T", "commit_id")
	require.NoError(t, os.WriteFile(file, []byte("func a() {\n\tx := 1\n\ty := 20\n\tz := 3\n}\n"), 0o644))
	to := run("log", "-r", "@", "--no-graph", "-T", "commit_id")
	require.NotEqual(t, from, to)
	ffi := repohostffi.New(library)
	require.NoError(t, ffi.Load())
	client := nativeRevisionClient{ffi: ffi, store: root}
	ordinary, err := BuildRevisionDiff(context.Background(), client, "alice", "demo", "change", from, to, "", BuildOptions{})
	require.NoError(t, err)
	require.Len(t, ordinary.FileDiffs, 1)
	assert.Equal(t, 3, ordinary.FileDiffs[0].Additions)
	assert.Equal(t, 3, ordinary.FileDiffs[0].Deletions)
	ignored, err := BuildRevisionDiff(context.Background(), client, "alice", "demo", "change", from, to, "", BuildOptions{IgnoreWhitespace: true})
	require.NoError(t, err)
	require.Len(t, ignored.FileDiffs, 1)
	assert.Equal(t, 1, ignored.FileDiffs[0].Additions)
	assert.Equal(t, 1, ignored.FileDiffs[0].Deletions)
	assert.NotContains(t, ignored.FileDiffs[0].Patch, "-    x := 1")
	assert.NotContains(t, ignored.FileDiffs[0].Patch, "-    z := 3")
	assert.Contains(t, ignored.FileDiffs[0].Patch, "-    y := 2")
	assert.Contains(t, ignored.FileDiffs[0].Patch, "+\ty := 20")
}
