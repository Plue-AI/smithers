package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestOauth2_Cov_AuthorizeAndTokenBranches(t *testing.T) {
	t.Run("dev auto authorize can be constrained by client id", func(t *testing.T) {
		h := &OAuth2Handler{DevAutoAuthorizeUserID: 99, DevAutoAuthorizeClientID: "allowed"}
		req := httptest.NewRequest(http.MethodGet, "/api/oauth2/authorize?client_id=blocked", nil)
		assert.False(t, h.devAutoAuthorizeAllowed(req))
		req = httptest.NewRequest(http.MethodGet, "/api/oauth2/authorize?client_id=allowed", nil)
		assert.True(t, h.devAutoAuthorizeAllowed(req))
	})

	t.Run("upstream authorize path trims and prefixes", func(t *testing.T) {
		h := &OAuth2Handler{}
		assert.Equal(t, "/api/auth/github", h.upstreamAuthorizePath())
		h.UpstreamAuthorizePath = "api/auth/auth0/authorize"
		assert.Equal(t, "/api/auth/auth0/authorize", h.upstreamAuthorizePath())
	})

	t.Run("authorize refuses third party clients after redirect validation", func(t *testing.T) {
		authorized := false
		h := &OAuth2Handler{
			Service: &oauth2CovRouteService{
				isValidRegisteredRedirectURIFn: func(ctx context.Context, clientID, redirectURI string) (bool, error) {
					return true, nil
				},
				authorizeFn: func(ctx context.Context, userID int64, clientID, redirectURI, scope, codeChallenge, codeChallengeMethod string, callerScopes []string) (services.OAuth2AuthorizeResult, error) {
					authorized = true
					return services.OAuth2AuthorizeResult{}, nil
				},
			},
		}
		req := httptest.NewRequest(http.MethodGet, "/api/oauth2/authorize?response_type=code&client_id=third_party&redirect_uri=https://app.example/cb&state=s&code_challenge=c&code_challenge_method=S256", nil)
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		h.GetAuthorize(rec, req)

		require.Equal(t, http.StatusForbidden, rec.Code)
		assert.False(t, authorized)
	})

	t.Run("oauth2 access tokens cannot mint new authorization codes", func(t *testing.T) {
		h := &OAuth2Handler{
			Service: &oauth2CovRouteService{
				isValidRegisteredRedirectURIFn: func(ctx context.Context, clientID, redirectURI string) (bool, error) {
					return true, nil
				},
			},
		}
		req := httptest.NewRequest(http.MethodGet, "/api/oauth2/authorize?response_type=code&client_id="+services.FirstPartyClientID+"&redirect_uri=smithers://oauth2/callback&state=s&code_challenge=c&code_challenge_method=S256", nil)
		req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
			User:        &db.User{ID: 7, Username: "alice"},
			IsTokenAuth: true,
			TokenSource: middleware.TokenSourceOAuth2AccessToken,
		}))
		rec := httptest.NewRecorder()

		h.GetAuthorize(rec, req)

		require.Equal(t, http.StatusForbidden, rec.Code)
	})

	t.Run("token form basic auth and revoke validation branches", func(t *testing.T) {
		var gotClientID string
		h := &OAuth2Handler{
			Service: &oauth2CovRouteService{
				refreshTokenFn: func(ctx context.Context, clientID, clientSecret, refreshToken string) (services.OAuth2TokenResponse, error) {
					gotClientID = clientID
					assert.Equal(t, "secret-basic", clientSecret)
					assert.Equal(t, "refresh-1", refreshToken)
					return services.OAuth2TokenResponse{AccessToken: "access", TokenType: "bearer", ExpiresIn: 3600}, nil
				},
				revokeTokenFn: func(ctx context.Context, clientID, clientSecret, token string) error {
					return pkgerrors.Forbidden("wrong client")
				},
			},
			Metrics: NewSmithersMetrics(),
		}
		req := httptest.NewRequest(http.MethodPost, "/api/oauth2/token", strings.NewReader("grant_type=refresh_token&refresh_token=refresh-1"))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.SetBasicAuth("client-basic", "secret-basic")
		rec := httptest.NewRecorder()
		h.PostToken(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "client-basic", gotClientID)

		req = httptest.NewRequest(http.MethodPost, "/api/oauth2/revoke", strings.NewReader(`{"token":""}`))
		req.Header.Set("Content-Type", "application/json")
		rec = httptest.NewRecorder()
		h.PostRevoke(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)

		req = httptest.NewRequest(http.MethodPost, "/api/oauth2/revoke", strings.NewReader("token=refresh-1&client_id=client"))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		rec = httptest.NewRecorder()
		h.PostRevoke(rec, req)
		require.Equal(t, http.StatusForbidden, rec.Code)
	})

	t.Run("revoke all requires oauth2 access token context", func(t *testing.T) {
		h := &OAuth2Handler{Service: &oauth2CovRouteService{}, Metrics: NewSmithersMetrics()}
		req := httptest.NewRequest(http.MethodPost, "/api/oauth2/revoke-all", nil)
		rec := httptest.NewRecorder()

		h.PostRevokeAll(rec, req)

		require.Equal(t, http.StatusUnauthorized, rec.Code)

		req = httptest.NewRequest(http.MethodPost, "/api/oauth2/revoke-all", nil)
		req = withAuth(req, 7, "alice")
		rec = httptest.NewRecorder()

		h.PostRevokeAll(rec, req)

		require.Equal(t, http.StatusForbidden, rec.Code)
	})
}

