package product

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

// #2206: the one-time scan flags every stored secret holding a subscription
// token, marks the live workspaces and snapshots of every repository that
// held one, records counts only, and does nothing on a second run.
func TestStoredSubscriptionTokenScanFlagsRowsOnce(t *testing.T) {
	pool := servicesBDatabase(t, 0)
	ctx := context.Background()
	codec, err := webhook.NewSecretCodec("subscription-token-scan-test-key")
	require.NoError(t, err)
	seal := func(value string) []byte {
		cipher, err := codec.EncryptString(value)
		require.NoError(t, err)
		return []byte(cipher)
	}
	exec := func(sql string, args ...any) {
		t.Helper()
		_, err := pool.Exec(ctx, sql, args...)
		require.NoError(t, err)
	}
	exec(`INSERT INTO users(id,username,lower_username) VALUES(1,'alice','alice')`)
	exec(`INSERT INTO organizations(id,name,lower_name) VALUES(9,'acme','acme')`)
	// 1 repo secret token, 2 org secret token (via org 9), 3 clean,
	// 4 agent setup script token, 5 agent secret token.
	exec(`INSERT INTO repositories(id,user_id,name,lower_name) VALUES(1,1,'r1','r1'),(3,1,'r3','r3'),(4,1,'r4','r4'),(5,1,'r5','r5'),(6,1,'r6','r6')`)
	// 6 repository variable token; 3 has a clean variable.
	// The token sits past the first page of 500 clean rows.
	exec(`INSERT INTO repository_variables(id,repository_id,name,value) SELECT n,3,'V'||n,'clean' FROM generate_series(1,600) n`)
	exec(`INSERT INTO repository_variables(id,repository_id,name,value) VALUES(700,6,'ANTHROPIC_AUTH_TOKEN','sk-ant-oat01-var')`)
	exec(`INSERT INTO repositories(id,org_id,name,lower_name) VALUES(2,9,'r2','r2')`)
	exec(`INSERT INTO repository_secrets(id,repository_id,name,value_encrypted) VALUES(1,1,'ANTHROPIC_AUTH_TOKEN',$1),(2,1,'ANTHROPIC_API_KEY',$2),(3,3,'OPENAI_API_KEY',$3)`,
		seal("sk-ant-oat01-stored"), seal("sk-ant-api03-fine"), seal("sk-proj-fine"))
	exec(`INSERT INTO organization_secrets(id,organization_id,name,value_encrypted) VALUES(1,9,'CLAUDE_CODE_OAUTH_TOKEN',$1)`, seal("anything"))
	exec(`INSERT INTO repository_agent_environments(repository_id,setup_script,environment_variables) VALUES(3,'npm ci','[]'),(4,'export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-x','[]')`)
	exec(`INSERT INTO repository_agent_environment_secrets(repository_id,name,value_encrypted) VALUES(5,'CODEX',$1),(3,'FINE',$2)`,
		seal(`{"auth_mode":"chatgpt","tokens":{"refresh_token":"r"}}`), seal("fine"))
	exec(`INSERT INTO workspaces(repository_id,user_id,status) VALUES(1,1,'running'),(2,1,'suspended'),(3,1,'running'),(4,1,'running'),(5,1,'failed'),(6,1,'suspended')`)
	exec(`INSERT INTO workspaces(repository_id,user_id,status,deleted_at) VALUES(1,1,'stopped',now())`)
	exec(`INSERT INTO workspace_snapshots(repository_id,user_id,name) VALUES(1,1,'s1'),(3,1,'s3')`)

	// A replica already scanning holds the lock: this one steps aside.
	holder, err := pool.Begin(ctx)
	require.NoError(t, err)
	_, err = holder.Exec(ctx, `SELECT pg_advisory_xact_lock(2206)`)
	require.NoError(t, err)
	_, ran, err := services.ScanStoredSubscriptionTokens(ctx, pool, codec)
	require.NoError(t, err)
	require.False(t, ran)
	require.NoError(t, holder.Rollback(ctx))

	counts, ran, err := services.ScanStoredSubscriptionTokens(ctx, pool, codec)
	require.NoError(t, err)
	require.True(t, ran)
	assert.Equal(t, services.StoredSubscriptionTokenScanCounts{
		RepositorySecrets: 1, OrganizationSecrets: 1, AgentEnvironmentSecrets: 1, AgentEnvironments: 1, Variables: 1,
		Workspaces: 5, Snapshots: 1,
	}, counts)

	flagged := func(sql string) []int64 {
		t.Helper()
		rows, err := pool.Query(ctx, sql)
		require.NoError(t, err)
		defer rows.Close()
		var ids []int64
		for rows.Next() {
			var id int64
			require.NoError(t, rows.Scan(&id))
			ids = append(ids, id)
		}
		require.NoError(t, rows.Err())
		return ids
	}
	assert.Equal(t, []int64{1}, flagged(`SELECT id FROM repository_secrets WHERE subscription_token_flagged_at IS NOT NULL ORDER BY id`))
	assert.Equal(t, []int64{1}, flagged(`SELECT id FROM organization_secrets WHERE subscription_token_flagged_at IS NOT NULL`))
	assert.Equal(t, []int64{5}, flagged(`SELECT repository_id FROM repository_agent_environment_secrets WHERE subscription_token_flagged_at IS NOT NULL`))
	assert.Equal(t, []int64{1, 2, 4, 5, 6}, flagged(`SELECT repository_id FROM workspaces WHERE rebuild_required_at IS NOT NULL ORDER BY repository_id`))
	assert.Equal(t, []int64{1}, flagged(`SELECT repository_id FROM workspace_snapshots WHERE rebuild_required_at IS NOT NULL`))

	var stored json.RawMessage
	require.NoError(t, pool.QueryRow(ctx, `SELECT counts FROM stored_subscription_token_scan`).Scan(&stored))
	var recorded services.StoredSubscriptionTokenScanCounts
	require.NoError(t, json.Unmarshal(stored, &recorded))
	assert.Equal(t, counts, recorded)
	assert.NotContains(t, string(stored), "sk-ant")

	// Writing a secret clears its flag; the scan never runs again.
	q := db.New(pool)
	_, err = q.CreateOrUpdateSecret(ctx, db.CreateOrUpdateSecretParams{RepositoryID: 1, Name: "ANTHROPIC_AUTH_TOKEN", ValueEncrypted: seal("sk-ant-api03-new")})
	require.NoError(t, err)
	assert.Empty(t, flagged(`SELECT id FROM repository_secrets WHERE subscription_token_flagged_at IS NOT NULL`))
	exec(`INSERT INTO repository_secrets(id,repository_id,name,value_encrypted) VALUES(10,3,'LATE',$1)`, seal("sk-ant-oat01-late"))
	_, ran, err = services.ScanStoredSubscriptionTokens(ctx, pool, codec)
	require.NoError(t, err)
	assert.False(t, ran)
	assert.Empty(t, flagged(`SELECT id FROM repository_secrets WHERE subscription_token_flagged_at IS NOT NULL`))

	// A value replaced after the scan read it is not flagged.
	rows, err := q.FlagRepositorySecretSubscriptionToken(ctx, db.FlagRepositorySecretSubscriptionTokenParams{ID: 1, ValueEncrypted: seal("sk-ant-oat01-stored")})
	require.NoError(t, err)
	assert.Zero(t, rows)
}
