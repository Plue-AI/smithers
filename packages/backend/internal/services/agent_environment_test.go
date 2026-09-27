package services

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

type agentEnvironmentTestQuerier struct {
	config        *db.RepositoryAgentEnvironment
	secrets       []db.ListRepositoryAgentEnvironmentSecretsRow
	secretValues  []db.ListRepositoryAgentEnvironmentSecretValuesRow
	storedCipher  []byte
	deletedSecret string
	now           time.Time
	// rebuildMarked lists the repositories whose workspaces and snapshots
	// were marked rebuild-required.
	rebuildMarked []int64
}

func (q *agentEnvironmentTestQuerier) GetRepoByOwnerAndLowerName(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	return db.Repository{ID: 42, UserID: pgtype.Int8{Int64: 7, Valid: true}}, nil
}
func (q *agentEnvironmentTestQuerier) IsOrgOwnerForRepoUser(context.Context, db.IsOrgOwnerForRepoUserParams) (bool, error) {
	return false, nil
}
func (q *agentEnvironmentTestQuerier) GetHighestTeamPermissionForRepoUser(context.Context, db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
	return "", nil
}
func (q *agentEnvironmentTestQuerier) GetCollaboratorPermissionForRepoUser(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
	return "", nil
}
func (q *agentEnvironmentTestQuerier) GetRepositoryAgentEnvironment(context.Context, int64) (db.RepositoryAgentEnvironment, error) {
	if q.config == nil {
		return db.RepositoryAgentEnvironment{}, pgx.ErrNoRows
	}
	return *q.config, nil
}
func (q *agentEnvironmentTestQuerier) UpsertRepositoryAgentEnvironment(_ context.Context, arg db.UpsertRepositoryAgentEnvironmentParams) (db.RepositoryAgentEnvironment, error) {
	row := db.RepositoryAgentEnvironment{
		RepositoryID:         arg.RepositoryID,
		SetupScript:          arg.SetupScript,
		EnvironmentVariables: append(json.RawMessage(nil), arg.EnvironmentVariables...),
		CreatedAt:            q.now,
		UpdatedAt:            q.now,
	}
	q.config = &row
	return row, nil
}
func (q *agentEnvironmentTestQuerier) ListRepositoryAgentEnvironmentSecrets(context.Context, int64) ([]db.ListRepositoryAgentEnvironmentSecretsRow, error) {
	return append([]db.ListRepositoryAgentEnvironmentSecretsRow(nil), q.secrets...), nil
}
func (q *agentEnvironmentTestQuerier) ListRepositoryAgentEnvironmentSecretValues(context.Context, int64) ([]db.ListRepositoryAgentEnvironmentSecretValuesRow, error) {
	return append([]db.ListRepositoryAgentEnvironmentSecretValuesRow(nil), q.secretValues...), nil
}
func (q *agentEnvironmentTestQuerier) UpsertRepositoryAgentEnvironmentSecret(_ context.Context, arg db.UpsertRepositoryAgentEnvironmentSecretParams) (db.UpsertRepositoryAgentEnvironmentSecretRow, error) {
	q.storedCipher = append([]byte(nil), arg.ValueEncrypted...)
	q.secrets = []db.ListRepositoryAgentEnvironmentSecretsRow{{RepositoryID: arg.RepositoryID, Name: arg.Name, Hosts: arg.Hosts, MatchHeaders: arg.MatchHeaders, CreatedAt: q.now, UpdatedAt: q.now}}
	q.secretValues = []db.ListRepositoryAgentEnvironmentSecretValuesRow{{Name: arg.Name, ValueEncrypted: append([]byte(nil), arg.ValueEncrypted...), Hosts: arg.Hosts, MatchHeaders: arg.MatchHeaders}}
	return db.UpsertRepositoryAgentEnvironmentSecretRow{RepositoryID: arg.RepositoryID, Name: arg.Name, Hosts: arg.Hosts, MatchHeaders: arg.MatchHeaders, CreatedAt: q.now, UpdatedAt: q.now}, nil
}
func (q *agentEnvironmentTestQuerier) DeleteRepositoryAgentEnvironmentSecret(_ context.Context, arg db.DeleteRepositoryAgentEnvironmentSecretParams) error {
	q.deletedSecret = arg.Name
	q.secrets = nil
	q.secretValues = nil
	return nil
}

func (q *agentEnvironmentTestQuerier) MarkRepositoryWorkspacesRebuildRequired(_ context.Context, repositoryID int64) (int64, error) {
	q.rebuildMarked = append(q.rebuildMarked, repositoryID)
	return 1, nil
}
func (q *agentEnvironmentTestQuerier) MarkRepositorySnapshotsRebuildRequired(context.Context, int64) (int64, error) {
	return 0, nil
}

