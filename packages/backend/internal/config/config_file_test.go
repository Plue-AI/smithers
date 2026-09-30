package config

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestLoad_ConfigFileOverridesDefaults verifies that a config file overrides default values
func TestLoad_ConfigFileOverridesDefaults(t *testing.T) {
	clearConfigEnv(t)

	// Create a temp config file
	tmpDir := t.TempDir()
	configFile := filepath.Join(tmpDir, "config.yaml")
	err := os.WriteFile(configFile, []byte(`
server:
  addr: ":6666"
database:
  url: "postgres://configfile:configfile@confighost:5432/configdb"
`), 0o644)
	require.NoError(t, err)

	cfg, err := Load(configFile)
	require.NoError(t, err)
	assert.Equal(t, ":6666", cfg.Server.Addr, "config file should override server.addr default")
	assert.Equal(t, "postgres://configfile:configfile@confighost:5432/configdb", cfg.Database.URL, "config file should override database.url default")
	// Other values should still be defaults
	assert.Equal(t, int32(25), cfg.Database.MaxConns, "config file should not affect other defaults")
}

// TestLoad_ConfigFilePrecedence_EnvOverridesConfigFile verifies that env vars take precedence over config file
func TestLoad_ConfigFilePrecedence_EnvOverridesConfigFile(t *testing.T) {
	clearConfigEnv(t)

	// Create a temp config file
	tmpDir := t.TempDir()
	configFile := filepath.Join(tmpDir, "config.yaml")
	err := os.WriteFile(configFile, []byte(`
server:
  addr: ":6666"
`), 0o644)
	require.NoError(t, err)

	// Set env var that overrides the config file value
	t.Setenv("SMITHERS_SERVER_ADDR", ":7777")

	cfg, err := Load(configFile)
	require.NoError(t, err)
	assert.Equal(t, ":7777", cfg.Server.Addr, "env var should override config file value")
}

// TestLoad_InvalidConfigFile_ReturnsError verifies that an invalid config file returns an error
func TestLoad_InvalidConfigFile_ReturnsError(t *testing.T) {
	clearConfigEnv(t)

	// Create a temp config file with invalid YAML
	tmpDir := t.TempDir()
	configFile := filepath.Join(tmpDir, "config.yaml")
	err := os.WriteFile(configFile, []byte(`
this is not valid yaml: [broken
`), 0o644)
	require.NoError(t, err)

	cfg, err := Load(configFile)
	require.Error(t, err, "Load() should return error for invalid config file")
	assert.Nil(t, cfg, "config should be nil on error")
}

// TestLoad_NonExistentConfigFile_ReturnsError verifies that a non-existent specific config file returns an error
func TestLoad_NonExistentConfigFile_ReturnsError(t *testing.T) {
	clearConfigEnv(t)

	cfg, err := Load("/nonexistent/path/config.yaml")
	require.Error(t, err, "Load() should return error for non-existent config file")
	assert.Nil(t, cfg, "config should be nil on error")
}

// TestLoad_EmptyStringUsesDefaultPaths verifies that empty string uses default search paths
// This is essentially the existing behavior - no config file exists so defaults are used
func TestLoad_EmptyStringUsesDefaultPaths(t *testing.T) {
	clearConfigEnv(t)

	// When no config file exists in default paths, defaults should be used
	cfg, err := Load("")
	require.NoError(t, err)
	assert.Equal(t, ":4000", cfg.Server.Addr, "should use default when no config file found")
}

func TestLoad_ConfigFile_ThreeWayPrecedence(t *testing.T) {
	clearConfigEnv(t)

	tmpDir := t.TempDir()
	configFile := filepath.Join(tmpDir, "config.yaml")
	err := os.WriteFile(configFile, []byte(`
server:
  addr: ":6666"
database:
  url: "postgres://config:config@filehost:5432/filedb"
`), 0o644)
	require.NoError(t, err)

	t.Setenv("SMITHERS_DATABASE_URL", "postgres://env:env@envhost:5432/envdb")

	cfg, err := Load(configFile)
	require.NoError(t, err)

	assert.Equal(t, int32(25), cfg.Database.MaxConns, "default should be used when unset in file/env")
	assert.Equal(t, ":6666", cfg.Server.Addr, "config file should be used when env is unset")
	assert.Equal(t, "postgres://env:env@envhost:5432/envdb", cfg.Database.URL, "env should override config file")
}

