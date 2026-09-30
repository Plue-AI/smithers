package services

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

type mockSecretInjectionQuerier struct {
	getRepoFn          func(ctx context.Context, id int64) (db.Repository, error)
	listSecretValuesFn func(ctx context.Context, repositoryID int64) ([]db.ListSecretValuesRow, error)
	listVariablesFn    func(ctx context.Context, repositoryID int64) ([]db.RepositoryVariable, error)
	listOrgSecretsFn   func(ctx context.Context, organizationID int64) ([]db.ListOrgSecretValuesRow, error)
	listOrgVariablesFn func(ctx context.Context, organizationID int64) ([]db.OrganizationVariable, error)
}

func (m *mockSecretInjectionQuerier) GetRepoByID(ctx context.Context, id int64) (db.Repository, error) {
	if m.getRepoFn != nil {
		return m.getRepoFn(ctx, id)
	}
	return db.Repository{ID: id}, nil
}

func (m *mockSecretInjectionQuerier) ListSecretValues(ctx context.Context, repositoryID int64) ([]db.ListSecretValuesRow, error) {
	if m.listSecretValuesFn != nil {
		return m.listSecretValuesFn(ctx, repositoryID)
	}
	return nil, nil
}

func (m *mockSecretInjectionQuerier) ListVariables(ctx context.Context, repositoryID int64) ([]db.RepositoryVariable, error) {
	if m.listVariablesFn != nil {
		return m.listVariablesFn(ctx, repositoryID)
	}
	return nil, nil
}

func (m *mockSecretInjectionQuerier) ListOrgSecretValues(ctx context.Context, organizationID int64) ([]db.ListOrgSecretValuesRow, error) {
	if m.listOrgSecretsFn != nil {
		return m.listOrgSecretsFn(ctx, organizationID)
	}
	return nil, nil
}

func (m *mockSecretInjectionQuerier) ListOrgVariables(ctx context.Context, organizationID int64) ([]db.OrganizationVariable, error) {
	if m.listOrgVariablesFn != nil {
		return m.listOrgVariablesFn(ctx, organizationID)
	}
	return nil, nil
}

func TestSecretInjector_RepositoryEnvironment_DecryptsSecrets(t *testing.T) {
	t.Parallel()

	injector := NewSecretInjector(&mockSecretInjectionQuerier{
		listSecretValuesFn: func(_ context.Context, repositoryID int64) ([]db.ListSecretValuesRow, error) {
			assert.Equal(t, int64(101), repositoryID)
			return []db.ListSecretValuesRow{
				{Name: "ANTHROPIC_AUTH_TOKEN", ValueEncrypted: []byte("smithers_secret_token")},
				{Name: "OPENAI_API_KEY", ValueEncrypted: []byte("openai-secret")},
			}, nil
		},
	}, webhook.NoopSecretCodec{})

	env, err := injector.RepositoryEnvironment(context.Background(), 101)
	require.NoError(t, err)
	assert.Equal(t, "smithers_secret_token", env["ANTHROPIC_AUTH_TOKEN"])
	assert.Equal(t, "openai-secret", env["OPENAI_API_KEY"])
}

func TestSecretInjector_RepositoryEnvironment_RejectsInvalidSecretNames(t *testing.T) {
	t.Parallel()

	injector := NewSecretInjector(&mockSecretInjectionQuerier{
		listSecretValuesFn: func(_ context.Context, repositoryID int64) ([]db.ListSecretValuesRow, error) {
			return []db.ListSecretValuesRow{
				{Name: "bad-secret-name", ValueEncrypted: []byte("secret")},
			}, nil
		},
	}, webhook.NoopSecretCodec{})

	_, err := injector.RepositoryEnvironment(context.Background(), 101)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "not a valid environment variable name")
}

func TestSecretInjector_RepositoryEnvironment_InjectsVariables(t *testing.T) {
	t.Parallel()

	injector := NewSecretInjector(&mockSecretInjectionQuerier{
		listVariablesFn: func(_ context.Context, repositoryID int64) ([]db.RepositoryVariable, error) {
			assert.Equal(t, int64(202), repositoryID)
			return []db.RepositoryVariable{
				{Name: "DEPLOY_ENV", Value: "production"},
				{Name: "REGION", Value: "us-east-1"},
			}, nil
		},
	}, webhook.NoopSecretCodec{})

	env, err := injector.RepositoryEnvironment(context.Background(), 202)
	require.NoError(t, err)
	assert.Equal(t, "production", env["DEPLOY_ENV"])
	assert.Equal(t, "us-east-1", env["REGION"])
}

