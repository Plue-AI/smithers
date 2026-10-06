package compose

import (
	"context"
	"errors"
	"fmt"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

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
	keyAuth, client, err := buildAuthProviders(config.AuthConfig{GitHubRedirectURL: "http://localhost:4000/api/auth/github/callback"}, provider, nil)
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
	keyAuth, client, err := buildAuthProviders(config.AuthConfig{Auth0ClientID: "independent-auth0-client"}, nil, nil)
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

func TestGitHubOAuthBudgetPausesExchangeAndRefresh(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		require.Equal(t, "/login/oauth/access_token", r.URL.Path)
		w.Header().Set("Retry-After", "60")
		w.WriteHeader(429)
		_, _ = w.Write([]byte(`{"error":"slow_down"}`))
	}))
	defer server.Close()
	budget := newGitHubBudget(topology{})
	_, client, err := buildAuthProviders(config.AuthConfig{GitHubOAuthBaseURL: server.URL}, &githubAppOAuthProviderFixture{id: "client", secret: "secret"}, budget)
	require.NoError(t, err)
	_, err = client.ExchangeCode(context.Background(), "one-use-code")
	require.Error(t, err)
	_, err = client.ExchangeCode(context.Background(), "other-code")
	require.Error(t, err)
	refresher, ok := client.(interface {
		RefreshToken(context.Context, string) (services.GitHubTokenResult, error)
	})
	require.True(t, ok)
	_, err = refresher.RefreshToken(context.Background(), "one-use-refresh")
	require.Error(t, err)
	require.NotErrorIs(t, err, services.ErrGitHubRefreshTokenInvalid, "a temporary local pause must not invalidate a refresh token")
	require.EqualValues(t, 1, calls.Load())
}

func TestGitHubSetupBudgetSharesAdmissionAndPreservesRedirectPolicy(t *testing.T) {
	for _, kind := range []string{"exhausted", "paused", "redirect"} {
		t.Run(kind, func(t *testing.T) {
			pool, _ := postgresfixture.NewProductDatabase(t)
			codec, err := webhook.NewSecretCodec("setup-budget-key")
			require.NoError(t, err)
			store := services.NewGitHubAppCredentialStore(pool, codec)
			var calls, redirects atomic.Int32
			destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirects.Add(1) }))
			defer destination.Close()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				require.Equal(t, "/users/acme", r.URL.Path)
				switch kind {
				case "exhausted":
					w.Header().Set("X-RateLimit-Limit", "100")
					w.Header().Set("X-RateLimit-Remaining", "0")
					w.Header().Set("X-RateLimit-Reset", fmt.Sprint(time.Now().Add(time.Hour).Unix()))
					_, _ = w.Write([]byte(`{"type":"Organization"}`))
				case "paused":
					w.Header().Set("Retry-After", "60")
					w.WriteHeader(429)
				case "redirect":
					http.Redirect(w, r, destination.URL, 302)
				}
			}))
			defer server.Close()
			budget := newGitHubBudget(topology{})
			setup := services.NewGitHubAppManifestService(pool, store, server.URL, nil, services.WithGitHubAppManifestBudget(budget))
			ctx := services.WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000")
			_, err = setup.Begin(ctx, services.GitHubAppManifestRequest{OwnerLogin: "acme"})
			if kind == "exhausted" {
				require.NoError(t, err)
			} else {
				require.Error(t, err)
			}
			if kind != "redirect" {
				_, err = setup.Begin(ctx, services.GitHubAppManifestRequest{OwnerLogin: "acme"})
				require.Error(t, err)
			}
			if kind == "exhausted" {
				_, oauth, e := buildAuthProviders(config.AuthConfig{GitHubOAuthBaseURL: server.URL}, &githubAppOAuthProviderFixture{id: "client", secret: "secret"}, budget)
				require.NoError(t, e)
				_, e = oauth.ExchangeCode(ctx, "code")
				require.Error(t, e, "anonymous setup headroom is shared with the exchange transport")
			}
			require.EqualValues(t, 1, calls.Load())
			require.Zero(t, redirects.Load())
		})
	}
}
