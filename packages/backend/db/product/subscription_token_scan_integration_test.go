package product

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

// scanFixture seeds a subscription token of each kind: Claude ones the scan
// removes on every deployment (#2777) and ChatGPT ones it flags only where
// they are refused (#2206).
type scanFixture struct {
	pool  *pgxpool.Pool
	codec webhook.SecretCodec
}

func newScanFixture(t *testing.T) scanFixture {
	t.Helper()
	pool := servicesBDatabase(t, 0)
	codec, err := webhook.NewSecretCodec("subscription-token-scan-test-key")
	require.NoError(t, err)
	f := scanFixture{pool: pool, codec: codec}
	chatgpt := `{"auth_mode":"chatgpt","tokens":{"refresh_token":"r"}}`
	f.exec(t, `INSERT INTO users(id,username,lower_username) VALUES(1,'alice','alice')`)
	f.exec(t, `INSERT INTO organizations(id,name,lower_name) VALUES(9,'acme','acme')`)
	// 1 repo secret tokens, 2 org secret tokens (via org 9), 3 clean,
	// 4 agent setup script token, 5 agent secret tokens, 6 variable tokens.
	f.exec(t, `INSERT INTO repositories(id,user_id,name,lower_name) VALUES(1,1,'r1','r1'),(3,1,'r3','r3'),(4,1,'r4','r4'),(5,1,'r5','r5'),(6,1,'r6','r6')`)
	f.exec(t, `INSERT INTO repositories(id,org_id,name,lower_name) VALUES(2,9,'r2','r2')`)
	// The variable tokens sit past the first page of 500 clean rows.
	f.exec(t, `INSERT INTO repository_variables(id,repository_id,name,value) SELECT n,3,'V'||n,'clean' FROM generate_series(1,600) n`)
	f.exec(t, `INSERT INTO repository_variables(id,repository_id,name,value) VALUES(700,6,'ANTHROPIC_AUTH_TOKEN','sk-ant-oat01-var'),(701,6,'OPENAI_CODEX_ACCESS_TOKEN','literal')`)
	f.exec(t, `INSERT INTO repository_secrets(id,repository_id,name,value_encrypted) VALUES(1,1,'ANTHROPIC_AUTH_TOKEN',$1),(2,1,'ANTHROPIC_API_KEY',$2),(3,3,'OPENAI_API_KEY',$3),(4,1,'CODEX_AUTH',$4)`,
		f.seal(t, "sk-ant-oat01-stored"), f.seal(t, "sk-ant-api03-fine"), f.seal(t, "sk-proj-fine"), f.seal(t, chatgpt))
	f.exec(t, `INSERT INTO organization_secrets(id,organization_id,name,value_encrypted) VALUES(1,9,'CLAUDE_CODE_OAUTH_TOKEN',$1),(2,9,'CODEX_AUTH_JSON',$2)`, f.seal(t, "anything"), f.seal(t, "anything"))
	f.exec(t, `INSERT INTO repository_agent_environments(repository_id,setup_script,environment_variables) VALUES(3,'npm ci','[]'),
		(4,'export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-x && npm ci','[{"name":"CLAUDE_CODE_OAUTH_TOKEN","value":"x"},{"name":"KEEP","value":"1"}]')`)
	f.exec(t, `INSERT INTO repository_agent_environment_secrets(repository_id,name,value_encrypted) VALUES(5,'CODEX',$1),(5,'CLAUDE',$2),(3,'FINE',$3)`,
		f.seal(t, chatgpt), f.seal(t, "sk-ant-ort01-refresh"), f.seal(t, "fine"))
	// Model credentials belong to the account: nothing to mark. The tokens
	// sort after a first page of 500 clean credentials.
	f.exec(t, `INSERT INTO owner_model_credentials(user_id,name,origin,value_encrypted) SELECT 1,'K'||lpad(n::text,4,'0'),'https://models.example',$1 FROM generate_series(1,600) n`, string(f.seal(t, "sk-proj-fine")))
	f.exec(t, `INSERT INTO owner_model_credentials(user_id,name,origin,value_encrypted) VALUES(1,'Y_KEY','https://models.example',$1),(1,'Z_KEY','https://models.example',$2),(1,'CUSTOM_KEY','https://models.example',NULL)`,
		string(f.seal(t, chatgpt)), string(f.seal(t, "sk-ant-oat01-model")))
	// Provider connections: a Claude token under a codex label, in either
	// field, is removed; a Codex sign-in and an Anthropic API key stay.
	f.exec(t, `INSERT INTO provider_connections(id,owner_type,user_id,provider,kind,label,access_token_encrypted,refresh_token_encrypted) VALUES
		('00000000-0000-0000-0000-000000000001','user',1,'codex','oauth','claude-refresh',$1,$2),
		('00000000-0000-0000-0000-000000000002','user',1,'codex','oauth','claude-access',$3,$4),
		('00000000-0000-0000-0000-000000000003','user',1,'codex','oauth','codex',$5,$6),
		('00000000-0000-0000-0000-000000000004','user',1,'claude','api_key','key',$7,NULL)`,
		f.seal(t, "at"), f.seal(t, "sk-ant-ort01-refresh"), f.seal(t, "sk-ant-oat01-access"), f.seal(t, "rt"),
		f.seal(t, "codex-at"), f.seal(t, "codex-rt"), f.seal(t, "sk-ant-api03-key"))
	f.exec(t, `INSERT INTO workspaces(repository_id,user_id,status) VALUES(1,1,'running'),(2,1,'suspended'),(3,1,'running'),(4,1,'running'),(5,1,'failed'),(6,1,'suspended')`)
	f.exec(t, `INSERT INTO workspaces(repository_id,user_id,status,deleted_at) VALUES(1,1,'stopped',now())`)
	f.exec(t, `INSERT INTO workspace_snapshots(repository_id,user_id,name) VALUES(1,1,'s1'),(3,1,'s3')`)
	return f
}

