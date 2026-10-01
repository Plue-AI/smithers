//go:build integration

package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	"github.com/stretchr/testify/require"
)

// Only external compute is controlled: this machine has no usable Linux/Cloud
// VM execution location. The product HTTP authorization, service, provisioning
// goroutine, and isolated PostgreSQL schema are real. A success here proves the
// public recreation contract and recorded provider result, not live VM restore.
type recoveryIntegrationSandbox struct {
	workspaceQuotaIntegrationSandbox
	unavailable bool
	release     chan struct{}
	calls       atomic.Int64
	snapshot    atomic.Value
}

func (s *recoveryIntegrationSandbox) InspectSandbox(ctx context.Context, id string) (sandbox.Sandbox, error) {
	if id == "missing-old-vm" {
		return sandbox.Sandbox{}, &sandbox.StatusError{StatusCode: 404, Code: "not_found"}
	}
	return s.workspaceQuotaIntegrationSandbox.InspectSandbox(ctx, id)
}
func (s *recoveryIntegrationSandbox) CreateSandbox(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
	s.calls.Add(1)
	s.snapshot.Store(req.SnapshotID)
	select {
	case <-s.release:
	case <-ctx.Done():
		return sandbox.CreateResult{}, ctx.Err()
	}
	if s.unavailable && req.SnapshotID != "" {
		return sandbox.CreateResult{}, &sandbox.StatusError{StatusCode: 404, Code: "snapshot_not_found"}
	}
	return s.workspaceQuotaIntegrationSandbox.CreateSandbox(ctx, req)
}
func (s *recoveryIntegrationSandbox) WriteFile(context.Context, string, string, sandbox.WriteFileRequest) error {
	return nil
}
func (s *recoveryIntegrationSandbox) Execute(ctx context.Context, id string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
	result, err := s.workspaceQuotaIntegrationSandbox.Execute(ctx, id, req)
	if strings.Contains(req.Command, "printf done") {
		result.Stdout = "done"
	}
	return result, err
}
func recoveryIntegrationServer(t *testing.T, q *db.Queries, svc *services.WorkspaceService) *httptest.Server {
	r := chi.NewRouter()
	r.Use(middleware.AuthLoader(q, config.AuthConfig{}))
	h := &WorkspaceHandler{Service: svc}
	r.Route("/api/repos/{owner}/{repo}", func(r chi.Router) {
		r.Use(middleware.LoadRepoContext(q))
		write := []func(http.Handler) http.Handler{middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteRepository), middleware.RequireRepoPermission(middleware.PermissionWrite)}
		read := []func(http.Handler) http.Handler{middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadRepository), middleware.RequireRepoPermission(middleware.PermissionRead)}
		r.With(write...).Post("/workspaces", h.CreateWorkspace)
		r.With(write...).Post("/workspaces/{id}/resume", h.ResumeWorkspace)
		r.With(read...).Get("/workspaces/{id}", h.GetWorkspace)
		r.With(read...).Get("/workspaces", h.ListWorkspaces)
	})
	server := httptest.NewServer(r)
	t.Cleanup(server.Close)
	return server
}
func TestWorkspaceRecovery_PublicHTTPRetainsOldIdentityAndCreatesNewRow(t *testing.T) {
	for _, tc := range []struct {
		name        string
		snapshot    bool
		unavailable bool
	}{
		{name: "owned usable snapshot", snapshot: true}, {name: "provider snapshot unavailable", snapshot: true, unavailable: true}, {name: "no snapshot fresh create"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Tiny artifact bytes accompany the external compute double; no guest
			// execution or installed binary qualification is claimed by this test.
			artifact := filepath.Join(t.TempDir(), "external-provider-fixture")
			require.NoError(t, os.WriteFile(artifact, []byte("controlled compute fixture"), 0600))
			for _, key := range []string{"SMITHERS_WORKSPACE_CLI_PACKAGE", "SMITHERS_WORKSPACE_CODING_HOST_BINARY", "SMITHERS_WORKSPACE_JJ_EXPORT_BINARY"} {
				t.Setenv(key, artifact)
			}
			pool := setupRoutesIntegrationPool(t)
			q := db.New(pool)
			ctx := context.Background()
			user := routesIntegrationCreateUser(t, pool, "recovery_owner")
			other := routesIntegrationCreateUser(t, pool, "recovery_other")
			repo := routesIntegrationCreateRepo(t, pool, user, "recovery", false)
			old, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: user.ID, Name: "retained-old", Kind: "container", TargetBookmark: "main", Status: "starting"})
			require.NoError(t, err)
			old, err = q.UpdateWorkspaceExecutionInfo(ctx, db.UpdateWorkspaceExecutionInfoParams{ID: old.ID, VmID: "missing-old-vm", Status: "suspended"})
			require.NoError(t, err)
			var snapshot db.WorkspaceSnapshot
			if tc.snapshot {
				snapshot, err = q.CreateWorkspaceSnapshot(ctx, db.CreateWorkspaceSnapshotParams{RepositoryID: repo.ID, UserID: user.ID, WorkspaceID: old.ID, Name: "saved", SnapshotID: "retained-provider-snapshot"})
				require.NoError(t, err)
				_, err = pool.Exec(ctx, `UPDATE workspaces SET source_snapshot_id=$2 WHERE id=$1`, old.ID, snapshot.ID)
				require.NoError(t, err)
				old, err = q.GetWorkspace(ctx, old.ID)
				require.NoError(t, err)
			}
			provider := &recoveryIntegrationSandbox{unavailable: tc.unavailable, release: make(chan struct{})}
			released := false
			defer func() {
				if !released {
					close(provider.release)
				}
			}()
			svc := services.NewWorkspaceService(q, services.WithWorkspaceGitBaseURL("http://smithers.test"), services.WithWorkspaceSandboxClient(provider))
			server := recoveryIntegrationServer(t, q, svc)
			ownerClient := routesIntegrationAuthenticatedClient(t, server, routesIntegrationCreateSessionCookie(t, q, user))
			otherClient := routesIntegrationAuthenticatedClient(t, server, routesIntegrationCreateSessionCookie(t, q, other))
			path := fmt.Sprintf("/api/repos/%s/%s/workspaces", repo.Owner, repo.Name)
			denied := routesIntegrationDoRequest(t, otherClient, server.URL, http.MethodPost, path+"/"+old.ID+"/resume", nil)
			require.NotEqual(t, http.StatusOK, denied.StatusCode)
			require.NotEqual(t, http.StatusConflict, denied.StatusCode)
			_ = routesIntegrationReadBody(t, denied)
			resp := routesIntegrationDoRequest(t, ownerClient, server.URL, http.MethodPost, path+"/"+old.ID+"/resume", nil)
			require.Equal(t, http.StatusConflict, resp.StatusCode)
			var failure struct {
				Code    pkgerrors.Code                    `json:"code"`
				Details services.WorkspaceRecoveryDetails `json:"details"`
			}
			routesIntegrationDecodeJSON(t, resp, &failure)
			require.Equal(t, pkgerrors.CodeWorkspaceVMMissing, failure.Code)
			require.Equal(t, old.ID, failure.Details.WorkspaceID)
			require.True(t, failure.Details.CreateFresh)
			require.Equal(t, snapshot.ID, failure.Details.SnapshotID)
			// A repository owner cannot use another person's snapshot without a
			// workspace write grant; a snapshot from another repository is not
			// admitted either. Both failures happen before any provider write.
			foreignBox, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: other.ID, Name: "foreign", Kind: "container", Status: "starting"})
			require.NoError(t, err)
			foreignSnapshot, err := q.CreateWorkspaceSnapshot(ctx, db.CreateWorkspaceSnapshotParams{RepositoryID: repo.ID, UserID: other.ID, WorkspaceID: foreignBox.ID, Name: "foreign", SnapshotID: "foreign-disk"})
			require.NoError(t, err)
			foreignRepo := routesIntegrationCreateRepo(t, pool, user, "other_repo", false)
			foreignRepoBox, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: foreignRepo.ID, UserID: user.ID, Name: "other-repo", Kind: "container", Status: "starting"})
			require.NoError(t, err)
			otherRepoSnapshot, err := q.CreateWorkspaceSnapshot(ctx, db.CreateWorkspaceSnapshotParams{RepositoryID: foreignRepo.ID, UserID: user.ID, WorkspaceID: foreignRepoBox.ID, Name: "other-repo", SnapshotID: "other-repo-disk"})
			require.NoError(t, err)
			for _, candidate := range []db.WorkspaceSnapshot{foreignSnapshot, otherRepoSnapshot} {
				denied := routesIntegrationDoRequest(t, ownerClient, server.URL, http.MethodPost, path, []byte(fmt.Sprintf(`{"name":"denied","snapshot_id":%q}`, candidate.ID)))
				require.Contains(t, []int{http.StatusForbidden, http.StatusNotFound}, denied.StatusCode)
				_ = routesIntegrationReadBody(t, denied)
			}
			require.Equal(t, int64(0), provider.calls.Load())
			// Public creation uses a distinct named identity, even for a lost primary.
			body := `{"name":"new-recovery","kind":"container"}`
			if tc.snapshot {
				body = fmt.Sprintf(`{"name":"new-recovery","kind":"container","snapshot_id":%q}`, snapshot.ID)
			}
			created := requireAcceptedWorkspaceCreate(t, ownerClient, server.URL, repo, path, body)
			require.NotEqual(t, old.ID, created.ID)
			newRow, err := q.GetWorkspace(ctx, created.ID)
			require.NoError(t, err)
			require.Equal(t, snapshot.ID, services.UUIDString(newRow.SourceSnapshotID))
			require.Empty(t, newRow.VmID, "launch acknowledgment is not a ready VM")
			close(provider.release)
			released = true
			var settled db.Workspace
			require.Eventually(t, func() bool {
				settled, err = q.GetWorkspace(ctx, created.ID)
				return err == nil && settled.Status != "starting"
			}, 30*time.Second, 20*time.Millisecond)
			if tc.unavailable {
				require.Equal(t, "failed", settled.Status)
				require.Equal(t, string(pkgerrors.CodeSnapshotNotFound), settled.FailureCode.String)
				require.Contains(t, settled.FailureMessage.String, "create")
				require.Empty(t, settled.VmID)
			} else {
				require.Equal(t, "running", settled.Status)
				require.NotEmpty(t, settled.VmID)
			}
			require.Equal(t, int64(1), provider.calls.Load())
			if tc.snapshot {
				require.Equal(t, "retained-provider-snapshot", provider.snapshot.Load())
			}
			retained, err := q.GetWorkspaceIncludingDeleted(ctx, old.ID)
			require.NoError(t, err)
			require.Equal(t, old.VmID, retained.VmID)
			require.Equal(t, old.SourceSnapshotID, retained.SourceSnapshotID)
			require.Equal(t, "suspended", retained.Status)
			require.False(t, retained.DeletedAt.Valid)
			if tc.snapshot {
				saved, err := q.GetWorkspaceSnapshotForUserRepo(ctx, db.GetWorkspaceSnapshotForUserRepoParams{ID: snapshot.ID, RepositoryID: repo.ID, UserID: user.ID})
				require.NoError(t, err)
				require.Equal(t, snapshot, saved)
			}
			// Execute the unchanged canonical source CLI against this real HTTP/PG
			// service. Its native host provider is the existing scripted fixture;
			// this backend command does not invoke a model or a local sandbox.
			if tc.snapshot {
				token := repositoryJobsToken(t, pool, user, string(middleware.ScopeReadRepository)+","+string(middleware.ScopeWriteRepository))
				home := t.TempDir()
				authFile := filepath.Join(home, "auth.json")
				authBytes, err := json.Marshal(map[string]string{"api_url": server.URL, "host": "127.0.0.1", "token": token})
				require.NoError(t, err)
				require.NoError(t, os.WriteFile(authFile, authBytes, 0600))
				entry, err := filepath.Abs("../../../smithers/src/bin.ts")
				require.NoError(t, err)
				scripted, err := filepath.Abs("../../../smithers/test/fixtures/scripted-native-host.ts")
				require.NoError(t, err)
				cliCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
				defer cancel()
				cmd := exec.CommandContext(cliCtx, "node", "--no-warnings", "--import", scripted, entry, "workspace", "create", "--snapshot", snapshot.ID, "--repo", repo.Owner+"/"+repo.Name, "--name", "cli-recovery", "--wait", "--wait-timeout", "5", "--format", "json")
				cmd.Dir = home
				cmd.Env = append(os.Environ(), "HOME="+home, "SMITHERS_AUTH_FILE="+authFile, "SMITHERS_DISABLE_SYSTEM_KEYRING=1", "SMITHERS_API_ORIGIN="+server.URL, "SMITHERS_WORKSPACE_CREATE_POLL_INTERVAL_MS=10", "SMITHERS_REMOTE=")
				output, runErr := cmd.CombinedOutput()
				require.NotContains(t, string(output), token)
				if tc.unavailable {
					require.Error(t, runErr, string(output))
					require.Contains(t, string(output), "snapshot_not_found")
					require.Contains(t, string(output), "remains")
				} else {
					require.NoError(t, runErr, string(output))
					require.Contains(t, string(output), `"running"`)
					require.Contains(t, string(output), snapshot.ID)
				}
				t.Logf("actual source CLI workspace create --snapshot --wait: unavailable=%v output=%s", tc.unavailable, output)
			}
			// Polling through the same authenticated public route exposes the real final
			// database status, including failed NEW rows with their recovery reference.
			resp = routesIntegrationDoRequest(t, ownerClient, server.URL, http.MethodGet, path+"/"+created.ID, nil)
			require.Equal(t, http.StatusOK, resp.StatusCode)
			var observed services.WorkspaceResponse
			routesIntegrationDecodeJSON(t, resp, &observed)
			require.Equal(t, settled.Status, observed.Status)
		})
	}
}
