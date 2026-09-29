package services

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

// Secrets and variables saved before the write-path refusal (c348432603) can
// still hold a subscription token. With the flag off, no path that decrypts or
// reads one for use delivers it: each refuses with the feature-gate 403, naming
// the secret and never its value (#2206).
func TestStoredSubscriptionTokenSecretsAreRefusedWhenUsed(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	const token = "sk-ant-oat01-storedsecret"
	codec, err := webhook.NewSecretCodec("agent-environment-unit-test-key")
	require.NoError(t, err)
	cipher, err := codec.EncryptString(token)
	require.NoError(t, err)
	apiKey, err := codec.EncryptString("sk-ant-api03-fine")
	require.NoError(t, err)

	injector := func(allowed bool, secrets []db.ListSecretValuesRow, orgSecrets []db.ListOrgSecretValuesRow, variables []db.RepositoryVariable) *SecretInjector {
		return NewSecretInjector(&mockSecretInjectionQuerier{
			getRepoFn: func(context.Context, int64) (db.Repository, error) {
				return db.Repository{ID: 42, OrgID: pgtype.Int8{Int64: 9, Valid: true}}, nil
			},
			listSecretValuesFn: func(context.Context, int64) ([]db.ListSecretValuesRow, error) { return secrets, nil },
			listOrgSecretsFn:   func(context.Context, int64) ([]db.ListOrgSecretValuesRow, error) { return orgSecrets, nil },
			listVariablesFn:    func(context.Context, int64) ([]db.RepositoryVariable, error) { return variables, nil },
		}, codec, WithSecretInjectorSubscriptionTokens(allowed))
	}
	agentEnvironment := func(allowed bool, bound bool) *AgentEnvironmentService {
		row := db.ListRepositoryAgentEnvironmentSecretValuesRow{Name: "ANTHROPIC_AUTH_TOKEN", ValueEncrypted: []byte(cipher)}
		if bound {
			row.Hosts, row.MatchHeaders = []string{"api.anthropic.com"}, []string{"Authorization"}
		}
		store := &agentEnvironmentTestQuerier{
			config:       &db.RepositoryAgentEnvironment{RepositoryID: 42, SetupScript: "npm ci", EnvironmentVariables: json.RawMessage(`[]`)},
			secretValues: []db.ListRepositoryAgentEnvironmentSecretValuesRow{row},
		}
		return NewAgentEnvironmentService(store, codec, WithAgentEnvironmentSubscriptionTokens(allowed))
	}

	type use func(allowed bool) error
	for name, fn := range map[string]use{
		"repository secret, injected": func(allowed bool) error {
			_, _, err := injector(allowed, []db.ListSecretValuesRow{{Name: "OK", ValueEncrypted: []byte(apiKey)}, {Name: "ANTHROPIC_AUTH_TOKEN", ValueEncrypted: []byte(cipher)}}, nil, nil).RepositoryEnvironmentAndSecrets(ctx, 42, false)
			return err
		},
		"repository secret, redaction map": func(allowed bool) error {
			_, _, err := injector(allowed, []db.ListSecretValuesRow{{Name: "ANTHROPIC_AUTH_TOKEN", ValueEncrypted: []byte(cipher)}}, nil, nil).RepositoryEnvironmentAndSecrets(ctx, 42, false)
			return err
		},
		"organization secret": func(allowed bool) error {
			_, _, err := injector(allowed, nil, []db.ListOrgSecretValuesRow{{Name: "CLAUDE_CODE_OAUTH_TOKEN", ValueEncrypted: []byte(cipher)}}, nil).RepositoryEnvironmentAndSecrets(ctx, 42, false)
			return err
		},
		"repository variable": func(allowed bool) error {
			_, _, err := injector(allowed, nil, nil, []db.RepositoryVariable{{Name: "ANTHROPIC_AUTH_TOKEN", Value: token}}).RepositoryEnvironmentAndSecrets(ctx, 42, false)
			return err
		},
		"repository secret, direct": func(allowed bool) error {
			svc := NewSecretService(&mockSecretQuerier{listSecretValuesFn: func(context.Context, int64) ([]db.ListSecretValuesForRepoRow, error) {
				return []db.ListSecretValuesForRepoRow{{Name: "ANTHROPIC_AUTH_TOKEN", ValueEncrypted: []byte(cipher)}}, nil
			}}, codec, WithSecretSubscriptionTokens(allowed))
			_, err := svc.ListDecryptedSecretsForRepo(ctx, 42)
			return err
		},
		"agent environment secret, setup run": func(allowed bool) error {
			_, err := agentEnvironment(allowed, false).LoadForProvisioning(ctx, 42)
			return err
		},
		"agent environment secret, egress proxy": func(allowed bool) error {
			_, err := agentEnvironment(allowed, true).LoadProxyBoundSecrets(ctx, 42)
			return err
		},
	} {
		t.Run(name, func(t *testing.T) {
			err := fn(false)
			requireSubscriptionTokenRefused(t, err)
			assert.NotContains(t, err.Error(), token)
			assert.Regexp(t, `ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN`, err.Error())
			// A stored Claude subscription token is refused with the flag on
			// too (#2777).
			requireSubscriptionTokenRefused(t, fn(true))
		})
	}
}