func (f scanFixture) exec(t *testing.T, sql string, args ...any) {
	t.Helper()
	_, err := f.pool.Exec(context.Background(), sql, args...)
	require.NoError(t, err)
}

func (f scanFixture) seal(t *testing.T, value string) []byte {
	t.Helper()
	cipher, err := f.codec.EncryptString(value)
	require.NoError(t, err)
	return []byte(cipher)
}

func (f scanFixture) ids(t *testing.T, sql string) []int64 {
	t.Helper()
	rows, err := f.pool.Query(context.Background(), sql)
	require.NoError(t, err)
	ids, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	require.NoError(t, err)
	return ids
}

func (f scanFixture) names(t *testing.T, sql string) []string {
	t.Helper()
	rows, err := f.pool.Query(context.Background(), sql)
	require.NoError(t, err)
	names, err := pgx.CollectRows(rows, pgx.RowTo[string])
	require.NoError(t, err)
	return names
}

// requireClaudeRemoved checks every Claude token of the fixture is gone and
// every other row is as seeded.
func (f scanFixture) requireClaudeRemoved(t *testing.T) {
	t.Helper()
	assert.Equal(t, []int64{2, 3, 4}, f.ids(t, `SELECT id FROM repository_secrets ORDER BY id`))
	assert.Equal(t, []int64{2}, f.ids(t, `SELECT id FROM organization_secrets ORDER BY id`))
	assert.Equal(t, []string{"CODEX", "FINE"}, f.names(t, `SELECT name FROM repository_agent_environment_secrets ORDER BY name`))
	assert.Equal(t, []int64{701}, f.ids(t, `SELECT id FROM repository_variables WHERE repository_id=6`))
	assert.Equal(t, []string{"CUSTOM_KEY", "Z_KEY"}, f.names(t, `SELECT name FROM owner_model_credentials WHERE value_encrypted IS NULL ORDER BY name`))
	var script string
	var variables []map[string]string
	require.NoError(t, f.pool.QueryRow(context.Background(), `SELECT setup_script, environment_variables FROM repository_agent_environments WHERE repository_id=4`).Scan(&script, &variables))
	assert.Equal(t, "export CLAUDE_CODE_OAUTH_TOKEN=[removed:#2777] && npm ci", script)
	assert.Equal(t, []map[string]string{{"name": "KEEP", "value": "1"}}, variables)
	assert.Equal(t, []string{"npm ci"}, f.names(t, `SELECT setup_script FROM repository_agent_environments WHERE repository_id=3`))
	assert.Equal(t, []string{"codex", "key"}, f.names(t, `SELECT label FROM provider_connections ORDER BY id`))
}

