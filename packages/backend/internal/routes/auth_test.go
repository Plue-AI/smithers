package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type mockAuthService struct {
	createKeyAuthNonceFn func(ctx context.Context) (string, error)
	verifyKeyAuthFn      func(ctx context.Context, message, signature string) (services.VerifyKeyAuthResult, error)
	startGitHubOAuthFn   func(ctx context.Context, stateVerifier string) (string, error)
	startGitHubScopesFn  func(ctx context.Context, stateVerifier, rawScopes string) (string, error)
	completeGitHubFn     func(ctx context.Context, code, state, stateVerifier string) (services.OAuthCallbackResult, error)
	startAuth0OAuthFn    func(ctx context.Context, stateVerifier string) (string, error)
	completeAuth0Fn      func(ctx context.Context, code, state, stateVerifier string) (services.OAuthCallbackResult, error)
	createTokenFn        func(ctx context.Context, userID int64, req services.CreateTokenRequest) (services.CreateTokenResult, error)
	exchangeGitHubFn     func(ctx context.Context, githubAccessToken, tokenName, githubRefreshToken string, ttlSeconds *int64) (services.ExchangeGitHubTokenResult, error)
	logoutFn             func(ctx context.Context, sessionKey string) error
}

func (m mockAuthService) ExchangeGitHubToken(ctx context.Context, githubAccessToken, tokenName, githubRefreshToken string, githubTokenExpiresIn int64, ttlSeconds *int64) (services.ExchangeGitHubTokenResult, error) {
	if m.exchangeGitHubFn != nil {
		return m.exchangeGitHubFn(ctx, githubAccessToken, tokenName, githubRefreshToken, ttlSeconds)
	}
	return services.ExchangeGitHubTokenResult{}, nil
}

func (m mockAuthService) CreateKeyAuthNonce(ctx context.Context) (string, error) {
	return m.createKeyAuthNonceFn(ctx)
}

func (m mockAuthService) VerifyKeyAuth(ctx context.Context, message, signature string) (services.VerifyKeyAuthResult, error) {
	return m.verifyKeyAuthFn(ctx, message, signature)
}

func (m mockAuthService) StartAuth0OAuth(ctx context.Context, stateVerifier string) (string, error) {
	if m.startAuth0OAuthFn != nil {
		return m.startAuth0OAuthFn(ctx, stateVerifier)
	}
	return "", nil
}

func (m mockAuthService) CompleteAuth0OAuth(ctx context.Context, code, state, stateVerifier string) (services.OAuthCallbackResult, error) {
	if m.completeAuth0Fn != nil {
		return m.completeAuth0Fn(ctx, code, state, stateVerifier)
	}
	return services.OAuthCallbackResult{}, nil
}

func (m mockAuthService) CreateToken(ctx context.Context, userID int64, req services.CreateTokenRequest) (services.CreateTokenResult, error) {
	if m.createTokenFn == nil {
		return services.CreateTokenResult{Token: "smithers_test_token"}, nil
	}
	return m.createTokenFn(ctx, userID, req)
}

func (m mockAuthService) Logout(ctx context.Context, sessionKey string) error {
	return m.logoutFn(ctx, sessionKey)
}

func (m mockAuthService) StartGitHubOAuth(ctx context.Context, stateVerifier, _ string) (string, error) {
	if m.startGitHubOAuthFn != nil {
		return m.startGitHubOAuthFn(ctx, stateVerifier)
	}
	return "", nil
}

func (m mockAuthService) StartGitHubOAuthWithScopes(ctx context.Context, stateVerifier, rawScopes string) (string, error) {
	if m.startGitHubScopesFn != nil {
		return m.startGitHubScopesFn(ctx, stateVerifier, rawScopes)
	}
	return m.StartGitHubOAuth(ctx, stateVerifier, "")
}

func (m mockAuthService) CompleteGitHubOAuth(ctx context.Context, code, state, stateVerifier string) (services.OAuthCallbackResult, error) {
	if m.completeGitHubFn != nil {
		return m.completeGitHubFn(ctx, code, state, stateVerifier)
	}
	return services.OAuthCallbackResult{}, nil
}

