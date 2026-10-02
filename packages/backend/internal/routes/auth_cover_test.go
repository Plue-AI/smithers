package routes

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestAuth_Cov_PostKeyAuthTokenSuccessAndErrors(t *testing.T) {
	expiresAt := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	var created services.CreateTokenRequest
	h := AuthHandler{
		Service: mockAuthService{
			verifyKeyAuthFn: func(_ context.Context, message, signature string) (services.VerifyKeyAuthResult, error) {
				assert.Equal(t, "signed", message)
				assert.Equal(t, "sig", signature)
				return services.VerifyKeyAuthResult{
					User:      db.User{ID: 12, Username: "wallet-user"},
					ExpiresAt: expiresAt,
				}, nil
			},
			createTokenFn: func(_ context.Context, userID int64, req services.CreateTokenRequest) (services.CreateTokenResult, error) {
				assert.Equal(t, int64(12), userID)
				created = req
				return services.CreateTokenResult{Token: "smithers_cli_token"}, nil
			},
		},
		AuthConfig: defaultRouteAuthConfig(),
	}

	req := httptest.NewRequest(http.MethodPost, "/api/auth/key/token", strings.NewReader(`{"message":"signed","signature":"sig"}`))
	rec := httptest.NewRecorder()
	h.PostKeyAuthToken(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "smithers-cli", created.Name)
	assert.Equal(t, []string{"repo", "user", "org"}, created.Scopes)
	var body map[string]string
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "smithers_cli_token", body["token"])
	assert.Equal(t, "wallet-user", body["username"])

	missingReq := httptest.NewRequest(http.MethodPost, "/api/auth/key/token", strings.NewReader(`{"message":"signed"}`))
	missingRec := httptest.NewRecorder()
	h.PostKeyAuthToken(missingRec, missingReq)
	require.Equal(t, http.StatusBadRequest, missingRec.Code)

	verifyErrHandler := AuthHandler{Service: mockAuthService{
		verifyKeyAuthFn: func(_ context.Context, message, signature string) (services.VerifyKeyAuthResult, error) {
			return services.VerifyKeyAuthResult{}, pkgerrors.Unauthorized("bad signature")
		},
	}}
	verifyErrReq := httptest.NewRequest(http.MethodPost, "/api/auth/key/token", strings.NewReader(`{"message":"signed","signature":"sig"}`))
	verifyErrRec := httptest.NewRecorder()
	verifyErrHandler.PostKeyAuthToken(verifyErrRec, verifyErrReq)
	require.Equal(t, http.StatusUnauthorized, verifyErrRec.Code)

	createErrHandler := AuthHandler{Service: mockAuthService{
		verifyKeyAuthFn: func(_ context.Context, message, signature string) (services.VerifyKeyAuthResult, error) {
			return services.VerifyKeyAuthResult{User: db.User{ID: 12, Username: "wallet-user"}}, nil
		},
		createTokenFn: func(_ context.Context, userID int64, req services.CreateTokenRequest) (services.CreateTokenResult, error) {
			return services.CreateTokenResult{}, pkgerrors.Forbidden("token creation disabled")
		},
	}}
	createErrReq := httptest.NewRequest(http.MethodPost, "/api/auth/key/token", strings.NewReader(`{"message":"signed","signature":"sig"}`))
	createErrRec := httptest.NewRecorder()
	createErrHandler.PostKeyAuthToken(createErrRec, createErrReq)
	require.Equal(t, http.StatusForbidden, createErrRec.Code)
}

