package routes

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type mockOAuth2RouteService struct {
	exchangeCodeFn                 func(ctx context.Context, clientID, clientSecret, code, redirectURI, codeVerifier string) (services.OAuth2TokenResponse, error)
	refreshTokenFn                 func(ctx context.Context, clientID, clientSecret, refreshToken string) (services.OAuth2TokenResponse, error)
	revokeTokenFn                  func(ctx context.Context, clientID, clientSecret, token string) error
	authorizeFn                    func(ctx context.Context, userID int64, clientID, redirectURI, scope, codeChallenge, codeChallengeMethod string, callerScopes []string) (services.OAuth2AuthorizeResult, error)
	getApplicationByClientIDFn     func(ctx context.Context, clientID string) (services.OAuth2ApplicationResponse, error)
	isValidRegisteredRedirectURIFn func(ctx context.Context, clientID, redirectURI string) (bool, error)
	revokeAllFn                    func(ctx context.Context, appID, userID int64) error
}

func (m *mockOAuth2RouteService) Authorize(ctx context.Context, userID int64, clientID, redirectURI, scope, codeChallenge, codeChallengeMethod string, callerScopes []string) (services.OAuth2AuthorizeResult, error) {
	if m.authorizeFn != nil {
		return m.authorizeFn(ctx, userID, clientID, redirectURI, scope, codeChallenge, codeChallengeMethod, callerScopes)
	}
	panic("not used in test")
}

func (m *mockOAuth2RouteService) GetApplicationByClientID(ctx context.Context, clientID string) (services.OAuth2ApplicationResponse, error) {
	if m.getApplicationByClientIDFn != nil {
		return m.getApplicationByClientIDFn(ctx, clientID)
	}
	panic("not used in test")
}

func (m *mockOAuth2RouteService) IsValidRegisteredRedirectURI(ctx context.Context, clientID, redirectURI string) (bool, error) {
	if m.isValidRegisteredRedirectURIFn != nil {
		return m.isValidRegisteredRedirectURIFn(ctx, clientID, redirectURI)
	}
	panic("not used in test")
}

func (m *mockOAuth2RouteService) ExchangeCode(ctx context.Context, clientID, clientSecret, code, redirectURI, codeVerifier string) (services.OAuth2TokenResponse, error) {
	if m.exchangeCodeFn != nil {
		return m.exchangeCodeFn(ctx, clientID, clientSecret, code, redirectURI, codeVerifier)
	}
	panic("not used in test")
}

func (m *mockOAuth2RouteService) RefreshToken(ctx context.Context, clientID, clientSecret, refreshToken string) (services.OAuth2TokenResponse, error) {
	if m.refreshTokenFn != nil {
		return m.refreshTokenFn(ctx, clientID, clientSecret, refreshToken)
	}
	panic("not used in test")
}

func (m *mockOAuth2RouteService) RevokeToken(ctx context.Context, clientID, clientSecret, token string) error {
	if m.revokeTokenFn != nil {
		return m.revokeTokenFn(ctx, clientID, clientSecret, token)
	}
	panic("not used in test")
}

func (m *mockOAuth2RouteService) RevokeAllByAppAndUser(ctx context.Context, appID, userID int64) error {
	if m.revokeAllFn != nil {
		return m.revokeAllFn(ctx, appID, userID)
	}
	panic("not used in test")
}

func readMetricsOutput(t *testing.T, metrics *SmithersMetrics) string {
	t.Helper()

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	metrics.Handler().ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	body, err := io.ReadAll(rec.Body)
	require.NoError(t, err)
	return string(body)
}

