package config

import (
	"strconv"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func validStartupConfig() *Config {
	return &Config{
		Server: ServerConfig{
			PublicURL:        "https://smithers.test",
			ReadTimeoutSecs:  30,
			WriteTimeoutSecs: 30,
			ShutdownTimeout:  "30s",
		},
		Database: DatabaseConfig{
			URL:             "postgres://smithers:smithers@localhost:5432/smithers?sslmode=require",
			MaxConns:        25,
			MinConns:        5,
			MaxConnLifetime: 3600,
			MaxConnIdleTime: 1800,
		},
		RepoHost: RepoHostConfig{
			URL:                   "http://localhost:8080",
			AuthToken:             "repo-host-secret",
			PushHookCallbackToken: "push-callback-secret",
		},
		Sandbox: SandboxConfig{AgentIdleTimeoutSecs: 300, WorkspaceMemoryMB: 4096, WorkspaceVCPUCount: 2},
		Auth: AuthConfig{
			Mode:             AuthModeSelfHosted,
			SessionSecret:    "super-secret",
			LFSSigningSecret: "lfs-signing-secret",
		},
		Billing: BillingConfig{Mode: "unlimited"},
		Email:   EmailConfig{},
		Webhook: WebhookConfig{SecretEncryptionKey: "webhook-secret-key"},
	}
}

func TestValidateServerStartup_BillingAuthorityIsExplicit(t *testing.T) {
	t.Parallel()

	cfg := validStartupConfig()
	cfg.Billing.Mode = "invalid"
	require.ErrorContains(t, ValidateServerStartup(cfg), "billing.mode must be unlimited or metered")

	cfg = validStartupConfig()
	cfg.Billing.StripeSecretKey = "sk_test_configured"
	require.ErrorContains(t, ValidateServerStartup(cfg), "billing Stripe settings are unavailable in the public backend")

	// A complete Stripe configuration is still refused: the public backend has
	// no payment client, so accepting it would advertise commerce it cannot do.
	cfg.Billing.Mode = "stripe"
	cfg.Billing.StripeWebhookSecret = "whsec_configured"
	require.ErrorContains(t, ValidateServerStartup(cfg), "billing.mode=stripe is unavailable in the public backend")

	require.NoError(t, ValidateServerStartup(validStartupConfig()))
}

func TestValidateServerStartup_Valid(t *testing.T) {
	t.Parallel()
	require.NoError(t, ValidateServerStartup(validStartupConfig()))
}

func TestValidateServerStartupWithInjectedLocalDependencies(t *testing.T) {
	cfg := validStartupConfig()
	cfg.RepoHost.URL = ""
	cfg.FeatureFlags.Sandboxes = true
	require.ErrorContains(t, ValidateServerStartup(cfg), "repo_host.url is required")
	require.ErrorContains(t, ValidateServerStartup(cfg), "an injected workspace runtime or compute provider is required")
	require.NoError(t, ValidateServerStartupWithDependencies(cfg, StartupDependencies{
		InProcessRepository: true, WorkspaceRuntime: true,
	}))
	require.ErrorContains(t, ValidateServerStartupWithDependencies(cfg, StartupDependencies{
		InProcessRepository: true,
	}), "an injected workspace runtime or compute provider is required")
}

func TestValidateServerStartup_RejectsUnknownAuthMode(t *testing.T) {
	t.Parallel()
	cfg := validStartupConfig()
	cfg.Auth.Mode = "shared-but-not-isolated"
	err := ValidateServerStartup(cfg)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "auth.mode must be one of selfhost, multitenant")
}

func TestValidateServerStartup_RequiresExplicitAuthMode(t *testing.T) {
	t.Parallel()
	cfg := validStartupConfig()
	cfg.Auth.Mode = ""
	err := ValidateServerStartup(cfg)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "auth.mode is required")
}