func TestAgentEnvironmentService_WriteOnlySecretsEncryptedAtRest(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC)
	store := &agentEnvironmentTestQuerier{now: now}
	codec, err := webhook.NewSecretCodec("agent-environment-unit-test-key")
	require.NoError(t, err)
	service := NewAgentEnvironmentService(store, codec)
	actor := &db.User{ID: 7}

	response, err := service.PutAgentEnvironment(context.Background(), actor, "alice", "demo", PutAgentEnvironmentInput{
		SetupScript: "npm install",
		Env:         []AgentEnvironmentVariable{{Name: "NODE_ENV", Value: "development"}},
		Secrets:     []AgentEnvironmentSecretWrite{{Name: "SETUP_TOKEN", Value: "setup-only-value"}},
	})
	require.NoError(t, err)
	require.Len(t, response.Secrets, 1)
	assert.Equal(t, "SETUP_TOKEN", response.Secrets[0].Name)
	assert.NotEqual(t, []byte("setup-only-value"), store.storedCipher)
	plaintext, err := codec.DecryptString(string(store.storedCipher))
	require.NoError(t, err)
	assert.Equal(t, "setup-only-value", plaintext)

	encoded, err := json.Marshal(response)
	require.NoError(t, err)
	assert.NotContains(t, string(encoded), "setup-only-value")
	assert.NotContains(t, string(encoded), "value_encrypted")

	loaded, err := service.GetAgentEnvironment(context.Background(), actor, "alice", "demo")
	require.NoError(t, err)
	encoded, err = json.Marshal(loaded)
	require.NoError(t, err)
	assert.NotContains(t, string(encoded), "setup-only-value")

	provisioning, err := service.LoadForProvisioning(context.Background(), 42)
	require.NoError(t, err)
	assert.Equal(t, "setup-only-value", provisioning.Secrets["SETUP_TOKEN"])

	require.NoError(t, service.DeleteAgentEnvironmentSecret(context.Background(), actor, "alice", "demo", "SETUP_TOKEN"))
	assert.Equal(t, "SETUP_TOKEN", store.deletedSecret)
}

func TestAgentEnvironmentService_DoesNotDecryptSecretsWithoutSetupScript(t *testing.T) {
	t.Parallel()
	store := &agentEnvironmentTestQuerier{
		config: &db.RepositoryAgentEnvironment{RepositoryID: 42, EnvironmentVariables: json.RawMessage(`[]`)},
		secretValues: []db.ListRepositoryAgentEnvironmentSecretValuesRow{{
			Name:           "UNUSED",
			ValueEncrypted: []byte("not-valid-ciphertext"),
		}},
	}
	codec, err := webhook.NewSecretCodec("agent-environment-unit-test-key")
	require.NoError(t, err)
	config, err := NewAgentEnvironmentService(store, codec).LoadForProvisioning(context.Background(), 42)
	require.NoError(t, err)
	assert.Empty(t, config.Secrets)
}

func TestAgentEnvironmentService_LoadForProvisioningSplitsBoundSecretsWithoutDecryptingThem(t *testing.T) {
	t.Parallel()
	codec, err := webhook.NewSecretCodec("agent-environment-unit-test-key")
	require.NoError(t, err)
	unbound, err := codec.EncryptString("setup-only-value")
	require.NoError(t, err)
	store := &agentEnvironmentTestQuerier{
		config: &db.RepositoryAgentEnvironment{RepositoryID: 42, SetupScript: "true", EnvironmentVariables: json.RawMessage(`[]`)},
		secretValues: []db.ListRepositoryAgentEnvironmentSecretValuesRow{
			// A bound secret must never be decrypted on this path; invalid
			// ciphertext proves it is not even attempted.
			{Name: "API_KEY", ValueEncrypted: []byte("not-valid-ciphertext"), Hosts: []string{"api.example.com"}, MatchHeaders: []string{"authorization"}},
			{Name: "SETUP_TOKEN", ValueEncrypted: []byte(unbound)},
		},
	}
	config, err := NewAgentEnvironmentService(store, codec).LoadForProvisioning(context.Background(), 42)
	require.NoError(t, err)
	assert.Equal(t, []string{"API_KEY"}, config.ProxyBound)
	assert.Equal(t, map[string]string{"SETUP_TOKEN": "setup-only-value"}, config.Secrets)

	// Without a setup script the bound names are still needed (every shell
	// gets the placeholder) while unbound values are not loaded at all.
	store.config.SetupScript = ""
	config, err = NewAgentEnvironmentService(store, codec).LoadForProvisioning(context.Background(), 42)
	require.NoError(t, err)
	assert.Equal(t, []string{"API_KEY"}, config.ProxyBound)
	assert.Empty(t, config.Secrets)
}