func TestOAuth2Handler_PostToken_RecordsTokenOperations(t *testing.T) {
	t.Parallel()

	t.Run("authorization_code increments issue metric", func(t *testing.T) {
		t.Parallel()

		metrics := NewSmithersMetrics()
		h := &OAuth2Handler{
			Service: &mockOAuth2RouteService{
				exchangeCodeFn: func(_ context.Context, _, _, _, _, _ string) (services.OAuth2TokenResponse, error) {
					return services.OAuth2TokenResponse{AccessToken: "access", TokenType: "bearer", ExpiresIn: 3600}, nil
				},
			},
			Metrics: metrics,
		}

		req := httptest.NewRequest(http.MethodPost, "/api/oauth2/token", strings.NewReader(`{"grant_type":"authorization_code","code":"code-123","client_id":"client-123","redirect_uri":"https://app.example/callback"}`))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()

		h.PostToken(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)

		output := readMetricsOutput(t, metrics)
		assert.Contains(t, output, `smithers_oauth2_token_operations_total{operation="issue"} 1`)
	})

	t.Run("refresh_token increments refresh metric", func(t *testing.T) {
		t.Parallel()

		metrics := NewSmithersMetrics()
		h := &OAuth2Handler{
			Service: &mockOAuth2RouteService{
				refreshTokenFn: func(_ context.Context, _, _, _ string) (services.OAuth2TokenResponse, error) {
					return services.OAuth2TokenResponse{AccessToken: "access", TokenType: "bearer", ExpiresIn: 3600}, nil
				},
			},
			Metrics: metrics,
		}

		req := httptest.NewRequest(http.MethodPost, "/api/oauth2/token", strings.NewReader(`{"grant_type":"refresh_token","refresh_token":"refresh-123","client_id":"client-123"}`))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()

		h.PostToken(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)

		output := readMetricsOutput(t, metrics)
		assert.Contains(t, output, `smithers_oauth2_token_operations_total{operation="refresh"} 1`)
	})
}

func TestOAuth2Handler_PostRevoke_RecordsTokenOperation(t *testing.T) {
	t.Parallel()

	metrics := NewSmithersMetrics()
	h := &OAuth2Handler{
		Service: &mockOAuth2RouteService{
			revokeTokenFn: func(_ context.Context, _, _, token string) error {
				assert.Equal(t, "refresh-123", token)
				return nil
			},
		},
		Metrics: metrics,
	}

	req := httptest.NewRequest(http.MethodPost, "/api/oauth2/revoke", strings.NewReader(`{"token":"refresh-123","client_id":"client-123"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	h.PostRevoke(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	output := readMetricsOutput(t, metrics)
	assert.Contains(t, output, `smithers_oauth2_token_operations_total{operation="revoke"} 1`)
}

func TestOAuth2Handler_PostRevokeAll_RecordsTokenOperation(t *testing.T) {
	t.Parallel()

	metrics := NewSmithersMetrics()
	h := &OAuth2Handler{
		Service: &mockOAuth2RouteService{
			revokeAllFn: func(_ context.Context, appID, userID int64) error {
				assert.Equal(t, int64(41), appID)
				assert.Equal(t, int64(7), userID)
				return nil
			},
		},
		Metrics: metrics,
	}

	req := httptest.NewRequest(http.MethodPost, "/api/oauth2/revoke-all", nil)
	req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
		User:        &db.User{ID: 7, Username: "alice", LowerUsername: "alice"},
		OAuth2AppID: 41,
		Scopes:      middleware.ScopeSet{middleware.ScopeReadUser: {}},
		IsTokenAuth: true,
		TokenSource: middleware.TokenSourceOAuth2AccessToken,
	}))
	rec := httptest.NewRecorder()

	h.PostRevokeAll(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	output := readMetricsOutput(t, metrics)
	assert.Contains(t, output, `smithers_oauth2_token_operations_total{operation="revoke_all"} 1`)
}

func (m *mockOAuth2RouteService) AuthorizeGrant(ctx context.Context, in services.OAuth2AuthorizeInput) (services.OAuth2AuthorizeResult, error) {
	return m.Authorize(ctx, in.UserID, in.ClientID, in.RedirectURI, in.Scope, in.CodeChallenge, in.CodeChallengeMethod, in.CallerScopes)
}
