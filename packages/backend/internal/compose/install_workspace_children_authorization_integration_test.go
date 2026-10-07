package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

func TestInstallWorkspaceChildrenCommandsPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{"http://example.com"}
	service := services.NewWorkspaceService(f.q, services.WithWorkspaceInstallAuthorization(f.q), services.WithWorkspaceTransactions(f.pool))
	router := githubAppSetupComposeRouter(cfg, f.pool, nil, &routes.WorkspaceHandler{Service: service})
	create := func(name string) db.Workspace {
		row, err := f.q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.owner.ID, Name: name, TargetBookmark: "main", Kind: "container", Status: "running"})
		require.NoError(t, err)
		return row
	}
	parent, other, child := create("parent"), create("other"), create("child")
	_, err := f.pool.Exec(f.ctx, `UPDATE workspaces SET parent_workspace_id=$2 WHERE id=$1`, child.ID, parent.ID)
	require.NoError(t, err)
	scopes := "read:repository,write:workspace," + middleware.RepositoryRestrictionScope(f.repoID) + "," + middleware.WorkspaceRestrictionScope(parent.ID) + "," + middleware.WorkspaceChildrenCredentialScope()
	machine := f.token(f.owner, "sandbox-workspace-children-"+parent.ID, scopes, true)
	wrong := f.token(f.owner, "children-unrecorded", scopes, true)
	run := f.token(f.owner, "children-run", "read:repository,write:workspace,"+middleware.RepositoryRestrictionScope(f.repoID), true)
	delegated := f.token(f.owner, "children-delegated", "write:repository,write:workspace,via:codex", true)
	cookie := "children-person"
	sum := sha256.Sum256([]byte(cookie))
	_, err = f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: f.owner.ID, Username: f.owner.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	for _, cell := range []struct {
		name, token, method, path string
		status, count             int
	}{
		{"own list", machine, "GET", parent.ID + "/children", 200, 1},
		{"other parent", machine, "GET", other.ID + "/children", 403, 1},
		{"other child", machine, "POST", parent.ID + "/children/" + other.ID + "/stop", 403, 1},
		{"unrecorded", wrong, "GET", parent.ID + "/children", 403, 1},
		{"run", run, "GET", parent.ID + "/children", 403, 1},
		{"delegated", delegated, "GET", parent.ID + "/children", 403, 1},
		{"person", "", "GET", parent.ID + "/children", 403, 1},
	} {
		t.Run(cell.name, func(t *testing.T) {
			req := httptest.NewRequest(cell.method, "http://example.com/api/repos/gate-owner/app/workspaces/"+cell.path, strings.NewReader(`{}`))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Origin", "http://example.com")
			if cell.token != "" {
				req.Header.Set("Authorization", "Bearer "+cell.token)
			} else {
				req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
			}
			decisions := []string{}
			req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
			out := httptest.NewRecorder()
			router.ServeHTTP(out, req)
			require.Equal(t, cell.status, out.Code, out.Body.String())
			require.Len(t, decisions, cell.count)
			if cell.status == 200 {
				require.Contains(t, out.Body.String(), `[]`)
			} else {
				require.Contains(t, out.Body.String(), `"code":"permission"`)
			}
		})
	}
	t.Run("direct entry binds child ancestry", func(t *testing.T) {
		sum := sha256.Sum256([]byte(machine))
		hash := hex.EncodeToString(sum[:])
		stored, err := f.q.GetAuthInfoByTokenHash(f.ctx, hash)
		require.NoError(t, err)
		info := &middleware.AuthInfo{User: &f.owner, IsTokenAuth: true, TokenSystemIssued: true, TokenID: stored.TokenID, TokenHash: hash, RawScopes: scopes, Scopes: middleware.ParseTokenScopes(scopes)}
		ctx := middleware.ContextWithAuthInfo(f.ctx, info)
		decisions := 0
		ctx = services.WithAuthorizationObserver(ctx, func(string) { decisions++ })
		subject := services.InstallSubject{RepositoryID: f.repoID, WorkspaceID: parent.ID}
		decision, err := services.Authorize(ctx, f.q, "workspace.children.list", subject)
		require.NoError(t, err)
		bound := services.WithInstallAuthorization(ctx, "workspace.children.list", decision, subject)
		rows, err := service.ListWorkspaceChildren(bound, parent.ID, f.repoID, f.owner.ID)
		require.NoError(t, err)
		require.Empty(t, rows)
		require.Equal(t, 1, decisions)
		subject.ChildWorkspaceID = child.ID
		_, err = services.Authorize(ctx, f.q, "workspace.children.stop", subject)
		require.NoError(t, err)
		subject.ChildWorkspaceID = other.ID
		_, err = services.Authorize(ctx, f.q, "workspace.children.stop", subject)
		require.Error(t, err)
		require.Contains(t, fmt.Sprint(err), "credential")
	})
	t.Run("bound list rechecks live credential and parent", func(t *testing.T) {
		sum := sha256.Sum256([]byte(machine))
		hash := hex.EncodeToString(sum[:])
		stored, err := f.q.GetAuthInfoByTokenHash(f.ctx, hash)
		require.NoError(t, err)
		info := &middleware.AuthInfo{User: &f.owner, IsTokenAuth: true, TokenSystemIssued: true, TokenID: stored.TokenID, TokenHash: hash, RawScopes: scopes, Scopes: middleware.ParseTokenScopes(scopes)}
		ctx := middleware.ContextWithAuthInfo(f.ctx, info)
		subject := services.InstallSubject{RepositoryID: f.repoID, WorkspaceID: parent.ID}
		for _, tc := range []struct {
			name, mutation, restore string
			status                  int
		}{
			{"expired", `UPDATE access_tokens SET expires_at=now()-interval '1 second' WHERE id=$1`, `UPDATE access_tokens SET expires_at=now()+interval '1 hour' WHERE id=$1`, 401},
			{"renamed publisher", `UPDATE access_tokens SET name='unrelated' WHERE id=$1`, `UPDATE access_tokens SET name=$2 WHERE id=$1`, 403},
			{"changed scopes", `UPDATE access_tokens SET scopes='read:user' WHERE id=$1`, `UPDATE access_tokens SET scopes=$3 WHERE id=$1`, 403},
		} {
			t.Run(tc.name, func(t *testing.T) {
				calls := 0
				observed := services.WithAuthorizationObserver(ctx, func(string) { calls++ })
				decision, err := services.Authorize(observed, f.q, "workspace.children.list", subject)
				require.NoError(t, err)
				bound := services.WithInstallAuthorization(observed, "workspace.children.list", decision, subject)
				_, err = f.pool.Exec(f.ctx, tc.mutation, stored.TokenID)
				require.NoError(t, err)
				t.Cleanup(func() {
					var err error
					switch tc.name {
					case "renamed publisher":
						_, err = f.pool.Exec(f.ctx, tc.restore, stored.TokenID, "sandbox-workspace-children-"+parent.ID)
					case "changed scopes":
						_, err = f.pool.Exec(f.ctx, `UPDATE access_tokens SET scopes=$2 WHERE id=$1`, stored.TokenID, scopes)
					default:
						_, err = f.pool.Exec(f.ctx, tc.restore, stored.TokenID)
					}
					require.NoError(t, err)
				})
				rows, err := service.ListWorkspaceChildren(bound, parent.ID, f.repoID, f.owner.ID)
				var access *services.AccessError
				require.ErrorAs(t, err, &access)
				require.Equal(t, tc.status, access.Status)
				require.Nil(t, rows)
				require.Equal(t, 1, calls)
			})
		}
	})

}