func TestLoad_ConfigFile_AllSections(t *testing.T) {
	clearConfigEnv(t)

	tmpDir := t.TempDir()
	configFile := filepath.Join(tmpDir, "config.yaml")
	err := os.WriteFile(configFile, []byte(`
server:
  addr: ":4100"
  read_timeout_secs: 41
  write_timeout_secs: 42
database:
  url: "postgres://all:all@dbhost:5432/alldb"
  max_conns: 44
  min_conns: 11
  max_conn_lifetime_secs: 4500
  max_conn_idle_time_secs: 1600
repo_host:
  url: "http://repo-host.internal:9090"
  auth_token: "file-token"
ssh:
  addr: ":2223"
  host_key_dir: "/tmp/ssh-keys"
  max_connections: 111
  max_connections_per_ip: 11
  max_receive_pack_size: 1048576
  max_upload_pack_request_size: 2048
  receive_pack_timeout: "7m"
  upload_pack_timeout: "8m"
auth:
  session_duration: "100h"
  session_refresh_window: "24h"
  session_cookie_name: "smithers_custom"
  session_secret: "file-session-secret"
  cookie_secure: false
  key_auth_domain: "smithers.local"
  github_client_id: "gh-id"
  github_client_secret: "gh-secret"
  github_redirect_url: "http://localhost:4100/callback"
  github_oauth_base_url: "https://ghe.example.com/login"
  github_api_base_url: "https://ghe.example.com/api/v3"
`), 0o644)
	require.NoError(t, err)

	cfg, err := Load(configFile)
	require.NoError(t, err)

	assert.Equal(t, ":4100", cfg.Server.Addr)
	assert.Equal(t, 41, cfg.Server.ReadTimeoutSecs)
	assert.Equal(t, 42, cfg.Server.WriteTimeoutSecs)

	assert.Equal(t, "postgres://all:all@dbhost:5432/alldb", cfg.Database.URL)
	assert.Equal(t, int32(44), cfg.Database.MaxConns)
	assert.Equal(t, int32(11), cfg.Database.MinConns)
	assert.Equal(t, 4500, cfg.Database.MaxConnLifetime)
	assert.Equal(t, 1600, cfg.Database.MaxConnIdleTime)

	assert.Equal(t, "http://repo-host.internal:9090", cfg.RepoHost.URL)
	assert.Equal(t, "file-token", cfg.RepoHost.AuthToken)

	assert.Equal(t, ":2223", cfg.SSH.Addr)
	assert.Equal(t, "/tmp/ssh-keys", cfg.SSH.HostKeyDir)
	assert.Equal(t, 111, cfg.SSH.MaxConnections)
	assert.Equal(t, 11, cfg.SSH.MaxConnectionsPerIP)
	assert.Equal(t, int64(1048576), cfg.SSH.MaxReceivePackSize)
	assert.Equal(t, int64(2048), cfg.SSH.MaxUploadPackRequestSize)
	assert.Equal(t, "7m", cfg.SSH.ReceivePackTimeout)
	assert.Equal(t, "8m", cfg.SSH.UploadPackTimeout)

	assert.Equal(t, "100h", cfg.Auth.SessionDuration)
	assert.Equal(t, "24h", cfg.Auth.SessionRefreshWindow)
	assert.Equal(t, "smithers_custom", cfg.Auth.SessionCookieName)
	assert.Equal(t, "file-session-secret", cfg.Auth.SessionSecret)
	assert.Equal(t, false, cfg.Auth.CookieSecure)
	assert.Equal(t, "smithers.local", cfg.Auth.KeyAuthDomain)
	assert.Equal(t, "gh-id", cfg.Auth.GitHubClientID)
	assert.Equal(t, "gh-secret", cfg.Auth.GitHubClientSecret)
	assert.Equal(t, "http://localhost:4100/callback", cfg.Auth.GitHubRedirectURL)
	assert.Equal(t, "https://ghe.example.com/login", cfg.Auth.GitHubOAuthBaseURL)
	assert.Equal(t, "https://ghe.example.com/api/v3", cfg.Auth.GitHubAPIBaseURL)
}