type oauth2CovRouteService struct {
	authorizeFn                    func(ctx context.Context, userID int64, clientID, redirectURI, scope, codeChallenge, codeChallengeMethod string, callerScopes []string) (services.OAuth2AuthorizeResult, error)
	exchangeCodeFn                 func(ctx context.Context, clientID, clientSecret, code, redirectURI, codeVerifier string) (services.OAuth2TokenResponse, error)
	refreshTokenFn                 func(ctx context.Context, clientID, clientSecret, refreshToken string) (services.OAuth2TokenResponse, error)
	revokeTokenFn                  func(ctx context.Context, clientID, clientSecret, token string) error
	getApplicationByClientIDFn     func(ctx context.Context, clientID string) (services.OAuth2ApplicationResponse, error)
	isValidRegisteredRedirectURIFn func(ctx context.Context, clientID, redirectURI string) (bool, error)
	revokeAllByAppAndUserFn        func(ctx context.Context, appID, userID int64) error
}

func (s *oauth2CovRouteService) Authorize(ctx context.Context, userID int64, clientID, redirectURI, scope, codeChallenge, codeChallengeMethod string, callerScopes []string) (services.OAuth2AuthorizeResult, error) {
	if s.authorizeFn != nil {
		return s.authorizeFn(ctx, userID, clientID, redirectURI, scope, codeChallenge, codeChallengeMethod, callerScopes)
	}
	return services.OAuth2AuthorizeResult{Code: "code", RedirectURI: redirectURI}, nil
}

func (s *oauth2CovRouteService) ExchangeCode(ctx context.Context, clientID, clientSecret, code, redirectURI, codeVerifier string) (services.OAuth2TokenResponse, error) {
	if s.exchangeCodeFn != nil {
		return s.exchangeCodeFn(ctx, clientID, clientSecret, code, redirectURI, codeVerifier)
	}
	return services.OAuth2TokenResponse{}, nil
}

func (s *oauth2CovRouteService) RefreshToken(ctx context.Context, clientID, clientSecret, refreshToken string) (services.OAuth2TokenResponse, error) {
	if s.refreshTokenFn != nil {
		return s.refreshTokenFn(ctx, clientID, clientSecret, refreshToken)
	}
	return services.OAuth2TokenResponse{}, nil
}

func (s *oauth2CovRouteService) RevokeToken(ctx context.Context, clientID, clientSecret, token string) error {
	if s.revokeTokenFn != nil {
		return s.revokeTokenFn(ctx, clientID, clientSecret, token)
	}
	return nil
}

func (s *oauth2CovRouteService) GetApplicationByClientID(ctx context.Context, clientID string) (services.OAuth2ApplicationResponse, error) {
	if s.getApplicationByClientIDFn != nil {
		return s.getApplicationByClientIDFn(ctx, clientID)
	}
	return services.OAuth2ApplicationResponse{}, nil
}

func (s *oauth2CovRouteService) IsValidRegisteredRedirectURI(ctx context.Context, clientID, redirectURI string) (bool, error) {
	if s.isValidRegisteredRedirectURIFn != nil {
		return s.isValidRegisteredRedirectURIFn(ctx, clientID, redirectURI)
	}
	return true, nil
}

func (s *oauth2CovRouteService) RevokeAllByAppAndUser(ctx context.Context, appID, userID int64) error {
	if s.revokeAllByAppAndUserFn != nil {
		return s.revokeAllByAppAndUserFn(ctx, appID, userID)
	}
	return nil
}

func (m *oauth2CovRouteService) AuthorizeGrant(ctx context.Context, in services.OAuth2AuthorizeInput) (services.OAuth2AuthorizeResult, error) {
	return m.Authorize(ctx, in.UserID, in.ClientID, in.RedirectURI, in.Scope, in.CodeChallenge, in.CodeChallengeMethod, in.CallerScopes)
}
