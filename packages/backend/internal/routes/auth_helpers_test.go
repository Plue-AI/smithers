package routes

import (
	"context"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestSessionCookieName_Matrix(t *testing.T) {
	t.Parallel()

	tests := []struct {
		input string
		want  string
	}{
		{input: "", want: "smithers_session"},
		{input: " ", want: "smithers_session"},
		{input: "custom_session", want: "custom_session"},
		{input: " custom_session ", want: " custom_session "},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.input, func(t *testing.T) {
			assert.Equal(t, tc.want, sessionCookieName(tc.input))
		})
	}
}

func TestOAuthStateVerifierFromRequest_Matrix(t *testing.T) {
	t.Parallel()

	t.Run("missing_cookie", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		assert.Equal(t, "", oauthStateVerifierFromRequest(req))
	})

	t.Run("trimmed_cookie_value", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.AddCookie(&http.Cookie{Name: oauthStateCookieName, Value: "  verifier  "})
		assert.Equal(t, "verifier", oauthStateVerifierFromRequest(req))
	})
}

func TestAuthCookieHelpers(t *testing.T) {
	t.Parallel()

	expiresAt := time.Now().UTC().Add(2 * time.Hour).Truncate(time.Second)

	t.Run("set_session_cookie", func(t *testing.T) {
		rec := httptest.NewRecorder()
		setSessionCookie(rec, "custom_session", "session-key", expiresAt, true)
		cookies := rec.Result().Cookies()
		require.Len(t, cookies, 1)
		cookie := cookies[0]
		assert.Equal(t, "custom_session", cookie.Name)
		assert.Equal(t, "session-key", cookie.Value)
		assert.Equal(t, "/", cookie.Path)
		assert.True(t, cookie.HttpOnly)
		assert.True(t, cookie.Secure)
		assert.Equal(t, http.SameSiteLaxMode, cookie.SameSite)
		assert.Equal(t, expiresAt, cookie.Expires)
		assert.Greater(t, cookie.MaxAge, 0)
	})

	t.Run("set_oauth_state_cookie", func(t *testing.T) {
		rec := httptest.NewRecorder()
		setOAuthStateCookie(rec, "verifier", expiresAt, false)
		cookies := rec.Result().Cookies()
		require.Len(t, cookies, 1)
		cookie := cookies[0]
		assert.Equal(t, oauthStateCookieName, cookie.Name)
		assert.Equal(t, "verifier", cookie.Value)
		assert.True(t, cookie.HttpOnly)
		assert.False(t, cookie.Secure)
		assert.Equal(t, http.SameSiteLaxMode, cookie.SameSite)
	})

	t.Run("set_csrf_cookie", func(t *testing.T) {
		rec := httptest.NewRecorder()
		middleware.SetCSRFCookie(rec, "csrf-token", true, expiresAt)
		cookies := rec.Result().Cookies()
		require.Len(t, cookies, 1)
		cookie := cookies[0]
		assert.Equal(t, middleware.CSRFCookieName, cookie.Name)
		assert.Equal(t, "csrf-token", cookie.Value)
		assert.False(t, cookie.HttpOnly)
		assert.True(t, cookie.Secure)
		assert.Equal(t, http.SameSiteStrictMode, cookie.SameSite)
		assert.Equal(t, expiresAt, cookie.Expires)
		assert.Greater(t, cookie.MaxAge, 0)
	})

	t.Run("clear_csrf_cookie", func(t *testing.T) {
		rec := httptest.NewRecorder()
		clearCSRFCookie(rec, false)
		cookies := rec.Result().Cookies()
		require.Len(t, cookies, 1)
		cookie := cookies[0]
		assert.Equal(t, middleware.CSRFCookieName, cookie.Name)
		assert.Equal(t, "", cookie.Value)
		assert.Equal(t, -1, cookie.MaxAge)
		assert.False(t, cookie.Expires.After(time.Unix(0, 0).UTC()))
		assert.False(t, cookie.HttpOnly)
		assert.False(t, cookie.Secure)
	})

	t.Run("clear_oauth_state_cookie", func(t *testing.T) {
		rec := httptest.NewRecorder()
		clearOAuthStateCookie(rec, true)
		cookies := rec.Result().Cookies()
		require.Len(t, cookies, 1)
		cookie := cookies[0]
		assert.Equal(t, oauthStateCookieName, cookie.Name)
		assert.Equal(t, "", cookie.Value)
		assert.Equal(t, -1, cookie.MaxAge)
		assert.True(t, cookie.HttpOnly)
		assert.True(t, cookie.Secure)
	})
}

