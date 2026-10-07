package native

import (
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

func TestMaintenancePreflightPrivateSocket(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("installing user required")
	}
	// Darwin limits Unix socket paths to 104 bytes; t.TempDir includes the
	// full test name. Keep this socket fixture short without moving all tests
	// under an unprotected global TMPDIR.
	state, err := os.MkdirTemp("", "preflight-")
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, os.RemoveAll(state)) })
	require.NoError(t, os.Chmod(state, 0700))
	var method, path string
	closeServer, err := services.StartInstallSetupHandoff(t.Context(), state, func(context.Context, io.Writer) error { return nil }, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		w.WriteHeader(503)
		_, _ = io.WriteString(w, `{"code":"install_quiesced","class":"infra","message":"quiesce unavailable: T-MCH-07 required"}`)
	}))
	require.NoError(t, err)
	defer closeServer()
	require.ErrorContains(t, MaintenancePreflight(t.Context(), state), "host_maintenance_unavailable: quiesce unavailable: T-MCH-07 required")
	require.Equal(t, "GET", method)
	require.Equal(t, "/maintenance/check", path)
	require.NoFileExists(t, filepath.Join(state, ".upgrade-incomplete"))
	require.NoDirExists(t, filepath.Join(state, "backups"))
	require.NoError(t, os.Chmod(filepath.Join(state, "run/host.sock"), 0666))
	require.ErrorContains(t, MaintenancePreflight(t.Context(), state), "host_owner_required:")
	require.NoError(t, os.Chmod(filepath.Join(state, "run/host.sock"), 0600))
	require.NoError(t, os.Chmod(filepath.Join(state, "run"), 0755))
	require.ErrorContains(t, MaintenancePreflight(t.Context(), state), "host_owner_required:")
}

func TestMaintenancePreflightRejectsSocketLinks(t *testing.T) {
	state := t.TempDir()
	require.NoError(t, os.Chmod(state, 0700))
	require.NoError(t, os.Mkdir(filepath.Join(state, "run"), 0700))
	require.NoError(t, os.Symlink("/outside", filepath.Join(state, "run/host.sock")))
	require.ErrorContains(t, MaintenancePreflight(t.Context(), state), "host_owner_required:")
	require.NoError(t, os.Remove(filepath.Join(state, "run/host.sock")))
	require.ErrorContains(t, MaintenancePreflight(t.Context(), state), "host_maintenance_unavailable:")
}
