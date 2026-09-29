package product

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Migration 0067 (#2777) deletes every stored Claude setup token and OAuth
// pair with the grants and workspace usage records that point at them, keeps
// a device login with no connection, keeps Anthropic API keys and Codex rows
// of every kind, and refuses a Claude subscription row from then on.
func TestClaudeSubscriptionConnectionsMigrationDeletesThem(t *testing.T) {
	pool := servicesBDatabase(t, 66)
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		_, err := pool.Exec(ctx, sql, args...)
		require.NoError(t, err)
	}
	exec(`INSERT INTO users(id,username,lower_username) VALUES(1,'alice','alice')`)
	exec(`INSERT INTO repositories(id,user_id,name,lower_name) VALUES(1,1,'r1','r1')`)
	exec(`INSERT INTO workspaces(id,repository_id,user_id) VALUES('00000000-0000-0000-0000-0000000000a1',1,1)`)
	exec(`INSERT INTO provider_connections(id,owner_type,user_id,provider,kind,access_token_encrypted,refresh_token_encrypted) VALUES
		('00000000-0000-0000-0000-000000000001','user',1,'claude','setup_token','sk-ant-oat01-a',NULL),
		('00000000-0000-0000-0000-000000000002','user',1,'claude','oauth','sk-ant-oat01-b','sk-ant-ort01-b'),
		('00000000-0000-0000-0000-000000000003','user',1,'codex','oauth','codex-access','codex-refresh'),
		('00000000-0000-0000-0000-000000000004','user',1,'claude','api_key','sk-ant-api03-d',NULL),
		('00000000-0000-0000-0000-000000000005','user',1,'codex','api_key','sk-proj-e',NULL),
		('00000000-0000-0000-0000-000000000006','user',1,'codex','setup_token','codex-f',NULL)`)
	exec(`INSERT INTO provider_connection_grants(connection_id,all_repositories) VALUES
		('00000000-0000-0000-0000-000000000001',true),('00000000-0000-0000-0000-000000000003',true),('00000000-0000-0000-0000-000000000004',true)`)
	exec(`INSERT INTO workspace_provider_uses(workspace_id,connection_id,model) VALUES
		('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-000000000002','claude-opus'),
		('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-000000000003','gpt-6-luna')`)
	exec(`INSERT INTO provider_connection_device_logins(user_id,provider,device_auth_id_encrypted,user_code,expires_at,state,connection_id) VALUES
		(1,'codex','x','ABCD-1234',now(),'connected','00000000-0000-0000-0000-000000000002')`)

	registered, err := registeredMigrations()
	require.NoError(t, err)
	require.Equal(t, 67, registered[66].version)
	require.NoError(t, applyOnce(ctx, pool, registered))

	column := func(sql string) []string {
		t.Helper()
		rows, err := pool.Query(ctx, sql)
		require.NoError(t, err)
		values, err := pgx.CollectRows(rows, pgx.RowTo[string])
		require.NoError(t, err)
		return values
	}
	assert.Equal(t, []string{"codex/oauth", "claude/api_key", "codex/api_key", "codex/setup_token"}, column(`SELECT provider||'/'||kind FROM provider_connections ORDER BY id`))
	assert.Equal(t, []string{"00000000-0000-0000-0000-000000000003", "00000000-0000-0000-0000-000000000004"},
		column(`SELECT connection_id::text FROM provider_connection_grants ORDER BY connection_id`))
	assert.Equal(t, []string{"gpt-6-luna"}, column(`SELECT model FROM workspace_provider_uses`))
	assert.Equal(t, []string{"connected:none"}, column(`SELECT state||':'||COALESCE(connection_id::text,'none') FROM provider_connection_device_logins`))

	for _, kind := range []string{"setup_token", "oauth"} {
		_, err = pool.Exec(ctx, `INSERT INTO provider_connections(owner_type,user_id,provider,kind,access_token_encrypted) VALUES('user',1,'claude',$1,'sk-ant-oat01-new')`, kind)
		var pgErr *pgconn.PgError
		require.True(t, errors.As(err, &pgErr), "claude %s: %v", kind, err)
		assert.Equal(t, "23514", pgErr.Code, "claude %s violates provider_connections_kind_check", kind)
		assert.Equal(t, "provider_connections_kind_check", pgErr.ConstraintName)
	}
	for _, kind := range []string{"setup_token", "oauth", "api_key"} {
		_, err = pool.Exec(ctx, `INSERT INTO provider_connections(owner_type,user_id,provider,kind,access_token_encrypted) VALUES('user',1,'codex',$1,'x')`, kind)
		require.NoError(t, err, "codex keeps every kind the earlier constraint allowed: %s", kind)
	}
	_, err = pool.Exec(ctx, `INSERT INTO provider_connections(owner_type,user_id,provider,kind,access_token_encrypted) VALUES('user',1,'codex','other','x')`)
	require.Error(t, err, "no kind outside the earlier set")
}