func TestAuth_Cov_GitHubCLIAndAuth0AuthorizeStarts(t *testing.T) {
	github := AuthHandler{
		Service: mockAuthService{
			startGitHubScopesFn: func(_ context.Context, stateVerifier, rawScopes string) (string, error) {
				assert.NotEmpty(t, stateVerifier)
				assert.Equal(t, "read:user,write:workspace,write:agent", rawScopes)
				return "https://github.example/auth", nil
			},
		},
		AuthConfig: defaultRouteAuthConfig(),
	}

	missingPortReq := httptest.NewRequest(http.MethodGet, "/api/auth/github/cli", nil)
	missingPortRec := httptest.NewRecorder()
	github.GetGitHubOAuthCLIStart(missingPortRec, missingPortReq)
	require.Equal(t, http.StatusBadRequest, missingPortRec.Code)

	badPortReq := httptest.NewRequest(http.MethodGet, "/api/auth/github/cli?callback_port=80", nil)
	badPortRec := httptest.NewRecorder()
	github.GetGitHubOAuthCLIStart(badPortRec, badPortReq)
	require.Equal(t, http.StatusBadRequest, badPortRec.Code)

	goodPortReq := httptest.NewRequest(http.MethodGet, "/api/auth/github/cli?callback_port=41523&scopes=read:user,write:workspace,write:agent", nil)
	goodPortRec := httptest.NewRecorder()
	github.GetGitHubOAuthCLIStart(goodPortRec, goodPortReq)
	require.Equal(t, http.StatusFound, goodPortRec.Code)
	assert.Equal(t, "https://github.example/auth", goodPortRec.Header().Get("Location"))
	oauthCookie := cookieByName(goodPortRec.Result().Cookies(), oauthStateCookieName)
	require.NotNil(t, oauthCookie)
	assert.True(t, oauthCookie.Secure)
	cliCookie := cookieByName(goodPortRec.Result().Cookies(), cliCallbackCookieName)
	require.NotNil(t, cliCookie)
	assert.Equal(t, "41523:"+oauthCookie.Value, cliCookie.Value)
	assert.True(t, cliCookie.Secure)

	auth0 := AuthHandler{
		Service: mockAuthService{
			startAuth0OAuthFn: func(_ context.Context, stateVerifier string) (string, error) {
				assert.NotEmpty(t, stateVerifier)
				return "https://auth0.example/authorize", nil
			},
		},
		AuthConfig: defaultRouteAuthConfig(),
	}

	auth0BadReq := httptest.NewRequest(http.MethodGet, "/api/auth/auth0?callback_port=99999", nil)
	auth0BadRec := httptest.NewRecorder()
	auth0.GetAuth0Authorize(auth0BadRec, auth0BadReq)
	require.Equal(t, http.StatusBadRequest, auth0BadRec.Code)

	auth0BrowserReq := httptest.NewRequest(http.MethodGet, "/api/auth/auth0", nil)
	auth0BrowserRec := httptest.NewRecorder()
	auth0.GetAuth0Authorize(auth0BrowserRec, auth0BrowserReq)
	require.Equal(t, http.StatusFound, auth0BrowserRec.Code)
	auth0Cookie := cookieByName(auth0BrowserRec.Result().Cookies(), oauthStateCookieName)
	require.NotNil(t, auth0Cookie)
	assert.True(t, auth0Cookie.Secure)

	auth0CLIReq := httptest.NewRequest(http.MethodGet, "/api/auth/auth0?callback_port=41524", nil)
	auth0CLIRec := httptest.NewRecorder()
	auth0.GetAuth0Authorize(auth0CLIRec, auth0CLIReq)
	require.Equal(t, http.StatusFound, auth0CLIRec.Code)
	auth0CLICookie := cookieByName(auth0CLIRec.Result().Cookies(), oauthStateCookieName)
	require.NotNil(t, auth0CLICookie)
	assert.True(t, auth0CLICookie.Secure)
	assert.Equal(t, "41524:"+auth0CLICookie.Value, cookieByName(auth0CLIRec.Result().Cookies(), cliCallbackCookieName).Value)
}