func TestValidateServerStartup_SelfhostBrowserOriginsAndCookieSecurity(t *testing.T) {
	for _, tc := range []struct {
		name, origin string
		cookieSecure bool
		wantError    string
	}{
		{"Railway HTTPS", "https://owner.example", true, ""},
		{"LAN HTTPS", "https://smithers.home.arpa:8443", true, ""},
		{"localhost HTTP", "http://localhost:4000", true, ""},
		{"IP loopback HTTP", "http://127.0.0.1:4000", true, ""},
		{"LAN HTTP explicitly insecure", "http://smithers.home.arpa:4000", false, ""},
		{"LAN HTTP secure cookie cannot work", "http://smithers.home.arpa:4000", true, "auth.cookie_secure must be false"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := validStartupConfig()
			cfg.Auth.Mode = AuthModeSelfHosted
			cfg.Auth.CookieSecure = tc.cookieSecure
			cfg.Server.AllowedOrigins = []string{tc.origin}
			err := ValidateServerStartup(cfg)
			if tc.wantError == "" {
				require.NoError(t, err)
				return
			}
			require.ErrorContains(t, err, tc.wantError)
		})
	}
}

func TestValidateServerStartup_RejectsAllowedOriginWithPath(t *testing.T) {
	t.Parallel()
	cfg := validStartupConfig()
	cfg.Server.AllowedOrigins = []string{"https://app.example/login"}
	err := ValidateServerStartup(cfg)
	require.ErrorContains(t, err, "server.allowed_origins contains invalid origin")
}

func TestValidateServerStartup_AgentIdleTimeoutMustBePositive(t *testing.T) {
	t.Parallel()

	for _, timeout := range []int64{0, -1} {
		cfg := validStartupConfig()
		cfg.Sandbox.AgentIdleTimeoutSecs = timeout

		err := ValidateServerStartup(cfg)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "sandbox.agent_idle_timeout_seconds must be > 0")
	}
}

func TestValidateServerStartup_SandboxBackedFeaturesRequireInjectedExecution(t *testing.T) {
	t.Parallel()

	for _, feature := range []struct {
		name   string
		enable func(*Config)
	}{
		{name: "workflows", enable: func(cfg *Config) { cfg.FeatureFlags.Workflows = true }},
		{name: "sandboxes", enable: func(cfg *Config) { cfg.FeatureFlags.Sandboxes = true }},
		{name: "workspaces", enable: func(cfg *Config) { cfg.FeatureFlags.Workspaces = true }},
		{name: "agents", enable: func(cfg *Config) { cfg.FeatureFlags.Agents = true }},
		{name: "remote sandbox", enable: func(cfg *Config) { cfg.FeatureFlags.RemoteSandboxEnabled = true }},
	} {
		feature := feature
		t.Run(feature.name, func(t *testing.T) {
			cfg := validStartupConfig()
			feature.enable(cfg)

			err := ValidateServerStartup(cfg)
			require.Error(t, err)
			assert.Contains(t, err.Error(), "an injected workspace runtime or compute provider is required")

			cfg.Sandbox.AgentSnapshotID = "snap-agent-test"
			require.NoError(t, ValidateServerStartupWithDependencies(cfg, StartupDependencies{ComputeProvider: true}))
			require.NoError(t, ValidateServerStartupWithDependencies(cfg, StartupDependencies{WorkspaceRuntime: true}))
		})
	}
}

func TestValidateServerStartup_AgentsRequireSnapshot(t *testing.T) {
	t.Parallel()
	cfg := validStartupConfig()
	cfg.FeatureFlags.Agents = true

	err := ValidateServerStartupWithDependencies(cfg, StartupDependencies{ComputeProvider: true})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "feature_flags.agents requires sandbox.agent_snapshot_id")
	assert.Contains(t, err.Error(), "SMITHERS_SANDBOX_AGENT_SNAPSHOT_ID")

	cfg.Sandbox.AgentSnapshotID = "snap-agent-test"
	require.NoError(t, ValidateServerStartupWithDependencies(cfg, StartupDependencies{ComputeProvider: true}))
}

