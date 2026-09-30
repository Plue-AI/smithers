package routes

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// Exercise the browser HTTP boundary; only the upstream identity exchange is a
// collaborator. The handler must carry and validate the actual cookie roundtrip.
func TestGitHubBrowserReturnRoundtrip(t *testing.T) {
	for _, tc := range []struct {
		name, target, want string
		stale              bool
	}{
		{"repository", "/smithersai/smithers/?tab=issues#open", "/smithersai/smithers/?tab=issues#open", false},
		{"landing app resume", "/?signed-in=github", "/?signed-in=github", false},
		{"stale flow", "/old/repo/", "https://app.example/", true},
		{"no target", "", "https://app.example/", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var verifier string
			h := AuthHandler{PublicOrigin: "https://app.example", AuthConfig: defaultRouteAuthConfig(), Service: mockAuthService{
				startGitHubOAuthFn: func(_ context.Context, v string) (string, error) {
					verifier = v
					return "https://github.com/login/oauth/authorize?state=opaque", nil
				},
				completeGitHubFn: func(_ context.Context, _, _, v string) (services.OAuthCallbackResult, error) {
					require.Equal(t, verifier, v)
					return services.OAuthCallbackResult{SessionKey: "session", ExpiresAt: time.Now().Add(time.Hour)}, nil
				},
			}}
			start := httptest.NewRecorder()
			h.GetGitHubOAuthStart(start, httptest.NewRequest("GET", "/api/auth/github?return_to="+url.QueryEscape(tc.target), nil))
			require.Equal(t, http.StatusFound, start.Code)
			callback := httptest.NewRequest("GET", "/api/auth/github/callback?code=code&state=opaque", nil)
			for _, c := range start.Result().Cookies() {
				if c.MaxAge >= 0 {
					callback.AddCookie(c)
				}
			}
			if tc.stale {
				second := httptest.NewRecorder()
				h.GetGitHubOAuthStart(second, httptest.NewRequest("GET", "/api/auth/github", nil))
				callback.Header.Del("Cookie")
				for _, c := range start.Result().Cookies() {
					if c.Name != oauthStateCookieName && c.MaxAge >= 0 {
						callback.AddCookie(c)
					}
				}
				callback.AddCookie(cookieByName(second.Result().Cookies(), oauthStateCookieName))
			}
			result := httptest.NewRecorder()
			h.GetGitHubOAuthCallback(result, callback)
			require.Equal(t, http.StatusFound, result.Code)
			require.Equal(t, tc.want, result.Header().Get("Location"))
			if tc.target != "" {
				cookie := cookieByName(start.Result().Cookies(), "smithers_return_to")
				require.NotNil(t, cookie)
				require.True(t, cookie.HttpOnly)
				require.True(t, cookie.Secure)
				require.Equal(t, http.SameSiteLaxMode, cookie.SameSite)
				cleared := cookieByName(result.Result().Cookies(), "smithers_return_to")
				require.NotNil(t, cleared)
				require.Equal(t, -1, cleared.MaxAge)
			}
		})
	}
}

func TestGitHubBrowserRejectsUnsafeReturnBeforeOAuth(t *testing.T) {
	for _, target := range []string{"https://evil.example/", "//evil.example/", "/\\evil.example/", "/%2f%2fevil.example/", "/%5cevil.example/", "/ok\r\nLocation: https://evil.example/", "relative", "///evil.example/"} {
		t.Run(target, func(t *testing.T) {
			called := false
			h := AuthHandler{AuthConfig: defaultRouteAuthConfig(), Service: mockAuthService{startGitHubOAuthFn: func(context.Context, string) (string, error) { called = true; return "https://github.com/", nil }}}
			r := httptest.NewRecorder()
			h.GetGitHubOAuthStart(r, httptest.NewRequest("GET", "/api/auth/github?return_to="+url.QueryEscape(target), nil))
			require.Equal(t, http.StatusBadRequest, r.Code)
			require.False(t, called, "unsafe redirect must be refused before creating OAuth state")
		})
	}
}

func TestGitHubBrowserCallbackRejectsTamperedReturn(t *testing.T) {
	for _, target := range []string{"https://evil.example/", "//evil.example/", "/\\evil.example/", "/%2f%2fevil.example/"} {
		t.Run(target, func(t *testing.T) {
			h := AuthHandler{PublicOrigin: "https://app.example", AuthConfig: defaultRouteAuthConfig(), Service: mockAuthService{
				completeGitHubFn: func(context.Context, string, string, string) (services.OAuthCallbackResult, error) {
					return services.OAuthCallbackResult{SessionKey: "session", ExpiresAt: time.Now().Add(time.Hour)}, nil
				},
			}}
			r := httptest.NewRequest("GET", "/api/auth/github/callback?code=code&state=opaque", nil)
			r.AddCookie(&http.Cookie{Name: oauthStateCookieName, Value: "verifier"})
			r.AddCookie(&http.Cookie{Name: "smithers_return_to", Value: "verifier." + base64.RawURLEncoding.EncodeToString([]byte(target))})
			result := httptest.NewRecorder()
			h.GetGitHubOAuthCallback(result, r)
			require.Equal(t, "https://app.example/", result.Header().Get("Location"))
			require.Equal(t, -1, cookieByName(result.Result().Cookies(), "smithers_return_to").MaxAge)
		})
	}
}

func TestGitHubBrowserDefaultReturnUsesCallbackOrigin(t *testing.T) {
	h := AuthHandler{PublicOrigin: "https://api.example", AuthConfig: defaultRouteAuthConfig(), Service: mockAuthService{
		completeGitHubFn: func(context.Context, string, string, string) (services.OAuthCallbackResult, error) {
			return services.OAuthCallbackResult{SessionKey: "session", ExpiresAt: time.Now().Add(time.Hour)}, nil
		},
	}}
	h.AuthConfig.GitHubRedirectURL = "https://app.example/api/auth/github/callback"
	r := httptest.NewRequest("GET", "/api/auth/github/callback?code=code&state=opaque", nil)
	w := httptest.NewRecorder()
	h.GetGitHubOAuthCallback(w, r)
	require.Equal(t, "https://app.example/", w.Header().Get("Location"))
	for _, c := range w.Result().Cookies() {
		require.Empty(t, c.Domain, "browser cookies must stay host-only")
	}
}