// A secret the one-time scan flagged is shown for reconnecting or removing;
// replacing or deleting it is the existing write path, which clears it.
func TestFlaggedSubscriptionTokenSecretsAskForReconnect(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	flagged := pgtype.Timestamptz{Valid: true}
	secrets := NewSecretService(&mockSecretQuerier{
		listSecretsFn: func(context.Context, int64) ([]db.ListSecretsRow, error) {
			return []db.ListSecretsRow{{Name: "ANTHROPIC_AUTH_TOKEN", SubscriptionTokenFlaggedAt: flagged}, {Name: "OK"}}, nil
		},
		listOrgSecretsFn: func(context.Context, int64) ([]db.ListOrgSecretsRow, error) {
			return []db.ListOrgSecretsRow{{Name: "CLAUDE", SubscriptionTokenFlaggedAt: flagged}}, nil
		},
	}, webhook.NoopSecretCodec{})
	repo, err := secrets.ListSecrets(ctx, &db.User{ID: 1}, "alice", "demo")
	require.NoError(t, err)
	require.Len(t, repo, 2)
	assert.True(t, repo[0].ReconnectRequired)
	assert.False(t, repo[1].ReconnectRequired)
	encoded, err := json.Marshal(repo)
	require.NoError(t, err)
	assert.Equal(t, 1, strings.Count(string(encoded), `"reconnect_required":true`))
	org, err := secrets.ListOrgSecrets(ctx, &db.User{ID: 1}, "acme")
	require.NoError(t, err)
	assert.True(t, org[0].ReconnectRequired)

	store := &agentEnvironmentTestQuerier{
		config:  &db.RepositoryAgentEnvironment{RepositoryID: 42, SetupScript: "npm ci", EnvironmentVariables: json.RawMessage(`[]`)},
		secrets: []db.ListRepositoryAgentEnvironmentSecretsRow{{RepositoryID: 42, Name: "ANTHROPIC_AUTH_TOKEN", SubscriptionTokenFlaggedAt: flagged}},
	}
	codec, err := webhook.NewSecretCodec("agent-environment-unit-test-key")
	require.NoError(t, err)
	response, err := NewAgentEnvironmentService(store, codec).GetAgentEnvironment(ctx, &db.User{ID: 7}, "alice", "demo")
	require.NoError(t, err)
	assert.True(t, response.ReconnectRequired)
	require.Len(t, response.Secrets, 1)
	assert.True(t, response.Secrets[0].ReconnectRequired)
	// The flag is this deployment's refusal: a self-hoster who stores tokens
	// is never asked to reconnect.
	response, err = NewAgentEnvironmentService(store, codec, WithAgentEnvironmentSubscriptionTokens(true)).GetAgentEnvironment(ctx, &db.User{ID: 7}, "alice", "demo")
	require.NoError(t, err)
	assert.False(t, response.ReconnectRequired)
	assert.False(t, response.Secrets[0].ReconnectRequired)
}

// Removing a stored token from the agent environment does not remove it from
// the workspaces its setup already ran in: saving over it marks them for a
// rebuild, whether or not the one-time scan reached the row first.
func TestReplacingAStoredSubscriptionTokenMarksWorkspacesForRebuild(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	codec, err := webhook.NewSecretCodec("agent-environment-unit-test-key")
	require.NoError(t, err)
	store := &agentEnvironmentTestQuerier{config: &db.RepositoryAgentEnvironment{
		RepositoryID: 42, SetupScript: "export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-x\nnpm ci", EnvironmentVariables: json.RawMessage(`[]`),
	}}
	svc := NewAgentEnvironmentService(store, codec)
	response, err := svc.GetAgentEnvironment(ctx, &db.User{ID: 7}, "alice", "demo")
	require.NoError(t, err)
	_, err = svc.PutAgentEnvironment(ctx, &db.User{ID: 7}, "alice", "demo", PutAgentEnvironmentInput{SetupScript: response.SetupScript})
	require.NoError(t, err)
	assert.Equal(t, []int64{42}, store.rebuildMarked)

	// An ordinary save marks nothing.
	_, err = svc.PutAgentEnvironment(ctx, &db.User{ID: 7}, "alice", "demo", PutAgentEnvironmentInput{SetupScript: "npm test"})
	require.NoError(t, err)
	assert.Equal(t, []int64{42}, store.rebuildMarked)
}
