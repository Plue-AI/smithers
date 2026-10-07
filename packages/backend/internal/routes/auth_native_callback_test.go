package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestAuthNativeCallbackStateRoundTrip(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct{ state, agent string }{{"", ""}, {strings.Repeat("A", 43), ""}, {strings.Repeat("A", 43), "extra"}, {"", "codex"}} {
		callbackState := tc.state
		t.Run(callbackState+"/"+tc.agent, func(t *testing.T) {
			var verifier string
			handler := AuthHandler{AuthConfig: defaultRouteAuthConfig(), Service: mockAuthService{
				startGitHubScopesFn: func(_ context.Context, stateVerifier, scopes string) (string, error) {
					verifier = stateVerifier
					require.Equal(t, "read:user,write:workspace,write:agent", scopes)
					return "https://github.example/authorize", nil
				},
				completeGitHubFn: func(_ context.Context, _, _, stateVerifier string) (services.OAuthCallbackResult, error) {
					require.Equal(t, verifier, stateVerifier)
					return services.OAuthCallbackResult{User: db.User{ID: 1, Username: "native-user"}, TokenScopes: []string{"read:user", "write:workspace", "write:agent"}}, nil
				},
				createTokenFn: func(_ context.Context, userID int64, request services.CreateTokenRequest) (services.CreateTokenResult, error) {
					require.Equal(t, int64(1), userID)
					via := tc.agent
					if via == "" {
						via = "cli"
					}
					require.Equal(t, via, request.Via)
					require.Equal(t, []string{"read:user", "write:workspace", "write:agent"}, request.Scopes)
					return services.CreateTokenResult{Token: "smithers_fixture_native"}, nil
				},
			}}
			query := url.Values{"callback_port": {"41523"}, "scopes": {"read:user,write:workspace,write:agent"}}
			if callbackState != "" {
				query.Set("callback_state", callbackState)
			}
			if tc.agent != "" {
				query.Set("agent", tc.agent)
			}
			start := httptest.NewRecorder()
			handler.GetGitHubOAuthCLIStart(start, httptest.NewRequest(http.MethodGet, "/api/auth/github/cli?"+query.Encode(), nil))
			require.Equal(t, http.StatusFound, start.Code)
			if callbackState != "" {
				require.NotContains(t, start.Header().Get("Location"), callbackState)
			}
			callback := httptest.NewRequest(http.MethodGet, "/api/auth/github/callback?code=fixture&state=fixture", nil)
			for _, cookie := range start.Result().Cookies() {
				callback.AddCookie(cookie)
			}
			port, state, ok := cliCallbackFromRequest(callback)
			require.True(t, ok)
			require.Equal(t, "41523", port)
			require.Equal(t, callbackState, state)
			completed := httptest.NewRecorder()
			handler.GetGitHubOAuthCallback(completed, callback)
			require.Equal(t, http.StatusFound, completed.Code)
			location, err := url.Parse(completed.Header().Get("Location"))
			require.NoError(t, err)
			require.Equal(t, "127.0.0.1:41523", location.Host)
			require.Empty(t, location.RawQuery)
			fragment, err := url.ParseQuery(location.Fragment)
			require.NoError(t, err)
			require.Equal(t, callbackState, fragment.Get("callback_state"))
			require.Equal(t, "smithers_fixture_native", fragment.Get("token"))
		})
	}
}

func TestAuthNativeCallbackStateRefusesInvalidAndUnboundState(t *testing.T) {
	t.Parallel()
	handler := AuthHandler{AuthConfig: defaultRouteAuthConfig()}
	for _, state := range []string{"", strings.Repeat("x", 42), strings.Repeat("x", 44), strings.Repeat("x", 42) + ":", strings.Repeat("x", 42) + "\n"} {
		response := httptest.NewRecorder()
		handler.GetGitHubOAuthCLIStart(response, httptest.NewRequest(http.MethodGet, "/api/auth/github/cli?callback_port=41523&callback_state="+url.QueryEscape(state), nil))
		require.Equal(t, http.StatusBadRequest, response.Code)
		require.Empty(t, response.Result().Cookies())
	}
	for _, cookie := range []string{"41523:other:" + strings.Repeat("A", 43), "41523:current:short", "41523:current:" + strings.Repeat("A", 43) + ":extra:unbound", "41523:current:" + strings.Repeat("A", 43) + ":smithers", "41523:current:" + strings.Repeat("A", 43) + ":terminal"} {
		request := httptest.NewRequest(http.MethodGet, "/callback", nil)
		request.AddCookie(&http.Cookie{Name: oauthStateCookieName, Value: "current"})
		request.AddCookie(&http.Cookie{Name: cliCallbackCookieName, Value: cookie})
		_, _, ok := cliCallbackFromRequest(request)
		require.False(t, ok)
	}
}
