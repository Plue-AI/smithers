package compose

import (
	"context"
	"errors"
	"net/url"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type githubAppOAuthProviderFixture struct {
	id, secret string
	err        error
	reads      int
}

func (f *githubAppOAuthProviderFixture) OAuthClient(ctx context.Context) (string, string, error) {
	f.reads++
	if err := ctx.Err(); err != nil {
		return "", "", err
	}
	return f.id, f.secret, f.err
}

func TestGitHubAppOAuthProviderCompositionReloadsCredentials(t *testing.T) {
	t.Setenv("SMITHERS_AUTH_GITHUB_CLIENT_ID", "legacy-oauth-id")
	t.Setenv("SMITHERS_AUTH_GITHUB_CLIENT_SECRET", "legacy-oauth-secret")
	provider := &githubAppOAuthProviderFixture{err: services.ErrGitHubAppNotConfigured}
	keyAuth, client, err := buildAuthProviders(config.AuthConfig{GitHubRedirectURL: "http://localhost:4000/api/auth/github/callback"}, provider)
	require.NoError(t, err)
	require.NotNil(t, keyAuth)
	require.NotNil(t, client, "App creation after startup must become usable without recomposition")
	require.Zero(t, provider.reads, "composition must not capture missing credentials before setup")
	_, err = client.AuthorizationURL(context.Background(), "state")
	require.ErrorIs(t, err, services.ErrGitHubAppNotConfigured)
	provider.id, provider.secret, provider.err = "stored-app-client", "stored-app-secret", nil
	location, err := client.AuthorizationURL(context.Background(), "state")
	require.NoError(t, err)
	parsed, err := url.Parse(location)
	require.NoError(t, err)
	require.Equal(t, "stored-app-client", parsed.Query().Get("client_id"))
	require.Equal(t, "state", parsed.Query().Get("state"))
	require.Equal(t, "http://localhost:4000/api/auth/github/callback", parsed.Query().Get("redirect_uri"))
	provider.err = errors.New("credential store unavailable")
	_, err = client.AuthorizationURL(context.Background(), "state")
	require.ErrorContains(t, err, "credential store unavailable")
	provider.err, provider.id = nil, "updated-app-client"
	location, err = client.AuthorizationURL(context.Background(), "state")
	require.NoError(t, err)
	require.Contains(t, location, "client_id=updated-app-client")
	require.NotContains(t, location, "legacy")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = client.AuthorizationURL(ctx, "state")
	require.ErrorIs(t, err, context.Canceled)
}

func TestGitHubAppOAuthProviderUnavailableWithoutSharedSource(t *testing.T) {
	keyAuth, client, err := buildAuthProviders(config.AuthConfig{Auth0ClientID: "independent-auth0-client"}, nil)
	require.NoError(t, err)
	require.NotNil(t, keyAuth)
	require.Nil(t, client)
}

func TestGitHubAppCredentialCompositionUsesOneSource(t *testing.T) {
	store := services.NewGitHubAppCredentialStore(nil, nil)
	for _, singleOwner := range []bool{true, false} {
		selected, err := selectGitHubAppCredentials(singleOwner, false, store)
		require.NoError(t, err)
		require.Same(t, store, selected)
	}
	selected, err := selectGitHubAppCredentials(false, true, store)
	require.NoError(t, err)
	require.IsType(t, &services.EnvGitHubAppCredentials{}, selected)
	selected, err = selectGitHubAppCredentials(true, true, store)
	require.ErrorContains(t, err, "requires sealed")
	require.Nil(t, selected)
}