func TestValidateServerStartup_EmptySecretRejected(t *testing.T) {
	t.Parallel()
	cfg := validStartupConfig()
	cfg.Auth.SessionSecret = "  "

	err := ValidateServerStartup(cfg)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "auth.session_secret must not be empty")
}

func TestValidateServerStartup_EmptyWebhookSecretEncryptionKeyRejected(t *testing.T) {
	t.Parallel()
	cfg := validStartupConfig()
	cfg.Webhook.SecretEncryptionKey = " "

	err := ValidateServerStartup(cfg)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "webhook.secret_encryption_key must not be empty")
}

func TestValidateServerStartup_EmptyRepoHostAuthTokenRejected(t *testing.T) {
	t.Parallel()
	cfg := validStartupConfig()
	cfg.RepoHost.AuthToken = " "

	err := ValidateServerStartup(cfg)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "repo_host.auth_token is required")
}

func TestValidateServerStartup_EmptyNarrowRepoHostTokensRejected(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name      string
		clear     func(*Config)
		wantError string
	}{
		{
			name:      "push callback",
			clear:     func(cfg *Config) { cfg.RepoHost.PushHookCallbackToken = " " },
			wantError: "repo_host.push_hook_callback_token must not be empty",
		},
	} {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			cfg := validStartupConfig()
			tc.clear(cfg)
			err := ValidateServerStartup(cfg)
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.wantError)
		})
	}
}

// Database URL must be supplied; there is no insecure default any more. An empty
// URL is rejected by the shared startup validation used by both the API and SSH
// binaries.
func TestValidateServerStartup_EmptyDatabaseURLRejected(t *testing.T) {
	t.Parallel()
	cfg := validStartupConfig()
	cfg.Database.URL = ""

	err := ValidateServerStartup(cfg)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "database.url is required")
}

func TestValidateServerStartup_RangeAndURLValidation(t *testing.T) {
	t.Parallel()
	cfg := validStartupConfig()
	cfg.Database.MaxConns = 2
	cfg.Database.MinConns = 5
	cfg.Server.ReadTimeoutSecs = 0
	cfg.Server.ShutdownTimeout = "0s"
	cfg.RepoHost.URL = "repo-host"

	err := ValidateServerStartup(cfg)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "database.max_conns must be >= database.min_conns")
	assert.Contains(t, err.Error(), "server.read_timeout_secs must be > 0")
	assert.Contains(t, err.Error(), "server.shutdown_timeout must be > 0")
	assert.Contains(t, err.Error(), "repo_host.url is invalid")
}

func TestValidateServerStartup_InvalidShutdownTimeoutRejected(t *testing.T) {
	t.Parallel()
	cfg := validStartupConfig()
	cfg.Server.ShutdownTimeout = "eventually"

	err := ValidateServerStartup(cfg)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "server.shutdown_timeout is invalid")
}

func TestValidateSSHStartup_RequiresDedicatedLFSSigningSecret(t *testing.T) {
	t.Parallel()
	cfg := validStartupConfig()
	cfg.Auth.LFSSigningSecret = ""

	err := ValidateSSHStartup(cfg)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "auth.lfs_signing_secret must not be empty")
}

func TestValidateServerStartup_RejectsUnnormalizedPushCallbackToken(t *testing.T) {
	t.Parallel()
	cfg := validStartupConfig()
	cfg.RepoHost.PushHookCallbackToken = " push-callback-secret\n"

	err := ValidateServerStartup(cfg)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "repo_host.push_hook_callback_token must not contain surrounding whitespace")
}

func TestValidateSSHStartup_RequiresTrustedPublicBaseURL(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		baseURL string
	}{
		{name: "empty", baseURL: ""},
		{name: "non-http", baseURL: "ssh://smithers.test"},
		{name: "credentials", baseURL: "https://user:secret@smithers.test"},
		{name: "query", baseURL: "https://smithers.test?redirect=evil"},
		{name: "fragment", baseURL: "https://smithers.test#fragment"},
	}
	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			cfg := validStartupConfig()
			cfg.Server.PublicURL = tc.baseURL
			err := ValidateSSHStartup(cfg)
			require.Error(t, err)
			assert.Contains(t, err.Error(), "server.public_url")
		})
	}
}

