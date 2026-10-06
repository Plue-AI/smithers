package native

import (
	"context"
	"os"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/compose"
	"github.com/stretchr/testify/require"
)

func TestMaintenanceDispatchReleaseGuards(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("maintenance refuses root")
	}
	old := compose.BuildVersion
	t.Cleanup(func() { compose.BuildVersion = old })
	for _, row := range []struct{ release, refusal string }{
		{"1.2.2", "older_version:"}, {"1.2.3", "host_maintenance_unavailable:"},
		{"1.3.0", "host_maintenance_unavailable:"}, {"dev", "host_maintenance_unavailable:"},
	} {
		t.Run(row.release, func(t *testing.T) {
			compose.BuildVersion = row.release
			backup := jsonBackup(t)
			handled, err := DispatchMaintenance(t.Context(), []string{"host-maintenance", "restore", backup})
			require.True(t, handled)
			require.ErrorContains(t, err, row.refusal)
		})
	}
}

func TestMaintenanceDispatchSyntaxAndCancellation(t *testing.T) {
	handled, err := DispatchMaintenance(t.Context(), []string{"microvm", "doctor"})
	require.False(t, handled)
	require.NoError(t, err)
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	handled, err = DispatchMaintenance(cancelled, []string{"host-maintenance", "upgrade"})
	require.True(t, handled)
	require.ErrorIs(t, err, context.Canceled)
	if os.Geteuid() == 0 {
		return
	}
	for _, args := range [][]string{
		{"host-maintenance"}, {"host-maintenance", "unknown"},
		{"host-maintenance", "backup", "extra"}, {"host-maintenance", "upgrade", "extra"},
		{"host-maintenance", "restore"}, {"host-maintenance", "restore", ""},
	} {
		handled, err := DispatchMaintenance(t.Context(), args)
		require.True(t, handled)
		require.Error(t, err)
	}
}
