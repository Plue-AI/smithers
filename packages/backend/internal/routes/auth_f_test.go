package routes

import (
	"context"
	stderrors "errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
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

// authFAuditQuerier is a minimal AuditQueries fake that records how many audit
// rows were written so the AuditService != nil branches can be asserted.
type authFAuditQuerier struct {
	mu    sync.Mutex
	calls int
}

func (q *authFAuditQuerier) InsertAuditLog(_ context.Context, _ db.InsertAuditLogParams) error {
	q.mu.Lock()
	q.calls++
	q.mu.Unlock()
	return nil
}

func authFAuditService() (*services.AuditService, *authFAuditQuerier) {
	q := &authFAuditQuerier{}
	return services.NewAuditService(q), q
}

// authFWarmer records the warmed user id.
type authFWarmer struct{ warmed int64 }

func (w *authFWarmer) WarmGitHubRepoListing(userID int64) { w.warmed = userID }

// withFailingAuthRandom swaps the package-level authRandomRead seam so randomHex
// returns an error, and restores it afterwards. Tests using it MUST stay serial
// (no t.Parallel) so the swap does not race with other tests.
func withFailingAuthRandom(t *testing.T) {
	t.Helper()
	prev := authRandomRead
	authRandomRead = func([]byte) (int, error) { return 0, stderrors.New("prng offline") }
	t.Cleanup(func() { authRandomRead = prev })
}

func authFUser() *db.User {
	return &db.User{ID: 7, Username: "alice", LowerUsername: "alice"}
}

// --- randomHex direct error branch ---

func TestAuth_F_RandomHexError(t *testing.T) {
	withFailingAuthRandom(t)
	_, err := randomHex(16)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "randomHex")
}

// --- PostKeyAuthVerify ---