func TestSecretInjector_RepositoryEnvironment_SecretsOverrideVariables(t *testing.T) {
	t.Parallel()

	// When a secret and variable share the same name, the secret wins.
	injector := NewSecretInjector(&mockSecretInjectionQuerier{
		listVariablesFn: func(_ context.Context, _ int64) ([]db.RepositoryVariable, error) {
			return []db.RepositoryVariable{
				{Name: "API_KEY", Value: "variable-value"},
			}, nil
		},
		listSecretValuesFn: func(_ context.Context, _ int64) ([]db.ListSecretValuesRow, error) {
			return []db.ListSecretValuesRow{
				{Name: "API_KEY", ValueEncrypted: []byte("secret-value")},
			}, nil
		},
	}, webhook.NoopSecretCodec{})

	env, err := injector.RepositoryEnvironment(context.Background(), 303)
	require.NoError(t, err)
	// Secret takes precedence over same-named variable.
	assert.Equal(t, "secret-value", env["API_KEY"])
}

func TestSecretInjector_RepositoryEnvironment_RejectsInvalidVariableNames(t *testing.T) {
	t.Parallel()

	injector := NewSecretInjector(&mockSecretInjectionQuerier{
		listVariablesFn: func(_ context.Context, _ int64) ([]db.RepositoryVariable, error) {
			return []db.RepositoryVariable{
				{Name: "bad-variable-name", Value: "value"},
			}, nil
		},
	}, webhook.NoopSecretCodec{})

	_, err := injector.RepositoryEnvironment(context.Background(), 404)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "not a valid environment variable name")
}

// TestSecretInjector_SecretsPassedButNotLogged confirms that secrets are present in
// the injected environment (passed to the runner) but are redacted when appearing
// in log output. Variables are NOT redacted because they are not secret.
func TestSecretInjector_SecretsPassedButNotLogged(t *testing.T) {
	t.Parallel()

	injector := NewSecretInjector(&mockSecretInjectionQuerier{
		listVariablesFn: func(_ context.Context, _ int64) ([]db.RepositoryVariable, error) {
			return []db.RepositoryVariable{
				{Name: "BUILD_ENV", Value: "staging"},
			}, nil
		},
		listSecretValuesFn: func(_ context.Context, _ int64) ([]db.ListSecretValuesRow, error) {
			return []db.ListSecretValuesRow{
				{Name: "DB_PASSWORD", ValueEncrypted: []byte("super-secret-password")},
			}, nil
		},
	}, webhook.NoopSecretCodec{})

	// RepositoryEnvironment returns secrets + variables — this is what the runner
	// receives as the job environment (both are passed to the sandbox).
	env, err := injector.RepositoryEnvironment(context.Background(), 505)
	require.NoError(t, err)

	// Secret is present in the environment — passed to the runner.
	assert.Equal(t, "super-secret-password", env["DB_PASSWORD"], "secret must be present in injected environment")
	// Variable is also present.
	assert.Equal(t, "staging", env["BUILD_ENV"], "variable must be present in injected environment")

	// For log redaction the runner uses RepositorySecrets (secrets only), NOT
	// the full environment. This ensures variable values remain visible in logs
	// while secret values are masked. Mixing both would redact innocuous variable
	// values from log output.
	_, secretsOnly, err := injector.RepositoryEnvironmentAndSecrets(context.Background(), 505, false)
	require.NoError(t, err)

	// Simulate a log line that accidentally echoes a secret value.
	logLine := "connecting to database with password=super-secret-password ok"
	redacted := RedactSecretValues(secretsOnly, logLine)

	// The secret value must be redacted in log output.
	assert.NotContains(t, redacted, "super-secret-password", "secret value must not appear in redacted log")
	assert.Equal(t, "connecting to database with password=******** ok", redacted)

	// Variables are plain text and ARE visible in redacted output — they are not secret.
	// Because we pass secretsOnly to RedactSecretValues, variable values are never masked.
	logLineWithVar := "deploying to env=staging"
	redactedWithVar := RedactSecretValues(secretsOnly, logLineWithVar)
	assert.Contains(t, redactedWithVar, "staging", "variable value must remain visible in log output")
}

func TestSecretInjector_RepositoryEnvironment_RejectsOverEntryBudget(t *testing.T) {
	t.Parallel()

	rows := make([]db.RepositoryVariable, MaxInjectedEnvEntries+1)
	for i := range rows {
		rows[i] = db.RepositoryVariable{Name: fmt.Sprintf("VAR_%d", i), Value: "v"}
	}

	injector := NewSecretInjector(&mockSecretInjectionQuerier{
		listVariablesFn: func(_ context.Context, _ int64) ([]db.RepositoryVariable, error) {
			return rows, nil
		},
	}, webhook.NoopSecretCodec{})

	_, err := injector.RepositoryEnvironment(context.Background(), 606)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "exceeds budget")
}

