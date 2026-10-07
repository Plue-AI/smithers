package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestInstallSystemCommandCredentialDeathPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	parent, err := f.q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.other.ID, Name: "system-identity", Kind: "container", Status: "running", TargetBookmark: "smithers/identity"})
	require.NoError(t, err)
	base := middleware.RepositoryRestrictionScope(f.repoID) + "," + middleware.WorkspaceRestrictionScope(parent.ID)
	for _, command := range []struct{ name, publisher, scopes string }{
		{"workspace.head", "head-publisher", "write:repository," + base},
		{"workspace.children.list", "sandbox-workspace-children-" + parent.ID, "read:repository,write:workspace," + base + "," + middleware.WorkspaceChildrenCredentialScope()},
		{"workspace.provider-pool", "provider-pool-workspace-" + parent.ID, services.ProviderPoolTokenScopes(f.repoID, parent.ID)},
	} {
		t.Run(command.name, func(t *testing.T) {
			bearer := f.token(f.other, command.publisher, command.scopes, true)
			sum := sha256.Sum256([]byte(bearer))
			hash := hex.EncodeToString(sum[:])
			token, err := f.q.GetAuthInfoByTokenHash(f.ctx, hash)
			require.NoError(t, err)
			if command.name == "workspace.head" {
				_, err = f.pool.Exec(f.ctx, `UPDATE workspaces SET head_push_token_id=$2 WHERE id=$1`, parent.ID, token.TokenID)
				require.NoError(t, err)
			}
			info := &middleware.AuthInfo{User: &f.other, IsTokenAuth: true, TokenSystemIssued: true, TokenID: token.TokenID, TokenHash: hash, RawScopes: command.scopes, Scopes: middleware.ParseTokenScopes(command.scopes)}
			ctx := middleware.ContextWithAuthInfo(f.ctx, info)
			own := services.InstallSubject{RepositoryID: f.repoID, WorkspaceID: parent.ID}
			_, err = services.Authorize(ctx, f.q, command.name, own)
			require.NoError(t, err)
			for _, mutation := range []struct {
				name, sql string
				args      []any
			}{
				{"expired", `UPDATE access_tokens SET expires_at=now()-interval '1 second' WHERE id=$1`, []any{token.TokenID}},
				{"changed hash", `UPDATE access_tokens SET token_hash=$2 WHERE id=$1`, []any{token.TokenID, "changed-" + hash}},
				{"changed scopes", `UPDATE access_tokens SET scopes='read:user' WHERE id=$1`, []any{token.TokenID}},
				{"suspended", `UPDATE collaborators SET suspended_at=now() WHERE repository_id=$1 AND user_id=$2`, []any{f.repoID, f.other.ID}},
				{"removed", `DELETE FROM collaborators WHERE repository_id=$1 AND user_id=$2`, []any{f.repoID, f.other.ID}},
			} {
				t.Run(mutation.name, func(t *testing.T) {
					_, err := f.pool.Exec(f.ctx, mutation.sql, mutation.args...)
					require.NoError(t, err)
					t.Cleanup(func() {
						_, err := f.pool.Exec(f.ctx, `UPDATE access_tokens SET expires_at=now()+interval '1 hour',token_hash=$2,scopes=$3 WHERE id=$1`, token.TokenID, hash, command.scopes)
						require.NoError(t, err)
						if mutation.name == "removed" {
							_, err = f.pool.Exec(f.ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, f.repoID, f.other.ID)
						} else {
							_, err = f.pool.Exec(f.ctx, `UPDATE collaborators SET suspended_at=NULL WHERE repository_id=$1 AND user_id=$2`, f.repoID, f.other.ID)
						}
						require.NoError(t, err)
					})
					for _, subject := range []services.InstallSubject{own, {}, {RepositoryID: f.repoID, WorkspaceID: "11111111-1111-4111-8111-111111111111"}} {
						calls := 0
						observed := services.WithAuthorizationObserver(ctx, func(string) { calls++ })
						_, err := services.Authorize(observed, f.q, command.name, subject)
						var access *services.AccessError
						require.ErrorAs(t, err, &access)
						require.Equal(t, 401, access.Status)
						require.Equal(t, "unauthenticated", access.Code)
						require.Equal(t, 1, calls)
					}
				})
			}
		})
	}
}
