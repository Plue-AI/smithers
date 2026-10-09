package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// Stored receipts cross the production HTTP and SQL read boundary. This proves
// hidden grant isolation, not guest token publication or child execution.
func TestAccessChildrenGrantMatrixComposedPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode, cfg.Auth.SessionCookieName = "selfhost", "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	service := services.NewWorkspaceService(f.q, services.WithWorkspaceInstallAuthorization(f.q), services.WithWorkspaceTransactions(f.pool))
	router := githubAppSetupComposeRouter(cfg, f.pool, nil, &routes.WorkspaceHandler{Service: service})
	maintainer, err := f.q.CreateUser(f.ctx, db.CreateUserParams{Username: "children-maintainer", LowerUsername: "children-maintainer"})
	require.NoError(t, err)
	_, err = f.pool.Exec(f.ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, f.repoID, maintainer.ID)
	require.NoError(t, err)
	issuer := services.NewAuthService(f.q, cfg.Auth, nil, nil)
	issuer.Members = &services.Members{Pool: f.pool}
	cells := 0
	tokenIndex := 0
	mint := func(user db.User, name, scopes string, system bool) string {
		tokenIndex++
		token := f.token(user, fmt.Sprintf("children-matrix-%d", tokenIndex), scopes, system)
		sum := sha256.Sum256([]byte(token))
		_, err := f.pool.Exec(f.ctx, `UPDATE access_tokens SET name=$2 WHERE token_hash=$1`, hex.EncodeToString(sum[:]), name)
		require.NoError(t, err)
		return token
	}
	for _, user := range []db.User{f.owner, maintainer, f.other} {
		t.Run(user.Username, func(t *testing.T) {
			create := func(name string, owner int64) db.Workspace {
				row, err := f.q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: owner, Name: name + "-" + user.Username, TargetBookmark: "main", Kind: "container", Status: "running"})
				require.NoError(t, err)
				return row
			}
			parent, other := create("grant-parent", user.ID), create("grant-other", user.ID)
			// Reserve and materialize the same durable rows the real spawn uses.
			tx, err := f.pool.Begin(f.ctx)
			require.NoError(t, err)
			defer tx.Rollback(f.ctx)
			q := db.New(tx)
			var parentID pgtype.UUID
			require.NoError(t, parentID.Scan(parent.ID))
			batch, err := q.CreateWorkspaceChildBatch(f.ctx, db.CreateWorkspaceChildBatchParams{ParentWorkspaceID: parentID, UserID: user.ID, Profile: "small", Requested: 1, ExpiresAt: time.Now().Add(time.Hour)})
			require.NoError(t, err)
			require.NoError(t, q.ReserveWorkspaceChildren(f.ctx, batch.ID))
			children, err := q.CreateWorkspaceChildRows(f.ctx, batch.ID)
			require.NoError(t, err)
			require.Len(t, children, 1)
			require.NoError(t, tx.Commit(f.ctx))
			child := children[0]
			grandchild := create("grant-grandchild", user.ID)
			_, err = f.pool.Exec(f.ctx, `UPDATE workspaces SET parent_workspace_id=$2 WHERE id=$1`, grandchild.ID, child.ID)
			require.NoError(t, err)
			cookie := "children-grant-session-" + user.Username
			sum := sha256.Sum256([]byte(cookie))
			_, err = f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: user.ID, Username: user.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
			require.NoError(t, err)
			base := "read:repository,write:workspace," + middleware.RepositoryRestrictionScope(f.repoID) + "," + middleware.WorkspaceRestrictionScope(parent.ID)
			grant := base + "," + middleware.WorkspaceChildrenCredentialScope()
			name := "sandbox-workspace-children-" + parent.ID
			machine := mint(user, name, grant, true)
			type actor struct{ name, token string }
			actors := []actor{{"session", ""}, {"unnamed", mint(user, "unbound-publisher", grant, true)}, {"no-system-issuance", mint(user, name, grant, false)},
				{"missing-grant", mint(user, name, base, true)},
				{"missing-repository", mint(user, name, "read:repository,write:workspace,"+middleware.WorkspaceRestrictionScope(parent.ID)+","+middleware.WorkspaceChildrenCredentialScope(), true)},
				{"missing-workspace", mint(user, name, "read:repository,write:workspace,"+middleware.RepositoryRestrictionScope(f.repoID)+","+middleware.WorkspaceChildrenCredentialScope(), true)}}
			for _, via := range []string{"cli", "codex", "claude-code"} {
				issued, err := issuer.CreateToken(f.ctx, user.ID, services.CreateTokenRequest{Name: "children-refusal-" + via, Via: via, Scopes: []string{"repo", "user"}})
				require.NoError(t, err)
				actors = append(actors, actor{via, issued.Token})
			}
			turn, err := issuer.MintForTurn(f.ctx, user.ID, liveAppTurnCredentialFixture(t, f.pool, user.ID), 1)
			require.NoError(t, err)
			actors = append(actors, actor{"app-agent", turn.Token})
			call := func(t *testing.T, a actor, method, suffix, command string, status int) *httptest.ResponseRecorder {
				t.Helper()
				req := httptest.NewRequest(method, cfg.Server.PublicURL+"/api/repos/gate-owner/app/workspaces/"+suffix, strings.NewReader(`{"count":1,"profile":"small","ttl_secs":60}`))
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Origin", cfg.Server.PublicURL)
				req.Header.Set("Smithers-Actor", "person")
				req.Header.Set("Smithers-Profile", "app_agent")
				if a.token == "" {
					req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
					req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "children-csrf"})
					req.Header.Set("X-CSRF-Token", "children-csrf")
				} else {
					req.Header.Set("Authorization", "Bearer "+a.token)
				}
				var decisions []string
				req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
				before, err := f.q.GetWorkspace(f.ctx, child.ID)
				require.NoError(t, err)
				out := httptest.NewRecorder()
				router.ServeHTTP(out, req)
				require.Equal(t, status, out.Code, out.Body.String())
				if a.name == "no-system-issuance" {
					require.Empty(t, decisions, "untrusted reserved scopes die in authentication")
					require.Contains(t, out.Body.String(), `"code":"unauthenticated"`)
				} else {
					require.Equal(t, []string{command}, decisions)
				}
				if status == 403 {
					require.Contains(t, out.Body.String(), `"class":"permission"`)
					require.Contains(t, out.Body.String(), `"code":"permission"`)
					require.NotContains(t, out.Body.String(), child.ID)
				}
				after, err := f.q.GetWorkspace(f.ctx, child.ID)
				require.NoError(t, err)
				require.Equal(t, before, after)
				var batches, receipts int
				require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT count(*) FROM workspace_child_batches WHERE parent_workspace_id=$1`, parent.ID).Scan(&batches))
				require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT count(*) FROM workspace_children WHERE batch_id=$1`, batch.ID).Scan(&receipts))
				require.Equal(t, 1, batches)
				require.Equal(t, 1, receipts)
				cells++
				return out
			}
			out := call(t, actor{"machine", machine}, "GET", parent.ID+"/children", "workspace.children.list", 200)
			var rows []services.WorkspaceChild
			require.NoError(t, json.Unmarshal(out.Body.Bytes(), &rows))
			require.Len(t, rows, 1)
			require.Equal(t, child.ID, rows[0].WorkspaceID)
			require.Equal(t, batch.ID, rows[0].BatchID)
			require.Equal(t, "small", rows[0].Profile)
			for _, a := range actors {
				status := 403
				if a.name == "no-system-issuance" {
					status = 401
				}
				for _, op := range []struct{ method, suffix, command string }{{"GET", "/children", "workspace.children.list"}, {"POST", "/children", "workspace.children.spawn"}, {"POST", "/children/" + child.ID + "/stop", "workspace.children.stop"}} {
					t.Run(a.name+"/"+op.command, func(t *testing.T) { call(t, a, op.method, parent.ID+op.suffix, op.command, status) })
				}
			}
			for _, target := range []db.Workspace{parent, other, grandchild} {
				t.Run("wrong-ancestry/"+target.Name, func(t *testing.T) {
					call(t, actor{"machine", machine}, "POST", parent.ID+"/children/"+target.ID+"/stop", "workspace.children.stop", 403)
				})
			}
			call(t, actor{"machine", machine}, "GET", other.ID+"/children", "workspace.children.list", 403)
		})
	}
	require.Equal(t, 105, cells)
	t.Logf("hidden children grants: %d composed HTTP cells; guest execution remains unqualified", cells)
}
