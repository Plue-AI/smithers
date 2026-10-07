package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http/httptest"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

func TestInstallExecutionReadDeathPriorityPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	ws, err := f.q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.owner.ID, Name: "death-priority", Kind: "container", Status: "running", TargetBookmark: "smithers/death-priority"})
	require.NoError(t, err)
	for _, kind := range []string{"run", "machine"} {
		for _, state := range []string{"expired", "deleted", "suspended", "removed"} {
			t.Run(kind+"/"+state, func(t *testing.T) {
				name := "priority-" + kind + "-" + state
				user, err := f.q.CreateUser(f.ctx, db.CreateUserParams{Username: name, LowerUsername: name})
				require.NoError(t, err)
				_, err = f.pool.Exec(f.ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, f.repoID, user.ID)
				require.NoError(t, err)
				scopes := "read:repository," + middleware.RepositoryRestrictionScope(f.repoID)
				if kind == "run" {
					scopes += "," + middleware.LandingWorkspaceScope(ws.ID) + "," + middleware.AgentSessionRestrictionScope("priority-run")
				} else {
					scopes += "," + middleware.WorkspaceRestrictionScope(ws.ID)
				}
				token := f.token(user, name, scopes, true)
				sum := sha256.Sum256([]byte(token))
				hash := hex.EncodeToString(sum[:])
				row, err := f.q.GetAuthInfoByTokenHash(f.ctx, hash)
				require.NoError(t, err)
				info := &middleware.AuthInfo{User: &user, IsTokenAuth: true, TokenSystemIssued: true, TokenID: row.TokenID, TokenHash: hash, RawScopes: scopes, Scopes: middleware.ParseTokenScopes(scopes)}
				ctx := middleware.ContextWithAuthInfo(f.ctx, info)
				// Both a missing binding and another TODO are permission failures while
				// the credential lives. Neither may mask its later death.
				subjects := []services.InstallSubject{{}, {RepositoryID: f.repoID, TodoNumber: 999999, WorkspaceID: ws.ID}}
				check := func(status int) {
					t.Helper()
					for _, subject := range subjects {
						var calls []string
						observed := services.WithAuthorizationObserver(ctx, func(command string) { calls = append(calls, command) })
						_, err := services.Authorize(observed, f.q, "todo.read", subject)
						var access *services.AccessError
						require.ErrorAs(t, err, &access)
						require.Equal(t, status, access.Status)
						require.Equal(t, []string{"todo.read"}, calls)
						if status == 401 {
							require.Equal(t, "unauthenticated", access.Code)
						} else {
							require.Equal(t, "permission", access.Code)
						}
					}
				}
				check(403)
				switch state {
				case "expired":
					_, err = f.pool.Exec(f.ctx, `UPDATE access_tokens SET expires_at=now()-interval '1 second' WHERE id=$1`, row.TokenID)
				case "deleted":
					_, err = f.pool.Exec(f.ctx, `DELETE FROM access_tokens WHERE id=$1`, row.TokenID)
				case "suspended":
					_, err = f.pool.Exec(f.ctx, `UPDATE collaborators SET suspended_at=now() WHERE repository_id=$1 AND user_id=$2`, f.repoID, user.ID)
				case "removed":
					_, err = f.pool.Exec(f.ctx, `DELETE FROM collaborators WHERE repository_id=$1 AND user_id=$2`, f.repoID, user.ID)
				}
				require.NoError(t, err)
				check(401)
				req := httptest.NewRequest("GET", "http://example.com/api/repos/gate-owner/app/landings/999999", nil)
				req.Header.Set("Authorization", "Bearer "+token)
				out := httptest.NewRecorder()
				f.router.ServeHTTP(out, req)
				require.Equal(t, 401, out.Code, out.Body.String())
			})
		}
	}
	require.Zero(t, f.hostCalls.Load())
}
