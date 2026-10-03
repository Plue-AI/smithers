package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestGitHubAppOAuthCredentialsCannotEnterProductConfig(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("SMITHERS_AUTH_GITHUB_CLIENT_ID", "legacy-github-oauth-id-canary")
	t.Setenv("SMITHERS_AUTH_GITHUB_CLIENT_SECRET", "legacy-github-oauth-secret-canary")
	path := filepath.Join(t.TempDir(), "config.yaml")
	require.NoError(t, os.WriteFile(path, []byte("auth:\n  github_client_id: file-github-oauth-id-canary\n  github_client_secret: file-github-oauth-secret-canary\n"), 0600))
	cfg, err := Load(path)
	require.NoError(t, err)
	serialized, err := json.Marshal(cfg.Auth)
	require.NoError(t, err)
	for _, canary := range []string{"legacy-github-oauth-id-canary", "legacy-github-oauth-secret-canary", "file-github-oauth-id-canary", "file-github-oauth-secret-canary", "GitHubClientID", "GitHubClientSecret"} {
		require.NotContains(t, string(serialized), canary, "GitHub OAuth credentials belong only to the sealed App store")
	}
}
