package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/process"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// Actual SQL credentials and file bytes cross the composed install router.
// The process runtime is a file fixture, not an install execution fallback.
func TestInstallExecutionWorkspaceFileReadPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	runtime, err := process.New(process.Config{Root: t.TempDir()})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	workspaces := make([]db.Workspace, 2)
	for i := range workspaces {
		row, err := f.q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.owner.ID, Name: fmt.Sprintf("file-read-%d", i), TargetBookmark: fmt.Sprintf("smithers/read-%d", i), Kind: "container", Status: "running"})
		require.NoError(t, err)
		workspaces[i] = row
		var item db.MythicalItem
		require.NoError(t, f.pool.QueryRow(f.ctx, `INSERT INTO mythical_items(repository_id,source,state,stack_position,title,workspace_id,request_run_id,owner_id,created_by,attempt) VALUES($1,'todo','running',$2,'File execution',$3,$4,$5,$5,1) RETURNING id`, f.repoID, i+1, row.ID, fmt.Sprintf("file-run-%d", i), f.owner.ID).Scan(&item.ID))
		_, _, err = f.q.BindMythicalLane(f.ctx, db.MythicalLane{RepositoryID: f.repoID, ItemID: item.ID, WorkspaceID: row.ID, Name: row.Name})
		require.NoError(t, err)
		_, err = runtime.CreateWorkspace(f.ctx, workspaceapi.WorkspaceSpec{ID: row.ID})
		require.NoError(t, err)
		require.NoError(t, runtime.WriteFile(f.ctx, row.ID, "proof.txt", []byte(fmt.Sprintf("execution-%d", i)), 0600))
		_, err = runtime.StartWorkspace(f.ctx, row.ID)
		require.NoError(t, err)
	}
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = "http://example.com"
	service := services.NewWorkspaceService(f.q, services.WithWorkspaceRuntime(runtime), services.WithWorkspaceInstallAuthorization(f.q), services.WithWorkspaceTransactions(f.pool))
	router := githubAppSetupComposeRouter(cfg, f.pool, nil, routerExtras{}, &routes.WorkspaceHandler{Service: service})
	creds := map[string]string{}
	for _, actor := range []struct{ name, binding string }{
		{"run", middleware.LandingWorkspaceScope(workspaces[0].ID) + "," + middleware.AgentSessionRestrictionScope("file-run-0")},
		{"machine", middleware.WorkspaceRestrictionScope(workspaces[0].ID)},
		{"wrong run", middleware.LandingWorkspaceScope(workspaces[0].ID) + "," + middleware.AgentSessionRestrictionScope("file-run-1")},
		{"children", middleware.WorkspaceChildrenCredentialScope() + "," + middleware.WorkspaceRestrictionScope(workspaces[0].ID)},
	} {
		creds[actor.name] = f.token(f.owner, "file-"+actor.name, "read:repository,"+middleware.RepositoryRestrictionScope(f.repoID)+","+actor.binding, true)
	}
	for _, cell := range []struct {
		actor     string
		workspace int
		status    int
	}{
		{"run", 0, 200}, {"machine", 0, 200}, {"run", 1, 403}, {"machine", 1, 403}, {"wrong run", 0, 403}, {"children", 0, 403},
	} {
		for _, suffix := range []string{"files/content?path=proof.txt", "files"} {
			t.Run(fmt.Sprintf("%s/%d/%s", cell.actor, cell.workspace, suffix), func(t *testing.T) {
				req := httptest.NewRequest("GET", cfg.Server.PublicURL+"/api/repos/gate-owner/app/workspaces/"+workspaces[cell.workspace].ID+"/"+suffix, nil)
				req.Header.Set("Authorization", "Bearer "+creds[cell.actor])
				req.Header.Set("Smithers-Actor", "person")
				req.Header.Set("Smithers-Via", "smithers")
				var decisions []string
				req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
				out := httptest.NewRecorder()
				router.ServeHTTP(out, req)
				require.Equal(t, cell.status, out.Code, out.Body.String())
				require.Equal(t, []string{"branch.read"}, decisions)
				if cell.status == 200 {
					require.Contains(t, out.Body.String(), "proof.txt")
					if strings.HasPrefix(suffix, "files/content") {
						require.Contains(t, out.Body.String(), "execution-0")
					}
				} else {
					require.Contains(t, out.Body.String(), `"code":"permission"`)
					require.NotContains(t, out.Body.String(), "execution-")
				}
			})
		}
	}

	for _, actor := range []string{"run", "machine"} {
		t.Run("direct service/"+actor, func(t *testing.T) {
			sum := sha256.Sum256([]byte(creds[actor]))
			hash := hex.EncodeToString(sum[:])
			stored, err := f.q.GetAuthInfoByTokenHash(f.ctx, hash)
			require.NoError(t, err)
			info := &middleware.AuthInfo{User: &f.owner, IsTokenAuth: true, TokenSystemIssued: true, TokenID: stored.TokenID, TokenHash: hash, RawScopes: stored.TokenScopes, Scopes: middleware.ParseTokenScopes(stored.TokenScopes)}
			ctx := middleware.ContextWithAuthInfo(f.ctx, info)
			var decisions []string
			ctx = services.WithAuthorizationObserver(ctx, func(command string) { decisions = append(decisions, command) })
			file, err := service.ReadWorkspaceFile(ctx, workspaces[0].ID, f.repoID, f.owner.ID, "proof.txt")
			require.NoError(t, err)
			require.Equal(t, "execution-0", file.Content)
			require.Equal(t, []string{"branch.read"}, decisions)
			decisions = nil
			file, err = service.ReadWorkspaceFile(ctx, workspaces[1].ID, f.repoID, f.owner.ID, "proof.txt")
			require.Error(t, err)
			require.Empty(t, file.Content)
			require.Equal(t, []string{"branch.read"}, decisions)
		})
	}
	// A takeover invalidates the old sponsor's next file request.
	_, err = f.pool.Exec(f.ctx, `UPDATE mythical_items SET owner_id=$2 WHERE workspace_id=$1`, workspaces[0].ID, f.other.ID)
	require.NoError(t, err)
	req := httptest.NewRequest("GET", cfg.Server.PublicURL+"/api/repos/gate-owner/app/workspaces/"+workspaces[0].ID+"/files/content?path=proof.txt", nil)
	req.Header.Set("Authorization", "Bearer "+creds["run"])
	out := httptest.NewRecorder()
	router.ServeHTTP(out, req)
	require.Equal(t, 403, out.Code, out.Body.String())
	require.NotContains(t, out.Body.String(), "execution-0")
}
