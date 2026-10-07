//go:build darwin

package hostbackup

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestAPFSClonerPreservesSnapshotWithoutCopyFallback(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	require.NoError(t, os.Mkdir(source, 0700))
	require.NoError(t, os.WriteFile(filepath.Join(source, "secret"), []byte("snapshot bytes"), 0600))
	target := filepath.Join(root, "target")
	require.NoError(t, (APFSCloner{}).Clone(source, target))
	body, err := os.ReadFile(filepath.Join(target, "secret"))
	require.NoError(t, err)
	require.Equal(t, []byte("snapshot bytes"), body)
	info, err := os.Stat(filepath.Join(target, "secret"))
	require.NoError(t, err)
	require.Equal(t, os.FileMode(0600), info.Mode().Perm())
	require.NoError(t, os.WriteFile(filepath.Join(source, "secret"), []byte("later bytes"), 0600))
	body, err = os.ReadFile(filepath.Join(target, "secret"))
	require.NoError(t, err)
	require.Equal(t, []byte("snapshot bytes"), body)
	require.ErrorContains(t, (APFSCloner{}).Clone(source, target), "extra_file")
}
