package native

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/hostbackup"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Protocol fixtures do not qualify the missing machine/runtime integrations.
func TestMaintenanceAuthorityOwnerProtocol(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("installing user required")
	}
	state := t.TempDir()
	require.NoError(t, os.Chmod(state, 0700))
	require.NoError(t, WriteVersion(state, Version{Version: "1.2.3", Schema: "1", Postgres: "18"}))
	since := time.Date(2026, 10, 7, 1, 2, 3, 0, time.UTC)
	closeSocket, err := services.StartInstallSetupHandoff(t.Context(), state, func(context.Context, io.Writer) error { return nil }, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/maintenance/backup/check":
			assert.Equal(t, "GET", r.Method)
			w.WriteHeader(204)
		case "/maintenance/database/size":
			assert.Equal(t, "GET", r.Method)
			io.WriteString(w, `{"bytes":1048576}`)
		case "/maintenance/quiesce":
			if r.Method == "DELETE" {
				assert.Equal(t, "backup /?&", r.URL.Query().Get("op"))
				w.WriteHeader(204)
				return
			}
			assert.Equal(t, "POST", r.Method)
			var body struct {
				Op string `json:"op"`
			}
			assert.NoError(t, json.NewDecoder(r.Body).Decode(&body))
			json.NewEncoder(w).Encode(struct {
				Op    string    `json:"op"`
				Since time.Time `json:"since"`
				Ready bool      `json:"ready"`
			}{body.Op, since, body.Op != "draining"})
		case "/maintenance/database/dump":
			assert.Equal(t, "POST", r.Method)
			assert.Equal(t, "backup /?&", r.URL.Query().Get("op"))
			w.Header().Set("Content-Type", "application/octet-stream")
			io.WriteString(w, "PGDMP-observed")
		case "/maintenance/summary":
			assert.Equal(t, "GET", r.Method)
			assert.Equal(t, "backup /?&", r.URL.Query().Get("op"))
			io.WriteString(w, `{"stack":[{"number":7,"state":"queued","place":2}],"branch_heads":{},"machine_disks":{},"run_journals":{}}`)
		default:
			t.Errorf("unexpected owner path %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	require.NoError(t, err)
	defer closeSocket()
	a := &maintenanceAuthority{state: state, version: hostbackup.Version{Release: "1.2.3", Schema: 1, PostgresMajor: 18}, checkVolume: func(string) error { return nil }}
	require.NoError(t, a.Check(t.Context()))
	size, err := a.DatabaseSize(t.Context())
	require.NoError(t, err)
	require.Equal(t, uint64(1048576), size)
	require.NoError(t, a.Renew(t.Context(), "draining"))
	_, err = a.Freeze(t.Context(), "draining")
	require.ErrorContains(t, err, "owner quiesce drain incomplete")
	at, err := a.Freeze(t.Context(), "backup /?&")
	require.NoError(t, err)
	require.Equal(t, since, at)
	var dump bytes.Buffer
	require.NoError(t, a.Dump(t.Context(), &dump))
	require.Equal(t, "PGDMP-observed", dump.String())
	summary, err := a.Summary(t.Context())
	require.NoError(t, err)
	require.JSONEq(t, `[{"number":7,"state":"queued","place":2}]`, string(summary.Stack))
	require.NoError(t, a.Reopen(t.Context(), "backup /?&"))
	a.version.Release = "1.2.4"
	require.EqualError(t, a.Check(t.Context()), "wrong_version: maintenance binary must match the running install")
	require.NoError(t, os.Remove(filepath.Join(state, "version.env")))
	require.ErrorContains(t, a.Check(t.Context()), "host_maintenance_unavailable: install version:")
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	require.ErrorIs(t, a.Renew(ctx, "backup /?&"), context.Canceled)
}
