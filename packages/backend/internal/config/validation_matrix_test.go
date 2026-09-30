package config

import (
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestValidateURL_Matrix(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		raw         string
		requireHTTP bool
		wantError   string
	}{
		{name: "postgres_allowed_without_http_requirement", raw: "postgres://user:pass@localhost:5432/db"},
		{name: "http_allowed", raw: "http://localhost:8080", requireHTTP: true},
		{name: "https_allowed", raw: "https://example.com", requireHTTP: true},
		{name: "trimmed_url", raw: "  https://example.com/path  ", requireHTTP: true},
		{name: "missing_scheme", raw: "example.com", wantError: "missing scheme"},
		{name: "missing_host", raw: "https:///path", requireHTTP: true, wantError: "missing host"},
		{name: "non_http_rejected", raw: "ssh://example.com", requireHTTP: true, wantError: "scheme must be http or https"},
		{name: "invalid_url", raw: "://", wantError: "missing protocol scheme"},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			err := validateURL(tc.raw, tc.requireHTTP)
			if tc.wantError != "" {
				require.Error(t, err)
				assert.Contains(t, err.Error(), tc.wantError)
				return
			}
			require.NoError(t, err)
		})
	}
}

func TestValidateURL_ParseErrorOmitsCredentials(t *testing.T) {
	t.Parallel()

	// A DSN whose password breaks url.Parse must not echo the password into
	// the error: ValidateServerStartup prints these at startup, where they land
	// in journald/log sinks.
	const password = "hunter2secret"
	err := validateURL("postgres://admin:"+password+"%zz@db.internal:5432/app", false)
	require.Error(t, err)
	assert.NotContains(t, err.Error(), password)
	assert.Contains(t, err.Error(), "invalid URL escape")
}

func TestValidateServerStartup_DatabaseURLParseErrorOmitsPassword(t *testing.T) {
	t.Parallel()

	const password = "hunter2secret"
	cfg := validStartupConfig()
	cfg.Database.URL = "postgres://admin:" + password + "%zz@db.internal:5432/app"

	err := ValidateServerStartup(cfg)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "database.url is invalid")
	assert.NotContains(t, err.Error(), password)
}

func TestValidateServerStartup_NilConfig(t *testing.T) {
	t.Parallel()

	err := ValidateServerStartup(nil)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "config must not be nil")
}

func TestValidateSSHStartup_NilConfig(t *testing.T) {
	t.Parallel()

	err := ValidateSSHStartup(nil)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "config must not be nil")
}

func TestValidateServerStartup_SandboxValidationMatrix(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		persistence string
		idleTimeout int64
		leaseDelete int64
		wantError   string
	}{
		{name: "empty_persistence_allowed", persistence: "", idleTimeout: 0},
		{name: "ephemeral_allowed", persistence: "ephemeral", idleTimeout: 10},
		{name: "persistent_allowed", persistence: "persistent", idleTimeout: 10},
		{name: "invalid_persistence", persistence: "shared", idleTimeout: 10, wantError: "sandbox.workspace_persistence must be one of ephemeral, persistent"},
		{name: "negative_idle_timeout", persistence: "persistent", idleTimeout: -1, wantError: "sandbox.workspace_idle_timeout must be >= 0"},
		{name: "zero_lease_delete_allowed", persistence: "persistent", idleTimeout: 10, leaseDelete: 0},
		{name: "negative_lease_delete", persistence: "persistent", idleTimeout: 10, leaseDelete: -1, wantError: "sandbox.workspace_lease_delete_after must be >= 0"},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			cfg := validStartupConfig()
			cfg.Sandbox.WorkspacePersistence = tc.persistence
			cfg.Sandbox.WorkspaceIdleTimeout = tc.idleTimeout
			cfg.Sandbox.WorkspaceLeaseDeleteAfter = tc.leaseDelete

			err := ValidateServerStartup(cfg)
			if tc.wantError != "" {
				require.Error(t, err)
				assert.Contains(t, err.Error(), tc.wantError)
				return
			}
			require.NoError(t, err)
		})
	}
}

func TestValidateServerStartup_SingleFieldFaults(t *testing.T) {
	t.Parallel()

	mutations := []struct {
		name      string
		mutate    func(cfg *Config)
		wantError string
	}{
		{name: "missing_database_url", mutate: func(cfg *Config) { cfg.Database.URL = "" }, wantError: "database.url is required"},
		{name: "missing_repo_host_url", mutate: func(cfg *Config) { cfg.RepoHost.URL = "" }, wantError: "repo_host.url is required"},
		{name: "missing_repo_host_token", mutate: func(cfg *Config) { cfg.RepoHost.AuthToken = "" }, wantError: "repo_host.auth_token is required"},
		{name: "missing_push_callback_token", mutate: func(cfg *Config) { cfg.RepoHost.PushHookCallbackToken = "" }, wantError: "repo_host.push_hook_callback_token must not be empty"},
		{name: "zero_max_conns", mutate: func(cfg *Config) { cfg.Database.MaxConns = 0 }, wantError: "database.max_conns must be > 0"},
		{name: "zero_min_conns", mutate: func(cfg *Config) { cfg.Database.MinConns = 0 }, wantError: "database.min_conns must be > 0"},
		{name: "max_less_than_min", mutate: func(cfg *Config) { cfg.Database.MaxConns, cfg.Database.MinConns = 1, 2 }, wantError: "database.max_conns must be >= database.min_conns"},
		{name: "zero_lifetime", mutate: func(cfg *Config) { cfg.Database.MaxConnLifetime = 0 }, wantError: "database.max_conn_lifetime_secs must be > 0"},
		{name: "zero_idle_time", mutate: func(cfg *Config) { cfg.Database.MaxConnIdleTime = 0 }, wantError: "database.max_conn_idle_time_secs must be > 0"},
		{name: "zero_read_timeout", mutate: func(cfg *Config) { cfg.Server.ReadTimeoutSecs = 0 }, wantError: "server.read_timeout_secs must be > 0"},
		{name: "negative_write_timeout", mutate: func(cfg *Config) { cfg.Server.WriteTimeoutSecs = -1 }, wantError: "server.write_timeout_secs must be >= 0"},
		{name: "zero_shutdown_timeout", mutate: func(cfg *Config) { cfg.Server.ShutdownTimeout = "0s" }, wantError: "server.shutdown_timeout must be > 0"},
		{name: "missing_session_secret", mutate: func(cfg *Config) { cfg.Auth.SessionSecret = "" }, wantError: "auth.session_secret must not be empty"},
		{name: "missing_lfs_signing_secret", mutate: func(cfg *Config) { cfg.Auth.LFSSigningSecret = "" }, wantError: "auth.lfs_signing_secret must not be empty"},
		{name: "missing_webhook_secret_key", mutate: func(cfg *Config) { cfg.Webhook.SecretEncryptionKey = "" }, wantError: "webhook.secret_encryption_key must not be empty"},
	}

	for idx, tc := range mutations {
		tc := tc
		t.Run(fmt.Sprintf("%02d_%s", idx, tc.name), func(t *testing.T) {
			cfg := validStartupConfig()
			tc.mutate(cfg)
			err := ValidateServerStartup(cfg)
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.wantError)
		})
	}
}