func TestWriteRouteError_Matrix(t *testing.T) {
	t.Parallel()

	t.Run("api_error_passthrough", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		writeRouteError(rec, req, pkgerrors.BadRequest("bad request"))
		assert.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "bad request")
	})

	t.Run("generic_error_becomes_internal", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		writeRouteError(rec, req, assert.AnError)
		assert.Equal(t, http.StatusInternalServerError, rec.Code)
		assert.Contains(t, rec.Body.String(), "internal server error")
	})

	// A 5xx sentence survives only if its code is in the safe set. This one is
	// a written constant naming an environment variable, and it is the only
	// part of the refusal a reader can act on: scrubbed to "service
	// unavailable" it would send them looking at their own box, which is
	// exactly what splitting this out of coding_host_unavailable fixed.
	t.Run("unconfigured_coding_gateway_keeps_its_sentence", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		writeRouteError(rec, req, &pkgerrors.APIError{
			Status:  http.StatusServiceUnavailable,
			Code:    pkgerrors.CodeCodingGatewayNotConfigured,
			Message: "workspace gateway health probe is not configured on this deployment",
		})
		assert.Equal(t, http.StatusServiceUnavailable, rec.Code)
		assert.Contains(t, rec.Body.String(), "health probe is not configured on this deployment")
		assert.Contains(t, rec.Body.String(), string(pkgerrors.CodeCodingGatewayNotConfigured))
	})
}

// §16.3.3 literal cookie attributes through production start/callback/logout.
// Unit exception: OAuth exchange is injected to isolate cookie writers; the
// composed real-provider journeys remain C-INS-03's activation gate.
func TestAuthCookiesFollowEffectiveOrigin(t *testing.T) {
	for _, tc := range []struct {
		origin, host string
		secure       bool
	}{
		{"http://localhost:4000", "localhost:4000", false},
		{"http://lan-a:4000", "lan-a:4000", false},
		{"https://box.example", "box.example", true},
	} {
		t.Run(tc.host, func(t *testing.T) {
			h := &AuthHandler{AuthConfig: defaultRouteAuthConfig(), Service: mockAuthService{
				startGitHubOAuthFn: func(context.Context, string) (string, error) { return "https://github.example/authorize", nil },
				completeGitHubFn: func(context.Context, string, string, string) (services.OAuthCallbackResult, error) {
					return services.OAuthCallbackResult{SessionKey: "session", ExpiresAt: time.Now().Add(time.Hour)}, nil
				},
				logoutFn: func(context.Context, string) error { return nil },
			}}
			h.AuthConfig.CookieSecure = !tc.secure
			guard := middleware.InstallEffectiveOrigin(func(context.Context) ([]string, error) { return []string{tc.origin}, nil })
			for _, operation := range []struct {
				path    string
				handler http.HandlerFunc
			}{
				{"/api/auth/github", h.GetGitHubOAuthStart},
				{"/api/auth/github/callback?code=code&state=state", h.GetGitHubOAuthCallback},
				{"/api/auth/logout", h.PostLogout},
			} {
				r := httptest.NewRequest("GET", "http://"+tc.host+operation.path, nil)
				r.RemoteAddr = "127.0.0.1:9"
				r.Header.Set("X-Forwarded-Proto", "https")
				r.AddCookie(&http.Cookie{Name: oauthStateCookieName, Value: "state"})
				r.AddCookie(&http.Cookie{Name: "smithers_session", Value: "session"})
				w := httptest.NewRecorder()
				guard(operation.handler).ServeHTTP(w, r)
				require.Less(t, w.Code, 400)
				require.NotEmpty(t, w.Result().Cookies())
				for _, cookie := range w.Result().Cookies() {
					require.Empty(t, cookie.Domain)
					require.Equal(t, "/", cookie.Path)
					require.Equal(t, http.SameSiteLaxMode, cookie.SameSite)
					require.Equal(t, tc.secure, cookie.Secure, operation.path+" "+cookie.Name)
				}
			}
		})
	}
}
