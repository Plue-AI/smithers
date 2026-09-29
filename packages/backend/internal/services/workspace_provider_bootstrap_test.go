package services

import (
	"context"
	"os/exec"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

func bootstrapModel(env AgentEnvironmentProvisioningConfig) string {
	for _, variable := range env.Env {
		if variable.Name == "SMITHERS_CODING_IMPLEMENT_MODEL" {
			return variable.Value
		}
	}
	return ""
}

func bootstrapFallbackModel(env AgentEnvironmentProvisioningConfig) string {
	for _, variable := range env.Env {
		if variable.Name == "SMITHERS_CODING_FALLBACK_MODEL" {
			return variable.Value
		}
	}
	return ""
}

func seatsFor(t *testing.T, providers ...string) []modelproxy.Seat {
	t.Helper()
	var seats []modelproxy.Seat
	for _, provider := range providers {
		seat, ok := modelproxy.SeatFor(provider)
		require.True(t, ok, provider)
		seats = append(seats, seat)
	}
	return seats
}

func TestWorkspaceProviderBootstrapPrecedenceAndRedaction(t *testing.T) {
	for _, source := range []string{"repository", "subscription", "platform"} {
		t.Run(source, func(t *testing.T) {
			var options []WorkspaceServiceOption
			options = append(options, WithWorkspaceGitBaseURL(poolTestBaseURL), WithWorkspaceProviderBootstrap(seatsFor(t, "openai", "anthropic", "cerebras"), "cerebras:gpt-oss-120b"))
			if source == "repository" {
				secret, _ := ProviderCredentialEgressSecret("ANTHROPIC_API_KEY", "repository-private")
				options = append(options, WithWorkspaceAgentEnvironment(&boundSecretsAgentEnvironmentProvider{bound: []sandbox.EgressProxySecret{secret}, staticAgentEnvironmentProvider: staticAgentEnvironmentProvider{config: AgentEnvironmentProvisioningConfig{ProxyBound: []string{"ANTHROPIC_API_KEY"}}}}))
			}
			if source != "platform" {
				options = append(options, WithWorkspaceProviderConnections(&workspaceProviderPool{pools: map[string]bool{ProviderConnectionProviderClaude: true}}))
			}
			q := &mockWorkspaceQuerier{}
			var minted []db.CreateAccessTokenParams
			q.createAccessTokenFn = func(_ context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
				minted = append(minted, arg)
				return db.AccessToken{ID: int64(len(minted))}, nil
			}
			s := newWorkspaceServiceForTests(q, options...)
			binding, err := s.resolveWorkspaceProviderBindings(context.Background(), sampleDBWorkspace("boot"))
			require.NoError(t, err)
			if source == "platform" || source == "subscription" {
				require.Equal(t, "cerebras:gpt-oss-120b", bootstrapModel(binding.environment))
			} else {
				require.Equal(t, "anthropic:claude-sonnet-4-6", bootstrapModel(binding.environment))
			}
			// Every metered seat carries the one model credential (the
			// Cerebras seat is always metered here); the pool's is another.
			var credential string
			for _, secret := range binding.egress.Secrets {
				if secret.Name == "CEREBRAS_API_KEY" {
					credential = secret.Value
				}
			}
			require.True(t, strings.HasPrefix(credential, "smithers_"))
			metered := map[string]string{}
			for _, secret := range binding.egress.Secrets {
				if secret.Value == credential && secret.Hosts[0] == "api.example.test" {
					metered[secret.Name] = secret.Value
				}
			}
			switch source {
			case "repository":
				secret, _ := ProviderCredentialEgressSecret("ANTHROPIC_API_KEY", "repository-private")
				require.Contains(t, binding.egress.Secrets, secret, "the repository's own key wins")
				require.ElementsMatch(t, []string{"OPENAI_API_KEY", "CEREBRAS_API_KEY"}, keys(metered))
			case "subscription":
				// The account pool key is its own binding; every platform
				// seat stays metered for a provider without accounts.
				require.ElementsMatch(t, []string{"OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CEREBRAS_API_KEY"}, keys(metered))
				require.Contains(t, binding.egress.SecretNames(), ProviderPoolKeyEnvName)
			case "platform":
				require.ElementsMatch(t, []string{"OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CEREBRAS_API_KEY"}, keys(metered))
			}
			var modelTokens int
			for _, arg := range minted {
				if strings.HasPrefix(arg.Name, "model-proxy-workspace-") {
					modelTokens++
					require.Contains(t, arg.Scopes, "workspace:")
				}
			}
			require.Equal(t, 1, modelTokens, "one model credential per boot")
			env := map[string]string{}
			for _, variable := range binding.environment.Env {
				env[variable.Name] = variable.Value
			}
			require.Equal(t, poolTestBaseURL+"/model-proxy", env[modelproxy.URLEnv])
			profile, err := renderWorkspaceAgentEnvironmentProfile(binding.environment.Env, binding.environment.ProxyBound)
			require.NoError(t, err)
			require.NotContains(t, profile, "private")
			require.NotContains(t, profile, "smithers_", "the model credential stays in the egress proxy")
			require.Empty(t, binding.environment.Secrets)
			for _, secret := range binding.egress.Secrets {
				require.NotEmpty(t, secret.Hosts)
				require.NotEmpty(t, secret.MatchHeaders)
			}
		})
	}
}

func keys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for key := range m {
		out = append(out, key)
	}
	return out
}

