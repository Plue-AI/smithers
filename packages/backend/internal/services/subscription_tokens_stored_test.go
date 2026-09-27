package services

import (
	"context"
	"encoding/json"
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
			_, _, err := injector(allowed, []db.ListSecretValuesRow{{Name: "OK", ValueEncrypted: []byte(apiKey)}, {Name: "ANTHROPIC_AUTH_TOKEN", ValueEncrypted: []byte(cipher)}}, nil, nil).RepositoryEnvironmentAndSecrets(ctx, 42)
			return err
		},
		"repository secret, redaction map": func(allowed bool) error {
			_, err := injector(allowed, []db.ListSecretValuesRow{{Name: "ANTHROPIC_AUTH_TOKEN", ValueEncrypted: []byte(cipher)}}, nil, nil).RepositorySecrets(ctx, 42)
			return err
		},
		"organization secret": func(allowed bool) error {
			_, _, err := injector(allowed, nil, []db.ListOrgSecretValuesRow{{Name: "CLAUDE_CODE_OAUTH_TOKEN", ValueEncrypted: []byte(cipher)}}, nil).RepositoryEnvironmentAndSecrets(ctx, 42)
			return err
		},
		"repository variable": func(allowed bool) error {
			_, _, err := injector(allowed, nil, nil, []db.RepositoryVariable{{Name: "ANTHROPIC_AUTH_TOKEN", Value: token}}).RepositoryEnvironmentAndSecrets(ctx, 42)
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
			require.NoError(t, fn(true))
		})
	}
}
