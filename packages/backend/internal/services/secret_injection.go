package services

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/sandbox"
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

// RepositoryEnvironmentAndSecrets is RepositorySecrets' environment and
// redaction map. A secret bound to hosts is in neither: it reaches a guest
// only through its egress proxy, which only a NixOS CI guest has.
func (s *SecretInjector) RepositoryEnvironmentAndSecrets(ctx context.Context, repositoryID int64, mainTrusted bool) (map[string]string, map[string]string, error) {
	snapshot, err := s.RepositorySecrets(ctx, repositoryID, mainTrusted)
	if err != nil {
		return nil, nil, err
	}
	return snapshot.Env, snapshot.Secrets, nil
}

// RepositorySecretSnapshot is one coherent read of a repository's and its
// organization's variables and secrets.
type RepositorySecretSnapshot struct {
	// Env holds variables and the unbound secrets' values.
	Env map[string]string
	// Secrets holds the unbound secrets' values, for redaction.
	Secrets map[string]string
	// Bound holds the secrets bound to hosts, with their values, sorted by
	// name. Only an egress proxy may carry them into a guest.
	Bound []sandbox.EgressProxySecret
}

// RepositorySecrets loads one coherent repository/org snapshot and derives
// the injected environment, the redaction-only secret map and the bound
// secrets from the same decrypted rows. Callers that build an execution
// environment must use it (or RepositoryEnvironmentAndSecrets) so a
// concurrent secret rotation cannot inject one value while marking/redacting
// a different value. A main-only repository secret is included only for
// mainTrusted, a trusted run on the default bookmark
// (workflowRunOnTrustedMain); an agent's run never is one. A repository
// secret overrides an organization secret of the same name, binding and all.
func (s *SecretInjector) RepositorySecrets(ctx context.Context, repositoryID int64, mainTrusted bool) (RepositorySecretSnapshot, error) {
	if repositoryID <= 0 {
		return RepositorySecretSnapshot{}, fmt.Errorf("repository id must be positive")
	}
	if s == nil || s.queries == nil {
		return RepositorySecretSnapshot{Env: map[string]string{}, Secrets: map[string]string{}}, nil
	}

	repository, err := s.queries.GetRepoByID(ctx, repositoryID)
	if err != nil {
		return RepositorySecretSnapshot{}, fmt.Errorf("load repository: %w", err)
	}

	env := map[string]string{}
	secrets := map[string]string{}
	bound := map[string]sandbox.EgressProxySecret{}
	// keep records one decrypted secret under the binding it carries.
	keep := func(kind, name, value string, hosts, matchHeaders []string) error {
		if len(hosts) == 0 && len(matchHeaders) == 0 {
			delete(bound, name)
			env[name] = value
			secrets[name] = value
			return nil
		}
		secret := sandbox.EgressProxySecret{
			Name: name, Value: value,
			Hosts: append([]string(nil), hosts...), MatchHeaders: append([]string(nil), matchHeaders...),
		}
		if err := secret.Validate(); err != nil {
			return fmt.Errorf("%s %q has an invalid host binding: %w", kind, name, err)
		}
		delete(env, name)
		delete(secrets, name)
		bound[name] = secret
		return nil
	}

	// Load organization variables before repository variables; repo values override.
	if repository.OrgID.Valid {
		orgVarRows, err := s.queries.ListOrgVariables(ctx, repository.OrgID.Int64)
		if err != nil {
			return RepositorySecretSnapshot{}, fmt.Errorf("list organization variables: %w", err)
		}
		for _, row := range orgVarRows {
			name := strings.TrimSpace(row.Name)
			if !IsInjectedSecretName(name) {
				return RepositorySecretSnapshot{}, fmt.Errorf("organization variable %q is not a valid environment variable name", row.Name)
			}
			if err := refuseStoredSubscriptionToken(s.subscriptionTokens, "organization variable", name, row.Value); err != nil {
				return RepositorySecretSnapshot{}, err
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
		return RepositorySecretSnapshot{}, fmt.Errorf("list repository variables: %w", err)
	}

	for _, row := range varRows {
		name := strings.TrimSpace(row.Name)
		if !IsInjectedSecretName(name) {
			return RepositorySecretSnapshot{}, fmt.Errorf("repository variable %q is not a valid environment variable name", row.Name)
		}
		if err := refuseStoredSubscriptionToken(s.subscriptionTokens, "repository variable", name, row.Value); err != nil {
			return RepositorySecretSnapshot{}, err
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
			return RepositorySecretSnapshot{}, fmt.Errorf("list organization secrets: %w", err)
		}
		for _, row := range orgSecretRows {
			name := strings.TrimSpace(row.Name)
			if !IsInjectedSecretName(name) {
				return RepositorySecretSnapshot{}, fmt.Errorf("organization secret %q is not a valid environment variable name", row.Name)
			}
			value, err := s.secretCodec.DecryptString(string(row.ValueEncrypted))
			if err != nil {
				return RepositorySecretSnapshot{}, fmt.Errorf("decrypt organization secret %q: %w", name, err)
			}
			if err := refuseStoredSubscriptionToken(s.subscriptionTokens, "organization secret", name, value); err != nil {
				return RepositorySecretSnapshot{}, err
			}
			if value == "" {
				continue
			}
			if err := keep("organization secret", name, value, row.Hosts, row.MatchHeaders); err != nil {
				return RepositorySecretSnapshot{}, err
			}
		}
	}

	secretRows, err := s.queries.ListSecretValues(ctx, repositoryID)
	if err != nil {
		return RepositorySecretSnapshot{}, fmt.Errorf("list repository secrets: %w", err)
	}

	for _, row := range secretRows {
		name := strings.TrimSpace(row.Name)
		if !IsInjectedSecretName(name) {
			return RepositorySecretSnapshot{}, fmt.Errorf("repository secret %q is not a valid environment variable name", row.Name)
		}
		if row.MainOnly && !mainTrusted {
			continue
		}

		value, err := s.secretCodec.DecryptString(string(row.ValueEncrypted))
		if err != nil {
			return RepositorySecretSnapshot{}, fmt.Errorf("decrypt repository secret %q: %w", name, err)
		}
		if err := refuseStoredSubscriptionToken(s.subscriptionTokens, "repository secret", name, value); err != nil {
			return RepositorySecretSnapshot{}, err
		}
		if value == "" {
			continue
		}
		if err := keep("repository secret", name, value, row.Hosts, row.MatchHeaders); err != nil {
			return RepositorySecretSnapshot{}, err
		}
	}

	budget := make(map[string]string, len(env)+len(bound))
	for name, value := range env {
		budget[name] = value
	}
	snapshot := RepositorySecretSnapshot{Env: env, Secrets: secrets}
	for name, secret := range bound {
		budget[name] = secret.Value
		snapshot.Bound = append(snapshot.Bound, secret)
	}
	if err := validateInjectedEnvBudget(budget); err != nil {
		return RepositorySecretSnapshot{}, err
	}
	slices.SortFunc(snapshot.Bound, func(a, b sandbox.EgressProxySecret) int { return strings.Compare(a.Name, b.Name) })
	return snapshot, nil
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

// secretSpan marks raw bytes to hide. rendered tracks a mask already emitted
// when a workflow log's bounded buffer splits a secret across stored entries.
type secretSpan struct {
	start, end int
	rendered   bool
}

func secretValues(secretEnv map[string]string) []string {
	values := make([]string, 0, len(secretEnv))
	seen := make(map[string]struct{}, len(secretEnv))
	for _, value := range secretEnv {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		normalized := strings.ReplaceAll(trimmed, "\r\n", "\n")
		for _, candidate := range []string{trimmed, normalized, strings.ReplaceAll(normalized, "\n", "\r\n")} {
			if _, ok := seen[candidate]; ok {
				continue
			}
			seen[candidate] = struct{}{}
			values = append(values, candidate)
		}
	}
	return values
}

type secretPattern struct {
	value  string
	prefix []int
}

func newSecretPatterns(values []string) []secretPattern {
	patterns := []secretPattern{}
	seen := map[string]bool{}
	for _, value := range values {
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		pattern := secretPattern{value: value, prefix: make([]int, len(value))}
		for i, matched := 1, 0; i < len(value); i++ {
			for matched > 0 && value[i] != value[matched] {
				matched = pattern.prefix[matched-1]
			}
			if value[i] == value[matched] {
				matched++
			}
			pattern.prefix[i] = matched
		}
		patterns = append(patterns, pattern)
	}
	return patterns
}

func findSecretSpans(patterns []secretPattern, text string) []secretSpan {
	spans := []secretSpan{}
	for _, pattern := range patterns {
		first := len(spans)
		matched := 0
		for i := 0; i < len(text); i++ {
			for matched > 0 && text[i] != pattern.value[matched] {
				matched = pattern.prefix[matched-1]
			}
			if text[i] == pattern.value[matched] {
				matched++
			}
			if matched == len(pattern.value) {
				span := secretSpan{start: i + 1 - matched, end: i + 1}
				if len(spans) > first && span.start < spans[len(spans)-1].end {
					spans[len(spans)-1].end = span.end
				} else {
					spans = append(spans, span)
				}
				matched = pattern.prefix[matched-1]
			}
		}
	}
	return spans
}

func mergeSecretSpans(spans []secretSpan) []secretSpan {
	slices.SortFunc(spans, func(a, b secretSpan) int { return cmp.Or(cmp.Compare(a.start, b.start), cmp.Compare(b.end, a.end)) })
	merged := spans[:0]
	for _, span := range spans {
		if len(merged) > 0 && span.start < merged[len(merged)-1].end {
			last := &merged[len(merged)-1]
			last.end = max(last.end, span.end)
			last.rendered = last.rendered || span.rendered
		} else {
			merged = append(merged, span)
		}
	}
	return merged
}

func redactSecretSpans(text string, spans []secretSpan) string {
	var redacted strings.Builder
	cursor := 0
	for _, span := range spans {
		if span.start >= len(text) {
			break
		}
		end := min(span.end, len(text))
		redacted.WriteString(text[cursor:span.start])
		if !span.rendered {
			redacted.WriteString(redactedSecretValue)
		}
		cursor = end
	}
	redacted.WriteString(text[cursor:])
	return redacted.String()
}

func RedactSecretValues(secretEnv map[string]string, text string) string {
	if len(secretEnv) == 0 || text == "" {
		return text
	}
	values := secretValues(secretEnv)
	matching := values[:0]
	for _, value := range values {
		if len(value) <= len(text) {
			matching = append(matching, value)
		}
	}
	return redactCompiledSecretValues(newSecretPatterns(matching), text)
}

func redactCompiledSecretValues(patterns []secretPattern, text string) string {
	return redactSecretSpans(text, mergeSecretSpans(findSecretSpans(patterns, text)))
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

// sealRedactionValues seals a run's retained redaction values like a stored
// secret, so they are encrypted at rest.
func (s *SecretInjector) sealRedactionValues(values []string) (string, error) {
	if len(values) == 0 {
		return "", nil
	}
	encoded, err := json.Marshal(values)
	if err != nil {
		return "", err
	}
	return s.secretCodec.EncryptString(string(encoded))
}

// openRedactionValues is sealRedactionValues' inverse; an empty seal holds no
// values.
func (s *SecretInjector) openRedactionValues(sealed string) ([]string, error) {
	if sealed == "" {
		return nil, nil
	}
	encoded, err := s.secretCodec.DecryptString(sealed)
	if err != nil {
		return nil, err
	}
	var values []string
	if err := json.Unmarshal([]byte(encoded), &values); err != nil {
		return nil, err
	}
	return values, nil
}
