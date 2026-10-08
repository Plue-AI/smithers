package native

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/stretchr/testify/require"
)

func TestStartRefusalDiskBoundary(t *testing.T) {
	for _, free := range []int64{(44 << 30) - 1, 44 << 30, (44 << 30) + 1} {
		root := t.TempDir()
		err := microsandbox.ComputeSizing(microsandbox.HostProfile{MemoryBytes: 32 << 30, PerfCores: 8, DiskFreeBytes: free}).ValidateStart(false)
		got := recordStartRefusal(root, errors.Join(err, nil))
		data, readErr := os.ReadFile(filepath.Join(root, "start-refusal.json"))
		if free >= 44<<30 {
			require.NoError(t, got)
			require.ErrorIs(t, readErr, os.ErrNotExist)
			continue
		}
		require.Error(t, got)
		require.NoError(t, readErr)
		var refusal microsandbox.CapacityError
		require.NoError(t, json.Unmarshal(data, &refusal))
		require.Equal(t, "host_capacity_zero", refusal.Code)
		require.Equal(t, "cannot start a fresh install: disk: 44.00 GiB free on the state volume; 44 GiB required", refusal.Message)
		info, err := os.Stat(filepath.Join(root, "start-refusal.json"))
		require.NoError(t, err)
		require.Equal(t, os.FileMode(0600), info.Mode().Perm())
	}
	root := t.TempDir()
	err := errors.New("unrelated crash")
	require.ErrorIs(t, recordStartRefusal(root, err), err)
	_, readErr := os.Stat(filepath.Join(root, "start-refusal.json"))
	require.ErrorIs(t, readErr, os.ErrNotExist)
}