func TestWorkspaceProviderBootstrapDefaultsAndExplicitChoice(t *testing.T) {
	for _, tc := range []struct{ name, provider, pin, want string }{
		{"openai", "openai", "", "openai:gpt-6-luna"},
		{"anthropic", "anthropic", "", "anthropic:claude-sonnet-4-6"},
		{"cerebras", "cerebras", "", "cerebras:gpt-oss-120b"},
		{"judge only", "vercel", "", ""},
		{"unavailable pin", "cerebras", "openai:gpt-6-luna", ""},
		{"malformed pin", "cerebras", "invalid", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceGitBaseURL(poolTestBaseURL), WithWorkspaceProviderBootstrap(seatsFor(t, tc.provider), tc.pin))
			binding, err := s.resolveWorkspaceProviderBindings(context.Background(), sampleDBWorkspace("boot"))
			require.NoError(t, err)
			require.Equal(t, tc.want, bootstrapModel(binding.environment))
			profile, err := renderWorkspaceAgentEnvironmentProfile(binding.environment.Env, binding.environment.ProxyBound)
			require.NoError(t, err)
			command := exec.Command("/bin/sh", "-c", profile+"\nprintf '%s' \"${SMITHERS_CODING_IMPLEMENT_MODEL-}\"")
			command.Env = []string{}
			output, err := command.CombinedOutput()
			require.NoError(t, err, string(output))
			require.Equal(t, tc.want, string(output), "unavailable explicit pin must not silently switch provider in the guest")
		})
	}
	for _, value := range []string{"", "anthropic:explicit-owner-model"} {
		t.Run("explicit="+value, func(t *testing.T) {
			env := &boundSecretsAgentEnvironmentProvider{staticAgentEnvironmentProvider: staticAgentEnvironmentProvider{config: AgentEnvironmentProvisioningConfig{Env: []AgentEnvironmentVariable{{Name: "SMITHERS_CODING_IMPLEMENT_MODEL", Value: value}}}}}
			s := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceGitBaseURL(poolTestBaseURL), WithWorkspaceAgentEnvironment(env), WithWorkspaceProviderBootstrap(seatsFor(t, "openai"), ""))
			binding, err := s.resolveWorkspaceProviderBindings(context.Background(), sampleDBWorkspace("boot"))
			require.NoError(t, err)
			require.Equal(t, value, bootstrapModel(binding.environment))
		})
	}
	s := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceGitBaseURL(poolTestBaseURL), WithWorkspaceProviderBootstrap(seatsFor(t, "openai"), ""))
	for _, which := range []string{"golden", "agent"} {
		workspace := sampleDBWorkspace(which)
		if which == "golden" {
			workspace.RepositoryID = 0
			workspace.UserID = 0
		} else {
			workspace.Kind = "agent"
		}
		binding, err := s.resolveWorkspaceProviderBindings(context.Background(), workspace)
		require.NoError(t, err)
		require.Empty(t, binding.egress.Secrets)
		require.Empty(t, bootstrapModel(binding.environment))
	}
}

