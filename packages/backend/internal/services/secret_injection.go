package services

import (
	"cmp"
	"context"
	"fmt"
	"regexp"
	"slices"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

const (
	redactedSecretValue        = "********"
	SecretEnvKeysRuntimeMarker = "SMITHERS_SECRET_ENV_KEYS"
)

// MaxInjectedEnvEntries and maxInjectedEnvBytes bound the total size of the
// combined org+repo secret/variable environment injected into a runner or
// sandbox. This caps the work done by log redaction (RedactSecretValues) and
// keeps a single repo/org from exhausting runner memory via unbounded
// secrets/variables.
const (
	MaxInjectedEnvEntries = 1000
	maxInjectedEnvBytes   = 1 << 20
)

var injectedSecretNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

type SecretInjectionQuerier interface {
	GetRepoByID(ctx context.Context, id int64) (db.Repository, error)
	ListSecretValues(ctx context.Context, repositoryID int64) ([]db.ListSecretValuesRow, error)
	ListVariables(ctx context.Context, repositoryID int64) ([]db.RepositoryVariable, error)
	ListOrgSecretValues(ctx context.Context, organizationID int64) ([]db.ListOrgSecretValuesRow, error)
	ListOrgVariables(ctx context.Context, organizationID int64) ([]db.OrganizationVariable, error)
}

type SecretInjector struct {
	queries     SecretInjectionQuerier
	secretCodec webhook.SecretCodec
	// subscriptionTokens mirrors feature_flags.subscription_connections.
	subscriptionTokens bool
}

type SecretInjectorOption func(*SecretInjector)

// WithSecretInjectorSubscriptionTokens lets a self-hosted deployment deliver a
// stored Claude or ChatGPT subscription token. Off by default (hosted).
func WithSecretInjectorSubscriptionTokens(allowed bool) SecretInjectorOption {
	return func(s *SecretInjector) { s.subscriptionTokens = allowed }
}

func NewSecretInjector(q SecretInjectionQuerier, codec webhook.SecretCodec, opts ...SecretInjectorOption) *SecretInjector {
	secretCodec := webhook.SecretCodec(webhook.NoopSecretCodec{})
	if codec != nil {
		secretCodec = codec
	}
	s := &SecretInjector{
		queries:     q,
		secretCodec: secretCodec,
	}
	for _, opt := range opts {
		if opt != nil {
			opt(s)
		}
	}
	return s
}

func (s *SecretInjector) ValidateRepository(ctx context.Context, repositoryID int64) error {
	_, err := s.RepositoryEnvironment(ctx, repositoryID)
	return err
}

// RepositoryEnvironment is the environment of a run that is not a trusted
// run on the default bookmark: it never holds a main-only secret.
func (s *SecretInjector) RepositoryEnvironment(ctx context.Context, repositoryID int64) (map[string]string, error) {
	env, _, err := s.RepositoryEnvironmentAndSecrets(ctx, repositoryID, false)
	return env, err
}

// RepositoryEnvironmentAndSecrets loads one coherent repository/org snapshot
// and derives both the injected environment and the redaction-only secret map
// from the same decrypted rows. Callers that build an execution environment
// must use this method so a concurrent secret rotation cannot inject one value
// while marking/redacting a different value. A main-only repository secret is
// included only for mainTrusted, a trusted run on the default bookmark
// (workflowRunOnTrustedMain); an agent's run never is one.
func (s *SecretInjector) RepositoryEnvironmentAndSecrets(ctx context.Context, repositoryID int64, mainTrusted bool) (map[string]string, map[string]string, error) {
	if repositoryID <= 0 {
		return nil, nil, fmt.Errorf("repository id must be positive")
	}
	if s == nil || s.queries == nil {
		return map[string]string{}, map[string]string{}, nil
	}

	repository, err := s.queries.GetRepoByID(ctx, repositoryID)
	if err != nil {
		return nil, nil, fmt.Errorf("load repository: %w", err)
	}

	env := map[string]string{}
	secrets := map[string]string{}

	// Load organization variables before repository variables; repo values override.
	if repository.OrgID.Valid {
		orgVarRows, err := s.queries.ListOrgVariables(ctx, repository.OrgID.Int64)
		if err != nil {
			return nil, nil, fmt.Errorf("list organization variables: %w", err)
		}
		for _, row := range orgVarRows {
			name := strings.TrimSpace(row.Name)
			if !IsInjectedSecretName(name) {
				return nil, nil, fmt.Errorf("organization variable %q is not a valid environment variable name", row.Name)
			}
			if err := refuseStoredSubscriptionToken(s.subscriptionTokens, "organization variable", name, row.Value); err != nil {
				return nil, nil, err
			}
			if row.Value == "" {
				continue
			}
			env[name] = row.Value
		}
	}

	// Load repository variables before secrets; secrets override on name collision.
	varRows, err := s.queries.ListVariables(ctx, repositoryID)
	if err != nil {
		return nil, nil, fmt.Errorf("list repository variables: %w", err)
	}

	for _, row := range varRows {
		name := strings.TrimSpace(row.Name)
		if !IsInjectedSecretName(name) {
			return nil, nil, fmt.Errorf("repository variable %q is not a valid environment variable name", row.Name)
		}
		if err := refuseStoredSubscriptionToken(s.subscriptionTokens, "repository variable", name, row.Value); err != nil {
			return nil, nil, err
		}
		if row.Value == "" {
			continue
		}
		env[name] = row.Value
	}

	// Load organization secrets before repository secrets; repo secrets override.
	if repository.OrgID.Valid {
		orgSecretRows, err := s.queries.ListOrgSecretValues(ctx, repository.OrgID.Int64)
		if err != nil {
			return nil, nil, fmt.Errorf("list organization secrets: %w", err)
		}
		for _, row := range orgSecretRows {
			name := strings.TrimSpace(row.Name)
			if !IsInjectedSecretName(name) {
				return nil, nil, fmt.Errorf("organization secret %q is not a valid environment variable name", row.Name)
			}
			value, err := s.secretCodec.DecryptString(string(row.ValueEncrypted))
			if err != nil {
				return nil, nil, fmt.Errorf("decrypt organization secret %q: %w", name, err)
			}
			if err := refuseStoredSubscriptionToken(s.subscriptionTokens, "organization secret", name, value); err != nil {
				return nil, nil, err
			}
			if value == "" {
				continue
			}
			env[name] = value
			secrets[name] = value
		}
	}

	secretRows, err := s.queries.ListSecretValues(ctx, repositoryID)
	if err != nil {
		return nil, nil, fmt.Errorf("list repository secrets: %w", err)
	}

	for _, row := range secretRows {
		name := strings.TrimSpace(row.Name)
		if !IsInjectedSecretName(name) {
			return nil, nil, fmt.Errorf("repository secret %q is not a valid environment variable name", row.Name)
		}
		if row.MainOnly && !mainTrusted {
			continue
		}

		value, err := s.secretCodec.DecryptString(string(row.ValueEncrypted))
		if err != nil {
			return nil, nil, fmt.Errorf("decrypt repository secret %q: %w", name, err)
		}
		if err := refuseStoredSubscriptionToken(s.subscriptionTokens, "repository secret", name, value); err != nil {
			return nil, nil, err
		}
		if value == "" {
			continue
		}
		env[name] = value
		secrets[name] = value
	}

	if err := validateInjectedEnvBudget(env); err != nil {
		return nil, nil, err
	}
	return env, secrets, nil
}

func (s *SecretInjector) InjectRepositoryEnvironment(
	ctx context.Context,
	repositoryID int64,
	baseEnv map[string]string,
) (map[string]string, error) {
	result := make(map[string]string, len(baseEnv))
	for key, value := range baseEnv {
		result[key] = value
	}

	secretEnv, err := s.RepositoryEnvironment(ctx, repositoryID)
	if err != nil {
		return nil, err
	}
	for key, value := range secretEnv {
		result[key] = value
	}
	return result, nil
}

func RedactSecretValues(secretEnv map[string]string, text string) string {
	if len(secretEnv) == 0 || text == "" {
		return text
	}

	values := make([]string, 0, len(secretEnv))
	seen := make(map[string]struct{}, len(secretEnv))
	for _, value := range secretEnv {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		values = append(values, trimmed)
	}
	slices.SortFunc(values, func(a, b string) int {
		return cmp.Or(cmp.Compare(len(b), len(a)), strings.Compare(a, b))
	})

	redacted := text
	for _, value := range values {
		redacted = strings.ReplaceAll(redacted, value, redactedSecretValue)
	}
	return redacted
}

func IsInjectedSecretName(name string) bool {
	trimmed := strings.TrimSpace(name)
	return !isReservedInjectedEnvName(trimmed) && injectedSecretNamePattern.MatchString(trimmed)
}

func isReservedInjectedEnvName(name string) bool {
	return strings.TrimSpace(name) == SecretEnvKeysRuntimeMarker
}

// validateInjectedEnvBudget rejects an injected environment that exceeds the
// entry-count or total-byte budget, so runner/sandbox setup and log
// redaction fail fast instead of doing unbounded work.
func validateInjectedEnvBudget(env map[string]string) error {
	totalBytes := injectedEnvByteSize(env)
	if len(env) > MaxInjectedEnvEntries || totalBytes > maxInjectedEnvBytes {
		return fmt.Errorf("injected environment exceeds budget: %d entries / %d bytes (max %d / %d)",
			len(env), totalBytes, MaxInjectedEnvEntries, maxInjectedEnvBytes)
	}
	return nil
}

func injectedEnvByteSize(env map[string]string) int {
	total := 0
	for name, value := range env {
		total += len(name) + len(value)
	}
	return total
}
