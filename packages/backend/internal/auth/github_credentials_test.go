package auth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// Unit exception: inject credential reads to isolate outbound OAuth behavior.
// Real sealed persistence and reload are covered by credential integration tests.
type testOAuthCredentials struct {
	id, secret string
	err        error
}

func (s *testOAuthCredentials) OAuthClient(ctx context.Context) (string, string, error) {
	if err := ctx.Err(); err != nil {
		return "", "", err
	}
	return s.id, s.secret, s.err
}

func TestGitHubClient_StoredOAuthCredentialsFreshForEveryRequest(t *testing.T) {
	source := &testOAuthCredentials{id: "first-id", secret: "first-secret"}
	var pairs [][2]string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.NoError(t, r.ParseForm())
		pairs = append(pairs, [2]string{r.Form.Get("client_id"), r.Form.Get("client_secret")})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"access","refresh_token":"refresh"}`))
	}))
	defer server.Close()
	client := NewGitHubClient(source, "http://localhost:4000/api/auth/github/callback", server.URL, server.URL)
	first, err := client.AuthorizationURL(context.Background(), "state-one")
	require.NoError(t, err)
	u, err := url.Parse(first)
	require.NoError(t, err)
	require.Equal(t, "first-id", u.Query().Get("client_id"))
	source.id = "second-id"
	source.secret = "second-secret"
	_, err = client.ExchangeCode(context.Background(), "conversion-code")
	require.NoError(t, err)
	source.id = "third-id"
	source.secret = "third-secret"
	_, err = client.RefreshToken(context.Background(), "old-refresh")
	require.NoError(t, err)
	last, err := client.AuthorizationURL(context.Background(), "state-two")
	require.NoError(t, err)
	u, err = url.Parse(last)
	require.NoError(t, err)
	require.Equal(t, "third-id", u.Query().Get("client_id"))
	require.Equal(t, [][2]string{{"second-id", "second-secret"}, {"third-id", "third-secret"}}, pairs)
}

func TestGitHubClient_StoredOAuthRefusesMissingCorruptAndCanceledCredentials(t *testing.T) {
	broken := errors.New("sealed credentials unavailable")
	for _, tc := range []struct {
		name   string
		source GitHubOAuthCredentialSource
		want   error
	}{
		{"nil", nil, services.ErrGitHubAppNotConfigured},
		{"absent", &testOAuthCredentials{err: services.ErrGitHubAppNotConfigured}, services.ErrGitHubAppNotConfigured},
		{"corrupt", &testOAuthCredentials{err: broken}, broken},
		{"empty-id", &testOAuthCredentials{secret: "secret"}, services.ErrGitHubAppNotConfigured},
		{"empty-secret", &testOAuthCredentials{id: "id"}, services.ErrGitHubAppNotConfigured},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(500) }))
			defer server.Close()
			client := NewGitHubClient(tc.source, "", server.URL, server.URL)
			value, err := client.AuthorizationURL(context.Background(), "state")
			require.ErrorIs(t, err, tc.want)
			require.Empty(t, value)
			token, err := client.ExchangeCode(context.Background(), "code")
			require.ErrorIs(t, err, tc.want)
			require.Empty(t, token.AccessToken)
			token, err = client.RefreshToken(context.Background(), "refresh")
			require.ErrorIs(t, err, tc.want)
			require.Empty(t, token.AccessToken)
			require.Zero(t, calls, "refused credentials must never reach GitHub")
		})
	}
	source := &testOAuthCredentials{id: "id", secret: "secret"}
	client := NewGitHubClient(source, "", "http://localhost:1", "")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := client.AuthorizationURL(ctx, "state")
	require.ErrorIs(t, err, context.Canceled)
	_, err = client.ExchangeCode(ctx, "code")
	require.ErrorIs(t, err, context.Canceled)
	_, err = client.RefreshToken(ctx, "refresh")
	require.ErrorIs(t, err, context.Canceled)
}

func TestGitHubClient_LegacyOAuthEnvironmentCannotConfigureSource(t *testing.T) {
	t.Setenv("SMITHERS_AUTH_GITHUB_CLIENT_ID", "legacy-id")
	t.Setenv("SMITHERS_AUTH_GITHUB_CLIENT_SECRET", "legacy-secret")
	client := NewGitHubClient(nil, "", "", "")
	_, err := client.AuthorizationURL(context.Background(), "state")
	require.ErrorIs(t, err, services.ErrGitHubAppNotConfigured)
}

// §16.3.3: configured origin scheme wins over forwarding/TLS hints. This
// unit fixture isolates URL construction; sealed credentials have real DB tests.
func TestGitHubClientEffectiveOriginRedirectURI(t *testing.T) {
	for _, tc := range []struct{ origin, host, want string }{
		{"http://lan-a:4000", "lan-a:4000", "http://lan-a:4000/api/auth/github/callback"},
		{"https://box.example", "box.example", "https://box.example/api/auth/github/callback"},
		{"http://localhost:4000", "localhost:4000", "http://localhost:4000/api/auth/github/callback"},
	} {
		t.Run(tc.host, func(t *testing.T) {
			client := NewGitHubClient(&testInstallOAuthCredentials{testOAuthCredentials: testOAuthCredentials{id: "client", secret: "secret"}}, "http://stale.example/api/auth/github/callback", "http://github.example", "")
			r := httptest.NewRequest("GET", "http://"+tc.host+"/authorization", nil)
			r.RemoteAddr = "127.0.0.1:9"
			r.Header.Set("X-Forwarded-Proto", "http")
			middleware.InstallEffectiveOrigin(func(context.Context) ([]string, error) { return []string{tc.origin}, nil })(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				target, err := client.AuthorizationURL(r.Context(), "state")
				require.NoError(t, err)
				u, err := url.Parse(target)
				require.NoError(t, err)
				require.Equal(t, tc.want, u.Query().Get("redirect_uri"))
			})).ServeHTTP(httptest.NewRecorder(), r)
		})
	}
}

// Unit credential fixture for the recorded callback-URL provider contract.
type testInstallOAuthCredentials struct {
	testOAuthCredentials
	fixes []services.GitHubAppCallbackFix
}

func (s *testInstallOAuthCredentials) CallbackFixes(context.Context, []string) ([]services.GitHubAppCallbackFix, error) {
	return s.fixes, nil
}

func TestGitHubClientMissingCallbackReturnsExactFix(t *testing.T) {
	source := &testInstallOAuthCredentials{testOAuthCredentials: testOAuthCredentials{id: "client", secret: "secret"}, fixes: []services.GitHubAppCallbackFix{{SettingsURL: "https://github.com/settings/apps/team", AddURL: "https://box.example/api/auth/github/callback"}}}
	client := NewGitHubClient(source, "", "", "")
	r := httptest.NewRequest("GET", "http://box.example/authorization", nil)
	r.RemoteAddr = "127.0.0.1:9"
	middleware.InstallEffectiveOrigin(func(context.Context) ([]string, error) { return []string{"https://box.example"}, nil })(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		target, err := client.AuthorizationURL(r.Context(), "state")
		require.Empty(t, target)
		require.ErrorContains(t, err, "https://github.com/settings/apps/team — add https://box.example/api/auth/github/callback")
	})).ServeHTTP(httptest.NewRecorder(), r)
}
