package services

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"net/http"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/stretchr/testify/require"
)

func TestGitHubAppUnknownOwnerIsUserError(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	fake, err := githubfake.New(githubfake.Config{AppID: 42, OwnerLogin: "acme", PrivateKeyPEM: string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))})
	require.NoError(t, err)
	defer fake.Close()
	service := NewGitHubAppManifestService(nil, nil, fake.URL, nil)
	var account struct {
		Type string `json:"type"`
	}
	require.NoError(t, service.request(context.Background(), http.MethodGet, "/users/acme", "", &account))
	require.Equal(t, "User", account.Type)
	err = service.request(context.Background(), http.MethodGet, "/users/missing-owner", "", &account)
	var api *pkgerrors.APIError
	require.ErrorAs(t, err, &api)
	require.Equal(t, http.StatusBadRequest, api.Status)
	require.Equal(t, "GitHub owner not found", api.Message)
	// An outage from the same GitHub fake remains an infrastructure failure.
	outage, err := githubfake.New(githubfake.Config{AppID: 42, OwnerLogin: "acme", OwnerStatus: 503, PrivateKeyPEM: string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))})
	require.NoError(t, err)
	defer outage.Close()
	unavailable := NewGitHubAppManifestService(nil, nil, outage.URL, nil)
	err = unavailable.request(context.Background(), http.MethodGet, "/users/acme", "", &account)
	require.ErrorAs(t, err, &api)
	require.Equal(t, http.StatusBadGateway, api.Status)
	// An unavailable GitHub connection remains an infrastructure failure.
	fake.Close()
	err = service.request(context.Background(), http.MethodGet, "/users/acme", "", &account)
	require.ErrorAs(t, err, &api)
	require.Equal(t, http.StatusBadGateway, api.Status)
}