func defaultRouteAuthConfig() config.AuthConfig {
	return config.AuthConfig{
		SessionCookieName: "smithers_session",
		SessionDuration:   "720h",
		CookieSecure:      true,
	}
}

func cookieByName(cookies []*http.Cookie, name string) *http.Cookie {
	for _, cookie := range cookies {
		if cookie.Name == name {
			return cookie
		}
	}
	return nil
}

func TestAuthHandler_GetKeyAuthNonce(t *testing.T) {
	t.Parallel()

	handler := AuthHandler{
		Service: mockAuthService{
			createKeyAuthNonceFn: func(ctx context.Context) (string, error) {
				return "nonce-123", nil
			},
		},
		AuthConfig: defaultRouteAuthConfig(),
	}

	req := httptest.NewRequest(http.MethodGet, "/api/auth/key/nonce", nil)
	rec := httptest.NewRecorder()
	handler.GetKeyAuthNonce(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var payload map[string]string
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	assert.Equal(t, "nonce-123", payload["nonce"])
}

func TestAuthHandler_PostKeyAuthVerify_SetsSessionAndCSRFCookies(t *testing.T) {
	t.Parallel()

	expiresAt := time.Now().UTC().Add(30 * 24 * time.Hour)
	handler := AuthHandler{
		Service: mockAuthService{
			verifyKeyAuthFn: func(ctx context.Context, message, signature string) (services.VerifyKeyAuthResult, error) {
				assert.Equal(t, "signed-message", message)
				assert.Equal(t, "0xsignature", signature)
				return services.VerifyKeyAuthResult{
					User:       db.User{ID: 7, Username: "alice", LowerUsername: "alice", IsActive: true},
					SessionKey: "session-key-1",
					ExpiresAt:  expiresAt,
				}, nil
			},
		},
		AuthConfig: defaultRouteAuthConfig(),
	}

	req := httptest.NewRequest(http.MethodPost, "/api/auth/key/verify", strings.NewReader(`{"message":"signed-message","signature":"0xsignature"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.PostKeyAuthVerify(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	cookies := rec.Result().Cookies()
	require.Len(t, cookies, 2)

	sessionCookie := cookieByName(cookies, "smithers_session")
	require.NotNil(t, sessionCookie)
	assert.Equal(t, "session-key-1", sessionCookie.Value)
	assert.True(t, sessionCookie.HttpOnly)
	assert.Equal(t, http.SameSiteLaxMode, sessionCookie.SameSite)
	assert.True(t, sessionCookie.Secure)

	csrfCookie := cookieByName(cookies, "__csrf")
	require.NotNil(t, csrfCookie)
	assert.Len(t, csrfCookie.Value, 64)
	assert.False(t, csrfCookie.HttpOnly)
	assert.Equal(t, http.SameSiteStrictMode, csrfCookie.SameSite)
	assert.True(t, csrfCookie.Secure)

	var payload struct {
		User struct {
			ID       int64  `json:"id"`
			Username string `json:"username"`
		} `json:"user"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	assert.Equal(t, int64(7), payload.User.ID)
	assert.Equal(t, "alice", payload.User.Username)
}

func TestAuthHandler_GetGitHubRedirect(t *testing.T) {
	t.Parallel()

	handler := AuthHandler{
		Service: mockAuthService{
			startGitHubOAuthFn: func(ctx context.Context, stateVerifier string) (string, error) {
				assert.NotEmpty(t, stateVerifier)
				return "https://github.com/login/oauth/authorize?client_id=x&state=y", nil
			},
		},
		AuthConfig: defaultRouteAuthConfig(),
	}

	req := httptest.NewRequest(http.MethodGet, "/api/auth/github", nil)
	rec := httptest.NewRecorder()
	handler.GetGitHubOAuthStart(rec, req)

	require.Equal(t, http.StatusFound, rec.Code)
	assert.Contains(t, rec.Header().Get("Location"), "github.com/login/oauth/authorize")
	assert.Contains(t, rec.Header().Get("Set-Cookie"), oauthStateCookieName+"=")
	// SECURITY: OAuth state cookie must have Secure attribute
	assert.Contains(t, rec.Header().Get("Set-Cookie"), "; Secure")
}

func TestAuthHandler_GetGitHubCallback_SetsSessionCookieAndRedirects(t *testing.T) {
	t.Parallel()

	expiresAt := time.Now().UTC().Add(30 * 24 * time.Hour)
	handler := AuthHandler{
		Service: mockAuthService{
			completeGitHubFn: func(ctx context.Context, code, state, stateVerifier string) (services.OAuthCallbackResult, error) {
				assert.Equal(t, "code-123", code)
				assert.Equal(t, "state-123", state)
				assert.Equal(t, "oauth-verifier-1", stateVerifier)
				return services.OAuthCallbackResult{
					User:        db.User{ID: 99, Username: "octocat", LowerUsername: "octocat", IsActive: true},
					SessionKey:  "session-key-gh",
					ExpiresAt:   expiresAt,
					RedirectURL: "/",
				}, nil
			},
		},
		AuthConfig: defaultRouteAuthConfig(),
	}

	req := httptest.NewRequest(http.MethodGet, "/api/auth/github/callback?code=code-123&state=state-123", nil)
	req.AddCookie(&http.Cookie{Name: oauthStateCookieName, Value: "oauth-verifier-1"})
	rec := httptest.NewRecorder()
	handler.GetGitHubOAuthCallback(rec, req)

	require.Equal(t, http.StatusFound, rec.Code)
	assert.Equal(t, "/", rec.Header().Get("Location"))
	setCookies := rec.Result().Cookies()
	// Session + CSRF + cleared oauth state + cleared CLI callback cookie
	// (browser logins always discard any stale CLI callback cookie).
	require.Len(t, setCookies, 4)

	cliClearCookie := cookieByName(setCookies, cliCallbackCookieName)
	require.NotNil(t, cliClearCookie)
	assert.Equal(t, "", cliClearCookie.Value)
	assert.Equal(t, -1, cliClearCookie.MaxAge)

	sessionCookie := cookieByName(setCookies, "smithers_session")
	require.NotNil(t, sessionCookie)
	assert.Equal(t, "session-key-gh", sessionCookie.Value)
	assert.True(t, sessionCookie.HttpOnly)
	assert.Equal(t, http.SameSiteLaxMode, sessionCookie.SameSite)
	assert.True(t, sessionCookie.Secure, "session cookie must have Secure attribute")

	csrfCookie := cookieByName(setCookies, "__csrf")
	require.NotNil(t, csrfCookie)
	assert.Len(t, csrfCookie.Value, 64)
	assert.False(t, csrfCookie.HttpOnly)
	assert.Equal(t, http.SameSiteStrictMode, csrfCookie.SameSite)
	assert.True(t, csrfCookie.Secure)

	oauthClearCookie := cookieByName(setCookies, oauthStateCookieName)
	require.NotNil(t, oauthClearCookie)
	assert.Equal(t, "", oauthClearCookie.Value)
	assert.Equal(t, -1, oauthClearCookie.MaxAge)
	// SECURITY: cleared OAuth state cookie must also have Secure attribute
	assert.True(t, oauthClearCookie.Secure, "OAuth state clear cookie must have Secure attribute")
}

func TestAuthHandler_GetGitHubCallback_ResumesPendingOAuth2Authorize(t *testing.T) {
	t.Parallel()

	expiresAt := time.Now().UTC().Add(30 * 24 * time.Hour)
	handler := AuthHandler{
		Service: mockAuthService{
			completeGitHubFn: func(ctx context.Context, code, state, stateVerifier string) (services.OAuthCallbackResult, error) {
				assert.Equal(t, "code-123", code)
				assert.Equal(t, "state-123", state)
				assert.Equal(t, "oauth-verifier-1", stateVerifier)
				return services.OAuthCallbackResult{
					User:       db.User{ID: 99, Username: "octocat", LowerUsername: "octocat", IsActive: true},
					SessionKey: "session-key-gh",
					ExpiresAt:  expiresAt,
				}, nil
			},
		},
		AuthConfig: defaultRouteAuthConfig(),
	}

	req := httptest.NewRequest(http.MethodGet, "/api/auth/github/callback?code=code-123&state=state-123", nil)
	req.AddCookie(&http.Cookie{Name: oauthStateCookieName, Value: "oauth-verifier-1"})
	req.AddCookie(&http.Cookie{
		Name:  oauth2PendingAuthorizeCookie,
		Value: "/api/oauth2/authorize?response_type=code&client_id=smithers_first_party_apps",
	})
	rec := httptest.NewRecorder()
	handler.GetGitHubOAuthCallback(rec, req)

	require.Equal(t, http.StatusFound, rec.Code)
	assert.Equal(t, "/api/oauth2/authorize?response_type=code&client_id=smithers_first_party_apps", rec.Header().Get("Location"))

	pendingClearCookie := cookieByName(rec.Result().Cookies(), oauth2PendingAuthorizeCookie)
	require.NotNil(t, pendingClearCookie)
	assert.Equal(t, "", pendingClearCookie.Value)
	assert.Equal(t, -1, pendingClearCookie.MaxAge)
}

func TestAuthHandler_GetGitHubCallback_MissingVerifierCookieRejected(t *testing.T) {
	t.Parallel()

	handler := AuthHandler{
		Service: mockAuthService{
			completeGitHubFn: func(ctx context.Context, code, state, stateVerifier string) (services.OAuthCallbackResult, error) {
				assert.Equal(t, "code-123", code)
				assert.Equal(t, "state-123", state)
				assert.Equal(t, "", stateVerifier)
				return services.OAuthCallbackResult{}, errors.Unauthorized("invalid oauth state")
			},
		},
		AuthConfig: defaultRouteAuthConfig(),
	}

	req := httptest.NewRequest(http.MethodGet, "/api/auth/github/callback?code=code-123&state=state-123", nil)
	rec := httptest.NewRecorder()
	handler.GetGitHubOAuthCallback(rec, req)

	require.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.Contains(t, rec.Header().Get("Set-Cookie"), oauthStateCookieName+"=")
}

func TestAuthHandler_GetGitHubCallback_CLIRedirectIncludesTokenMetadata(t *testing.T) {
	t.Parallel()

	expiresAt := time.Date(2026, 12, 31, 0, 0, 0, 0, time.UTC)
	handler := AuthHandler{
		Service: mockAuthService{
			completeGitHubFn: func(ctx context.Context, code, state, stateVerifier string) (services.OAuthCallbackResult, error) {
				assert.Equal(t, "code-123", code)
				assert.Equal(t, "state-123", state)
				assert.Equal(t, "oauth-verifier-1", stateVerifier)
				return services.OAuthCallbackResult{
					User: db.User{
						ID:            99,
						Username:      "octocat",
						LowerUsername: "octocat",
						Email:         pgtype.Text{String: "octocat@example.com", Valid: true},
						IsActive:      true,
					},
					SessionKey: "session-key-gh",
					ExpiresAt:  expiresAt,
					TokenScopes: []string{
						"read:user",
						"write:workspace",
						"write:agent",
					},
				}, nil
			},
			createTokenFn: func(ctx context.Context, userID int64, req services.CreateTokenRequest) (services.CreateTokenResult, error) {
				assert.Equal(t, int64(99), userID)
				assert.Equal(t, []string{"read:user", "write:workspace", "write:agent"}, req.Scopes)
				return services.CreateTokenResult{Token: "smithers_cli_token"}, nil
			},
		},
		AuthConfig: defaultRouteAuthConfig(),
	}

	req := httptest.NewRequest(http.MethodGet, "/api/auth/github/callback?code=code-123&state=state-123", nil)
	req.AddCookie(&http.Cookie{Name: oauthStateCookieName, Value: "oauth-verifier-1"})
	req.AddCookie(&http.Cookie{Name: cliCallbackCookieName, Value: "41523:oauth-verifier-1"})
	rec := httptest.NewRecorder()
	handler.GetGitHubOAuthCallback(rec, req)

	require.Equal(t, http.StatusFound, rec.Code)
	location := rec.Header().Get("Location")
	require.True(t, strings.HasPrefix(location, "http://127.0.0.1:41523/callback#"))

	parts := strings.SplitN(location, "#", 2)
	require.Len(t, parts, 2)
	params, err := url.ParseQuery(parts[1])
	require.NoError(t, err)
	assert.Equal(t, "smithers_cli_token", params.Get("token"))
	assert.Equal(t, "octocat", params.Get("username"))
	assert.Equal(t, "octocat@example.com", params.Get("email"))
	assert.Equal(t, "2026-12-31T00:00:00Z", params.Get("expires_at"))
}

func TestAuthHandler_GetGitHubCallback_StaleCLICookieDoesNotHijackBrowserLogin(t *testing.T) {
	t.Parallel()

	handler := AuthHandler{
		Service: mockAuthService{
			completeGitHubFn: func(ctx context.Context, code, state, stateVerifier string) (services.OAuthCallbackResult, error) {
				return services.OAuthCallbackResult{
					User:       db.User{ID: 99, Username: "octocat", IsActive: true},
					SessionKey: "session-key-browser",
					ExpiresAt:  time.Now().UTC().Add(time.Hour),
				}, nil
			},
			createTokenFn: func(ctx context.Context, userID int64, req services.CreateTokenRequest) (services.CreateTokenResult, error) {
				t.Fatal("a stale CLI callback cookie must not mint a CLI token")
				return services.CreateTokenResult{}, nil
			},
		},
		AuthConfig:   defaultRouteAuthConfig(),
		PublicOrigin: "https://code.smithers.sh",
	}

	// The CLI cookie is bound to a DIFFERENT flow's state verifier (an
	// abandoned earlier CLI login); this callback completes a browser flow.
	req := httptest.NewRequest(http.MethodGet, "/api/auth/github/callback?code=code-123&state=state-123", nil)
	req.AddCookie(&http.Cookie{Name: oauthStateCookieName, Value: "oauth-verifier-browser"})
	req.AddCookie(&http.Cookie{Name: cliCallbackCookieName, Value: "41523:oauth-verifier-stale"})
	rec := httptest.NewRecorder()
	handler.GetGitHubOAuthCallback(rec, req)

	require.Equal(t, http.StatusFound, rec.Code)
	// No service-provided RedirectURL: the handler falls back to the composed
	// public origin so direct API callbacks don't land on the API's 404 page.
	assert.Equal(t, "https://code.smithers.sh/", rec.Header().Get("Location"))
	sessionCookie := cookieByName(rec.Result().Cookies(), "smithers_session")
	require.NotNil(t, sessionCookie)
	assert.Equal(t, "session-key-browser", sessionCookie.Value)
	// The unusable stale cookie is discarded.
	staleCookie := cookieByName(rec.Result().Cookies(), cliCallbackCookieName)
	require.NotNil(t, staleCookie)
	assert.Equal(t, -1, staleCookie.MaxAge)
}

func TestAuthHandler_GetAuth0Callback_ResumesPendingOAuth2Authorize(t *testing.T) {
	t.Parallel()

	expiresAt := time.Now().UTC().Add(30 * 24 * time.Hour)
	handler := AuthHandler{
		Service: mockAuthService{
			completeAuth0Fn: func(ctx context.Context, code, state, stateVerifier string) (services.OAuthCallbackResult, error) {
				assert.Equal(t, "code-123", code)
				assert.Equal(t, "state-123", state)
				assert.Equal(t, "oauth-verifier-1", stateVerifier)
				return services.OAuthCallbackResult{
					User:       db.User{ID: 99, Username: "octocat", LowerUsername: "octocat", IsActive: true},
					SessionKey: "session-key-auth0",
					ExpiresAt:  expiresAt,
				}, nil
			},
		},
		AuthConfig: defaultRouteAuthConfig(),
	}

	req := httptest.NewRequest(http.MethodGet, "/api/auth/auth0/callback?code=code-123&state=state-123", nil)
	req.AddCookie(&http.Cookie{Name: oauthStateCookieName, Value: "oauth-verifier-1"})
	req.AddCookie(&http.Cookie{
		Name:  oauth2PendingAuthorizeCookie,
		Value: "/api/oauth2/authorize?response_type=code&client_id=smithers_first_party_apps",
	})
	rec := httptest.NewRecorder()
	handler.GetAuth0Callback(rec, req)

	require.Equal(t, http.StatusFound, rec.Code)
	assert.Equal(t, "/api/oauth2/authorize?response_type=code&client_id=smithers_first_party_apps", rec.Header().Get("Location"))

	pendingClearCookie := cookieByName(rec.Result().Cookies(), oauth2PendingAuthorizeCookie)
	require.NotNil(t, pendingClearCookie)
	assert.Equal(t, "", pendingClearCookie.Value)
	assert.Equal(t, -1, pendingClearCookie.MaxAge)
}

func TestAuthHandler_PostLogout_RevokesSessionAndClearsCookie(t *testing.T) {
	t.Parallel()

	logoutCalled := false
	handler := AuthHandler{
		Service: mockAuthService{
			logoutFn: func(ctx context.Context, sessionKey string) error {
				logoutCalled = true
				assert.Equal(t, "session-xyz", sessionKey)
				return nil
			},
		},
		AuthConfig: defaultRouteAuthConfig(),
	}

	req := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	req.AddCookie(&http.Cookie{Name: "smithers_session", Value: "session-xyz"})
	rec := httptest.NewRecorder()
	handler.PostLogout(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.True(t, logoutCalled)
	assert.Contains(t, rec.Header().Get("Set-Cookie"), "smithers_session=")

	logoutCookies := rec.Result().Cookies()
	require.Len(t, logoutCookies, 2)

	sessionCookie := cookieByName(logoutCookies, "smithers_session")
	require.NotNil(t, sessionCookie)
	assert.Equal(t, "", sessionCookie.Value)
	assert.Equal(t, -1, sessionCookie.MaxAge)
	assert.True(t, sessionCookie.HttpOnly)
	assert.Equal(t, http.SameSiteLaxMode, sessionCookie.SameSite)
	assert.True(t, sessionCookie.Secure, "logout session clear cookie must have Secure attribute")

	csrfCookie := cookieByName(logoutCookies, "__csrf")
	require.NotNil(t, csrfCookie)
	assert.Equal(t, "", csrfCookie.Value)
	assert.Equal(t, -1, csrfCookie.MaxAge)
	assert.False(t, csrfCookie.HttpOnly)
	assert.Equal(t, http.SameSiteStrictMode, csrfCookie.SameSite)
	assert.True(t, csrfCookie.Secure, "logout csrf clear cookie must have Secure attribute")
}

func TestAuthHandler_PropagatesAPIErrors(t *testing.T) {
	t.Parallel()

	handler := AuthHandler{
		Service: mockAuthService{
			createKeyAuthNonceFn: func(ctx context.Context) (string, error) {
				return "", errors.BadRequest("bad nonce request")
			},
		},
		AuthConfig: defaultRouteAuthConfig(),
	}

	req := httptest.NewRequest(http.MethodGet, "/api/auth/key/nonce", nil)
	rec := httptest.NewRecorder()
	handler.GetKeyAuthNonce(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestAuthHandler_PostKeyAuthVerify_NonAPIErrorReturnsSanitizedInternalError(t *testing.T) {
	t.Parallel()

	handler := AuthHandler{
		Service: mockAuthService{
			verifyKeyAuthFn: func(ctx context.Context, message, signature string) (services.VerifyKeyAuthResult, error) {
				return services.VerifyKeyAuthResult{}, fmt.Errorf("provider failure secret=shh")
			},
		},
		AuthConfig: defaultRouteAuthConfig(),
	}

	req := httptest.NewRequest(http.MethodPost, "/api/auth/key/verify", strings.NewReader(`{"message":"signed-message","signature":"0xsignature"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.PostKeyAuthVerify(rec, req)

	require.Equal(t, http.StatusInternalServerError, rec.Code)
	var body map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "internal server error", body["message"])
	assert.NotContains(t, rec.Body.String(), "secret=shh")
}
