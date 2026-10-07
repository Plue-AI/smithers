package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/stretchr/testify/require"
)

// Direct service fixtures use persisted credentials, just as HTTP callers do.
// Tests explicitly revoking one never invoke this helper again.
func registerTestInstallCredential(t *testing.T, pool MythicalStore, ctx context.Context, repository int64) context.Context {
	t.Helper()
	info := middleware.AuthInfoFromContext(ctx)
	require.NotNil(t, info)
	_, err := pool.Exec(ctx, `INSERT INTO install_settings(key,value)
 SELECT 'github.repository',jsonb_build_object('owner_login',u.username,'repository_name',r.name,'repository_id',r.id)
 FROM repositories r JOIN users u ON u.id=r.user_id WHERE r.id=$1 ON CONFLICT(key) DO NOTHING`, repository)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO install_settings(key,value) SELECT 'owner.access',value || jsonb_build_object('last_access_check_at',to_char(now(),'YYYY-MM-DD"T"HH24:MI:SS"Z"')) FROM install_settings WHERE key='github.repository' ON CONFLICT(key) DO NOTHING`)
	require.NoError(t, err)
	if !info.IsTokenAuth {
		_, err = pool.Exec(ctx, `INSERT INTO auth_sessions(session_key,user_id,username,expires_at) SELECT $1,id,username,now()+interval '1 hour' FROM users WHERE id=$2 ON CONFLICT(session_key) DO NOTHING`, info.SessionHash, info.User.ID)
		require.NoError(t, err)
		return ctx
	}
	if delegation, terminal := info.TerminalDelegation(); terminal {
		_, err = pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,name) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING`, delegation.Branch, repository, info.User.ID, "fixture-terminal:"+delegation.Branch)
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `INSERT INTO workspace_sessions(id,workspace_id,repository_id,user_id,status) VALUES($1,$2,$3,$4,'running') ON CONFLICT(id) DO NOTHING`, delegation.Session, delegation.Branch, repository, info.User.ID)
		require.NoError(t, err)
		info.RawScopes = strings.ReplaceAll(info.RawScopes, middleware.RepositoryRestrictionScope(info.RepositoryRestriction()), middleware.RepositoryRestrictionScope(repository))
	}
	if info.TokenHash == "" {
		hash := sha256.Sum256([]byte(uuid.NewString()))
		info.TokenHash = hex.EncodeToString(hash[:])
		err = pool.QueryRow(ctx, `INSERT INTO access_tokens(user_id,name,token_hash,token_last_eight,scopes,system_issued,expires_at) VALUES($1,'fixture',$2,$3,$4,$5,now()+interval '1 hour') RETURNING id`, info.User.ID, info.TokenHash, info.TokenHash[56:], info.RawScopes, info.TokenSystemIssued).Scan(&info.TokenID)
		require.NoError(t, err)
	}
	return ctx
}
