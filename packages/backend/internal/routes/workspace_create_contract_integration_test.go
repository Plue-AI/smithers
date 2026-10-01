//go:build integration
// +build integration

package routes

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// sizingSandbox records the VM boundary; actual SDK sizing is covered in
// the deployment worker suite and live guest qualification. PostgreSQL and
// HTTP are real here, so this suite independently checks persisted admission.
type sizingSandbox struct {
	workspaceQuotaIntegrationSandbox
	mu      sync.Mutex
	creates []sandbox.CreateRequest
	forks   []sandbox.ForkRequest
}

func (s *sizingSandbox) CreateSandbox(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
	s.mu.Lock()
	s.creates = append(s.creates, req)
	s.mu.Unlock()
	return s.workspaceQuotaIntegrationSandbox.CreateSandbox(ctx, req)
}

func (s *sizingSandbox) ForkSandbox(ctx context.Context, source string, req sandbox.ForkRequest) (sandbox.CreateResult, error) {
	s.mu.Lock()
	s.forks = append(s.forks, req)
	s.mu.Unlock()
	return s.workspaceQuotaIntegrationSandbox.ForkSandbox(ctx, source, req)
}

// WriteFile and Execute complete the guest artifact bootstrap every product
// guest runs after boot.
func (s *sizingSandbox) WriteFile(context.Context, string, string, sandbox.WriteFileRequest) error {
	return nil
}

func (s *sizingSandbox) Execute(_ context.Context, _ string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
	ok, stdout := int32(0), "done"
	if strings.Contains(req.Command, "owner=$(cat") {
		stdout = "legacy\n"
	}
	return sandbox.ExecResult{StatusCode: &ok, Stdout: stdout}, nil
}

func (s *sizingSandbox) requests() ([]sandbox.CreateRequest, []sandbox.ForkRequest) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]sandbox.CreateRequest(nil), s.creates...), append([]sandbox.ForkRequest(nil), s.forks...)
}

