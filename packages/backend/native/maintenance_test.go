package native

import (
	"context"
	"fmt"
	"github.com/smithersai/smithers/packages/backend/db/product"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"
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

// Actual command dispatch reaches the installing-owner contract before any
// freeze, database startup, file staging or Homebrew execution.
func TestMaintenanceDispatchCoordinatorsRefuseMissingProviders(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("installing user required")
	}
	// The owner socket is HOME/Library/Application Support/Smithers/run/host.sock,
	// 51 bytes below HOME, and Darwin allows a socket path 104. The default
	// temporary directory alone is 49 bytes there, so HOME takes a short one.
	home, err := os.MkdirTemp("/tmp", "ins07-")
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, os.RemoveAll(home)) })
	t.Setenv("HOME", home)
	state := filepath.Join(home, "Library/Application Support/Smithers")
	require.NoError(t, os.MkdirAll(state, 0700))
	sentinel := filepath.Join(state, "sentinel")
	require.NoError(t, os.WriteFile(sentinel, []byte("unchanged-live-state"), 0640))
	var checks atomic.Int32
	closeSocket, err := services.StartInstallSetupHandoff(t.Context(), state, func(context.Context, io.Writer) error { return nil }, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.Path != "/maintenance/backup/check" {
			t.Errorf("unexpected authority operation %s %s", r.Method, r.URL.Path)
		}
		checks.Add(1)
		w.WriteHeader(503)
		io.WriteString(w, `{"message":"quiesce unavailable: T-MCH-07 required"}`)
	}))
	require.NoError(t, err)
	defer closeSocket()
	old := compose.BuildVersion
	compose.BuildVersion = "1.2.3"
	defer func() { compose.BuildVersion = old }()
	for _, tc := range []struct {
		args    []string
		refusal string
	}{
		{[]string{"host-maintenance", "backup"}, "host_maintenance_unavailable: quiesce unavailable: T-MCH-07 required"},
		{[]string{"host-maintenance", "upgrade"}, "host_maintenance_unavailable: upgrade lifecycle and bundle required"},
		{[]string{"host-maintenance", "restore", jsonBackup(t)}, "host_maintenance_unavailable: restore providers required"},
	} {
		handled, err := DispatchMaintenance(t.Context(), tc.args)
		require.True(t, handled)
		require.EqualError(t, err, tc.refusal)
		bytes, err := os.ReadFile(sentinel)
		require.NoError(t, err)
		require.Equal(t, "unchanged-live-state", string(bytes))
		info, err := os.Stat(sentinel)
		require.NoError(t, err)
		require.Equal(t, os.FileMode(0640), info.Mode().Perm())
		require.NoDirExists(t, filepath.Join(state, "backups"))
		require.NoDirExists(t, filepath.Join(state, "postgres"))
		require.NoFileExists(t, filepath.Join(state, ".upgrade-incomplete"))
	}
	require.Equal(t, int32(1), checks.Load())
	// A ready owner contract on this Linux host still cannot acquire a freeze.
	// This exercises the actual dispatcher, without an APFS copying fallback.
	if runtime.GOOS != "darwin" {
		require.NoError(t, closeSocket())
		head, err := product.HeadVersion()
		require.NoError(t, err)
		require.NoError(t, WriteVersion(state, Version{Version: "1.2.3", Schema: fmt.Sprint(head), Postgres: "18"}))
		closeReady, err := services.StartInstallSetupHandoff(t.Context(), state, func(context.Context, io.Writer) error { return nil }, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/maintenance/backup/check" || r.Method != "GET" {
				t.Errorf("non-APFS dispatcher reached %s %s", r.Method, r.URL.Path)
			}
			w.WriteHeader(204)
		}))
		require.NoError(t, err)
		defer closeReady()
		handled, err := DispatchMaintenance(t.Context(), []string{"host-maintenance", "backup"})
		require.True(t, handled)
		require.EqualError(t, err, "clone_unavailable: APFS volume required")
		require.NoDirExists(t, filepath.Join(state, "backups"))
		require.NoFileExists(t, filepath.Join(state, ".upgrade-incomplete"))
	}

}
