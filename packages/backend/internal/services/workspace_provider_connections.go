package services

import (
	"context"
	"slices"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// workspaceProviderBinding is operation-scoped. Only egress carries credentials;
// environment and files contain public account metadata and placeholders.
type workspaceProviderBinding struct {
	environment AgentEnvironmentProvisioningConfig
	egress      *sandbox.EgressProxyPolicy
	// pooled are the seats connected accounts serve at boot; they count as
	// available when the coding model is chosen.
	pooled []string
}

func (s *WorkspaceService) resolveWorkspaceProviderBindings(ctx context.Context, workspace db.Workspace) (*workspaceProviderBinding, error) {
	binding := &workspaceProviderBinding{}
	var err error
	binding.egress, err = s.workspaceEgressProxy(ctx, workspace.RepositoryID, workspace.ID)
	if err != nil {
		return nil, err
	}
	if s.agentEnvironment != nil {
		binding.environment, err = s.agentEnvironment.LoadForProvisioning(ctx, workspace.RepositoryID)
		if err != nil {
			return nil, agentEnvironmentLoadError(err)
		}
	}
	// Copy slices before adding runtime values; providers may cache their config.
	binding.environment.Env = slices.Clone(binding.environment.Env)
	binding.environment.ProxyBound = slices.Clone(binding.environment.ProxyBound)
	// Choose from repository runtime credentials before adding subscriptions
	// or platform fallbacks. A setup-only secret is deliberately not usable by
	// a long-running coding host and still shadows the same provider fallback.
	model := workspaceCodingModel(binding.availableProviderNames(), "")
	// Connected provider accounts are served per request by the account pool
	// route (provider_pool.go), never bound into the guest: the guest holds a
	// workspace-bound pool credential that the egress proxy swaps in on
	// requests to this API host only. Explicit repository-admin API keys win
	// over the pool, which in turn replaces platform credentials.
	if s.providerConnections != nil && workspace.Kind != "agent" {
		if err := s.bindWorkspaceProviderPool(ctx, workspace, binding); err != nil {
			return nil, err
		}
		if model == "" {
			model = workspaceCodingModel(binding.availableProviderNames(), "")
		}
	}
	if s.providerBootstrap && workspace.RepositoryID > 0 && workspace.UserID > 0 && workspace.Kind != "agent" {
		if model == "" {
			model = workspaceCodingModel(binding.availableProviderNames(), "")
		}
		if err := s.bindWorkspaceModelProxy(ctx, workspace, binding); err != nil {
			return nil, err
		}
		if model == "" {
			model = workspaceCodingModel(binding.availableProviderNames(), s.codingDefaultModel)
		}
		present := slices.ContainsFunc(binding.environment.Env, func(v AgentEnvironmentVariable) bool { return v.Name == "SMITHERS_CODING_IMPLEMENT_MODEL" })
		// Preserve an unavailable explicit deployment pin as a blank model, so
		// old-box fallback cannot silently switch to a different provider.
		if !present && (model != "" || s.codingDefaultModel != "") {
			binding.setEnv("SMITHERS_CODING_IMPLEMENT_MODEL", model)
		}
	}
	if err := binding.egress.Validate(); err != nil {
		return nil, pkgerrors.Internal("invalid workspace provider binding").WithCause(err)
	}
	return binding, nil
}

func workspaceProviderFamily(name string) []string {
	switch name {
	case "OPENAI_API_KEY", "OPENAI_CODEX_ACCESS_TOKEN":
		return []string{"OPENAI_API_KEY", "OPENAI_CODEX_ACCESS_TOKEN"}
	case "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN":
		return []string{"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"}
	default:
		return []string{name}
	}
}

func workspaceDeclaresProvider(config AgentEnvironmentProvisioningConfig, key string) bool {
	for _, name := range workspaceProviderFamily(key) {
		if _, ok := config.Secrets[name]; ok {
			return true
		}
		if slices.Contains(config.ProxyBound, name) || slices.ContainsFunc(config.Env, func(v AgentEnvironmentVariable) bool { return v.Name == name }) {
			return true
		}
	}
	return false
}

func (b *workspaceProviderBinding) availableProviderNames() map[string]bool {
	names := map[string]bool{}
	for _, name := range b.pooled {
		names[name] = true
	}
	for _, secret := range b.egress.Secrets {
		if secret.Value != sandbox.EgressProxyPlaceholder(secret.Name) && secret.Value != "[redacted]" && IsUsableProviderCredential(secret.Value) && slices.Contains(b.environment.ProxyBound, secret.Name) {
			names[secret.Name] = true
		}
	}
	for _, env := range b.environment.Env {
		if env.Value != sandbox.EgressProxyPlaceholder(env.Name) && IsUsableProviderCredential(env.Value) {
			names[env.Name] = true
		}
	}
	return names
}

// These defaults are already present in the current native model catalog and
// deployed app: ReviewLint (GPT-6 Luna), ModelCatalog (Sonnet), and the
// Worker recommendation + Cerebras integration test (gpt-oss). A deployment can
// pin a different model without adding a repository setting. Never probe or
// silently retry a failed completion against a different provider.
var workspaceCodingModels = []struct {
	Provider, Model string
	Keys            []string
}{
	{"openai", "gpt-6-luna", []string{"OPENAI_CODEX_ACCESS_TOKEN", "OPENAI_API_KEY"}},
	{"anthropic", "claude-sonnet-4-6", []string{"ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"}},
	{"cerebras", "gpt-oss-120b", []string{"CEREBRAS_API_KEY"}},
}

func workspaceCodingModel(available map[string]bool, preferred string) string {
	provider, model, pinned := strings.Cut(preferred, ":")
	if preferred != "" && !pinned {
		return ""
	}
	for _, choice := range workspaceCodingModels {
		if pinned && (provider != choice.Provider || strings.TrimSpace(model) == "" || strings.ContainsAny(model, " \t\r\n:")) {
			continue
		}
		for _, key := range choice.Keys {
			if available[key] {
				if pinned {
					return preferred
				}
				return choice.Provider + ":" + choice.Model
			}
		}
	}
	return ""
}

func (b *workspaceProviderBinding) setEnv(name, value string) {
	b.environment.Env = slices.DeleteFunc(b.environment.Env, func(v AgentEnvironmentVariable) bool { return v.Name == name })
	b.environment.Env = append(b.environment.Env, AgentEnvironmentVariable{Name: name, Value: value})
}

func (b *workspaceProviderBinding) bind(secret sandbox.EgressProxySecret) {
	b.egress.Secrets = mergeEgressSecrets(b.egress.Secrets, []sandbox.EgressProxySecret{secret})
	b.environment.Env = slices.DeleteFunc(b.environment.Env, func(v AgentEnvironmentVariable) bool { return v.Name == secret.Name })
	if !slices.Contains(b.environment.ProxyBound, secret.Name) {
		b.environment.ProxyBound = append(b.environment.ProxyBound, secret.Name)
	}
}

func (b *workspaceProviderBinding) apply(req *sandbox.CreateRequest) {
	if b == nil {
		return
	}
	req.EgressProxy = b.egress
}

// bindWorkspaceModelProxy offers the platform seats the repository does not
// supply itself (a key, or connected accounts) through the metered model
// proxy. One workspace model credential, minted per boot and replacing the
// earlier one, is bound for the API host only; the workspace's user pays.
func (s *WorkspaceService) bindWorkspaceModelProxy(ctx context.Context, workspace db.Workspace, binding *workspaceProviderBinding) error {
	proxyURL := modelProxyURL(s.gitBaseURL)
	host := apiHost(proxyURL)
	if proxyURL == "" || !sandbox.ValidEgressHost(host) {
		return nil
	}
	var seats []modelproxy.Seat
	for _, seat := range s.platformSeats {
		if !workspaceDeclaresProvider(binding.environment, seat.KeyEnv) {
			seats = append(seats, seat)
		}
	}
	if len(seats) == 0 {
		return nil
	}
	holder := "workspace-" + workspace.ID
	token, err := issueModelProxyToken(ctx, s.q, workspace.UserID, workspace.RepositoryID, holder, workspace.ID)
	if err != nil {
		return pkgerrors.Internal("mint workspace model credential").WithCause(err)
	}
	// This boot's egress policy replaces the previous boot's.
	revokeModelProxyTokens(ctx, s.q, workspace.UserID, holder, token.ID)
	for _, seat := range seats {
		binding.bind(sandbox.EgressProxySecret{Name: seat.KeyEnv, Value: token.Plaintext, Hosts: []string{host}, MatchHeaders: []string{"authorization", "x-api-key"}})
	}
	for name, value := range modelproxy.GuestEnvironment(proxyURL, seats) {
		binding.setEnv(name, value)
	}
	return nil
}