// POST /workspaces is one contract (#2939): the requested size is persisted,
// reported, booted on create and fork, and every field the server would not
// honor refuses before a row or guest exists.
func TestWorkspaceRoutes_CreateHonorsOrRefusesEveryField(t *testing.T) {
	pool := setupRoutesIntegrationPool(t)
	queries := db.New(pool)
	user := routesIntegrationCreateUser(t, pool, "workspace_sizing_user")
	repo := routesIntegrationCreateRepo(t, pool, user, "workspace_sizing_repo", false)

	provider := &sizingSandbox{}
	service := services.NewWorkspaceService(queries,
		services.WithWorkspaceGitBaseURL("http://smithers.test"),
		services.WithWorkspaceSandboxClient(provider),
		services.WithWorkspaceResourceLimits(16, 32768, 65536),
	)
	handler := &WorkspaceHandler{Service: service}
	router := chi.NewRouter()
	router.Use(middleware.AuthLoader(queries, config.AuthConfig{}))
	router.Route("/api/repos/{owner}/{repo}", func(r chi.Router) {
		r.Use(middleware.LoadRepoContext(queries))
		r.Use(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteRepository), middleware.RequireRepoPermission(middleware.PermissionWrite))
		r.Post("/workspaces", handler.CreateWorkspace)
		r.Get("/workspaces/{id}", handler.GetWorkspace)
		r.Post("/workspaces/{id}/fork", handler.ForkWorkspace)
	})
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	client := routesIntegrationAuthenticatedClient(t, server, routesIntegrationCreateSessionCookie(t, queries, user))
	path := fmt.Sprintf("/api/repos/%s/%s/workspaces", repo.Owner, repo.Name)

	created := requireAcceptedWorkspaceCreate(t, client, server.URL, repo, path,
		`{"name":"sized","resources":{"vcpu":4,"memory_mib":8192,"disk_gib":40}}`)
	want := services.WorkspaceResources{CPUs: int32Ptr(4), MemoryMB: int32Ptr(8192), DiskGiB: int32Ptr(40)}
	assert.Equal(t, want, created.Resources)

	reuseResponse := routesIntegrationDoRequest(t, client, server.URL, http.MethodPost, path, []byte(`{"name":"sized","resources":{"vcpu":4,"memory_mib":8192,"disk_gib":40}}`))
	require.Equal(t, http.StatusAccepted, reuseResponse.StatusCode)
	var reused services.WorkspaceResponse
	routesIntegrationDecodeJSON(t, reuseResponse, &reused)
	require.Equal(t, created.ID, reused.ID)
	row := requireWorkspaceProvisioned(t, queries, created.ID)
	assert.Equal(t, pgtype.Int4{Int32: 4, Valid: true}, row.VcpuCount)
	assert.Equal(t, pgtype.Int4{Int32: 8192, Valid: true}, row.MemoryMb)
	assert.Equal(t, pgtype.Int4{Int32: 40960, Valid: true}, row.DiskMb)
	creates, _ := provider.requests()
	require.Len(t, creates, 1)
	assert.Empty(t, creates[0].SnapshotID)
	assert.Equal(t, int32(4), *creates[0].VCPUCount)
	assert.Equal(t, int32(8192), *creates[0].MemSizeMB)
	assert.Equal(t, int64(40960), *creates[0].RootfsSizeMB)

	var viewed services.WorkspaceResponse
	routesIntegrationDecodeJSON(t, routesIntegrationDoRequest(t, client, server.URL, http.MethodGet, path+"/"+created.ID, nil), &viewed)
	assert.Equal(t, want, viewed.Resources)

	resp := routesIntegrationDoRequest(t, client, server.URL, http.MethodPost, path+"/"+created.ID+"/fork", []byte(`{"name":"sized-fork"}`))
	require.Equal(t, http.StatusCreated, resp.StatusCode)
	var fork services.WorkspaceResponse
	routesIntegrationDecodeJSON(t, resp, &fork)
	assert.Equal(t, want, fork.Resources, "a fork keeps its source's size")
	_, forks := provider.requests()
	require.Len(t, forks, 1)
	assert.Equal(t, int32(4), *forks[0].VCPUCount)
	assert.Equal(t, int32(8192), *forks[0].MemSizeMB)

	snapshot, err := service.CreateWorkspaceSnapshot(context.Background(), services.CreateWorkspaceSnapshotInput{WorkspaceID: created.ID, RepositoryID: repo.ID, UserID: user.ID, Name: "sized-recovery"})
	require.NoError(t, err)
	// A retained snapshot recovers the persisted shape.
	restored := requireAcceptedWorkspaceCreate(t, client, server.URL, repo, path, fmt.Sprintf(`{"name":"restored","snapshot_id":%q}`, snapshot.ID))
	restoredRow := requireWorkspaceProvisioned(t, queries, restored.ID)
	assert.Equal(t, want, restored.Resources)
	assert.Equal(t, row.VcpuCount, restoredRow.VcpuCount)
	assert.Equal(t, row.MemoryMb, restoredRow.MemoryMb)
	assert.Equal(t, row.DiskMb, restoredRow.DiskMb)
	creates, _ = provider.requests()
	require.Len(t, creates, 2)
	assert.Equal(t, int32(4), *creates[1].VCPUCount)
	assert.Equal(t, int32(8192), *creates[1].MemSizeMB)
	assert.Equal(t, int64(40960), *creates[1].RootfsSizeMB)

	before, err := queries.CountActiveWorkspacesByUser(context.Background(), user.ID)
	require.NoError(t, err)
	for _, tc := range []struct {
		body    string
		status  int
		message string
	}{
		{`{"name":"image","image":"docker.io/library/python:3.13-slim"}`, http.StatusBadRequest, `unknown field "image"`},
		{`{"name":"net","network":{"mode":"none"}}`, http.StatusBadRequest, `unknown field "network"`},
		{`{"name":"idle","idle_timeout_seconds":0}`, http.StatusBadRequest, `unknown field "idle_timeout_seconds"`},
		{`{"name":"gpu","resources":{"gpus":1}}`, http.StatusBadRequest, `unknown field "gpus"`},
		{`{"name":"half","resources":{"vcpu":1.5}}`, http.StatusBadRequest, "invalid request body"},
		{`{"name":"big","resources":{"vcpu":17}}`, http.StatusBadRequest, "resources.vcpu must be between 1 and 16"},
		{`{"name":"zero","resources":{"memory_mib":0}}`, http.StatusBadRequest, "resources.memory_mib must be between 512 and 32768"},
		{`{"name":"desk","kind":"desktop","resources":{"vcpu":2}}`, http.StatusBadRequest, "resources apply to container and vm workspaces"},
		{`{"name":"sized","resources":{"vcpu":2}}`, http.StatusConflict, "exists with different resources"},
	} {
		resp := routesIntegrationDoRequest(t, client, server.URL, http.MethodPost, path, []byte(tc.body))
		assert.Equal(t, tc.status, resp.StatusCode, tc.body)
		var refusal struct {
			Message string
			Code    string
		}
		routesIntegrationDecodeJSON(t, resp, &refusal)
		assert.Contains(t, refusal.Message, tc.message, tc.body)
		if strings.Contains(tc.body, `"name":"big"`) {
			assert.Equal(t, "workspace_resources_exceeded", refusal.Code)
		}
	}
	after, err := queries.CountActiveWorkspacesByUser(context.Background(), user.ID)
	require.NoError(t, err)
	assert.Equal(t, before, after, "a refused create never inserts a workspace")
	creates, forks = provider.requests()
	assert.Len(t, creates, 2, "a refused create never boots a guest")
	assert.Len(t, forks, 1)
	_, err = pool.Exec(context.Background(), "UPDATE workspaces SET deleted_at = now() WHERE id = $1", created.ID)
	require.NoError(t, err)
	recovered := requireAcceptedWorkspaceCreate(t, client, server.URL, repo, path, fmt.Sprintf(`{"name":"after-delete","snapshot_id":%q}`, snapshot.ID))
	recoveredRow := requireWorkspaceProvisioned(t, queries, recovered.ID)
	assert.Equal(t, want, recovered.Resources)
	assert.Equal(t, row.VcpuCount, recoveredRow.VcpuCount)
	assert.Equal(t, row.MemoryMb, recoveredRow.MemoryMb)
	assert.Equal(t, row.DiskMb, recoveredRow.DiskMb)
	require.NoError(t, service.WaitForProvisioning(context.Background()))
}

func int32Ptr(v int32) *int32 { return &v }