func TestWorkspaceProviderBootstrapPreservesSetupOnlySecret(t *testing.T) {
	env := &boundSecretsAgentEnvironmentProvider{staticAgentEnvironmentProvider: staticAgentEnvironmentProvider{config: AgentEnvironmentProvisioningConfig{Secrets: map[string]string{"OPENAI_API_KEY": "setup-only-private"}}}}
	resolver := &workspaceProviderPool{pools: map[string]bool{ProviderConnectionProviderCodex: true}}
	s := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceAgentEnvironment(env), WithWorkspaceProviderConnections(resolver), WithWorkspaceProviderBootstrap(seatsFor(t, "openai"), ""))
	binding, err := s.resolveWorkspaceProviderBindings(context.Background(), sampleDBWorkspace("boot"))
	require.NoError(t, err)
	require.Empty(t, binding.egress.Secrets)
	require.Empty(t, bootstrapModel(binding.environment))
	require.NotContains(t, resolver.calls, ProviderConnectionProviderCodex)
}

func TestWorkspaceProviderBootstrapDoesNotPinPoolOnlyAccounts(t *testing.T) {
	for _, tc := range []struct {
		name, provider, pin, want string
	}{
		{"codex", ProviderConnectionProviderCodex, "", ""},
		{"claude", ProviderConnectionProviderClaude, "", ""},
		{"explicit codex model", ProviderConnectionProviderCodex, "openai:gpt-6-sol", "openai:gpt-6-sol"},
		{"unavailable explicit pin", ProviderConnectionProviderClaude, "openai:gpt-6-sol", "openai:gpt-6-sol"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pool := &workspaceProviderPool{pools: map[string]bool{tc.provider: true}}
			service := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceGitBaseURL(poolTestBaseURL),
				WithWorkspaceProviderConnections(pool), WithWorkspaceProviderBootstrap(nil, tc.pin))
			binding, err := service.resolveWorkspaceProviderBindings(context.Background(), sampleDBWorkspace("pool-only"))
			require.NoError(t, err)
			require.Equal(t, tc.want, bootstrapModel(binding.environment))
			profile, err := renderWorkspaceAgentEnvironmentProfile(binding.environment.Env, binding.environment.ProxyBound)
			require.NoError(t, err)
			require.Contains(t, profile, ProviderPoolURLEnvName)
			if tc.pin == "" {
				require.NotContains(t, profile, "SMITHERS_CODING_IMPLEMENT_MODEL", "the next host must ask the live pool")
			}
		})
	}
}

func TestWorkspaceProviderBootstrapPoolKeepsPlatformModelAsFallback(t *testing.T) {
	for _, tc := range []struct {
		name, poolProvider, platformProvider, fallback string
	}{
		{"codex pool with anthropic platform", ProviderConnectionProviderCodex, "anthropic", "anthropic:claude-sonnet-4-6"},
		{"claude pool with openai platform", ProviderConnectionProviderClaude, "openai", "openai:gpt-6-luna"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pool := &workspaceProviderPool{pools: map[string]bool{tc.poolProvider: true}}
			service := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceGitBaseURL(poolTestBaseURL),
				WithWorkspaceProviderConnections(pool), WithWorkspaceProviderBootstrap(seatsFor(t, tc.platformProvider), ""))
			binding, err := service.resolveWorkspaceProviderBindings(context.Background(), sampleDBWorkspace("pool-platform"))
			require.NoError(t, err)
			require.Empty(t, bootstrapModel(binding.environment))
			require.Equal(t, tc.fallback, bootstrapFallbackModel(binding.environment))
			profile, err := renderWorkspaceAgentEnvironmentProfile(binding.environment.Env, binding.environment.ProxyBound)
			require.NoError(t, err)
			require.NotContains(t, profile, "SMITHERS_CODING_IMPLEMENT_MODEL")
			require.Contains(t, profile, "export SMITHERS_CODING_FALLBACK_MODEL='"+tc.fallback+"'")
			require.Contains(t, profile, ProviderPoolURLEnvName)
		})
	}
}

func TestWorkspaceProviderBootstrapPlatformWithoutPoolPreservesModel(t *testing.T) {
	service := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceGitBaseURL(poolTestBaseURL),
		WithWorkspaceProviderBootstrap(seatsFor(t, "anthropic"), ""))
	binding, err := service.resolveWorkspaceProviderBindings(context.Background(), sampleDBWorkspace("platform-only"))
	require.NoError(t, err)
	require.Equal(t, "anthropic:claude-sonnet-4-6", bootstrapModel(binding.environment))
	require.Empty(t, bootstrapFallbackModel(binding.environment))
}
