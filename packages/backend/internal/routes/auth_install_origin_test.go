package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

func TestInstallOAuthStartsCanonicalizeLoopbackBeforeEffects(t *testing.T) {
	for _, host := range []string{"127.0.0.1:4000", "[::1]:4000"} {
		for _, path := range []string{
			"/api/auth/github?return_to=%2Fowner%2Frepo",
			"/api/auth/github/cli?callback_port=4321&callback_state=" + strings.Repeat("a", 43) + "&scopes=read%3Arepository",
			"/api/auth/github/cli?callback_port=4321&admin=1&ttl=5m",
		} {
			t.Run(host+path, func(t *testing.T) {
				calls := 0
				fake := cliAdminAuthFake{start: func(context.Context, string, string, int, string, string) (string, error) {
					calls++
					return "https://github.com/login/oauth/authorize", nil
				}}
				fake.startGitHubScopesFn = func(context.Context, string, string) (string, error) {
					calls++
					return "https://github.com/login/oauth/authorize", nil
				}
				h := AuthHandler{Service: fake, InstallSetup: &services.InstallSetupSessions{}, AuthConfig: config.AuthConfig{Mode: "selfhost"}}
				start := h.GetGitHubOAuthStart
				if strings.Contains(path, "/cli?") {
					start = h.GetGitHubOAuthCLIStart
				}
				req := httptest.NewRequest(http.MethodGet, "http://"+host+path, nil)
				req.RemoteAddr = "127.0.0.1:32100"
				response := httptest.NewRecorder()
				start(response, req)
				require.Equal(t, http.StatusFound, response.Code)
				require.Equal(t, "http://localhost:4000"+path, response.Header().Get("Location"))
				require.Zero(t, calls, "alias redirects precede OAuth and admin consent requests")
				require.Empty(t, response.Result().Cookies(), "state and callback cookies belong to localhost only")
			})
		}
	}
}

func TestInstallCLIOAuthUsesResolvedOriginAndCookieScheme(t *testing.T) {
	for _, tc := range []struct {
		name, host, peer, forwarded, origin string
		secure                              bool
	}{
		{"localhost", "localhost:4000", "127.0.0.1:32100", "", "http://localhost:4000", false},
		{"LAN", "mini.local:4000", "192.0.2.1:32100", "", "http://mini.local:4000", false},
		{"proxy", "127.0.0.1:4000", "127.0.0.1:32100", "box.example", "https://box.example", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			fake := mockAuthService{startGitHubScopesFn: func(ctx context.Context, verifier, scopes string) (string, error) {
				calls++
				require.NotEmpty(t, verifier)
				require.Equal(t, "read:repository", scopes)
				require.Equal(t, tc.origin+"/api/auth/github/callback", services.GitHubRedirectURI(ctx))
				return "https://github.com/login/oauth/authorize?state=bound", nil
			}}
			origins := middleware.FixedOrigins("http://mini.local:4000", "https://box.example")
			h := AuthHandler{Service: fake, InstallSetup: &services.InstallSetupSessions{}, Origins: origins, AuthConfig: config.AuthConfig{Mode: "selfhost"}}
			req := httptest.NewRequest(http.MethodGet, "http://"+tc.host+"/api/auth/github/cli?callback_port=4321&scopes=read%3Arepository", nil)
			req.RemoteAddr = tc.peer
			req.Header.Set("X-Forwarded-Host", tc.forwarded)
			req.Header.Set("X-Forwarded-Proto", "untrusted")
			response := httptest.NewRecorder()
			h.GetGitHubOAuthCLIStart(response, req)
			require.Equal(t, http.StatusFound, response.Code)
			require.Equal(t, "https://github.com/login/oauth/authorize?state=bound", response.Header().Get("Location"))
			require.Equal(t, 1, calls)
			require.False(t, h.AuthConfig.CookieSecure, "per-request scheme must not mutate the shared handler")
			require.Len(t, response.Result().Cookies(), 2)
			for _, cookie := range response.Result().Cookies() {
				require.Equal(t, tc.secure, cookie.Secure)
				require.True(t, cookie.HttpOnly)
				require.Empty(t, cookie.Domain)
				require.Equal(t, "/", cookie.Path)
				require.Equal(t, http.SameSiteLaxMode, cookie.SameSite)
			}
		})
	}
}

func TestInstallCLIOAuthRefusesCrossOriginBeforeEffects(t *testing.T) {
	for _, admin := range []string{"", "&admin=1&ttl=5m"} {
		t.Run(admin, func(t *testing.T) {
			calls := 0
			fake := cliAdminAuthFake{start: func(context.Context, string, string, int, string, string) (string, error) {
				calls++
				return "https://github.com/login/oauth/authorize", nil
			}}
			fake.startGitHubScopesFn = func(context.Context, string, string) (string, error) {
				calls++
				return "https://github.com/login/oauth/authorize", nil
			}
			h := AuthHandler{Service: fake, InstallSetup: &services.InstallSetupSessions{}, AuthConfig: config.AuthConfig{Mode: "selfhost"}}
			req := httptest.NewRequest(http.MethodGet, "http://localhost:4000/api/auth/github/cli?callback_port=4321"+admin, nil)
			req.RemoteAddr = "127.0.0.1:32100"
			req.Header.Set("Origin", "https://other.example")
			response := httptest.NewRecorder()
			h.GetGitHubOAuthCLIStart(response, req)
			require.Equal(t, http.StatusForbidden, response.Code)
			require.Zero(t, calls)
			require.Empty(t, response.Result().Cookies())
		})
	}
}