func TestAuth_Cov_Auth0CallbackBranches(t *testing.T) {
	missingReq := httptest.NewRequest(http.MethodGet, "/api/auth/auth0/callback?code=only", nil)
	missingRec := httptest.NewRecorder()
	(&AuthHandler{}).GetAuth0Callback(missingRec, missingReq)
	require.Equal(t, http.StatusBadRequest, missingRec.Code)

	serviceErr := AuthHandler{
		Service: mockAuthService{
			completeAuth0Fn: func(_ context.Context, code, state, stateVerifier string) (services.OAuthCallbackResult, error) {
				assert.Equal(t, "verifier", stateVerifier)
				return services.OAuthCallbackResult{}, pkgerrors.Unauthorized("bad state")
			},
		},
		AuthConfig: defaultRouteAuthConfig(),
	}
	errReq := httptest.NewRequest(http.MethodGet, "/api/auth/auth0/callback?code=c&state=s", nil)
	errReq.AddCookie(&http.Cookie{Name: oauthStateCookieName, Value: "verifier"})
	errRec := httptest.NewRecorder()
	serviceErr.GetAuth0Callback(errRec, errReq)
	require.Equal(t, http.StatusUnauthorized, errRec.Code)
	assert.Equal(t, -1, cookieByName(errRec.Result().Cookies(), oauthStateCookieName).MaxAge)

	expires := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	success := AuthHandler{
		Service: mockAuthService{
			completeAuth0Fn: func(_ context.Context, code, state, stateVerifier string) (services.OAuthCallbackResult, error) {
				return services.OAuthCallbackResult{
					User:       db.User{ID: 44, Username: "auth0-user", Email: pgtype.Text{String: "a@example.test", Valid: true}},
					SessionKey: "session-auth0",
					ExpiresAt:  expires,
				}, nil
			},
			createTokenFn: func(_ context.Context, userID int64, req services.CreateTokenRequest) (services.CreateTokenResult, error) {
				return services.CreateTokenResult{Token: "cli-auth0-token"}, nil
			},
		},
		AuthConfig: defaultRouteAuthConfig(),
	}

	badCLIReq := httptest.NewRequest(http.MethodGet, "/api/auth/auth0/callback?code=c&state=s", nil)
	badCLIReq.AddCookie(&http.Cookie{Name: oauthStateCookieName, Value: "verifier"})
	badCLIReq.AddCookie(&http.Cookie{Name: cliCallbackCookieName, Value: "@evil:verifier"})
	badCLIRec := httptest.NewRecorder()
	success.GetAuth0Callback(badCLIRec, badCLIReq)
	require.Equal(t, http.StatusBadRequest, badCLIRec.Code)
	assert.Equal(t, -1, cookieByName(badCLIRec.Result().Cookies(), cliCallbackCookieName).MaxAge)

	browserReq := httptest.NewRequest(http.MethodGet, "/api/auth/auth0/callback?code=c&state=s", nil)
	browserReq.AddCookie(&http.Cookie{Name: oauthStateCookieName, Value: "verifier"})
	browserRec := httptest.NewRecorder()
	success.GetAuth0Callback(browserRec, browserReq)
	require.Equal(t, http.StatusFound, browserRec.Code)
	assert.Equal(t, "/", browserRec.Header().Get("Location"))
	sessionCookie := cookieByName(browserRec.Result().Cookies(), "smithers_session")
	assert.Equal(t, "session-auth0", sessionCookie.Value)
	csrfCookie := cookieByName(browserRec.Result().Cookies(), middleware.CSRFCookieName)
	assert.Len(t, csrfCookie.Value, 64)
	assert.Equal(t, sessionCookie.Expires, csrfCookie.Expires)
	assert.Equal(t, sessionCookie.MaxAge, csrfCookie.MaxAge)

	cliReq := httptest.NewRequest(http.MethodGet, "/api/auth/auth0/callback?code=c&state=s", nil)
	cliReq.AddCookie(&http.Cookie{Name: oauthStateCookieName, Value: "verifier"})
	cliReq.AddCookie(&http.Cookie{Name: cliCallbackCookieName, Value: "41525:verifier"})
	cliRec := httptest.NewRecorder()
	success.GetAuth0Callback(cliRec, cliReq)
	require.Equal(t, http.StatusFound, cliRec.Code)
	location := cliRec.Header().Get("Location")
	assert.True(t, strings.HasPrefix(location, "http://127.0.0.1:41525/callback#"))
	fragment, err := url.ParseQuery(strings.SplitN(location, "#", 2)[1])
	require.NoError(t, err)
	assert.Equal(t, "cli-auth0-token", fragment.Get("token"))
	assert.Equal(t, "auth0-user", fragment.Get("username"))
	assert.Equal(t, "a@example.test", fragment.Get("email"))
}

