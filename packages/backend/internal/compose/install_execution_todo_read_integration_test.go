package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/modelhost"
	"github.com/stretchr/testify/require"
)

func TestInstallExecutionTodoReadPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{"http://example.com"}
	service := services.NewMythicalService(f.pool, nil)
	router := githubAppSetupComposeRouter(cfg, f.pool, nil, routerExtras{Mythical: &routes.MythicalHandler{Service: service}})
	mountModelPublic(router.(chi.Router), modelhost.OwnerModels{Pool: f.pool}, f.q, cfg)
	workspaces := make([]db.Workspace, 2)
	for i := range workspaces {
		row, err := f.q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.owner.ID, Name: fmt.Sprintf("read-%d", i), TargetBookmark: "main", Kind: "container", Status: "running"})
		require.NoError(t, err)
		workspaces[i] = row
		_, err = f.pool.Exec(f.ctx, `INSERT INTO mythical_items(repository_id,source,state,number,stack_position,title,workspace_id,request_run_id,owner_id,created_by,revisions,checks,attempt)
 VALUES($1,'todo','running',$2,$2,'Own execution',$3,$4,$5,$5,'[{"private":"never-return-person-card"}]','{"private":"never-return-confirmation"}',1)`, f.repoID, i+1, row.ID, fmt.Sprintf("run-%d", i), f.owner.ID)
		require.NoError(t, err)
	}
	credentials := map[string]string{}
	for _, fixture := range []struct{ name, binding string }{
		{"RO", middleware.LandingWorkspaceScope(workspaces[0].ID) + "," + middleware.AgentSessionRestrictionScope("run-0")},
		{"RX", middleware.LandingWorkspaceScope(workspaces[1].ID) + "," + middleware.AgentSessionRestrictionScope("run-1")},
		{"MO", middleware.WorkspaceRestrictionScope(workspaces[0].ID)},
		{"MX", middleware.WorkspaceRestrictionScope(workspaces[1].ID)},
		{"unbound", ""},
	} {
		credentials[fixture.name] = f.token(f.owner, "todo-read-"+fixture.name, "read:repository,"+middleware.RepositoryRestrictionScope(f.repoID)+","+fixture.binding, true)
	}
	// SG-07's four literal cells. Expected results are independent of the
	// catalog and implementation; real stored subjects distinguish O from X.
	for _, cell := range []struct {
		credential, path string
		status           int
	}{
		{"RO", "/api/todos/1", 200}, {"MO", "/api/todos/1", 200},
		{"RX", "/api/todos/1", 403}, {"MX", "/api/todos/1", 403},
		{"unbound", "/api/todos/1", 403},
		{"RO", "/api/todos", 403}, {"MO", "/api/todos", 403},
		{"RO", "/api/todos/1/events", 403}, {"MO", "/api/todos/1/events", 403},
		{"RO", "/api/agents", 403}, {"MO", "/api/agents", 403},
		{"RX", "/api/todos/2", 200}, {"MX", "/api/todos/2", 200},
	} {
		t.Run(cell.credential+cell.path, func(t *testing.T) {
			req := httptest.NewRequest("GET", "http://example.com"+cell.path, nil)
			req.Header.Set("Authorization", "Bearer "+credentials[cell.credential])
			decisions := []string{}
			req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
			out := httptest.NewRecorder()
			router.ServeHTTP(out, req)
			require.Equal(t, cell.status, out.Code, out.Body.String())
			require.NotContains(t, out.Body.String(), "never-return")
			require.NotContains(t, out.Body.String(), "prompt_revisions")
			if cell.status == 200 {
				require.Equal(t, []string{"todo.read"}, decisions)
				require.Contains(t, out.Body.String(), `"title":"Own execution"`)
				var view map[string]any
				require.NoError(t, json.Unmarshal(out.Body.Bytes(), &view))
				keys := []string{}
				for key := range view {
					keys = append(keys, key)
				}
				require.ElementsMatch(t, []string{"n", "title", "state", "attempt", "generation", "workspace", "run", "base"}, keys)
			} else {
				require.Contains(t, out.Body.String(), `"code":"permission"`)
			}
		})
	}
	t.Run("bound read does not disclose reassigned workspace", func(t *testing.T) {
		hash := sha256.Sum256([]byte(credentials["RO"]))
		stored, err := f.q.GetAuthInfoByTokenHash(f.ctx, hex.EncodeToString(hash[:]))
		require.NoError(t, err)
		scopes := "read:repository," + middleware.RepositoryRestrictionScope(f.repoID) + "," + middleware.LandingWorkspaceScope(workspaces[0].ID) + "," + middleware.AgentSessionRestrictionScope("run-0")
		info := &middleware.AuthInfo{User: &f.owner, IsTokenAuth: true, TokenSystemIssued: true, TokenID: stored.TokenID, TokenHash: hex.EncodeToString(hash[:]), RawScopes: scopes, Scopes: middleware.ParseTokenScopes(scopes)}
		ctx := middleware.ContextWithAuthInfo(f.ctx, info)
		count := 0
		ctx = services.WithAuthorizationObserver(ctx, func(string) { count++ })
		subject := services.InstallSubject{RepositoryID: f.repoID, TodoNumber: 1}
		decision, err := services.Authorize(ctx, f.q, "todo.read", subject)
		require.NoError(t, err)
		ctx = services.WithInstallAuthorization(ctx, "todo.read", decision, subject)
		_, err = f.pool.Exec(f.ctx, `UPDATE mythical_items SET workspace_id=$1 WHERE repository_id=$2 AND number=1`, workspaces[1].ID, f.repoID)
		require.NoError(t, err)
		view, err := service.Todo(ctx, f.repoID, 1)
		require.Error(t, err)
		require.Nil(t, view)
		require.Equal(t, 1, count)
	})

}
