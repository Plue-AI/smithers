package services

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestRepoConnectionGitHubApp_Cov_PrivateKeyCredentialAndURLBranches(t *testing.T) {
	rsaKey, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	pkcs8, err := x509.MarshalPKCS8PrivateKey(rsaKey)
	require.NoError(t, err)
	pkcs8PEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pkcs8})

	parsed, err := parseGitHubAppPrivateKey(string(pkcs8PEM))
	require.NoError(t, err)
	assert.Equal(t, rsaKey.N, parsed.N)

	_, err = parseGitHubAppPrivateKey("not pem")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "no pem")

	ecdsaKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(t, err)
	ecdsaPKCS8, err := x509.MarshalPKCS8PrivateKey(ecdsaKey)
	require.NoError(t, err)
	_, err = parseGitHubAppPrivateKey(string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: ecdsaPKCS8})))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "must be RSA")

	t.Setenv(envGitHubAppAPIBaseURL, "https://api.github.test///")
	assert.Equal(t, "https://api.github.test", githubAPIBaseURL())
}

func TestRepoConnectionGitHubApp_Cov_CreateTokenHTTPErrorBranches(t *testing.T) {
	const installationID = int64(9908)
	invalidateCachedInstallationToken(installationID)
	defer invalidateCachedInstallationToken(installationID)

	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	privateKeyPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(privateKey)})

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/app/installations/9908/access_tokens", r.URL.Path)
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"message":"installation suspended"}`))
	}))
	defer server.Close()

	setTestCallerCredentials(t, "ID", "12345")
	setTestCallerCredentials(t, "PEM", string(privateKeyPEM))
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)

	svc := newTestRepoConnectionService(t, &mockRepoConnectionDB{
		queryRowFn: func(context.Context, string, ...any) pgx.Row {
			return mockRepoConnectionRow{scanFn: func(dest ...any) error {
				*(dest[0].(*int64)) = installationID
				return nil
			}}
		},
	})

	_, err = svc.CreateGitHubInstallationTokenForUserRepo(context.Background(), 7, "acme", "repo", testTokenPermissions)
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, http.StatusBadGateway, apiErr.Status)
	assert.Equal(t, pkgerrors.CodeGitHubPermission, apiErr.Code)
	assert.Equal(t, "GitHub access denied", apiErr.Message, "upstream text never reaches a caller")

	storeCachedInstallationToken(testTokenKey(installationID), installationID, "cached", time.Now().Add(installationTokenEarlyExpiry-time.Second))
	_, ok := getCachedInstallationToken(testTokenKey(installationID))
	assert.False(t, ok, "tokens inside the early-expiry window must not be served")
}