func TestLoad_ConfigFile_PartialSections(t *testing.T) {
	clearConfigEnv(t)

	tmpDir := t.TempDir()
	configFile := filepath.Join(tmpDir, "config.yaml")
	err := os.WriteFile(configFile, []byte(`
database:
  url: "postgres://partial:partial@host:5432/partial"
`), 0o644)
	require.NoError(t, err)

	cfg, err := Load(configFile)
	require.NoError(t, err)

	assert.Equal(t, "postgres://partial:partial@host:5432/partial", cfg.Database.URL)
	assert.Equal(t, int32(25), cfg.Database.MaxConns)
	assert.Equal(t, int32(5), cfg.Database.MinConns)
	assert.Equal(t, 30, cfg.Server.ReadTimeoutSecs)
}

func TestLoad_ConfigFile_UnknownKeysIgnored(t *testing.T) {
	clearConfigEnv(t)

	tmpDir := t.TempDir()
	configFile := filepath.Join(tmpDir, "config.yaml")
	err := os.WriteFile(configFile, []byte(`
server:
  addr: ":5555"
  unknown_field: "ignored"
completely_unknown_section:
  foo: "bar"
`), 0o644)
	require.NoError(t, err)

	cfg, err := Load(configFile)
	require.NoError(t, err)

	assert.Equal(t, ":5555", cfg.Server.Addr)
	assert.Equal(t, int32(25), cfg.Database.MaxConns)
}

func TestLoad_ConfigFile_EmptyFile(t *testing.T) {
	clearConfigEnv(t)

	tmpDir := t.TempDir()
	configFile := filepath.Join(tmpDir, "config.yaml")
	err := os.WriteFile(configFile, []byte{}, 0o644)
	require.NoError(t, err)

	cfg, err := Load(configFile)
	require.NoError(t, err)

	assert.Equal(t, ":4000", cfg.Server.Addr)
	assert.Equal(t, "", cfg.Database.URL)
	assert.Equal(t, int32(25), cfg.Database.MaxConns)
}

func TestLoad_ConfigFile_YAMLTypeCoercion(t *testing.T) {
	clearConfigEnv(t)

	tmpDir := t.TempDir()
	configFile := filepath.Join(tmpDir, "config.yaml")
	err := os.WriteFile(configFile, []byte(`
server:
  read_timeout_secs: 45
  write_timeout_secs: 60
database:
  max_conns: 50
  min_conns: 10
auth:
  cookie_secure: false
`), 0o644)
	require.NoError(t, err)

	cfg, err := Load(configFile)
	require.NoError(t, err)

	assert.Equal(t, 45, cfg.Server.ReadTimeoutSecs)
	assert.Equal(t, 60, cfg.Server.WriteTimeoutSecs)
	assert.Equal(t, int32(50), cfg.Database.MaxConns)
	assert.Equal(t, int32(10), cfg.Database.MinConns)
	assert.Equal(t, false, cfg.Auth.CookieSecure)
}

func TestLoad_ConfigFile_DiscoveryModeYMLExtension(t *testing.T) {
	clearConfigEnv(t)

	tmpDir := t.TempDir()
	originalWd, err := os.Getwd()
	require.NoError(t, err)
	defer os.Chdir(originalWd)

	err = os.Chdir(tmpDir)
	require.NoError(t, err)

	err = os.WriteFile("config.yml", []byte(`
server:
  addr: ":6767"
`), 0o644)
	require.NoError(t, err)

	cfg, err := Load("")
	require.NoError(t, err)
	assert.Equal(t, ":6767", cfg.Server.Addr)
}