func TestAuth_Cov_PendingCookieAndLogout(t *testing.T) {
	absoluteReq := httptest.NewRequest(http.MethodGet, "/api/auth/github/callback", nil)
	absoluteReq.AddCookie(&http.Cookie{Name: oauth2PendingAuthorizeCookie, Value: "https://evil.example/callback"})
	absoluteRec := httptest.NewRecorder()
	assert.Empty(t, consumeOAuth2PendingAuthorizeCookie(absoluteRec, absoluteReq, true))
	clearCookie := cookieByName(absoluteRec.Result().Cookies(), oauth2PendingAuthorizeCookie)
	require.NotNil(t, clearCookie)
	assert.Equal(t, -1, clearCookie.MaxAge)
	assert.True(t, clearCookie.Secure)

	wrongPathReq := httptest.NewRequest(http.MethodGet, "/api/auth/github/callback", nil)
	wrongPathReq.AddCookie(&http.Cookie{Name: oauth2PendingAuthorizeCookie, Value: "/not-authorize"})
	wrongPathRec := httptest.NewRecorder()
	assert.Empty(t, consumeOAuth2PendingAuthorizeCookie(wrongPathRec, wrongPathReq, false))

	noCookieReq := httptest.NewRequest(http.MethodGet, "/api/auth/github/callback", nil)
	noCookieRec := httptest.NewRecorder()
	assert.Empty(t, consumeOAuth2PendingAuthorizeCookie(noCookieRec, noCookieReq, false))
	assert.Empty(t, noCookieRec.Result().Cookies())

	logoutReq := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	logoutRec := httptest.NewRecorder()
	(&AuthHandler{AuthConfig: defaultRouteAuthConfig()}).PostLogout(logoutRec, logoutReq)
	require.Equal(t, http.StatusNoContent, logoutRec.Code)
	assert.Equal(t, -1, cookieByName(logoutRec.Result().Cookies(), "smithers_session").MaxAge)
	assert.Equal(t, -1, cookieByName(logoutRec.Result().Cookies(), middleware.CSRFCookieName).MaxAge)

}

func TestAuth_Cov_RouteErrorRetryAfterAndRandomHex(t *testing.T) {
	value, err := randomHex(4)
	require.NoError(t, err)
	assert.Len(t, value, 8)
	_, err = hex.DecodeString(value)
	require.NoError(t, err)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/test", nil)
	writeRouteError(rec, req, &pkgerrors.APIError{Status: http.StatusTooManyRequests, Message: "slow down", RetryAfter: 7})
	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	assert.Equal(t, "7", rec.Header().Get("Retry-After"))

	zeroRec := httptest.NewRecorder()
	writeRouteError(zeroRec, req, &pkgerrors.APIError{Status: http.StatusTooManyRequests, Message: "slow down"})
	require.Equal(t, http.StatusTooManyRequests, zeroRec.Code)
	assert.Equal(t, "0", zeroRec.Header().Get("Retry-After"))

	internalRec := httptest.NewRecorder()
	writeRouteError(internalRec, req, errors.New("raw secret detail"))
	require.Equal(t, http.StatusInternalServerError, internalRec.Code)
	assert.NotContains(t, internalRec.Body.String(), "raw secret detail")
}

func TestAuth_Cov_RouteErrorPreservesOnlyAllowlisted5xxMessages(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/test", nil)
	for _, code := range []pkgerrors.Code{
		pkgerrors.CodeNoCapacity,
		pkgerrors.CodeEgressProxyUnavailable,
		pkgerrors.CodeSecretDeliveryUnavailable,
		pkgerrors.CodeWorkerDraining,
	} {
		t.Run(string(code), func(t *testing.T) {
			rec := httptest.NewRecorder()
			writeRouteError(rec, req, &pkgerrors.APIError{
				Status:  http.StatusServiceUnavailable,
				Code:    code,
				Message: "safe retry guidance",
				Details: map[string]string{"provider_detail": "must not leak"},
			})

			require.Equal(t, http.StatusServiceUnavailable, rec.Code)
			var body pkgerrors.APIError
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
			assert.Equal(t, code, body.Code)
			assert.Equal(t, "safe retry guidance", body.Message)
			// fault is derived from the code, never chosen at the call site,
			// and it survives sanitization: a client reading only `fault`
			// still knows this is plue's problem, not the caller's.
			entry, ok := pkgerrors.Lookup(code)
			require.True(t, ok)
			assert.Equal(t, entry.Fault, body.Fault)
			assert.NotContains(t, rec.Body.String(), "provider_detail")
		})
	}

	for _, code := range []pkgerrors.Code{"", "desktop_not_ready_typo", pkgerrors.CodeProvisioningFailed} {
		t.Run("sanitized_"+string(code), func(t *testing.T) {
			rec := httptest.NewRecorder()
			writeRouteError(rec, req, &pkgerrors.APIError{
				Status:  http.StatusInternalServerError,
				Code:    code,
				Message: "raw database detail",
			})

			require.Equal(t, http.StatusInternalServerError, rec.Code)
			var body pkgerrors.APIError
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
			assert.Equal(t, "internal server error", body.Message)
			assert.NotContains(t, rec.Body.String(), "raw database detail")
			// An unregistered or absent code still reaches the wire as a
			// registered one with a fault, so no client ever has to handle a
			// body with no verdict in it.
			assert.NotEmpty(t, body.Code)
			assert.Equal(t, pkgerrors.FaultBug, body.Fault)
		})
	}
}
