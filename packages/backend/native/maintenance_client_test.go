package native

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/assert"
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

func TestMaintenanceDatabaseClient(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("installing user required")
	}
	for _, tc := range []struct {
		name, body, content, refusal string
		status                       int
		size                         bool
		abort                        bool
	}{
		{name: "size", body: `{"bytes":1048576}`, status: 200, size: true},
		{name: "missing size", body: `{}`, status: 200, size: true, refusal: "invalid database size response"},
		{name: "invalid size", body: `{"bytes":-1}`, status: 200, size: true, refusal: "invalid database size response"},
		{name: "size unavailable", body: `{"message":"owned postgres maintenance unavailable"}`, status: 503, size: true, refusal: "owned postgres maintenance unavailable"},
		{name: "dump", body: "PGDMP-observed-bytes", content: "application/octet-stream", status: 200},
		{name: "escaped operation", body: "PGDMP-observed-bytes", content: "application/octet-stream", status: 200},
		{name: "empty dump", content: "application/octet-stream", status: 200, refusal: "invalid database dump: EOF"},
		{name: "invalid magic", body: "WRONG", content: "application/octet-stream", status: 200, refusal: "invalid database dump format"},
		{name: "wrong format", body: `{}`, content: "application/json", status: 200, refusal: "invalid dump response"},
		{name: "dump refused", body: `{"message":"ready owner quiesce lease required"}`, status: 503, refusal: "ready owner quiesce lease required"},
		{name: "aborted dump", body: "PGDMP-partial", content: "application/octet-stream", status: 200, abort: true, refusal: "unexpected EOF"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			state := t.TempDir()
			require.NoError(t, os.Chmod(state, 0700))
			op := "backup-export"
			if tc.name == "escaped operation" {
				op = "backup/&?= export"
			}
			closeSocket, err := services.StartInstallSetupHandoff(t.Context(), state, func(context.Context, io.Writer) error { return nil }, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if tc.size {
					assert.Equal(t, "GET", r.Method)
					assert.Equal(t, "/maintenance/database/size", r.URL.Path)
				} else {
					assert.Equal(t, "POST", r.Method)
					assert.Equal(t, "/maintenance/database/dump", r.URL.Path)
					assert.Equal(t, op, r.URL.Query().Get("op"))
				}
				if tc.content != "" {
					w.Header().Set("Content-Type", tc.content)
				}
				w.WriteHeader(tc.status)
				_, writeErr := io.WriteString(w, tc.body)
				assert.NoError(t, writeErr)
				if tc.abort {
					assert.NoError(t, http.NewResponseController(w).Flush())
					panic(http.ErrAbortHandler)
				}
			}))
			require.NoError(t, err)
			defer closeSocket()
			output := &bytes.Buffer{}
			if tc.size {
				var size uint64
				size, err = MaintenanceDatabaseSize(t.Context(), state)
				if tc.refusal == "" {
					require.Equal(t, uint64(1048576), size)
				}
			} else {
				err = MaintenanceDump(t.Context(), state, op, output)
			}
			if tc.refusal == "" {
				require.NoError(t, err)
				if !tc.size {
					require.Equal(t, "PGDMP-observed-bytes", output.String())
				}
			} else {
				require.ErrorContains(t, err, tc.refusal)
			}
			require.NoFileExists(t, filepath.Join(state, ".upgrade-incomplete"))
		})
	}
	_, pathErr := MaintenanceDatabaseSize(t.Context(), "relative")
	require.ErrorContains(t, pathErr, "absolute install state directory required")
	var output bytes.Buffer
	require.ErrorContains(t, MaintenanceDump(t.Context(), "/missing", "", &output), "operation and destination required")
	require.ErrorContains(t, MaintenanceDump(t.Context(), "/missing", "backup", nil), "operation and destination required")
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	state := t.TempDir()
	require.NoError(t, os.Chmod(state, 0700))
	closeSocket, err := services.StartInstallSetupHandoff(t.Context(), state, func(context.Context, io.Writer) error { return nil }, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("cancelled request reached server") }))
	require.NoError(t, err)
	defer closeSocket()
	require.ErrorIs(t, MaintenanceDump(ctx, state, "backup", &output), context.Canceled)
	require.ErrorIs(t, ctx.Err(), context.Canceled)
}