func TestAuth_F_PostKeyAuthVerify(t *testing.T) {
	t.Run("decode fail", func(t *testing.T) {
		h := &AuthHandler{Service: mockAuthService{}, AuthConfig: defaultRouteAuthConfig()}
		req := httptest.NewRequest(http.MethodPost, "/api/auth/key/verify", strings.NewReader("{bad"))
		rec := httptest.NewRecorder()
		h.PostKeyAuthVerify(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("missing fields", func(t *testing.T) {
		h := &AuthHandler{Service: mockAuthService{}, AuthConfig: defaultRouteAuthConfig()}
		req := httptest.NewRequest(http.MethodPost, "/api/auth/key/verify", strings.NewReader(`{"message":"x"}`))
		rec := httptest.NewRecorder()
		h.PostKeyAuthVerify(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("verify error", func(t *testing.T) {
		h := &AuthHandler{Service: mockAuthService{
			verifyKeyAuthFn: func(context.Context, string, string) (services.VerifyKeyAuthResult, error) {
				return services.VerifyKeyAuthResult{}, pkgerrors.Unauthorized("bad sig")
			},
		}, AuthConfig: defaultRouteAuthConfig()}
		req := httptest.NewRequest(http.MethodPost, "/api/auth/key/verify", strings.NewReader(`{"message":"m","signature":"s"}`))
		rec := httptest.NewRecorder()
		h.PostKeyAuthVerify(rec, req)
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("csrf error", func(t *testing.T) {
		withFailingAuthRandom(t)
		h := &AuthHandler{Service: mockAuthService{
			verifyKeyAuthFn: func(context.Context, string, string) (services.VerifyKeyAuthResult, error) {
				return services.VerifyKeyAuthResult{User: db.User{ID: 7, Username: "alice"}}, nil
			},
		}, AuthConfig: defaultRouteAuthConfig()}
		req := httptest.NewRequest(http.MethodPost, "/api/auth/key/verify", strings.NewReader(`{"message":"m","signature":"s"}`))
		rec := httptest.NewRecorder()
		h.PostKeyAuthVerify(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("success with audit", func(t *testing.T) {
		audit, q := authFAuditService()
		h := &AuthHandler{Service: mockAuthService{
			verifyKeyAuthFn: func(context.Context, string, string) (services.VerifyKeyAuthResult, error) {
				return services.VerifyKeyAuthResult{
					User:      db.User{ID: 7, Username: "alice"},
					ExpiresAt: time.Now().Add(time.Hour),
				}, nil
			},
		}, AuthConfig: defaultRouteAuthConfig(), AuditService: audit}
		req := httptest.NewRequest(http.MethodPost, "/api/auth/key/verify", strings.NewReader(`{"message":"m","signature":"s"}`))
		rec := httptest.NewRecorder()
		h.PostKeyAuthVerify(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, 1, q.calls)
		assert.NotNil(t, cookieByName(rec.Result().Cookies(), "smithers_session"))
	})
}

// --- PostKeyAuthToken ---

func TestAuth_F_PostKeyAuthToken(t *testing.T) {
	t.Run("decode fail", func(t *testing.T) {
		h := &AuthHandler{Service: mockAuthService{}, AuthConfig: defaultRouteAuthConfig()}
		req := httptest.NewRequest(http.MethodPost, "/api/auth/key/token", strings.NewReader("{bad"))
		rec := httptest.NewRecorder()
		h.PostKeyAuthToken(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("success with audit", func(t *testing.T) {
		audit, q := authFAuditService()
		h := &AuthHandler{Service: mockAuthService{
			verifyKeyAuthFn: func(context.Context, string, string) (services.VerifyKeyAuthResult, error) {
				return services.VerifyKeyAuthResult{User: db.User{ID: 7, Username: "alice"}}, nil
			},
			createTokenFn: func(context.Context, int64, services.CreateTokenRequest) (services.CreateTokenResult, error) {
				return services.CreateTokenResult{Token: "smithers_tok"}, nil
			},
		}, AuthConfig: defaultRouteAuthConfig(), AuditService: audit}
		req := httptest.NewRequest(http.MethodPost, "/api/auth/key/token", strings.NewReader(`{"message":"m","signature":"s"}`))
		rec := httptest.NewRecorder()
		h.PostKeyAuthToken(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, 1, q.calls)
	})
}

// --- PostSSETicket internal (non-limit) error ---

func TestAuth_F_ConsumePendingCookieParseError(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/auth/github/callback", nil)
	// "%zz" is a valid cookie value but an invalid URL escape, so url.Parse errors.
	req.Header.Set("Cookie", oauth2PendingAuthorizeCookie+"=%zz")
	rec := httptest.NewRecorder()
	assert.Empty(t, consumeOAuth2PendingAuthorizeCookie(rec, req, true))
	// Cookie is still cleared even when rejected.
	assert.Equal(t, -1, cookieByName(rec.Result().Cookies(), oauth2PendingAuthorizeCookie).MaxAge)
	assert.True(t, cookieByName(rec.Result().Cookies(), oauth2PendingAuthorizeCookie).Secure)
}

// --- GetGitHubOAuthStart ---

func TestAuth_F_GetGitHubOAuthStart(t *testing.T) {
	t.Run("random error", func(t *testing.T) {
		withFailingAuthRandom(t)
		h := &AuthHandler{Service: mockAuthService{}, AuthConfig: defaultRouteAuthConfig()}
		req := httptest.NewRequest(http.MethodGet, "/api/auth/github", nil)
		rec := httptest.NewRecorder()
		h.GetGitHubOAuthStart(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("service error", func(t *testing.T) {
		h := &AuthHandler{Service: mockAuthService{
			startGitHubOAuthFn: func(context.Context, string) (string, error) {
				return "", pkgerrors.Internal("gh down")
			},
		}, AuthConfig: defaultRouteAuthConfig()}
		req := httptest.NewRequest(http.MethodGet, "/api/auth/github", nil)
		rec := httptest.NewRecorder()
		h.GetGitHubOAuthStart(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})
}

// --- GetGitHubOAuthCLIStart error branches ---

func TestAuth_F_GetGitHubOAuthCLIStart(t *testing.T) {
	t.Run("random error", func(t *testing.T) {
		withFailingAuthRandom(t)
		h := &AuthHandler{Service: mockAuthService{}, AuthConfig: defaultRouteAuthConfig()}
		req := httptest.NewRequest(http.MethodGet, "/api/auth/github/cli?callback_port=41530", nil)
		rec := httptest.NewRecorder()
		h.GetGitHubOAuthCLIStart(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("service error", func(t *testing.T) {
		h := &AuthHandler{Service: mockAuthService{
			startGitHubOAuthFn: func(context.Context, string) (string, error) {
				return "", pkgerrors.Internal("gh down")
			},
		}, AuthConfig: defaultRouteAuthConfig()}
		req := httptest.NewRequest(http.MethodGet, "/api/auth/github/cli?callback_port=41530", nil)
		rec := httptest.NewRecorder()
		h.GetGitHubOAuthCLIStart(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})
}

// --- GetGitHubOAuthCallback ---

func TestAuth_F_GetGitHubOAuthCallback(t *testing.T) {
	t.Run("missing code and state", func(t *testing.T) {
		h := &AuthHandler{Service: mockAuthService{}, AuthConfig: defaultRouteAuthConfig()}
		req := httptest.NewRequest(http.MethodGet, "/api/auth/github/callback", nil)
		rec := httptest.NewRecorder()
		h.GetGitHubOAuthCallback(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("csrf error", func(t *testing.T) {
		withFailingAuthRandom(t)
		h := &AuthHandler{Service: mockAuthService{
			completeGitHubFn: func(context.Context, string, string, string) (services.OAuthCallbackResult, error) {
				return services.OAuthCallbackResult{User: db.User{ID: 7, Username: "alice"}, SessionKey: "sk"}, nil
			},
		}, AuthConfig: defaultRouteAuthConfig()}
		req := httptest.NewRequest(http.MethodGet, "/api/auth/github/callback?code=c&state=s", nil)
		rec := httptest.NewRecorder()
		h.GetGitHubOAuthCallback(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("browser success with audit", func(t *testing.T) {
		audit, q := authFAuditService()
		h := &AuthHandler{Service: mockAuthService{
			completeGitHubFn: func(context.Context, string, string, string) (services.OAuthCallbackResult, error) {
				return services.OAuthCallbackResult{
					User:        db.User{ID: 7, Username: "alice"},
					SessionKey:  "sk",
					ExpiresAt:   time.Now().Add(time.Hour),
					RedirectURL: "/dashboard",
				}, nil
			},
		}, AuthConfig: defaultRouteAuthConfig(), AuditService: audit}
		req := httptest.NewRequest(http.MethodGet, "/api/auth/github/callback?code=c&state=s", nil)
		rec := httptest.NewRecorder()
		h.GetGitHubOAuthCallback(rec, req)
		require.Equal(t, http.StatusFound, rec.Code)
		assert.Equal(t, "/dashboard", rec.Header().Get("Location"))
		assert.Equal(t, 1, q.calls)
	})

	t.Run("cli create token error", func(t *testing.T) {
		h := &AuthHandler{Service: mockAuthService{
			completeGitHubFn: func(context.Context, string, string, string) (services.OAuthCallbackResult, error) {
				return services.OAuthCallbackResult{User: db.User{ID: 7, Username: "alice"}}, nil
			},
			createTokenFn: func(context.Context, int64, services.CreateTokenRequest) (services.CreateTokenResult, error) {
				return services.CreateTokenResult{}, pkgerrors.Forbidden("no tokens")
			},
		}, AuthConfig: defaultRouteAuthConfig()}
		req := httptest.NewRequest(http.MethodGet, "/api/auth/github/callback?code=c&state=s", nil)
		req.AddCookie(&http.Cookie{Name: oauthStateCookieName, Value: "sv-cli-err"})
		req.AddCookie(&http.Cookie{Name: cliCallbackCookieName, Value: "41531:sv-cli-err"})
		rec := httptest.NewRecorder()
		h.GetGitHubOAuthCallback(rec, req)
		require.Equal(t, http.StatusForbidden, rec.Code)
	})

	t.Run("cli success with audit", func(t *testing.T) {
		audit, q := authFAuditService()
		h := &AuthHandler{Service: mockAuthService{
			completeGitHubFn: func(context.Context, string, string, string) (services.OAuthCallbackResult, error) {
				return services.OAuthCallbackResult{
					User:      db.User{ID: 7, Username: "alice", Email: pgtype.Text{String: "a@x.test", Valid: true}},
					ExpiresAt: time.Now().Add(time.Hour),
				}, nil
			},
			createTokenFn: func(context.Context, int64, services.CreateTokenRequest) (services.CreateTokenResult, error) {
				return services.CreateTokenResult{Token: "cli-token"}, nil
			},
		}, AuthConfig: defaultRouteAuthConfig(), AuditService: audit}
		req := httptest.NewRequest(http.MethodGet, "/api/auth/github/callback?code=c&state=s", nil)
		req.AddCookie(&http.Cookie{Name: oauthStateCookieName, Value: "sv-cli-ok"})
		req.AddCookie(&http.Cookie{Name: cliCallbackCookieName, Value: "41532:sv-cli-ok"})
		rec := httptest.NewRecorder()
		h.GetGitHubOAuthCallback(rec, req)
		require.Equal(t, http.StatusFound, rec.Code)
		assert.True(t, strings.HasPrefix(rec.Header().Get("Location"), "http://127.0.0.1:41532/callback#"))
		assert.Equal(t, 1, q.calls)
	})
}

// --- GetAuth0Authorize error branches ---

func TestAuth_F_GetAuth0Authorize(t *testing.T) {
	t.Run("random error", func(t *testing.T) {
		withFailingAuthRandom(t)
		h := &AuthHandler{Service: mockAuthService{}, AuthConfig: defaultRouteAuthConfig()}
		req := httptest.NewRequest(http.MethodGet, "/api/auth/auth0", nil)
		rec := httptest.NewRecorder()
		h.GetAuth0Authorize(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("service error", func(t *testing.T) {
		h := &AuthHandler{Service: mockAuthService{
			startAuth0OAuthFn: func(context.Context, string) (string, error) {
				return "", pkgerrors.Internal("auth0 down")
			},
		}, AuthConfig: defaultRouteAuthConfig()}
		req := httptest.NewRequest(http.MethodGet, "/api/auth/auth0", nil)
		rec := httptest.NewRecorder()
		h.GetAuth0Authorize(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})
}

// --- GetAuth0Callback ---

func TestAuth_F_GetAuth0Callback(t *testing.T) {
	t.Run("csrf error", func(t *testing.T) {
		withFailingAuthRandom(t)
		h := &AuthHandler{Service: mockAuthService{
			completeAuth0Fn: func(context.Context, string, string, string) (services.OAuthCallbackResult, error) {
				return services.OAuthCallbackResult{User: db.User{ID: 7, Username: "alice"}, SessionKey: "sk"}, nil
			},
		}, AuthConfig: defaultRouteAuthConfig()}
		req := httptest.NewRequest(http.MethodGet, "/api/auth/auth0/callback?code=c&state=s", nil)
		rec := httptest.NewRecorder()
		h.GetAuth0Callback(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("browser success with audit and resume cookie", func(t *testing.T) {
		audit, q := authFAuditService()
		h := &AuthHandler{Service: mockAuthService{
			completeAuth0Fn: func(context.Context, string, string, string) (services.OAuthCallbackResult, error) {
				return services.OAuthCallbackResult{
					User:       db.User{ID: 7, Username: "alice"},
					SessionKey: "sk",
					ExpiresAt:  time.Now().Add(time.Hour),
				}, nil
			},
		}, AuthConfig: defaultRouteAuthConfig(), AuditService: audit}
		req := httptest.NewRequest(http.MethodGet, "/api/auth/auth0/callback?code=c&state=s", nil)
		req.AddCookie(&http.Cookie{Name: oauth2PendingAuthorizeCookie, Value: "/api/oauth2/authorize?client_id=abc"})
		rec := httptest.NewRecorder()
		h.GetAuth0Callback(rec, req)
		require.Equal(t, http.StatusFound, rec.Code)
		assert.Equal(t, "/api/oauth2/authorize?client_id=abc", rec.Header().Get("Location"))
		assert.Equal(t, 1, q.calls)
	})
}

// --- PostGitHubTokenExchange ---

func TestAuth_F_PostGitHubTokenExchange(t *testing.T) {
	t.Run("decode fail", func(t *testing.T) {
		h := &AuthHandler{Service: mockAuthService{}, AuthConfig: defaultRouteAuthConfig()}
		req := httptest.NewRequest(http.MethodPost, "/api/auth/github/exchange", strings.NewReader("{bad"))
		rec := httptest.NewRecorder()
		h.PostGitHubTokenExchange(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("success with audit and warmer", func(t *testing.T) {
		audit, q := authFAuditService()
		warmer := &authFWarmer{}
		expires := time.Now().Add(time.Hour)
		h := &AuthHandler{Service: mockAuthService{
			exchangeGitHubFn: func(context.Context, string, string, string, *int64) (services.ExchangeGitHubTokenResult, error) {
				return services.ExchangeGitHubTokenResult{
					User:      db.User{ID: 7, Username: "alice"},
					Token:     "pat",
					TokenID:   99,
					ExpiresAt: &expires,
				}, nil
			},
		}, AuthConfig: defaultRouteAuthConfig(), AuditService: audit, RepoListingWarmer: warmer}
		req := httptest.NewRequest(http.MethodPost, "/api/auth/github/exchange", strings.NewReader(`{"github_access_token":"gho_x","token_name":"n"}`))
		rec := httptest.NewRecorder()
		h.PostGitHubTokenExchange(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, 1, q.calls)
		assert.Equal(t, int64(7), warmer.warmed)
		assert.Contains(t, rec.Body.String(), "expires_at")
	})
}

// --- PostLogout ---

func TestAuth_F_PostLogout(t *testing.T) {
	t.Run("logout service error", func(t *testing.T) {
		h := &AuthHandler{Service: mockAuthService{
			logoutFn: func(context.Context, string) error { return pkgerrors.Internal("logout down") },
		}, AuthConfig: defaultRouteAuthConfig()}
		req := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: "session-key"})
		rec := httptest.NewRecorder()
		h.PostLogout(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
		// The browser credential must be cleared even when the server row
		// could not be deleted; session expiry cleans the row later.
		cleared := map[string]bool{}
		for _, c := range rec.Result().Cookies() {
			if c.MaxAge < 0 {
				cleared[c.Name] = true
			}
		}
		assert.True(t, cleared["smithers_session"], "session cookie cleared")
		assert.Len(t, cleared, 2, "session and CSRF cookies cleared")
	})

	t.Run("success with audit and user context", func(t *testing.T) {
		audit, q := authFAuditService()
		h := &AuthHandler{Service: mockAuthService{
			logoutFn: func(context.Context, string) error { return nil },
		}, AuthConfig: defaultRouteAuthConfig(), AuditService: audit}
		req := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: "session-key"})
		req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{User: authFUser()}))
		rec := httptest.NewRecorder()
		h.PostLogout(rec, req)
		require.Equal(t, http.StatusNoContent, rec.Code)
		assert.Equal(t, 1, q.calls)
	})
}