func TestValidateSSHStartup_LegacyAPIBaseDoesNotOverridePublicURL(t *testing.T) {
	t.Setenv("SMITHERS_API_BASE_URL", "https://api.smithers.test/api")
	cfg := validStartupConfig()
	cfg.Server.PublicURL = ""

	require.ErrorContains(t, ValidateSSHStartup(cfg), "server.public_url is required")
}

// The SSH server must enforce the same empty-database-URL rejection as the API
// server (regression guard for the dropped insecure default).
func TestValidateSSHStartup_EmptyDatabaseURLRejected(t *testing.T) {
	t.Parallel()
	cfg := validStartupConfig()
	cfg.Database.URL = ""

	err := ValidateSSHStartup(cfg)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "database.url is required")
}

func TestValidateSSHStartup_RequiredAndRangeChecks(t *testing.T) {
	t.Parallel()
	cfg := validStartupConfig()
	cfg.Database.URL = ""
	cfg.RepoHost.URL = ""
	cfg.RepoHost.AuthToken = ""
	cfg.Database.MaxConns = 0

	err := ValidateSSHStartup(cfg)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "database.url is required")
	assert.Contains(t, err.Error(), "repo_host.url is required")
	assert.Contains(t, err.Error(), "repo_host.auth_token is required")
	assert.Contains(t, err.Error(), "database.max_conns must be > 0")
}

func TestValidateServerStartup_WorkspaceSandboxResourceBounds(t *testing.T) {
	for _, field := range []struct {
		key, envKey string
		max         int
	}{
		{key: "workspace_memory_mb", envKey: "SMITHERS_SANDBOX_WORKSPACE_MEMORY_MB", max: 65536},
		{key: "workspace_vcpu_count", envKey: "SMITHERS_SANDBOX_WORKSPACE_VCPU_COUNT", max: 16},
	} {
		for _, value := range []int{-1, 0, 1, field.max, field.max + 1} {
			t.Run(field.key+"/"+strconv.Itoa(value), func(t *testing.T) {
				clearConfigEnv(t)
				t.Setenv(field.envKey, strconv.Itoa(value))
				loaded, err := Load("")
				require.NoError(t, err)
				cfg := validStartupConfig()
				cfg.Sandbox = loaded.Sandbox
				err = ValidateServerStartup(cfg)
				if value > 0 && value <= field.max {
					require.NoError(t, err)
				} else {
					require.Error(t, err)
					assert.Contains(t, err.Error(), "sandbox."+field.key+" must be between 1 and "+strconv.Itoa(field.max))
				}
			})
		}
	}
}

func TestValidateServerStartup_MeteredAdmissionNeedsNoPaymentKeys(t *testing.T) {
	cfg := validStartupConfig()
	cfg.Auth.Mode = AuthModeMultitenant
	require.ErrorContains(t, ValidateServerStartup(cfg), "unlimited requires single-owner")
	cfg.Billing.Mode = "metered"
	require.ErrorContains(t, ValidateServerStartup(cfg), "metered requires injected admission")
	require.NoError(t, ValidateServerStartupWithDependencies(cfg, StartupDependencies{MeteredAdmission: true}))
	cfg.Billing.StripeSecretKey = "private-key"
	require.ErrorContains(t, ValidateServerStartupWithDependencies(cfg, StartupDependencies{MeteredAdmission: true}), "payment credentials belong to the deployment")
	cfg.Auth.Mode = AuthModeSelfHosted
	cfg.Billing.Mode = "unlimited"
	cfg.Billing.StripeSecretKey = ""
	require.ErrorContains(t, ValidateServerStartupWithDependencies(cfg, StartupDependencies{MeteredAdmission: true}), "injected admission requires billing.mode=metered")
}
