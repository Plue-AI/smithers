package services

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// testGitHubAppPrivateKeyPEM generates a throwaway RSA private key in PKCS#1 PEM
// form for tests that need the GitHub App to look "configured".
func testGitHubAppPrivateKeyPEM(t *testing.T) string {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	return string(pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(key),
	}))
}

// notConfiguredStatusDB returns a mock whose installation lookups both miss
// (ErrNoRows), simulating an uninstalled/unmapped repo — the exact prod shape
// where GetGitHubAppStatus must decide what to tell the client.
func notConfiguredStatusDB() *mockRepoConnectionDB {
	return &mockRepoConnectionDB{
		queryRowFn: func(ctx context.Context, sql string, args ...any) pgx.Row {
			return mockRepoConnectionRow{scanFn: func(dest ...any) error { return pgx.ErrNoRows }}
		},
	}
}

// RED: when GitHub App credentials are unconfigured (no app id / private key)
// AND no install-url override is set, the status MUST NOT emit the known-dead
// default install URL (https://github.com/apps/smithers-cloud/... 404s). Today
// it always emits that dead default, so this fails for the right reason.
func TestRepoConnectionService_GetGitHubAppStatus_NotConfigured_OmitsDeadInstallURL(t *testing.T) {
	setTestCallerCredentials(t, "ID", "")
	setTestCallerCredentials(t, "PEM", "")

	svc := newTestRepoConnectionService(t, notConfiguredStatusDB())

	status, err := svc.GetGitHubAppStatus(context.Background(), 7, "acme", "repo")
	require.NoError(t, err)
	assert.False(t, status.GitHubAppInstalled)
	assert.NotContains(t, status.InstallURL, "smithers-cloud",
		"must never emit the known-dead smithers-cloud install URL")
	assert.Empty(t, status.InstallURL,
		"install_url must be blank when creds are unconfigured and no override is set")
}

// RED: GitHubAppStatus must expose a distinct github_app_configured signal so the
// client can render honestly instead of showing a useless install prompt. Today
// there is no such field, so the marshaled JSON lacks the key.
func TestRepoConnectionService_GetGitHubAppStatus_NotConfigured_ExposesConfiguredFalse(t *testing.T) {
	setTestCallerCredentials(t, "ID", "")
	setTestCallerCredentials(t, "PEM", "")

	svc := newTestRepoConnectionService(t, notConfiguredStatusDB())

	status, err := svc.GetGitHubAppStatus(context.Background(), 7, "acme", "repo")
	require.NoError(t, err)

	raw, err := json.Marshal(status)
	require.NoError(t, err)

	var fields map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(raw, &fields))

	val, ok := fields["github_app_configured"]
	require.True(t, ok, "GitHubAppStatus must expose a github_app_configured field")
	assert.Equal(t, "false", string(val),
		"github_app_configured must be false when app credentials are absent")
}

// RED: when credentials ARE configured, github_app_configured must be true.
func TestRepoConnectionService_GetGitHubAppStatus_Configured_ExposesConfiguredTrue(t *testing.T) {
	setTestCallerCredentials(t, "ID", "12345")
	setTestCallerCredentials(t, "PEM", testGitHubAppPrivateKeyPEM(t))

	svc := newTestRepoConnectionService(t, notConfiguredStatusDB())

	status, err := svc.GetGitHubAppStatus(context.Background(), 7, "acme", "repo")
	require.NoError(t, err)

	raw, err := json.Marshal(status)
	require.NoError(t, err)

	var fields map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(raw, &fields))

	val, ok := fields["github_app_configured"]
	require.True(t, ok, "GitHubAppStatus must expose a github_app_configured field")
	assert.Equal(t, "true", string(val),
		"github_app_configured must be true when app credentials are present")
}
