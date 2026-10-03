//go:build darwin

package microsandbox

import (
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestDetectRealStateVolume(t *testing.T) {
	root := t.TempDir()
	p, err := Detect(root)
	require.NoError(t, err)
	require.Positive(t, p.MemoryBytes)
	require.Positive(t, p.PerfCores)
	require.GreaterOrEqual(t, p.PhysicalCores, p.PerfCores)
	require.Positive(t, p.DiskFreeBytes)
	require.NotEmpty(t, p.MacOSVersion)
	_, err = Detect(filepath.Join(root, "missing"))
	var typed *HostProfileError
	require.ErrorAs(t, err, &typed)
	require.Equal(t, "disk", typed.Field)
	require.Contains(t, err.Error(), "host profile disk")
}
