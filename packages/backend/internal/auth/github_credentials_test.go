package auth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

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