// #2206 and #2777: on a deployment that refuses every subscription token the
// scan removes each Claude token, flags each other secret holding one, marks
// the live workspaces and snapshots of every repository that held one, logs
// each removal by table, owner and entry, and records counts only. The Claude
// removal runs again on every start; the ChatGPT flagging does not.
func TestStoredSubscriptionTokenScanRemovesClaudeEveryStartAndFlagsTheRestOnce(t *testing.T) {
	f := newScanFixture(t)
	ctx := context.Background()

	// A replica already scanning holds the lock: this one steps aside.
	holder, err := f.pool.Begin(ctx)
	require.NoError(t, err)
	_, err = holder.Exec(ctx, `SELECT pg_advisory_xact_lock(2206)`)
	require.NoError(t, err)
	_, ran, err := services.ScanStoredSubscriptionTokens(ctx, f.pool, f.codec, false)
	require.NoError(t, err)
	require.False(t, ran)
	require.NoError(t, holder.Rollback(ctx))

	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	counts, ran, err := services.ScanStoredSubscriptionTokens(ctx, f.pool, f.codec, false)
	slog.SetDefault(previous)
	require.NoError(t, err)
	require.True(t, ran)
	assert.Equal(t, services.StoredSubscriptionTokenScanCounts{
		RepositorySecrets: 2, OrganizationSecrets: 2, AgentEnvironmentSecrets: 2, AgentEnvironments: 1, Variables: 2, ModelCredentials: 2,
		ProviderConnections: 2, ClaudeRemoved: 8, Workspaces: 5, Snapshots: 1,
	}, counts)
	f.requireClaudeRemoved(t)
	for _, removed := range []string{
		"table=repository_secrets owner_id=1 entry=ANTHROPIC_AUTH_TOKEN",
		"table=organization_secrets owner_id=9 entry=CLAUDE_CODE_OAUTH_TOKEN",
		"table=repository_agent_environment_secrets owner_id=5 entry=CLAUDE",
		"table=repository_variables owner_id=6 entry=ANTHROPIC_AUTH_TOKEN",
		`table=repository_agent_environments owner_id=4 entry="setup script and variables"`,
		"table=owner_model_credentials owner_id=1 entry=Z_KEY",
		`table=provider_connections owner_id=1 entry="user codex connection 00000000-0000-0000-0000-000000000001"`,
		`table=provider_connections owner_id=1 entry="user codex connection 00000000-0000-0000-0000-000000000002"`,
	} {
		assert.Contains(t, logs.String(), removed)
	}
	assert.Equal(t, 8, strings.Count(logs.String(), "removed a stored Claude subscription token"))
	assert.NotContains(t, logs.String(), "sk-ant")

	assert.Equal(t, []int64{4}, f.ids(t, `SELECT id FROM repository_secrets WHERE subscription_token_flagged_at IS NOT NULL ORDER BY id`))
	assert.Equal(t, []int64{2}, f.ids(t, `SELECT id FROM organization_secrets WHERE subscription_token_flagged_at IS NOT NULL`))
	assert.Equal(t, []string{"CODEX"}, f.names(t, `SELECT name FROM repository_agent_environment_secrets WHERE subscription_token_flagged_at IS NOT NULL`))
	assert.Equal(t, []int64{1, 2, 4, 5, 6}, f.ids(t, `SELECT repository_id FROM workspaces WHERE rebuild_required_at IS NOT NULL ORDER BY repository_id`))
	assert.Equal(t, []int64{1}, f.ids(t, `SELECT repository_id FROM workspace_snapshots WHERE rebuild_required_at IS NOT NULL`))

	var stored json.RawMessage
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT counts FROM stored_subscription_token_scan`).Scan(&stored))
	var recorded services.StoredSubscriptionTokenScanCounts
	require.NoError(t, json.Unmarshal(stored, &recorded))
	assert.Equal(t, counts, recorded)
	assert.NotContains(t, string(stored), "sk-ant")

	// Writing a secret clears its flag. A Claude token an old replica writes
	// later goes on the next start; a ChatGPT one written later is not
	// flagged again.
	q := db.New(f.pool)
	_, err = q.CreateOrUpdateSecret(ctx, db.CreateOrUpdateSecretParams{RepositoryID: 1, Name: "CODEX_AUTH", ValueEncrypted: f.seal(t, "sk-proj-new")})
	require.NoError(t, err)
	assert.Empty(t, f.ids(t, `SELECT id FROM repository_secrets WHERE subscription_token_flagged_at IS NOT NULL`))
	f.exec(t, `INSERT INTO repository_secrets(id,repository_id,name,value_encrypted) VALUES(10,3,'LATE',$1),(11,3,'LATE_CODEX',$2)`,
		f.seal(t, "sk-ant-oat01-late"), f.seal(t, `{"auth_mode":"chatgpt"}`))
	counts, ran, err = services.ScanStoredSubscriptionTokens(ctx, f.pool, f.codec, false)
	require.NoError(t, err)
	require.True(t, ran)
	assert.Equal(t, services.StoredSubscriptionTokenScanCounts{RepositorySecrets: 1, ClaudeRemoved: 1, Workspaces: 1, Snapshots: 1}, counts)
	assert.Equal(t, []int64{2, 3, 4, 11}, f.ids(t, `SELECT id FROM repository_secrets ORDER BY id`))
	assert.Empty(t, f.ids(t, `SELECT id FROM repository_secrets WHERE subscription_token_flagged_at IS NOT NULL`))

	// A value replaced after the scan read it is neither flagged nor removed.
	rows, err := q.FlagRepositorySecretSubscriptionToken(ctx, db.FlagRepositorySecretSubscriptionTokenParams{ID: 4, ValueEncrypted: f.seal(t, "anything")})
	require.NoError(t, err)
	assert.Zero(t, rows)
}

// #2777: a value that does not decrypt (a start with the wrong key) is
// counted and kept, and removed by the first start that reads it.
func TestStoredSubscriptionTokenScanRetriesUnreadableRows(t *testing.T) {
	f := newScanFixture(t)
	ctx := context.Background()
	other, err := webhook.NewSecretCodec("another-deployment-key")
	require.NoError(t, err)
	cipher, err := other.EncryptString("sk-ant-oat01-unreadable")
	require.NoError(t, err)
	f.exec(t, `INSERT INTO repository_secrets(id,repository_id,name,value_encrypted) VALUES(20,3,'OTHER_KEY',$1)`, []byte(cipher))

	counts, ran, err := services.ScanStoredSubscriptionTokens(ctx, f.pool, f.codec, true)
	require.NoError(t, err)
	require.True(t, ran)
	assert.Equal(t, int64(1), counts.Unreadable)
	assert.Equal(t, []int64{20}, f.ids(t, `SELECT id FROM repository_secrets WHERE id=20`))

	counts, ran, err = services.ScanStoredSubscriptionTokens(ctx, f.pool, other, true)
	require.NoError(t, err)
	require.True(t, ran)
	assert.Positive(t, counts.Unreadable, "every other row is unreadable under this key")
	assert.Empty(t, f.ids(t, `SELECT id FROM repository_secrets WHERE id=20`), "the start with the right key removes it")
}

// #2777: a deployment that allows ChatGPT tokens still removes every Claude
// one on every start and marks only what those built; its ChatGPT tokens stay
// unflagged until the deployment turns the flag off.
func TestStoredSubscriptionTokenScanRemovesClaudeWithTheFlagOn(t *testing.T) {
	f := newScanFixture(t)
	ctx := context.Background()

	counts, ran, err := services.ScanStoredSubscriptionTokens(ctx, f.pool, f.codec, true)
	require.NoError(t, err)
	require.True(t, ran)
	assert.Equal(t, services.StoredSubscriptionTokenScanCounts{
		RepositorySecrets: 1, OrganizationSecrets: 1, AgentEnvironmentSecrets: 1, AgentEnvironments: 1, Variables: 1, ModelCredentials: 1,
		ProviderConnections: 2, ClaudeRemoved: 8, Workspaces: 5, Snapshots: 1,
	}, counts)
	f.requireClaudeRemoved(t)
	assert.Empty(t, f.ids(t, `SELECT id FROM repository_secrets WHERE subscription_token_flagged_at IS NOT NULL`))
	assert.Empty(t, f.ids(t, `SELECT id FROM organization_secrets WHERE subscription_token_flagged_at IS NOT NULL`))
	assert.Empty(t, f.names(t, `SELECT name FROM repository_agent_environment_secrets WHERE subscription_token_flagged_at IS NOT NULL`))
	assert.Empty(t, f.ids(t, `SELECT 1::bigint FROM stored_subscription_token_scan`), "the ChatGPT part has not run")

	counts, ran, err = services.ScanStoredSubscriptionTokens(ctx, f.pool, f.codec, true)
	require.NoError(t, err)
	require.True(t, ran, "the Claude removal runs on every start")
	assert.Equal(t, services.StoredSubscriptionTokenScanCounts{}, counts, "nothing left to remove")

	// Turning the flag off runs the ChatGPT part.
	f.exec(t, `UPDATE workspaces SET rebuild_required_at=NULL`)
	counts, ran, err = services.ScanStoredSubscriptionTokens(ctx, f.pool, f.codec, false)
	require.NoError(t, err)
	require.True(t, ran)
	assert.Zero(t, counts.ClaudeRemoved)
	assert.Equal(t, []int64{4}, f.ids(t, `SELECT id FROM repository_secrets WHERE subscription_token_flagged_at IS NOT NULL`))
	assert.Equal(t, []int64{1, 2, 5, 6}, f.ids(t, `SELECT repository_id FROM workspaces WHERE rebuild_required_at IS NOT NULL ORDER BY repository_id`))
}

// #2777: a database the #2206 scan already covered runs only the Claude
// removal: no ChatGPT secret is flagged again and no workspace is marked for
// one.
func TestStoredSubscriptionTokenScanAfterAnEarlierScanOnlyRemovesClaude(t *testing.T) {
	f := newScanFixture(t)
	ctx := context.Background()
	f.exec(t, `INSERT INTO stored_subscription_token_scan(counts) VALUES('{}')`)

	counts, ran, err := services.ScanStoredSubscriptionTokens(ctx, f.pool, f.codec, false)
	require.NoError(t, err)
	require.True(t, ran)
	assert.Equal(t, int64(8), counts.ClaudeRemoved)
	f.requireClaudeRemoved(t)
	assert.Empty(t, f.ids(t, `SELECT id FROM repository_secrets WHERE subscription_token_flagged_at IS NOT NULL`))
	assert.Equal(t, []int64{1, 2, 4, 5, 6}, f.ids(t, `SELECT repository_id FROM workspaces WHERE rebuild_required_at IS NOT NULL ORDER BY repository_id`),
		"repository 6 held a Claude variable too")
}
