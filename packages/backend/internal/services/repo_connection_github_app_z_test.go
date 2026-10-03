package services

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRepoConnectionGitHubApp_Z_JWTCreationError(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	setTestCallerCredentials(t, "ID", "12345")
	setTestCallerCredentials(t, "PEM", string(keyPEM))

	oldCreate := createGitHubAppJWTFunc
	createGitHubAppJWTFunc = func(int64, *rsa.PrivateKey, time.Time) (string, error) {
		return "", errors.New("jwt failed")
	}
	t.Cleanup(func() { createGitHubAppJWTFunc = oldCreate })

	svc := newTestRepoConnectionService(t, &mockRepoConnectionDB{
		queryRowFn: func(context.Context, string, ...any) pgx.Row {
			return mockRepoConnectionRow{scanFn: func(dest ...any) error {
				*(dest[0].(*int64)) = 901
				return nil
			}}
		},
	})
	_, err = svc.CreateGitHubInstallationToken(context.Background(), 1, "owner", "repo")
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
}

func TestRepoConnectionGitHubApp_Z_MustBase64URLEncodeJSONPanics(t *testing.T) {
	assert.Panics(t, func() {
		_ = mustBase64URLEncodeJSON(func() {})
	})
}
