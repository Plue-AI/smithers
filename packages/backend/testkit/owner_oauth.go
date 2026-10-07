package testkit

import (
	"net/http"
	"net/url"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/stretchr/testify/require"
)

// InstallOwnerOAuth registers a loopback GitHub fake and stores its sealed App
// credentials in the test-owned database. The native entry lives outside Go's
// internal import boundary, so its process harness uses this shared fixture.
// No request from this fixture reaches GitHub.
func InstallOwnerOAuth(t *testing.T, pool *pgxpool.Pool, origin, encryptionKey string) string {
	t.Helper()
	seed, err := githubfake.LocalSeed()
	require.NoError(t, err)
	github, err := githubfake.New(seed)
	require.NoError(t, err)
	t.Cleanup(github.Close)
	res, err := http.PostForm(github.URL+"/settings/apps/new", url.Values{"manifest": {`{"redirect_url":"` + origin + `/setup/github/callback","callback_urls":["` + origin + `/api/auth/github/callback"],"default_permissions":{"emails":"read","contents":"write","metadata":"read"}}`}})
	require.NoError(t, err)
	require.Equal(t, 200, res.StatusCode)
	res.Body.Close()
	res, err = http.Post(github.URL+"/app-manifests/"+seed.ConversionCode+"/conversions", "application/json", nil)
	require.NoError(t, err)
	require.Equal(t, 201, res.StatusCode)
	res.Body.Close()
	codec, err := webhook.NewSecretCodec(encryptionKey)
	require.NoError(t, err)
	store := services.NewGitHubAppCredentialStore(pool, codec)
	require.NoError(t, store.Save(t.Context(), services.GitHubAppCredentials{ID: seed.AppID, Slug: seed.Slug, OwnerLogin: seed.OwnerLogin, OwnerKind: seed.OwnerKind, ClientID: seed.ClientID, ClientSecret: seed.ClientSecret, WebhookSecret: seed.WebhookSecret, PEM: seed.PrivateKeyPEM}))
	require.NoError(t, store.SaveCallbackURLs(t.Context(), []string{origin + "/api/auth/github/callback"}))
	return github.URL
}
