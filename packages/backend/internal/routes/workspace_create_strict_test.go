package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// #2939: the create route stores name, snapshot, bookmark, kind, environment and
// client lease and resources. Every other setting the CLI can send is refused before any
// provisioning instead of being silently discarded.
func TestCreateWorkspaceRefusesSettingsItDoesNotStore(t *testing.T) {
	for _, tc := range []struct {
		body  string
		field string
	}{
		{`{"name":"dev","resources":{"cpus":4,"memory_mb":8192,"disk_mb":32768}}`, `"cpus"`},
		{`{"name":"dev","image":"docker.io/library/python:3.13-slim"}`, `"image"`},
		{`{"name":"dev","network":{"mode":"allowlist","allow":["github.com"]}}`, `"network"`},
		{`{"name":"dev","idle_timeout_seconds":1800}`, `"idle_timeout_seconds"`},
		{`{"name":"dev","services":[{"name":"web","mode":"service","exec":["/bin/sh","-lc","npm start"]}]}`, `"services"`},
	} {
		t.Run(tc.field, func(t *testing.T) {
			called := false
			h := &WorkspaceHandler{Service: &mockWorkspaceRouteService{
				createWorkspaceFn: func(context.Context, services.CreateWorkspaceInput) (services.WorkspaceResponse, error) {
					called = true
					return services.WorkspaceResponse{ID: "ws-1"}, nil
				},
			}}
			rec := createWorkspaceRoute(h, tc.body)
			require.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
			require.Contains(t, rec.Body.String(), "unknown field")
			require.Contains(t, rec.Body.String(), strings.Trim(tc.field, `"`))
			require.False(t, called, "an unsupported setting must never reach provisioning")
		})
	}
}

func TestCreateWorkspaceAcceptsTheStoredContract(t *testing.T) {
	var got services.CreateWorkspaceInput
	h := &WorkspaceHandler{Service: &mockWorkspaceRouteService{
		createWorkspaceFn: func(_ context.Context, input services.CreateWorkspaceInput) (services.WorkspaceResponse, error) {
			got = input
			return services.WorkspaceResponse{ID: "ws-1"}, nil
		},
	}}
	rec := createWorkspaceRoute(h, `{"name":"issue-2924","snapshot_id":"snap-1","source_bookmark":"main","kind":"vm","client_lease_seconds":300,"resources":{"vcpu":4,"memory_mib":8192,"disk_gib":40}}`)
	require.Less(t, rec.Code, 300, rec.Body.String())
	require.Equal(t, "issue-2924", got.Name)
	require.Equal(t, "snap-1", got.SnapshotID)
	require.Equal(t, "main", got.SourceBookmark)
	require.Equal(t, "vm", got.Kind)
	require.Equal(t, int32(300), got.ClientLeaseSeconds)
	require.Equal(t, int32(4), *got.Resources.CPUs)
	require.Equal(t, int32(8192), *got.Resources.MemoryMB)
	require.Equal(t, int32(40), *got.Resources.DiskGiB)

	for _, body := range []string{`{"name":"dev"}{"name":"other"}`, `{"name":`, `[]`} {
		rec := createWorkspaceRoute(h, body)
		require.Equal(t, http.StatusBadRequest, rec.Code, body)
	}
}

func createWorkspaceRoute(h *WorkspaceHandler, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workspaces", strings.NewReader(body))
	req = withWorkspaceRepoCtx(req, "alice", "demo")
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.CreateWorkspace(rec, req)
	return rec
}
