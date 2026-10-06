package microsandbox

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestFirstRunCapacityChecksAccountVolume(t *testing.T) {
	home := t.TempDir()
	runtime := &Runtime{cli: &cli{home: home}}
	free, err := runtime.freeBytes()
	require.NoError(t, err)
	require.Positive(t, free)
	_, err = os.Lstat(filepath.Join(home, ".microsandbox"))
	require.ErrorIs(t, err, os.ErrNotExist, "capacity observation must not create state")
	require.NoError(t, os.Mkdir(filepath.Join(home, ".microsandbox"), 0700))
	free, err = runtime.freeBytes()
	require.NoError(t, err)
	require.Positive(t, free)
}

func TestFirstRunCapacityRefusesBrokenState(t *testing.T) {
	home := t.TempDir()
	require.NoError(t, os.Symlink(filepath.Join(home, "missing"), filepath.Join(home, ".microsandbox")))
	runtime := &Runtime{cli: &cli{home: home}}
	free, err := runtime.freeBytes()
	require.ErrorIs(t, err, os.ErrNotExist)
	require.Zero(t, free, "a broken existing state path cannot select the parent volume")
	runtime.cli.home = filepath.Join(home, "missing-home")
	free, err = runtime.freeBytes()
	require.ErrorIs(t, err, os.ErrNotExist)
	require.Zero(t, free)
	file := filepath.Join(home, "not-a-home")
	require.NoError(t, os.WriteFile(file, []byte("not a directory"), 0600))
	runtime.cli.home = file
	free, err = runtime.freeBytes()
	require.ErrorIs(t, err, syscall.ENOTDIR)
	require.Zero(t, free)
}