func TestSecretInjector_RepositoryEnvironment_RejectsOverByteBudget(t *testing.T) {
	t.Parallel()

	bigValue := strings.Repeat("x", maxInjectedEnvBytes+1)
	injector := NewSecretInjector(&mockSecretInjectionQuerier{
		listVariablesFn: func(_ context.Context, _ int64) ([]db.RepositoryVariable, error) {
			return []db.RepositoryVariable{{Name: "BIG_VAR", Value: bigValue}}, nil
		},
	}, webhook.NoopSecretCodec{})

	_, err := injector.RepositoryEnvironment(context.Background(), 707)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "exceeds budget")
}

func TestSecretInjector_RepositorySecrets_RejectsOverEntryBudget(t *testing.T) {
	t.Parallel()

	rows := make([]db.ListSecretValuesRow, MaxInjectedEnvEntries+1)
	for i := range rows {
		rows[i] = db.ListSecretValuesRow{Name: fmt.Sprintf("SECRET_%d", i), ValueEncrypted: []byte("v")}
	}

	injector := NewSecretInjector(&mockSecretInjectionQuerier{
		listSecretValuesFn: func(_ context.Context, _ int64) ([]db.ListSecretValuesRow, error) {
			return rows, nil
		},
	}, webhook.NoopSecretCodec{})

	_, _, err := injector.RepositoryEnvironmentAndSecrets(context.Background(), 808, false)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "exceeds budget")
}

func TestRedactSecretValues_RedactsDistinctSecrets(t *testing.T) {
	t.Parallel()

	redacted := RedactSecretValues(map[string]string{
		"ANTHROPIC_AUTH_TOKEN": "smithers_secret_token",
		"SMITHERS_AGENT_TOKEN": "smithers_agent_0123456789abcdef0123456789abcdef01234567",
	}, "token=smithers_secret_token agent=smithers_agent_0123456789abcdef0123456789abcdef01234567")

	assert.Equal(t, "token=******** agent=********", redacted)
}

func TestRedactSecretValues_RedactsMultilineNewlineVariants(t *testing.T) {
	t.Parallel()
	for _, secret := range []string{"first-secret\nsecond-secret", "first-secret\r\nsecond-secret"} {
		for _, newline := range []string{"\n", "\r\n"} {
			assert.Equal(t, "before "+redactedSecretValue+" after", RedactSecretValues(map[string]string{"TOKEN": secret}, "before first-secret"+newline+"second-secret after"), "secret=%q newline=%q", secret, newline)
		}
	}
}

func TestRedactSecretValues_HandlesOverlappingAndAdjacentValues(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name       string
		env        map[string]string
		text, want string
	}{
		{"nil", nil, "ordinary", "ordinary"},
		{"empty text", map[string]string{"TOKEN": "secret"}, "", ""},
		{"blank values", map[string]string{"TOKEN": " \n\r\t"}, "ordinary", "ordinary"},
		{"adjacent", map[string]string{"TOKEN": "abc"}, "abcabc", redactedSecretValue + redactedSecretValue},
		{"contained", map[string]string{"SHORT": "hunter2", "LONG": "pw=hunter2\nTAIL"}, "pw=hunter2\nTAIL", redactedSecretValue},
		{"partial overlap", map[string]string{"FIRST": "abc", "SECOND": "bcd"}, "abcd", redactedSecretValue},
		{"newline dedup", map[string]string{"FIRST": "alpha\nbeta", "SECOND": "alpha\r\nbeta"}, "alpha\nbeta alpha\r\nbeta", redactedSecretValue + " " + redactedSecretValue},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) { assert.Equal(t, tc.want, RedactSecretValues(tc.env, tc.text)) })
	}
}

func TestRedactSecretValues_RedactsSelfOverlappingOccurrences(t *testing.T) {
	t.Parallel()
	assert.Equal(t, redactedSecretValue, RedactSecretValues(map[string]string{"TOKEN": "aba"}, "ababa"))
}

func TestRedactSecretValues_RedactsLongSelfOverlappingOccurrences(t *testing.T) {
	t.Parallel()
	secret := strings.Repeat("a", 64<<10)
	assert.Equal(t, redactedSecretValue, RedactSecretValues(map[string]string{"TOKEN": secret}, secret+secret))
}

func TestRedactSecretValues_BoundsAllocationForLongerThanTextSecrets(t *testing.T) {
	env := map[string]string{"TOKEN": strings.Repeat("s", 1<<20)}
	result := testing.Benchmark(func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			if got := RedactSecretValues(env, "ordinary log"); got != "ordinary log" {
				b.Fatalf("unexpected redaction: %q", got)
			}
		}
	})
	assert.Less(t, result.AllocedBytesPerOp(), int64(1<<20), "an unrelated short line must not compile megabytes of secret patterns")
}
