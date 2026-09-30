package services

import (
	"context"
	"encoding/json"
	stdErrors "errors"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/subscriptiontoken"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

const (
	maxAgentEnvironmentEntries    = 100
	maxAgentEnvironmentSetupBytes = 1024 * 1024
	maxAgentEnvironmentValueBytes = 64 * 1024
)

var agentEnvironmentNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// AgentEnvironmentQuerier is the database surface used by the per-repository
// agent workspace environment resource. Secret value queries are deliberately
// absent from all public response paths and used only by LoadForProvisioning.
type AgentEnvironmentQuerier interface {
	RepoPermQuerier
	GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	GetRepositoryAgentEnvironment(ctx context.Context, repositoryID int64) (db.RepositoryAgentEnvironment, error)
	UpsertRepositoryAgentEnvironment(ctx context.Context, arg db.UpsertRepositoryAgentEnvironmentParams) (db.RepositoryAgentEnvironment, error)
	ListRepositoryAgentEnvironmentSecrets(ctx context.Context, repositoryID int64) ([]db.ListRepositoryAgentEnvironmentSecretsRow, error)
	ListRepositoryAgentEnvironmentSecretValues(ctx context.Context, repositoryID int64) ([]db.ListRepositoryAgentEnvironmentSecretValuesRow, error)
	UpsertRepositoryAgentEnvironmentSecret(ctx context.Context, arg db.UpsertRepositoryAgentEnvironmentSecretParams) (db.UpsertRepositoryAgentEnvironmentSecretRow, error)
	DeleteRepositoryAgentEnvironmentSecret(ctx context.Context, arg db.DeleteRepositoryAgentEnvironmentSecretParams) error
	MarkRepositoryWorkspacesRebuildRequired(ctx context.Context, repositoryID int64) (int64, error)
	MarkRepositorySnapshotsRebuildRequired(ctx context.Context, repositoryID int64) (int64, error)
}

type AgentEnvironmentService struct {
	queries        AgentEnvironmentQuerier
	secretCodec    webhook.SecretCodec
	ownershipGuard RepoOwnershipGuard
	// subscriptionTokens mirrors feature_flags.subscription_connections.
	subscriptionTokens bool
}

type AgentEnvironmentServiceOption func(*AgentEnvironmentService)

// WithAgentEnvironmentSubscriptionTokens lets a self-hosted deployment store
// a Claude or ChatGPT subscription token in a repository agent environment.
// Off by default (hosted).
func WithAgentEnvironmentSubscriptionTokens(allowed bool) AgentEnvironmentServiceOption {
	return func(s *AgentEnvironmentService) { s.subscriptionTokens = allowed }
}

func WithAgentEnvironmentOwnershipGuard(guard RepoOwnershipGuard) AgentEnvironmentServiceOption {
	return func(s *AgentEnvironmentService) { s.ownershipGuard = guard }
}

func NewAgentEnvironmentService(q AgentEnvironmentQuerier, codec webhook.SecretCodec, opts ...AgentEnvironmentServiceOption) *AgentEnvironmentService {
	secretCodec := webhook.SecretCodec(webhook.NoopSecretCodec{})
	if codec != nil {
		secretCodec = codec
	}
	s := &AgentEnvironmentService{queries: q, secretCodec: secretCodec}
	for _, opt := range opts {
		if opt != nil {
			opt(s)
		}
	}
	return s
}

type AgentEnvironmentVariable struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// AgentEnvironmentSecretMetadata is the only public representation of a
// setup secret. There is intentionally no Value field. Hosts and
// MatchHeaders are the egress-proxy binding: when both are set the secret is
// substituted by the per-sandbox proxy on requests to those hosts/headers and
// the guest only ever holds the NAME placeholder.
type AgentEnvironmentSecretMetadata struct {
	Name         string    `json:"name"`
	Hosts        []string  `json:"hosts"`
	MatchHeaders []string  `json:"match_headers"`
	UpdatedAt    time.Time `json:"updated_at"`
	// ReconnectRequired reports a secret found holding a subscription token
	// this deployment refuses to use; replacing or deleting it clears it.
	ReconnectRequired bool `json:"reconnect_required,omitempty"`
}

// ProxyBound reports whether the secret is delivered through the egress
// proxy rather than the legacy in-guest environment.
func (m AgentEnvironmentSecretMetadata) ProxyBound() bool {
	return len(m.Hosts) > 0 && len(m.MatchHeaders) > 0
}

type AgentEnvironmentResponse struct {
	SetupScript string                           `json:"setup_script"`
	Env         []AgentEnvironmentVariable       `json:"env"`
	Secrets     []AgentEnvironmentSecretMetadata `json:"secrets"`
	UpdatedAt   *time.Time                       `json:"updated_at"`
	// ReconnectRequired reports that the stored setup script, variables or a
	// secret held a Claude or ChatGPT subscription token this deployment
	// refuses to use. The token is redacted from this answer and nothing runs
	// with the environment until it is saved without one.
	ReconnectRequired bool `json:"reconnect_required,omitempty"`
}

type AgentEnvironmentSecretWrite struct {
	Name  string `json:"name"`
	Value string `json:"value"`
	// Hosts and MatchHeaders bind the secret to the egress proxy. Both or
	// neither: a host without a header location (or the reverse) is rejected
	// because the proxy could not enforce it.
	Hosts        []string `json:"hosts,omitempty"`
	MatchHeaders []string `json:"match_headers,omitempty"`
}

type PutAgentEnvironmentInput struct {
	SetupScript string                        `json:"setup_script"`
	Env         []AgentEnvironmentVariable    `json:"env"`
	Secrets     []AgentEnvironmentSecretWrite `json:"secrets,omitempty"`
}

// AgentEnvironmentProvisioningConfig is internal-only. Secrets in this type
// must never be serialized, logged, persisted in run events, or returned by a
// route. Workspace provisioning keeps it in memory only long enough to render
// and remove the setup wrapper.
type AgentEnvironmentProvisioningConfig struct {
	SetupScript string
	Env         []AgentEnvironmentVariable
	// Secrets are the unbound setup secrets (no egress binding), delivered to
	// the setup run only through the nonpersisting wrapper path.
	Secrets map[string]string
	// ProxyBound names the secrets that carry an egress binding. Their values
	// never enter a workspace: the sandbox is created with them bound to its
	// per-sandbox egress proxy (LoadProxyBoundSecrets) and the guest only ever
	// sees the NAME=NAME placeholder, in the setup run and in every shell.
	ProxyBound []string
}

func (s *AgentEnvironmentService) GetAgentEnvironment(ctx context.Context, actor *db.User, owner, repo string) (AgentEnvironmentResponse, error) {
	repository, err := s.resolveAgentEnvironmentRepo(ctx, owner, repo)
	if err != nil {
		return AgentEnvironmentResponse{}, err
	}
	if err := s.requireAgentEnvironmentWriteAccess(ctx, repository, actor); err != nil {
		return AgentEnvironmentResponse{}, err
	}
	return s.agentEnvironmentResponse(ctx, repository.ID)
}

func (s *AgentEnvironmentService) PutAgentEnvironment(ctx context.Context, actor *db.User, owner, repo string, input PutAgentEnvironmentInput) (AgentEnvironmentResponse, error) {
	if agentEnvironmentContentBytes(input) > middleware.MaxAgentEnvironmentBodySize {
		return AgentEnvironmentResponse{}, pkgerrors.RequestEntityTooLarge("agent environment too large")
	}
	repository, err := s.resolveAgentEnvironmentRepo(ctx, owner, repo)
	if err != nil {
		return AgentEnvironmentResponse{}, err
	}
	if err := s.requireAgentEnvironmentAdminAccess(ctx, repository, actor); err != nil {
		return AgentEnvironmentResponse{}, err
	}

	normalizedEnv, envNames, err := validateAgentEnvironment(input.SetupScript, input.Env)
	if err != nil {
		return AgentEnvironmentResponse{}, err
	}
	if err := refuseSubscriptionToken(s.subscriptionTokens, "", input.SetupScript); err != nil {
		return AgentEnvironmentResponse{}, err
	}
	for _, variable := range normalizedEnv {
		if err := refuseSubscriptionToken(s.subscriptionTokens, variable.Name, variable.Value); err != nil {
			return AgentEnvironmentResponse{}, err
		}
	}
	if len(input.Secrets) > maxAgentEnvironmentEntries {
		return AgentEnvironmentResponse{}, pkgerrors.BadRequest("too many agent environment secrets")
	}

	existingSecrets, err := s.queries.ListRepositoryAgentEnvironmentSecrets(ctx, repository.ID)
	if err != nil {
		return AgentEnvironmentResponse{}, pkgerrors.Internal("failed to load agent environment").WithCause(err)
	}
	for _, secret := range existingSecrets {
		if _, conflict := envNames[secret.Name]; conflict {
			return AgentEnvironmentResponse{}, pkgerrors.BadRequest("environment variable and secret names must be unique")
		}
	}

	type encryptedSecret struct {
		name         string
		value        []byte
		hosts        []string
		matchHeaders []string
	}
	encrypted := make([]encryptedSecret, 0, len(input.Secrets))
	secretNames := make(map[string]struct{}, len(input.Secrets))
	for _, secret := range input.Secrets {
		name, err := validateAgentEnvironmentSecret(secret.Name, secret.Value)
		if err != nil {
			return AgentEnvironmentResponse{}, err
		}
		if err := refuseSubscriptionToken(s.subscriptionTokens, name, secret.Value); err != nil {
			return AgentEnvironmentResponse{}, err
		}
		hosts, matchHeaders, err := validateSecretBinding(secret.Hosts, secret.MatchHeaders)
		if err != nil {
			return AgentEnvironmentResponse{}, err
		}
		if _, duplicate := secretNames[name]; duplicate {
			return AgentEnvironmentResponse{}, pkgerrors.BadRequest("duplicate agent environment secret name")
		}
		if _, conflict := envNames[name]; conflict {
			return AgentEnvironmentResponse{}, pkgerrors.BadRequest("environment variable and secret names must be unique")
		}
		secretNames[name] = struct{}{}
		ciphertext, err := s.secretCodec.EncryptString(secret.Value)
		if err != nil {
			return AgentEnvironmentResponse{}, pkgerrors.Internal("failed to encrypt agent environment secret").WithCause(err)
		}
		encrypted = append(encrypted, encryptedSecret{name: name, value: []byte(ciphertext), hosts: hosts, matchHeaders: matchHeaders})
	}
	if len(existingSecrets)+newSecretCount(existingSecrets, secretNames) > maxAgentEnvironmentEntries {
		return AgentEnvironmentResponse{}, pkgerrors.QuotaExceeded("agent environment secret limit reached (100)")
	}

	envJSON, err := json.Marshal(normalizedEnv)
	if err != nil {
		return AgentEnvironmentResponse{}, pkgerrors.Internal("failed to encode agent environment").WithCause(err)
	}
	stored, err := s.queries.GetRepositoryAgentEnvironment(ctx, repository.ID)
	if err != nil && !stdErrors.Is(err, pgx.ErrNoRows) {
		return AgentEnvironmentResponse{}, pkgerrors.Internal("failed to load agent environment").WithCause(err)
	}
	storedToken := err == nil && agentEnvironmentHoldsSubscriptionToken(s.subscriptionTokens, stored)
	err = guardedRepoWrite(ctx, s.ownershipGuard, repository, func() error {
		if _, err := s.queries.UpsertRepositoryAgentEnvironment(ctx, db.UpsertRepositoryAgentEnvironmentParams{
			RepositoryID:         repository.ID,
			SetupScript:          input.SetupScript,
			EnvironmentVariables: envJSON,
		}); err != nil {
			return pkgerrors.Internal("failed to update agent environment").WithCause(err)
		}
		for _, secret := range encrypted {
			if _, err := s.queries.UpsertRepositoryAgentEnvironmentSecret(ctx, db.UpsertRepositoryAgentEnvironmentSecretParams{
				RepositoryID:   repository.ID,
				Name:           secret.name,
				ValueEncrypted: secret.value,
				Hosts:          secret.hosts,
				MatchHeaders:   secret.matchHeaders,
			}); err != nil {
				return pkgerrors.Internal("failed to update agent environment secret").WithCause(err)
			}
		}
		if storedToken {
			// The replaced token stays in every workspace and snapshot the
			// setup already ran in, until they are rebuilt.
			return markRepositoryRebuildRequired(ctx, s.queries, repository.ID)
		}
		return nil
	})
	if err != nil {
		return AgentEnvironmentResponse{}, err
	}
	return s.agentEnvironmentResponse(ctx, repository.ID)
}

// Valid UTF-8 decoded string bytes cannot exceed the JSON wire bytes. Checking them
// keeps direct service calls bounded without rejecting a wire-valid request
// because Go escapes characters differently from a browser JSON encoder.
func agentEnvironmentContentBytes(input PutAgentEnvironmentInput) int64 {
	total := int64(len(input.SetupScript))
	for _, variable := range input.Env {
		total += int64(len(variable.Name) + len(variable.Value))
	}
	for _, secret := range input.Secrets {
		total += int64(len(secret.Name) + len(secret.Value))
		for _, host := range secret.Hosts {
			total += int64(len(host))
		}
		for _, header := range secret.MatchHeaders {
			total += int64(len(header))
		}
	}
	return total
}

func (s *AgentEnvironmentService) PutAgentEnvironmentSecret(ctx context.Context, actor *db.User, owner, repo string, input AgentEnvironmentSecretWrite) (AgentEnvironmentSecretMetadata, error) {
	repository, err := s.resolveAgentEnvironmentRepo(ctx, owner, repo)
	if err != nil {
		return AgentEnvironmentSecretMetadata{}, err
	}
	if err := s.requireAgentEnvironmentAdminAccess(ctx, repository, actor); err != nil {
		return AgentEnvironmentSecretMetadata{}, err
	}
	name, err := validateAgentEnvironmentSecret(input.Name, input.Value)
	if err != nil {
		return AgentEnvironmentSecretMetadata{}, err
	}
	if err := refuseSubscriptionToken(s.subscriptionTokens, name, input.Value); err != nil {
		return AgentEnvironmentSecretMetadata{}, err
	}
	hosts, matchHeaders, err := validateSecretBinding(input.Hosts, input.MatchHeaders)
	if err != nil {
		return AgentEnvironmentSecretMetadata{}, err
	}
	value := input.Value

	config, err := s.loadAgentEnvironmentRow(ctx, repository.ID)
	if err != nil {
		return AgentEnvironmentSecretMetadata{}, err
	}
	for _, variable := range config.Env {
		if variable.Name == name {
			return AgentEnvironmentSecretMetadata{}, pkgerrors.BadRequest("environment variable and secret names must be unique")
		}
	}
	rows, err := s.queries.ListRepositoryAgentEnvironmentSecrets(ctx, repository.ID)
	if err != nil {
		return AgentEnvironmentSecretMetadata{}, pkgerrors.Internal("failed to load agent environment").WithCause(err)
	}
	if !containsAgentEnvironmentSecret(rows, name) && len(rows) >= maxAgentEnvironmentEntries {
		return AgentEnvironmentSecretMetadata{}, pkgerrors.QuotaExceeded("agent environment secret limit reached (100)")
	}
	ciphertext, err := s.secretCodec.EncryptString(value)
	if err != nil {
		return AgentEnvironmentSecretMetadata{}, pkgerrors.Internal("failed to encrypt agent environment secret").WithCause(err)
	}

	var saved db.UpsertRepositoryAgentEnvironmentSecretRow
	err = guardedRepoWrite(ctx, s.ownershipGuard, repository, func() error {
		var writeErr error
		saved, writeErr = s.queries.UpsertRepositoryAgentEnvironmentSecret(ctx, db.UpsertRepositoryAgentEnvironmentSecretParams{
			RepositoryID:   repository.ID,
			Name:           name,
			ValueEncrypted: []byte(ciphertext),
			Hosts:          hosts,
			MatchHeaders:   matchHeaders,
		})
		if writeErr != nil {
			return pkgerrors.Internal("failed to update agent environment secret").WithCause(writeErr)
		}
		return nil
	})
	if err != nil {
		return AgentEnvironmentSecretMetadata{}, err
	}
	return AgentEnvironmentSecretMetadata{
		Name: saved.Name, Hosts: nonNilStrings(saved.Hosts), MatchHeaders: nonNilStrings(saved.MatchHeaders), UpdatedAt: saved.UpdatedAt,
	}, nil
}

// LoadProxyBoundSecrets decrypts only the secrets that carry an egress-proxy
// binding and returns them shaped for the sandbox provider. It is the one
// path by which an agent-environment secret reaches an agent session, and it
// never returns a value the proxy would not be able to scope.
func (s *AgentEnvironmentService) LoadProxyBoundSecrets(ctx context.Context, repositoryID int64) ([]sandbox.EgressProxySecret, error) {
	if s == nil || s.queries == nil || repositoryID <= 0 {
		return nil, nil
	}
	rows, err := s.queries.ListRepositoryAgentEnvironmentSecretValues(ctx, repositoryID)
	if err != nil {
		return nil, pkgerrors.Internal("failed to load agent environment secrets").WithCause(err)
	}
	var bound []sandbox.EgressProxySecret
	for _, row := range rows {
		if len(row.Hosts) == 0 || len(row.MatchHeaders) == 0 {
			continue
		}
		if !agentEnvironmentNamePattern.MatchString(row.Name) {
			return nil, pkgerrors.Internal("invalid agent environment secret")
		}
		plaintext, err := s.secretCodec.DecryptString(string(row.ValueEncrypted))
		if err != nil {
			return nil, pkgerrors.Internal("failed to decrypt agent environment secret").WithCause(err)
		}
		if err := refuseStoredSubscriptionToken(s.subscriptionTokens, "agent environment secret", row.Name, plaintext); err != nil {
			return nil, err
		}
		secret := sandbox.EgressProxySecret{
			Name: row.Name, Value: plaintext,
			Hosts: append([]string(nil), row.Hosts...), MatchHeaders: append([]string(nil), row.MatchHeaders...),
		}
		if err := secret.Validate(); err != nil {
			return nil, pkgerrors.Internal("invalid agent environment secret binding").WithCause(err)
		}
		bound = append(bound, secret)
	}
	return bound, nil
}

func (s *AgentEnvironmentService) DeleteAgentEnvironmentSecret(ctx context.Context, actor *db.User, owner, repo, name string) error {
	repository, err := s.resolveAgentEnvironmentRepo(ctx, owner, repo)
	if err != nil {
		return err
	}
	if err := s.requireAgentEnvironmentAdminAccess(ctx, repository, actor); err != nil {
		return err
	}
	name = strings.TrimSpace(name)
	if !agentEnvironmentNamePattern.MatchString(name) || len(name) > 255 {
		return pkgerrors.BadRequest("invalid agent environment secret name")
	}
	return guardedRepoWrite(ctx, s.ownershipGuard, repository, func() error {
		if err := s.queries.DeleteRepositoryAgentEnvironmentSecret(ctx, db.DeleteRepositoryAgentEnvironmentSecretParams{
			RepositoryID: repository.ID,
			Name:         name,
		}); err != nil {
			return pkgerrors.Internal("failed to delete agent environment secret").WithCause(err)
		}
		return nil
	})
}

// LoadVariables returns the repository's validated non-secret environment
// variables without loading or decrypting any setup secrets.
func (s *AgentEnvironmentService) LoadVariables(ctx context.Context, repositoryID int64) ([]AgentEnvironmentVariable, error) {
	if s == nil || s.queries == nil || repositoryID <= 0 {
		return nil, nil
	}
	config, err := s.loadAgentEnvironmentRow(ctx, repositoryID)
	if err != nil {
		return nil, err
	}
	if config.SubscriptionToken {
		return nil, storedSubscriptionTokenRefused()
	}
	return append([]AgentEnvironmentVariable(nil), config.Env...), nil
}

// LoadForProvisioning returns plaintext secret values only to the VM setup
// lifecycle. When there is no setup script, secrets are not decrypted at all.
func (s *AgentEnvironmentService) LoadForProvisioning(ctx context.Context, repositoryID int64) (AgentEnvironmentProvisioningConfig, error) {
	if s == nil || s.queries == nil || repositoryID <= 0 {
		return AgentEnvironmentProvisioningConfig{}, nil
	}
	config, err := s.loadAgentEnvironmentRow(ctx, repositoryID)
	if err != nil {
		return AgentEnvironmentProvisioningConfig{}, err
	}
	if config.SubscriptionToken {
		return AgentEnvironmentProvisioningConfig{}, storedSubscriptionTokenRefused()
	}
	result := AgentEnvironmentProvisioningConfig{SetupScript: config.SetupScript, Env: config.Env}
	rows, err := s.queries.ListRepositoryAgentEnvironmentSecretValues(ctx, repositoryID)
	if err != nil {
		return AgentEnvironmentProvisioningConfig{}, pkgerrors.Internal("failed to load agent environment secrets").WithCause(err)
	}
	loadUnbound := strings.TrimSpace(config.SetupScript) != ""
	if loadUnbound {
		result.Secrets = make(map[string]string, len(rows))
	}
	for _, row := range rows {
		if !agentEnvironmentNamePattern.MatchString(row.Name) {
			return AgentEnvironmentProvisioningConfig{}, pkgerrors.Internal("invalid agent environment secret")
		}
		// A bound secret is never decrypted here: it reaches the sandbox only
		// as an egress-proxy binding at create time, and the guest gets the
		// placeholder. Only its name is needed to render that placeholder.
		if len(row.Hosts) > 0 && len(row.MatchHeaders) > 0 {
			result.ProxyBound = append(result.ProxyBound, row.Name)
			continue
		}
		// Unbound secrets exist only for the setup run; without a setup
		// script there is nothing to deliver them to.
		if !loadUnbound {
			continue
		}
		plaintext, err := s.secretCodec.DecryptString(string(row.ValueEncrypted))
		if err != nil {
			return AgentEnvironmentProvisioningConfig{}, pkgerrors.Internal("failed to decrypt agent environment secret").WithCause(err)
		}
		if err := refuseStoredSubscriptionToken(s.subscriptionTokens, "agent environment secret", row.Name, plaintext); err != nil {
			return AgentEnvironmentProvisioningConfig{}, err
		}
		result.Secrets[row.Name] = plaintext
	}
	sort.Strings(result.ProxyBound)
	return result, nil
}

type agentEnvironmentConfigRow struct {
	SetupScript string
	Env         []AgentEnvironmentVariable
	UpdatedAt   *time.Time
	// SubscriptionToken reports a stored Claude or ChatGPT subscription token
	// that this deployment refuses (saved before the setup-script check).
	SubscriptionToken bool
}

func (s *AgentEnvironmentService) loadAgentEnvironmentRow(ctx context.Context, repositoryID int64) (agentEnvironmentConfigRow, error) {
	row, err := s.queries.GetRepositoryAgentEnvironment(ctx, repositoryID)
	if stdErrors.Is(err, pgx.ErrNoRows) {
		return agentEnvironmentConfigRow{Env: []AgentEnvironmentVariable{}}, nil
	}
	if err != nil {
		return agentEnvironmentConfigRow{}, pkgerrors.Internal("failed to load agent environment").WithCause(err)
	}
	var variables []AgentEnvironmentVariable
	if err := json.Unmarshal(row.EnvironmentVariables, &variables); err != nil {
		return agentEnvironmentConfigRow{}, pkgerrors.Internal("invalid stored agent environment").WithCause(err)
	}
	normalized, _, err := validateAgentEnvironment(row.SetupScript, variables)
	if err != nil {
		return agentEnvironmentConfigRow{}, pkgerrors.Internal("invalid stored agent environment").WithCause(err)
	}
	updatedAt := row.UpdatedAt
	config := agentEnvironmentConfigRow{SetupScript: row.SetupScript, Env: normalized, UpdatedAt: &updatedAt}
	config.SubscriptionToken = agentEnvironmentHoldsSubscriptionToken(s.subscriptionTokens, row)
	return config, nil
}

// agentEnvironmentHoldsSubscriptionToken reports a stored setup script or
// variable holding a subscription token the deployment refuses: a Claude one
// always, a ChatGPT one unless allowed. Variables that do not decode are
// checked as one document.
func agentEnvironmentHoldsSubscriptionToken(allowed bool, row db.RepositoryAgentEnvironment) bool {
	if !subscriptionTokenAllowed(allowed, "", row.SetupScript) {
		return true
	}
	var variables []AgentEnvironmentVariable
	if json.Unmarshal(row.EnvironmentVariables, &variables) != nil {
		return !subscriptionTokenAllowed(allowed, "", string(row.EnvironmentVariables))
	}
	for _, variable := range variables {
		if !subscriptionTokenAllowed(allowed, variable.Name, variable.Value) {
			return true
		}
	}
	return false
}

func (s *AgentEnvironmentService) agentEnvironmentResponse(ctx context.Context, repositoryID int64) (AgentEnvironmentResponse, error) {
	config, err := s.loadAgentEnvironmentRow(ctx, repositoryID)
	if err != nil {
		return AgentEnvironmentResponse{}, err
	}
	rows, err := s.queries.ListRepositoryAgentEnvironmentSecrets(ctx, repositoryID)
	if err != nil {
		return AgentEnvironmentResponse{}, pkgerrors.Internal("failed to load agent environment").WithCause(err)
	}
	secrets := make([]AgentEnvironmentSecretMetadata, 0, len(rows))
	flaggedSecret := false
	for _, row := range rows {
		flagged := row.SubscriptionTokenFlaggedAt.Valid && !s.subscriptionTokens
		flaggedSecret = flaggedSecret || flagged
		secrets = append(secrets, AgentEnvironmentSecretMetadata{
			Name: row.Name, Hosts: nonNilStrings(row.Hosts), MatchHeaders: nonNilStrings(row.MatchHeaders), UpdatedAt: row.UpdatedAt,
			ReconnectRequired: flagged,
		})
	}
	response := AgentEnvironmentResponse{
		SetupScript: config.SetupScript,
		Env:         config.Env,
		Secrets:     secrets,
		UpdatedAt:   config.UpdatedAt,
		// A flagged secret alone leaves the script and variables as stored.
		ReconnectRequired: flaggedSecret,
	}
	if config.SubscriptionToken {
		// Never hand a refused token back. Saving this answer as-is drops the
		// token variables and keeps the redacted script.
		response.ReconnectRequired = true
		if s.subscriptionTokens {
			response.SetupScript = subscriptiontoken.RemoveClaude(config.SetupScript)
		} else {
			response.SetupScript = subscriptiontoken.Redact(config.SetupScript)
		}
		response.Env = make([]AgentEnvironmentVariable, 0, len(config.Env))
		for _, variable := range config.Env {
			if subscriptionTokenAllowed(s.subscriptionTokens, variable.Name, variable.Value) {
				response.Env = append(response.Env, variable)
			}
		}
	}
	return response, nil
}

func validateAgentEnvironment(setupScript string, variables []AgentEnvironmentVariable) ([]AgentEnvironmentVariable, map[string]struct{}, error) {
	if !utf8.ValidString(setupScript) || strings.IndexByte(setupScript, 0) >= 0 || len(setupScript) > maxAgentEnvironmentSetupBytes {
		return nil, nil, pkgerrors.BadRequest("invalid agent environment setup script")
	}
	if len(variables) > maxAgentEnvironmentEntries {
		return nil, nil, pkgerrors.BadRequest("too many agent environment variables")
	}
	normalized := make([]AgentEnvironmentVariable, 0, len(variables))
	names := make(map[string]struct{}, len(variables))
	for _, variable := range variables {
		name := strings.TrimSpace(variable.Name)
		if !agentEnvironmentNamePattern.MatchString(name) || len(name) > 255 {
			return nil, nil, pkgerrors.BadRequest("invalid agent environment variable name")
		}
		if !utf8.ValidString(variable.Value) || strings.IndexByte(variable.Value, 0) >= 0 || len(variable.Value) > maxAgentEnvironmentValueBytes {
			return nil, nil, pkgerrors.BadRequest("invalid agent environment variable value")
		}
		if _, duplicate := names[name]; duplicate {
			return nil, nil, pkgerrors.BadRequest("duplicate agent environment variable name")
		}
		names[name] = struct{}{}
		normalized = append(normalized, AgentEnvironmentVariable{Name: name, Value: variable.Value})
	}
	sort.Slice(normalized, func(i, j int) bool { return normalized[i].Name < normalized[j].Name })
	return normalized, names, nil
}

const maxSecretBindingEntries = 20

var secretBindingHeaderPattern = regexp.MustCompile(`^[A-Za-z0-9-]{1,128}$`)

// validateSecretBinding normalises an egress-proxy binding, for
// agent-environment and workflow secrets alike.
// Empty on both sides means the legacy environment path. Hosts must be DNS
// names, "*.suffix" wildcards, or CIDRs; headers must be plain header names.
// A one-sided binding is rejected: the proxy needs both a host and a
// location to scope a swap.
func validateSecretBinding(hosts, matchHeaders []string) ([]string, []string, error) {
	hosts = normaliseBindingList(hosts, strings.ToLower)
	matchHeaders = normaliseBindingList(matchHeaders, strings.ToLower)
	if len(hosts) == 0 && len(matchHeaders) == 0 {
		return []string{}, []string{}, nil
	}
	if len(hosts) == 0 || len(matchHeaders) == 0 {
		return nil, nil, pkgerrors.BadRequest("secret binding needs both hosts and match_headers")
	}
	if len(hosts) > maxSecretBindingEntries || len(matchHeaders) > maxSecretBindingEntries {
		return nil, nil, pkgerrors.BadRequest("secret binding has too many entries")
	}
	for _, host := range hosts {
		if !sandbox.ValidEgressHost(host) {
			return nil, nil, pkgerrors.BadRequest("invalid secret binding host")
		}
	}
	for _, header := range matchHeaders {
		if !secretBindingHeaderPattern.MatchString(header) {
			return nil, nil, pkgerrors.BadRequest("invalid secret binding header")
		}
	}
	return hosts, matchHeaders, nil
}

func normaliseBindingList(values []string, transform func(string) string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = transform(strings.TrimSpace(value))
		if value == "" {
			continue
		}
		if _, duplicate := seen[value]; duplicate {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}

func validateAgentEnvironmentSecret(name, value string) (string, error) {
	name = strings.TrimSpace(name)
	if !agentEnvironmentNamePattern.MatchString(name) || len(name) > 255 {
		return "", pkgerrors.BadRequest("invalid agent environment secret name")
	}
	if value == "" || !utf8.ValidString(value) || strings.IndexByte(value, 0) >= 0 || len(value) > maxAgentEnvironmentValueBytes {
		return "", pkgerrors.BadRequest("invalid agent environment secret value")
	}
	return name, nil
}

func newSecretCount(existing []db.ListRepositoryAgentEnvironmentSecretsRow, names map[string]struct{}) int {
	count := 0
	for name := range names {
		if !containsAgentEnvironmentSecret(existing, name) {
			count++
		}
	}
	return count
}

func containsAgentEnvironmentSecret(rows []db.ListRepositoryAgentEnvironmentSecretsRow, name string) bool {
	for _, row := range rows {
		if row.Name == name {
			return true
		}
	}
	return false
}

func (s *AgentEnvironmentService) resolveAgentEnvironmentRepo(ctx context.Context, owner, repo string) (db.Repository, error) {
	owner = strings.ToLower(strings.TrimSpace(owner))
	repo = strings.ToLower(strings.TrimSpace(repo))
	if owner == "" || repo == "" {
		return db.Repository{}, pkgerrors.BadRequest("repository owner and name are required")
	}
	repository, err := s.queries.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{Owner: owner, LowerName: repo})
	if stdErrors.Is(err, pgx.ErrNoRows) {
		return db.Repository{}, pkgerrors.NotFound("repository not found")
	}
	if err != nil {
		return db.Repository{}, pkgerrors.Internal("failed to load repository").WithCause(err)
	}
	return repository, nil
}

func (s *AgentEnvironmentService) requireAgentEnvironmentWriteAccess(ctx context.Context, repository db.Repository, actor *db.User) error {
	if actor == nil {
		return pkgerrors.Unauthorized("authentication required")
	}
	if actor.IsAdmin {
		return nil
	}
	allowed, err := canWriteRepo(ctx, s.queries, repository, actor.ID)
	if err != nil {
		return err
	}
	if !allowed {
		return pkgerrors.Forbidden("permission denied")
	}
	return nil
}

func nonNilStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

func (s *AgentEnvironmentService) requireAgentEnvironmentAdminAccess(ctx context.Context, repository db.Repository, actor *db.User) error {
	if actor == nil {
		return pkgerrors.Unauthorized("authentication required")
	}
	if actor.IsAdmin {
		return nil
	}
	allowed, err := canAdminRepo(ctx, s.queries, repository, actor.ID)
	if err != nil {
		return err
	}
	if !allowed {
		return pkgerrors.Forbidden("permission denied")
	}
	return nil
}
