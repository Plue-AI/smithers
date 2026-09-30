package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestOauth2_Cov_ApplicationCRUD(t *testing.T) {
	t.Run("post requires auth and validates json", func(t *testing.T) {
		h := &OAuth2Handler{Service: &oauth2CovRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/oauth2/applications", strings.NewReader(`{"name":"cli"}`))
		rec := httptest.NewRecorder()

		h.PostApplication(rec, req)

		require.Equal(t, http.StatusUnauthorized, rec.Code)

		req = httptest.NewRequest(http.MethodPost, "/api/oauth2/applications", strings.NewReader(`{bad`))
		req = withAuth(req, 7, "alice")
		rec = httptest.NewRecorder()

		h.PostApplication(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("post delegates and returns client secret once", func(t *testing.T) {
		var gotOwner int64
		var gotReq services.CreateOAuth2ApplicationRequest
		h := &OAuth2Handler{Service: &oauth2CovRouteService{
			createApplicationFn: func(ctx context.Context, ownerID int64, req services.CreateOAuth2ApplicationRequest) (services.CreateOAuth2ApplicationResult, error) {
				gotOwner = ownerID
				gotReq = req
				return services.CreateOAuth2ApplicationResult{
					OAuth2ApplicationResponse: services.OAuth2ApplicationResponse{
						ID:           41,
						ClientID:     "client_123",
						Name:         req.Name,
						RedirectURIs: req.RedirectURIs,
						Scopes:       req.Scopes,
						Confidential: *req.Confidential,
						CreatedAt:    time.Unix(1, 0).UTC(),
						UpdatedAt:    time.Unix(1, 0).UTC(),
					},
					ClientSecret: "secret-once",
				}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/oauth2/applications", strings.NewReader(`{"name":"cli","redirect_uris":["https://app.example/cb"],"scopes":["read:user"],"confidential":true}`))
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		h.PostApplication(rec, req)

		require.Equal(t, http.StatusCreated, rec.Code)
		assert.Equal(t, int64(7), gotOwner)
		assert.Equal(t, "cli", gotReq.Name)
		require.NotNil(t, gotReq.Confidential)
		assert.True(t, *gotReq.Confidential)
		var body services.CreateOAuth2ApplicationResult
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		assert.Equal(t, "client_123", body.ClientID)
		assert.Equal(t, "secret-once", body.ClientSecret)
	})

	t.Run("list get and delete cover parse and service errors", func(t *testing.T) {
		h := &OAuth2Handler{Service: &oauth2CovRouteService{
			listApplicationsFn: func(ctx context.Context, ownerID int64) ([]services.OAuth2ApplicationResponse, error) {
				assert.Equal(t, int64(7), ownerID)
				return []services.OAuth2ApplicationResponse{{ID: 1, ClientID: "client_1", Name: "one"}}, nil
			},
			getApplicationFn: func(ctx context.Context, appID, ownerID int64) (services.OAuth2ApplicationResponse, error) {
				assert.Equal(t, int64(42), appID)
				assert.Equal(t, int64(7), ownerID)
				return services.OAuth2ApplicationResponse{ID: appID, ClientID: "client_42", Name: "forty two"}, nil
			},
			deleteApplicationFn: func(ctx context.Context, appID, ownerID int64) error {
				assert.Equal(t, int64(42), appID)
				assert.Equal(t, int64(7), ownerID)
				return nil
			},
		}}

		listReq := httptest.NewRequest(http.MethodGet, "/api/oauth2/applications", nil)
		listReq = withAuth(listReq, 7, "alice")
		listRec := httptest.NewRecorder()
		h.GetApplications(listRec, listReq)
		require.Equal(t, http.StatusOK, listRec.Code)

		getBadReq := httptest.NewRequest(http.MethodGet, "/api/oauth2/applications/nope", nil)
		getBadReq = withAuth(getBadReq, 7, "alice")
		getBadReq = withRouteParams(getBadReq, map[string]string{"id": "nope"})
		getBadRec := httptest.NewRecorder()
		h.GetApplication(getBadRec, getBadReq)
		require.Equal(t, http.StatusBadRequest, getBadRec.Code)

		getReq := httptest.NewRequest(http.MethodGet, "/api/oauth2/applications/42", nil)
		getReq = withAuth(getReq, 7, "alice")
		getReq = withRouteParams(getReq, map[string]string{"id": "42"})
		getRec := httptest.NewRecorder()
		h.GetApplication(getRec, getReq)
		require.Equal(t, http.StatusOK, getRec.Code)

		delReq := httptest.NewRequest(http.MethodDelete, "/api/oauth2/applications/42", nil)
		delReq = withAuth(delReq, 7, "alice")
		delReq = withRouteParams(delReq, map[string]string{"id": "42"})
		delRec := httptest.NewRecorder()
		h.DeleteApplication(delRec, delReq)
		require.Equal(t, http.StatusNoContent, delRec.Code)
	})

	t.Run("application service errors are normalized", func(t *testing.T) {
		h := &OAuth2Handler{Service: &oauth2CovRouteService{
			listApplicationsFn: func(ctx context.Context, ownerID int64) ([]services.OAuth2ApplicationResponse, error) {
				return nil, pkgerrors.Forbidden("blocked")
			},
			getApplicationFn: func(ctx context.Context, appID, ownerID int64) (services.OAuth2ApplicationResponse, error) {
				return services.OAuth2ApplicationResponse{}, pkgerrors.NotFound("app not found")
			},
			deleteApplicationFn: func(ctx context.Context, appID, ownerID int64) error {
				return pkgerrors.NotFound("app not found")
			},
		}}
		listReq := httptest.NewRequest(http.MethodGet, "/api/oauth2/applications", nil)
		listReq = withAuth(listReq, 7, "alice")
		listRec := httptest.NewRecorder()
		h.GetApplications(listRec, listReq)
		require.Equal(t, http.StatusForbidden, listRec.Code)

		getReq := httptest.NewRequest(http.MethodGet, "/api/oauth2/applications/42", nil)
		getReq = withAuth(getReq, 7, "alice")
		getReq = withRouteParams(getReq, map[string]string{"id": "42"})
		getRec := httptest.NewRecorder()
		h.GetApplication(getRec, getReq)
		require.Equal(t, http.StatusNotFound, getRec.Code)

		delReq := httptest.NewRequest(http.MethodDelete, "/api/oauth2/applications/42", nil)
		delReq = withAuth(delReq, 7, "alice")
		delReq = withRouteParams(delReq, map[string]string{"id": "42"})
		delRec := httptest.NewRecorder()
		h.DeleteApplication(delRec, delReq)
		require.Equal(t, http.StatusNotFound, delRec.Code)
	})
}

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
	createApplicationFn            func(ctx context.Context, ownerID int64, req services.CreateOAuth2ApplicationRequest) (services.CreateOAuth2ApplicationResult, error)
	listApplicationsFn             func(ctx context.Context, ownerID int64) ([]services.OAuth2ApplicationResponse, error)
	getApplicationFn               func(ctx context.Context, appID, ownerID int64) (services.OAuth2ApplicationResponse, error)
	deleteApplicationFn            func(ctx context.Context, appID, ownerID int64) error
	authorizeFn                    func(ctx context.Context, userID int64, clientID, redirectURI, scope, codeChallenge, codeChallengeMethod string, callerScopes []string) (services.OAuth2AuthorizeResult, error)
	exchangeCodeFn                 func(ctx context.Context, clientID, clientSecret, code, redirectURI, codeVerifier string) (services.OAuth2TokenResponse, error)
	refreshTokenFn                 func(ctx context.Context, clientID, clientSecret, refreshToken string) (services.OAuth2TokenResponse, error)
	revokeTokenFn                  func(ctx context.Context, clientID, clientSecret, token string) error
	getApplicationByClientIDFn     func(ctx context.Context, clientID string) (services.OAuth2ApplicationResponse, error)
	isValidRegisteredRedirectURIFn func(ctx context.Context, clientID, redirectURI string) (bool, error)
	revokeAllByAppAndUserFn        func(ctx context.Context, appID, userID int64) error
}

func (s *oauth2CovRouteService) CreateApplication(ctx context.Context, ownerID int64, req services.CreateOAuth2ApplicationRequest) (services.CreateOAuth2ApplicationResult, error) {
	if s.createApplicationFn != nil {
		return s.createApplicationFn(ctx, ownerID, req)
	}
	return services.CreateOAuth2ApplicationResult{}, nil
}

func (s *oauth2CovRouteService) ListApplications(ctx context.Context, ownerID int64) ([]services.OAuth2ApplicationResponse, error) {
	if s.listApplicationsFn != nil {
		return s.listApplicationsFn(ctx, ownerID)
	}
	return nil, nil
}

func (s *oauth2CovRouteService) GetApplication(ctx context.Context, appID, ownerID int64) (services.OAuth2ApplicationResponse, error) {
	if s.getApplicationFn != nil {
		return s.getApplicationFn(ctx, appID, ownerID)
	}
	return services.OAuth2ApplicationResponse{}, nil
}

func (s *oauth2CovRouteService) DeleteApplication(ctx context.Context, appID, ownerID int64) error {
	if s.deleteApplicationFn != nil {
		return s.deleteApplicationFn(ctx, appID, ownerID)
	}
	return nil
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
