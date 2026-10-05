package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type mockUserTokenService struct {
	listTokensFn  func(ctx context.Context, userID int64) ([]services.TokenSummary, error)
	createTokenFn func(ctx context.Context, userID int64, req services.CreateTokenRequest) (services.CreateTokenResult, error)
	deleteTokenFn func(ctx context.Context, userID, tokenID int64) error
}

type mockUserProfileService struct {
	getAuthenticatedUserFn           func(ctx context.Context, userID int64) (services.UserProfile, error)
	getUserByUsernameFn              func(ctx context.Context, username string) (services.PublicUserProfile, error)
	updateAuthenticatedUserFn        func(ctx context.Context, userID int64, req services.UpdateUserRequest) (services.UserProfile, error)
	listAuthenticatedUserReposFn     func(ctx context.Context, userID int64, page, perPage int) (services.RepoListResult, error)
	listAuthenticatedUserOrgsFn      func(ctx context.Context, userID int64, page, perPage int) (services.OrgListResult, error)
	listAuthenticatedUserStarredFn   func(ctx context.Context, userID int64, page, perPage int) (services.RepoListResult, error)
	listUserReposByUsernameFn        func(ctx context.Context, username string, page, perPage int) (services.RepoListResult, error)
	getNotificationPreferencesFn     func(ctx context.Context, userID int64) (services.NotificationPreferences, error)
	updateNotificationPreferencesFn  func(ctx context.Context, userID int64, req services.UpdateNotificationPreferencesRequest) (services.NotificationPreferences, error)
	listConnectedAccountsFn          func(ctx context.Context, userID int64) ([]services.ConnectedAccountResponse, error)
	deleteConnectedAccountFn         func(ctx context.Context, userID, accountID int64) error
	listUserActivityByUsernameFn     func(ctx context.Context, username string, page, perPage int) (services.ActivityListResult, error)
	listUserStarredReposByUsernameFn func(ctx context.Context, username string, page, perPage int) (services.RepoListResult, error)
	listReadableReposFn              func(ctx context.Context, userID int64, page, perPage int) (services.ReadableRepoListResult, error)
}

func (m mockUserProfileService) ListReadableReposForAuthenticatedUser(ctx context.Context, userID int64, page, perPage int) (services.ReadableRepoListResult, error) {
	if m.listReadableReposFn != nil {
		return m.listReadableReposFn(ctx, userID, page, perPage)
	}
	return services.ReadableRepoListResult{}, nil
}

type mockUserSessionService struct {
	listUserSessionsFn func(ctx context.Context, userID int64) ([]db.AuthSession, error)
	revokeSessionFn    func(ctx context.Context, userID int64, sessionKey string) error
}

func (m mockUserTokenService) ListTokens(ctx context.Context, userID int64) ([]services.TokenSummary, error) {
	return m.listTokensFn(ctx, userID)
}

func (m mockUserTokenService) CreateToken(ctx context.Context, userID int64, req services.CreateTokenRequest) (services.CreateTokenResult, error) {
	return m.createTokenFn(ctx, userID, req)
}

func (m mockUserTokenService) DeleteToken(ctx context.Context, userID, tokenID int64) error {
	return m.deleteTokenFn(ctx, userID, tokenID)
}

func (m mockUserProfileService) GetAuthenticatedUser(ctx context.Context, userID int64) (services.UserProfile, error) {
	return m.getAuthenticatedUserFn(ctx, userID)
}

func (m mockUserProfileService) GetUserByUsername(ctx context.Context, username string) (services.PublicUserProfile, error) {
	return m.getUserByUsernameFn(ctx, username)
}

func (m mockUserProfileService) UpdateAuthenticatedUser(ctx context.Context, userID int64, req services.UpdateUserRequest) (services.UserProfile, error) {
	return m.updateAuthenticatedUserFn(ctx, userID, req)
}

func (m mockUserProfileService) ListAuthenticatedUserRepos(ctx context.Context, userID int64, page, perPage int) (services.RepoListResult, error) {
	return m.listAuthenticatedUserReposFn(ctx, userID, page, perPage)
}

func (m mockUserProfileService) ListAuthenticatedUserOrgs(ctx context.Context, userID int64, page, perPage int) (services.OrgListResult, error) {
	return m.listAuthenticatedUserOrgsFn(ctx, userID, page, perPage)
}

func (m mockUserProfileService) ListAuthenticatedUserStarredRepos(ctx context.Context, userID int64, page, perPage int) (services.RepoListResult, error) {
	return m.listAuthenticatedUserStarredFn(ctx, userID, page, perPage)
}

func (m mockUserProfileService) ListUserReposByUsername(ctx context.Context, username string, page, perPage int) (services.RepoListResult, error) {
	return m.listUserReposByUsernameFn(ctx, username, page, perPage)
}

func (m mockUserProfileService) GetNotificationPreferences(ctx context.Context, userID int64) (services.NotificationPreferences, error) {
	if m.getNotificationPreferencesFn != nil {
		return m.getNotificationPreferencesFn(ctx, userID)
	}
	return services.NotificationPreferences{}, nil
}

func (m mockUserProfileService) UpdateNotificationPreferences(ctx context.Context, userID int64, req services.UpdateNotificationPreferencesRequest) (services.NotificationPreferences, error) {
	if m.updateNotificationPreferencesFn != nil {
		return m.updateNotificationPreferencesFn(ctx, userID, req)
	}
	return services.NotificationPreferences{}, nil
}

func (m mockUserProfileService) ListConnectedAccounts(ctx context.Context, userID int64) ([]services.ConnectedAccountResponse, error) {
	if m.listConnectedAccountsFn != nil {
		return m.listConnectedAccountsFn(ctx, userID)
	}
	return nil, nil
}

func (m mockUserProfileService) DeleteConnectedAccount(ctx context.Context, userID, accountID int64) error {
	if m.deleteConnectedAccountFn != nil {
		return m.deleteConnectedAccountFn(ctx, userID, accountID)
	}
	return nil
}

func (m mockUserProfileService) ListUserActivityByUsername(ctx context.Context, username string, page, perPage int) (services.ActivityListResult, error) {
	if m.listUserActivityByUsernameFn != nil {
		return m.listUserActivityByUsernameFn(ctx, username, page, perPage)
	}
	return services.ActivityListResult{}, nil
}

func (m mockUserProfileService) ListUserStarredReposByUsername(ctx context.Context, username string, page, perPage int) (services.RepoListResult, error) {
	if m.listUserStarredReposByUsernameFn != nil {
		return m.listUserStarredReposByUsernameFn(ctx, username, page, perPage)
	}
	return services.RepoListResult{}, nil
}

func (m mockUserSessionService) ListUserSessions(ctx context.Context, userID int64) ([]db.AuthSession, error) {
	return m.listUserSessionsFn(ctx, userID)
}

func (m mockUserSessionService) RevokeUserSession(ctx context.Context, userID int64, sessionKey string) error {
	return m.revokeSessionFn(ctx, userID, sessionKey)
}

func TestUserHandler_ListTokens(t *testing.T) {
	t.Parallel()

	handler := UserHandler{
		TokenService: mockUserTokenService{
			listTokensFn: func(ctx context.Context, userID int64) ([]services.TokenSummary, error) {
				assert.Equal(t, int64(50), userID)
				return []services.TokenSummary{
					{ID: 1, Name: "deploy", TokenLastEight: "89abcdef", Scopes: []string{"write:user"}},
				}, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/user/tokens", nil)
	req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
		User: &db.User{ID: 50, Username: "alice", LowerUsername: "alice"},
	}))
	rec := httptest.NewRecorder()
	handler.GetUserTokens(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var payload []services.TokenSummary
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	require.Len(t, payload, 1)
	assert.Equal(t, int64(1), payload[0].ID)
}

func TestUserHandler_ListSessions(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC()
	handler := UserHandler{
		SessionService: mockUserSessionService{
			listUserSessionsFn: func(ctx context.Context, userID int64) ([]db.AuthSession, error) {
				assert.Equal(t, int64(50), userID)
				return []db.AuthSession{
					{
						SessionKey: "550e8400-e29b-41d4-a716-446655440000",
						UserID:     userID,
						ExpiresAt:  now.Add(24 * time.Hour),
						CreatedAt:  now.Add(-time.Hour),
					},
				}, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/user/sessions", nil)
	req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
		User: &db.User{ID: 50, Username: "alice", LowerUsername: "alice"},
	}))
	rec := httptest.NewRecorder()
	handler.GetUserSessions(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var payload []map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	require.Len(t, payload, 1)
	assert.Equal(t, services.SessionPublicID("550e8400-e29b-41d4-a716-446655440000"), payload[0]["id"])
	assert.NotEqual(t, "550e8400-e29b-41d4-a716-446655440000", payload[0]["id"], "raw session key must never be returned")
	assert.NotEmpty(t, payload[0]["created_at"])
	assert.NotEmpty(t, payload[0]["expires_at"])
}

func TestUserHandler_ListSessions_Unauthenticated(t *testing.T) {
	t.Parallel()

	handler := UserHandler{
		SessionService: mockUserSessionService{
			listUserSessionsFn: func(ctx context.Context, userID int64) ([]db.AuthSession, error) {
				t.Fatal("service should not be called")
				return nil, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/user/sessions", nil)
	rec := httptest.NewRecorder()
	handler.GetUserSessions(rec, req)

	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestUserHandler_RevokeSession(t *testing.T) {
	t.Parallel()

	handler := UserHandler{
		SessionService: mockUserSessionService{
			revokeSessionFn: func(ctx context.Context, userID int64, sessionKey string) error {
				assert.Equal(t, int64(99), userID)
				assert.Equal(t, services.SessionPublicID("550e8400-e29b-41d4-a716-446655440000"), sessionKey)
				return nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/user/sessions/"+services.SessionPublicID("550e8400-e29b-41d4-a716-446655440000"), nil)
	req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
		User: &db.User{ID: 99, Username: "alice", LowerUsername: "alice"},
	}))
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("id", services.SessionPublicID("550e8400-e29b-41d4-a716-446655440000"))
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))

	rec := httptest.NewRecorder()
	handler.DeleteUserSession(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
}

func TestUserHandler_RevokeSession_Unauthenticated(t *testing.T) {
	t.Parallel()

	handler := UserHandler{
		SessionService: mockUserSessionService{
			revokeSessionFn: func(ctx context.Context, userID int64, sessionKey string) error {
				t.Fatal("service should not be called")
				return nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/user/sessions/550e8400-e29b-41d4-a716-446655440000", nil)
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("id", "550e8400-e29b-41d4-a716-446655440000")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))

	rec := httptest.NewRecorder()
	handler.DeleteUserSession(rec, req)

	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestUserHandler_RevokeSession_NotFound(t *testing.T) {
	t.Parallel()

	handler := UserHandler{
		SessionService: mockUserSessionService{
			revokeSessionFn: func(ctx context.Context, userID int64, sessionKey string) error {
				return errors.NotFound("session not found")
			},
		},
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/user/sessions/550e8400-e29b-41d4-a716-446655440000", nil)
	req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
		User: &db.User{ID: 99, Username: "alice", LowerUsername: "alice"},
	}))
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("id", "550e8400-e29b-41d4-a716-446655440000")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))

	rec := httptest.NewRecorder()
	handler.DeleteUserSession(rec, req)

	require.Equal(t, http.StatusNotFound, rec.Code)
}

func TestUserHandler_RevokeSession_OtherUserSession(t *testing.T) {
	t.Parallel()

	handler := UserHandler{
		SessionService: mockUserSessionService{
			revokeSessionFn: func(ctx context.Context, userID int64, sessionKey string) error {
				return errors.NotFound("session not found")
			},
		},
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/user/sessions/550e8400-e29b-41d4-a716-446655440000", nil)
	req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
		User: &db.User{ID: 99, Username: "alice", LowerUsername: "alice"},
	}))
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("id", "550e8400-e29b-41d4-a716-446655440000")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))

	rec := httptest.NewRecorder()
	handler.DeleteUserSession(rec, req)

	require.Equal(t, http.StatusNotFound, rec.Code)
}

func TestUserHandler_CreateToken(t *testing.T) {
	t.Parallel()

	handler := UserHandler{
		TokenService: mockUserTokenService{
			createTokenFn: func(ctx context.Context, userID int64, req services.CreateTokenRequest) (services.CreateTokenResult, error) {
				assert.Equal(t, int64(77), userID)
				assert.Equal(t, "deploy", req.Name)
				return services.CreateTokenResult{
					TokenSummary: services.TokenSummary{
						ID:             8,
						Name:           req.Name,
						TokenLastEight: "12345678",
						Scopes:         []string{"write:user"},
					},
					Token: "smithers_0123456789abcdef0123456789abcdef01234567",
				}, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/api/user/tokens", strings.NewReader(`{"name":"deploy","scopes":["write:user"]}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
		User: &db.User{ID: 77, Username: "bob", LowerUsername: "bob"},
	}))
	rec := httptest.NewRecorder()
	handler.PostUserToken(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
	var payload services.CreateTokenResult
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	assert.Equal(t, int64(8), payload.ID)
	assert.True(t, strings.HasPrefix(payload.Token, "smithers_"))
}

func TestUserHandler_DeleteToken(t *testing.T) {
	t.Parallel()

	handler := UserHandler{
		TokenService: mockUserTokenService{
			deleteTokenFn: func(ctx context.Context, userID, tokenID int64) error {
				assert.Equal(t, int64(99), userID)
				assert.Equal(t, int64(55), tokenID)
				return nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/user/tokens/55", nil)
	req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
		User: &db.User{ID: 99, Username: "carol", LowerUsername: "carol"},
	}))
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("id", "55")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))

	rec := httptest.NewRecorder()
	handler.DeleteUserToken(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
}

func TestUserHandler_UnauthorizedWhenMissingAuthContext(t *testing.T) {
	t.Parallel()

	handler := UserHandler{
		TokenService: mockUserTokenService{
			listTokensFn: func(ctx context.Context, userID int64) ([]services.TokenSummary, error) {
				t.Fatal("service should not be called")
				return nil, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/user/tokens", nil)
	rec := httptest.NewRecorder()
	handler.GetUserTokens(rec, req)

	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestUserHandler_PropagatesServiceErrors(t *testing.T) {
	t.Parallel()

	handler := UserHandler{
		TokenService: mockUserTokenService{
			deleteTokenFn: func(ctx context.Context, userID, tokenID int64) error {
				return errors.NotFound("token not found")
			},
		},
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/user/tokens/99", nil)
	req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
		User: &db.User{ID: 1, Username: "dave", LowerUsername: "dave"},
	}))
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("id", "99")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))

	rec := httptest.NewRecorder()
	handler.DeleteUserToken(rec, req)

	require.Equal(t, http.StatusNotFound, rec.Code)
}

func TestUserHandler_DeleteToken_InvalidID(t *testing.T) {
	t.Parallel()

	handler := UserHandler{
		TokenService: mockUserTokenService{
			deleteTokenFn: func(ctx context.Context, userID, tokenID int64) error {
				t.Fatal("service should not be called for invalid ID")
				return nil
			},
		},
	}

	tests := []struct {
		name    string
		tokenID string
	}{
		{"non-numeric id", "abc"},
		{"zero id", "0"},
		{"negative id", "-1"},
		{"empty id", ""},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodDelete, "/api/user/tokens/"+tc.tokenID, nil)
			req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
				User: &db.User{ID: 1, Username: "eve", LowerUsername: "eve"},
			}))
			routeCtx := chi.NewRouteContext()
			routeCtx.URLParams.Add("id", tc.tokenID)
			req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))

			rec := httptest.NewRecorder()
			handler.DeleteUserToken(rec, req)

			require.Equal(t, http.StatusBadRequest, rec.Code)
		})
	}
}

func TestUserHandler_CreateToken_InvalidJSON(t *testing.T) {
	t.Parallel()

	handler := UserHandler{
		TokenService: mockUserTokenService{
			createTokenFn: func(ctx context.Context, userID int64, req services.CreateTokenRequest) (services.CreateTokenResult, error) {
				t.Fatal("service should not be called for invalid JSON")
				return services.CreateTokenResult{}, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/api/user/tokens", strings.NewReader("not json"))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
		User: &db.User{ID: 1, Username: "frank", LowerUsername: "frank"},
	}))
	rec := httptest.NewRecorder()
	handler.PostUserToken(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
	var payload map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	assert.Equal(t, "invalid request body", payload["message"])
}

func TestUserHandler_CreateToken_Unauthenticated(t *testing.T) {
	t.Parallel()

	handler := UserHandler{
		TokenService: mockUserTokenService{
			createTokenFn: func(ctx context.Context, userID int64, req services.CreateTokenRequest) (services.CreateTokenResult, error) {
				t.Fatal("service should not be called")
				return services.CreateTokenResult{}, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/api/user/tokens", strings.NewReader(`{"name":"test","scopes":["read:repository"]}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.PostUserToken(rec, req)

	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestUserHandler_CreateToken_PropagatesServiceErrors(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		serviceErr error
		wantStatus int
	}{
		{
			name: "validation failed",
			serviceErr: errors.ValidationFailed(errors.FieldError{
				Resource: "AccessToken",
				Field:    "scopes[0]",
				Code:     "invalid",
			}),
			wantStatus: http.StatusUnprocessableEntity,
		},
		{
			name:       "forbidden",
			serviceErr: errors.Forbidden("insufficient privileges for requested token scopes"),
			wantStatus: http.StatusForbidden,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			handler := UserHandler{
				TokenService: mockUserTokenService{
					createTokenFn: func(ctx context.Context, userID int64, req services.CreateTokenRequest) (services.CreateTokenResult, error) {
						return services.CreateTokenResult{}, tc.serviceErr
					},
				},
			}

			req := httptest.NewRequest(http.MethodPost, "/api/user/tokens", strings.NewReader(`{"name":"deploy","scopes":["admin"]}`))
			req.Header.Set("Content-Type", "application/json")
			req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
				User: &db.User{ID: 1, Username: "alice", LowerUsername: "alice"},
			}))

			rec := httptest.NewRecorder()
			handler.PostUserToken(rec, req)
			require.Equal(t, tc.wantStatus, rec.Code)
		})
	}
}

func TestUserHandler_DeleteToken_Unauthenticated(t *testing.T) {
	t.Parallel()

	handler := UserHandler{
		TokenService: mockUserTokenService{
			deleteTokenFn: func(ctx context.Context, userID, tokenID int64) error {
				t.Fatal("service should not be called")
				return nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/user/tokens/55", nil)
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("id", "55")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))

	rec := httptest.NewRecorder()
	handler.DeleteUserToken(rec, req)

	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestUserHandler_GetAuthenticatedUser(t *testing.T) {
	t.Parallel()

	t.Run("unauthenticated", func(t *testing.T) {
		handler := UserHandler{
			ProfileService: mockUserProfileService{
				getAuthenticatedUserFn: func(ctx context.Context, userID int64) (services.UserProfile, error) {
					t.Fatal("service should not be called")
					return services.UserProfile{}, nil
				},
			},
		}

		req := httptest.NewRequest(http.MethodGet, "/api/user", nil)
		rec := httptest.NewRecorder()
		handler.GetAuthenticatedUser(rec, req)

		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("success", func(t *testing.T) {
		handler := UserHandler{
			ProfileService: mockUserProfileService{
				getAuthenticatedUserFn: func(ctx context.Context, userID int64) (services.UserProfile, error) {
					assert.Equal(t, int64(7), userID)
					return services.UserProfile{ID: 7, Username: "alice"}, nil
				},
			},
		}

		req := httptest.NewRequest(http.MethodGet, "/api/user", nil)
		req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
			User: &db.User{ID: 7, Username: "alice", LowerUsername: "alice"},
		}))
		rec := httptest.NewRecorder()
		handler.GetAuthenticatedUser(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		var body map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		assert.Equal(t, "alice", body["username"])
	})

	t.Run("not found", func(t *testing.T) {
		handler := UserHandler{
			ProfileService: mockUserProfileService{
				getAuthenticatedUserFn: func(ctx context.Context, userID int64) (services.UserProfile, error) {
					return services.UserProfile{}, errors.NotFound("user not found")
				},
			},
		}

		req := httptest.NewRequest(http.MethodGet, "/api/user", nil)
		req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
			User: &db.User{ID: 9, Username: "ghost", LowerUsername: "ghost"},
		}))
		rec := httptest.NewRecorder()
		handler.GetAuthenticatedUser(rec, req)

		require.Equal(t, http.StatusNotFound, rec.Code)
	})
}

func TestUserHandler_GetAuthenticatedUser_TokenMetadata(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name       string
		authInfo   middleware.AuthInfo
		wantScopes string
		wantSource string
		// wantKind and wantVia are the stored credential kind and via that
		// smthrs auth status reports (#3537).
		wantKind string
		wantVia  string
	}{
		{
			name: "personal access token with normalized scopes",
			authInfo: middleware.AuthInfo{
				IsTokenAuth: true,
				TokenSource: middleware.TokenSourcePersonalAccessToken,
				Scopes:      middleware.ParseTokenScopes(" WRITE:ADMIN, read:USER,read:user "),
			},
			wantScopes: `["read:admin","read:user","write:admin"]`,
			wantSource: "personal_access_token",
			wantKind:   "person",
		},
		{
			name: "legacy scopes preserved exactly as held",
			authInfo: middleware.AuthInfo{
				IsTokenAuth: true,
				TokenSource: middleware.TokenSourcePersonalAccessToken,
				Scopes: middleware.ScopeSet{
					middleware.ScopeAll: {}, middleware.ScopeAdmin: {},
				},
			},
			wantScopes: `["admin","all"]`,
			wantSource: "personal_access_token",
			wantKind:   "person",
		},
		{
			name: "oauth2 access token",
			authInfo: middleware.AuthInfo{
				IsTokenAuth: true,
				TokenSource: middleware.TokenSourceOAuth2AccessToken,
				Scopes:      middleware.ParseTokenScopes("read:user"),
			},
			wantScopes: `["read:user"]`,
			wantSource: "oauth2_access_token",
			wantKind:   "person",
		},
		{
			name: "terminal's delegated credential",
			authInfo: middleware.AuthInfo{
				IsTokenAuth:       true,
				TokenSystemIssued: true,
				TokenSource:       middleware.TokenSourcePersonalAccessToken,
				RawScopes:         "read:user,repo:7,via:terminal,branch:b,profile:terminal_s1,terminal-session:s",
				Scopes:            middleware.ParseTokenScopes("read:user,repo:7,via:terminal,branch:b,profile:terminal_s1,terminal-session:s"),
			},
			wantScopes: `["read:user"]`,
			wantSource: "personal_access_token",
			wantKind:   "delegated",
			wantVia:    "terminal",
		},
		{
			name: "token without scopes",
			authInfo: middleware.AuthInfo{
				IsTokenAuth: true,
				TokenSource: middleware.TokenSourcePersonalAccessToken,
			},
			wantScopes: `[]`,
			wantSource: "personal_access_token",
			wantKind:   "person",
		},
		{
			name: "session omits token metadata",
			authInfo: middleware.AuthInfo{
				Scopes: middleware.ParseTokenScopes("all"),
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			profile := services.UserProfile{ID: 7, Username: "alice", Email: "alice@example.com", IsAdmin: true}
			handler := UserHandler{
				ProfileService: mockUserProfileService{
					getAuthenticatedUserFn: func(ctx context.Context, userID int64) (services.UserProfile, error) {
						assert.Equal(t, profile.ID, userID)
						return profile, nil
					},
				},
			}
			tc.authInfo.User = &db.User{ID: profile.ID, Username: profile.Username}
			req := httptest.NewRequest(http.MethodGet, "/api/user", nil)
			req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &tc.authInfo))
			rec := httptest.NewRecorder()
			handler.GetAuthenticatedUser(rec, req)

			require.Equal(t, http.StatusOK, rec.Code)
			var body map[string]json.RawMessage
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
			if tc.authInfo.IsTokenAuth {
				assert.JSONEq(t, tc.wantScopes, string(body["token_scopes"]))
				assert.JSONEq(t, `"`+tc.wantSource+`"`, string(body["token_source"]))
				assert.JSONEq(t, `"`+tc.wantKind+`"`, string(body["credential_kind"]))
				if tc.wantVia == "" {
					assert.NotContains(t, body, "via")
				} else {
					assert.JSONEq(t, `"`+tc.wantVia+`"`, string(body["via"]))
				}
			} else {
				assert.NotContains(t, body, "token_scopes")
				assert.NotContains(t, body, "token_source")
				assert.NotContains(t, body, "credential_kind")
			}
			delete(body, "token_scopes")
			delete(body, "token_source")
			delete(body, "credential_kind")
			delete(body, "via")
			gotProfile, err := json.Marshal(body)
			require.NoError(t, err)
			wantProfile, err := json.Marshal(profile)
			require.NoError(t, err)
			assert.JSONEq(t, string(wantProfile), string(gotProfile), "profile fields stay flat and unchanged")
		})
	}
}

func TestUserHandler_GetUserByUsername(t *testing.T) {
	t.Parallel()

	t.Run("success returns public profile without sensitive keys", func(t *testing.T) {
		now := time.Now().UTC().Truncate(time.Second)
		handler := UserHandler{
			ProfileService: mockUserProfileService{
				getUserByUsernameFn: func(ctx context.Context, username string) (services.PublicUserProfile, error) {
					assert.Equal(t, "alice", username)
					return services.PublicUserProfile{
						ID:          1,
						Username:    "alice",
						DisplayName: "Alice",
						Bio:         "Engineer",
						AvatarURL:   "https://example.com/avatar.png",
						CreatedAt:   now,
						UpdatedAt:   now,
					}, nil
				},
			},
		}

		req := httptest.NewRequest(http.MethodGet, "/api/users/alice", nil)
		routeCtx := chi.NewRouteContext()
		routeCtx.URLParams.Add("username", "alice")
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))

		rec := httptest.NewRecorder()
		handler.GetUserByUsername(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)

		var body map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))

		// Assert expected public keys are present
		assert.Equal(t, "alice", body["username"])
		assert.Equal(t, "Alice", body["display_name"])
		assert.Equal(t, "Engineer", body["bio"])
		assert.Equal(t, "https://example.com/avatar.png", body["avatar_url"])
		assert.NotNil(t, body["id"])
		assert.NotNil(t, body["created_at"])
		assert.NotNil(t, body["updated_at"])

		// Assert sensitive keys are NOT present in the response
		sensitiveKeys := []string{"email", "lower_username", "lower_email", "is_admin", "wallet_address", "is_synthetic", "user_type"}
		for _, key := range sensitiveKeys {
			_, exists := body[key]
			assert.False(t, exists, "public profile response must not contain key %q", key)
		}
	})

	t.Run("unknown user", func(t *testing.T) {
		handler := UserHandler{
			ProfileService: mockUserProfileService{
				getUserByUsernameFn: func(ctx context.Context, username string) (services.PublicUserProfile, error) {
					return services.PublicUserProfile{}, errors.NotFound("user not found")
				},
			},
		}

		req := httptest.NewRequest(http.MethodGet, "/api/users/missing", nil)
		routeCtx := chi.NewRouteContext()
		routeCtx.URLParams.Add("username", "missing")
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))

		rec := httptest.NewRecorder()
		handler.GetUserByUsername(rec, req)

		require.Equal(t, http.StatusNotFound, rec.Code)
	})
}

func TestUserHandler_PatchAuthenticatedUser(t *testing.T) {
	t.Parallel()

	t.Run("invalid json", func(t *testing.T) {
		handler := UserHandler{
			ProfileService: mockUserProfileService{
				updateAuthenticatedUserFn: func(ctx context.Context, userID int64, req services.UpdateUserRequest) (services.UserProfile, error) {
					t.Fatal("service should not be called")
					return services.UserProfile{}, nil
				},
			},
		}

		req := httptest.NewRequest(http.MethodPatch, "/api/user", strings.NewReader("{invalid"))
		req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
			User: &db.User{ID: 5, Username: "alice", LowerUsername: "alice"},
		}))
		rec := httptest.NewRecorder()
		handler.PatchAuthenticatedUser(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("validation failure", func(t *testing.T) {
		handler := UserHandler{
			ProfileService: mockUserProfileService{
				updateAuthenticatedUserFn: func(ctx context.Context, userID int64, req services.UpdateUserRequest) (services.UserProfile, error) {
					return services.UserProfile{}, errors.ValidationFailed(errors.FieldError{
						Resource: "User",
						Field:    "email",
						Code:     "invalid",
					})
				},
			},
		}

		req := httptest.NewRequest(http.MethodPatch, "/api/user", strings.NewReader(`{"email":"not-an-email"}`))
		req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
			User: &db.User{ID: 5, Username: "alice", LowerUsername: "alice"},
		}))
		rec := httptest.NewRecorder()
		handler.PatchAuthenticatedUser(rec, req)

		require.Equal(t, http.StatusUnprocessableEntity, rec.Code)
	})

	t.Run("success", func(t *testing.T) {
		handler := UserHandler{
			ProfileService: mockUserProfileService{
				updateAuthenticatedUserFn: func(ctx context.Context, userID int64, req services.UpdateUserRequest) (services.UserProfile, error) {
					assert.Equal(t, int64(5), userID)
					require.NotNil(t, req.DisplayName)
					assert.Equal(t, "Alice Updated", *req.DisplayName)
					return services.UserProfile{ID: 5, Username: "alice", DisplayName: "Alice Updated"}, nil
				},
			},
		}

		req := httptest.NewRequest(http.MethodPatch, "/api/user", strings.NewReader(`{"display_name":"Alice Updated"}`))
		req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
			User: &db.User{ID: 5, Username: "alice", LowerUsername: "alice"},
		}))
		rec := httptest.NewRecorder()
		handler.PatchAuthenticatedUser(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		var body map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		assert.Equal(t, "Alice Updated", body["display_name"])
	})

	t.Run("unauthenticated", func(t *testing.T) {
		handler := UserHandler{
			ProfileService: mockUserProfileService{
				updateAuthenticatedUserFn: func(ctx context.Context, userID int64, req services.UpdateUserRequest) (services.UserProfile, error) {
					t.Fatal("service should not be called")
					return services.UserProfile{}, nil
				},
			},
		}

		req := httptest.NewRequest(http.MethodPatch, "/api/user", strings.NewReader(`{"display_name":"x"}`))
		rec := httptest.NewRecorder()
		handler.PatchAuthenticatedUser(rec, req)
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})
}

func TestUserHandler_GetAuthenticatedUserRepos(t *testing.T) {
	t.Parallel()

	t.Run("default pagination", func(t *testing.T) {
		handler := UserHandler{
			ProfileService: mockUserProfileService{
				listAuthenticatedUserReposFn: func(ctx context.Context, userID int64, page, perPage int) (services.RepoListResult, error) {
					assert.Equal(t, int64(5), userID)
					assert.Equal(t, 1, page)
					assert.Equal(t, 30, perPage)
					return services.RepoListResult{
						Items:      []services.RepoSummary{{ID: 1, Name: "repo"}},
						TotalCount: 31,
						Page:       1,
						PerPage:    30,
					}, nil
				},
			},
		}

		req := httptest.NewRequest(http.MethodGet, "/api/user/repos", nil)
		req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
			User: &db.User{ID: 5, Username: "alice", LowerUsername: "alice"},
		}))
		rec := httptest.NewRecorder()
		handler.GetAuthenticatedUserRepos(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "31", rec.Header().Get("X-Total-Count"))
		assert.Contains(t, rec.Header().Get("Link"), `rel="next"`)
		assert.Contains(t, rec.Header().Get("Link"), `rel="last"`)
	})

	t.Run("explicit pagination", func(t *testing.T) {
		handler := UserHandler{
			ProfileService: mockUserProfileService{
				listAuthenticatedUserReposFn: func(ctx context.Context, userID int64, page, perPage int) (services.RepoListResult, error) {
					assert.Equal(t, 2, page)
					assert.Equal(t, 5, perPage)
					return services.RepoListResult{
						Items:      []services.RepoSummary{{ID: 1, Name: "repo"}},
						TotalCount: 12,
						Page:       2,
						PerPage:    5,
					}, nil
				},
			},
		}

		req := httptest.NewRequest(http.MethodGet, "/api/user/repos?page=2&per_page=5", nil)
		req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
			User: &db.User{ID: 5, Username: "alice", LowerUsername: "alice"},
		}))
		rec := httptest.NewRecorder()
		handler.GetAuthenticatedUserRepos(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "12", rec.Header().Get("X-Total-Count"))
		assert.Contains(t, rec.Header().Get("Link"), `page=3`)
	})

	t.Run("includes owner type and default bookmark head", func(t *testing.T) {
		handler := UserHandler{
			ProfileService: mockUserProfileService{
				listAuthenticatedUserReposFn: func(context.Context, int64, int, int) (services.RepoListResult, error) {
					return services.RepoListResult{Items: []services.RepoSummary{{
						ID:              1,
						Owner:           "alice",
						OwnerType:       "user",
						Name:            "repo",
						FullName:        "alice/repo",
						DefaultBookmark: "main",
						DefaultBookmarkHead: services.DefaultBookmarkHead{
							ChangeID: "change-main",
							CommitID: "commit-main",
						},
					}}}, nil
				},
			},
		}

		req := httptest.NewRequest(http.MethodGet, "/api/user/repos", nil)
		req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
			User: &db.User{ID: 5, Username: "alice", LowerUsername: "alice"},
		}))
		rec := httptest.NewRecorder()
		handler.GetAuthenticatedUserRepos(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		var payload []map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
		require.Len(t, payload, 1)
		assert.Equal(t, "user", payload[0]["owner_type"])
		assert.Equal(t, map[string]any{
			"change_id": "change-main",
			"commit_id": "commit-main",
		}, payload[0]["default_bookmark_head"])
	})

	t.Run("invalid page", func(t *testing.T) {
		handler := UserHandler{
			ProfileService: mockUserProfileService{
				listAuthenticatedUserReposFn: func(ctx context.Context, userID int64, page, perPage int) (services.RepoListResult, error) {
					t.Fatal("service should not be called")
					return services.RepoListResult{}, nil
				},
			},
		}

		req := httptest.NewRequest(http.MethodGet, "/api/user/repos?page=abc", nil)
		req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
			User: &db.User{ID: 5, Username: "alice", LowerUsername: "alice"},
		}))
		rec := httptest.NewRecorder()
		handler.GetAuthenticatedUserRepos(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})
}

func TestUserHandler_GetAuthenticatedUserOrgs(t *testing.T) {
	t.Parallel()

	t.Run("default pagination", func(t *testing.T) {
		handler := UserHandler{
			ProfileService: mockUserProfileService{
				listAuthenticatedUserOrgsFn: func(ctx context.Context, userID int64, page, perPage int) (services.OrgListResult, error) {
					assert.Equal(t, 1, page)
					assert.Equal(t, 30, perPage)
					return services.OrgListResult{
						Items:      []services.OrgSummary{{ID: 2, Name: "acme"}},
						TotalCount: 31,
						Page:       1,
						PerPage:    30,
					}, nil
				},
			},
		}

		req := httptest.NewRequest(http.MethodGet, "/api/user/orgs", nil)
		req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
			User: &db.User{ID: 5, Username: "alice", LowerUsername: "alice"},
		}))
		rec := httptest.NewRecorder()
		handler.GetAuthenticatedUserOrgs(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "31", rec.Header().Get("X-Total-Count"))
		assert.Contains(t, rec.Header().Get("Link"), `rel="next"`)
		assert.Contains(t, rec.Header().Get("Link"), `rel="last"`)
	})

	t.Run("explicit pagination", func(t *testing.T) {
		handler := UserHandler{
			ProfileService: mockUserProfileService{
				listAuthenticatedUserOrgsFn: func(ctx context.Context, userID int64, page, perPage int) (services.OrgListResult, error) {
					assert.Equal(t, 2, page)
					assert.Equal(t, 1, perPage)
					return services.OrgListResult{
						Items:      []services.OrgSummary{{ID: 3, Name: "beta"}},
						TotalCount: 3,
						Page:       2,
						PerPage:    1,
					}, nil
				},
			},
		}

		req := httptest.NewRequest(http.MethodGet, "/api/user/orgs?page=2&per_page=1", nil)
		req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
			User: &db.User{ID: 5, Username: "alice", LowerUsername: "alice"},
		}))
		rec := httptest.NewRecorder()
		handler.GetAuthenticatedUserOrgs(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "3", rec.Header().Get("X-Total-Count"))
		assert.Contains(t, rec.Header().Get("Link"), `page=3`)
		assert.Contains(t, rec.Header().Get("Link"), `rel="next"`)
	})
}

func TestUserHandler_GetUserReposByUsername_DefaultPagination(t *testing.T) {
	t.Parallel()

	handler := UserHandler{
		ProfileService: mockUserProfileService{
			listUserReposByUsernameFn: func(ctx context.Context, username string, page, perPage int) (services.RepoListResult, error) {
				assert.Equal(t, "alice", username)
				assert.Equal(t, 1, page)
				assert.Equal(t, 30, perPage)
				return services.RepoListResult{
					Items:      []services.RepoSummary{{ID: 1, Name: "repo"}},
					TotalCount: 31,
					Page:       1,
					PerPage:    30,
				}, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/users/alice/repos", nil)
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("username", "alice")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))

	rec := httptest.NewRecorder()
	handler.GetUserReposByUsername(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "31", rec.Header().Get("X-Total-Count"))
	assert.Contains(t, rec.Header().Get("Link"), `rel="next"`)
	assert.Contains(t, rec.Header().Get("Link"), `rel="last"`)

	var payload []services.RepoSummary
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	require.Len(t, payload, 1)
	assert.Equal(t, int64(1), payload[0].ID)
}

func TestUserHandler_GetUserReposByUsername_ExplicitPagination(t *testing.T) {
	t.Parallel()

	handler := UserHandler{
		ProfileService: mockUserProfileService{
			listUserReposByUsernameFn: func(ctx context.Context, username string, page, perPage int) (services.RepoListResult, error) {
				assert.Equal(t, 2, page)
				assert.Equal(t, 5, perPage)
				return services.RepoListResult{
					Items:      []services.RepoSummary{{ID: 1, Name: "repo"}},
					TotalCount: 12,
					Page:       2,
					PerPage:    5,
				}, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/users/alice/repos?page=2&per_page=5", nil)
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("username", "alice")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))

	rec := httptest.NewRecorder()
	handler.GetUserReposByUsername(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "12", rec.Header().Get("X-Total-Count"))
	assert.Contains(t, rec.Header().Get("Link"), `page=3`)
}

func TestUserHandler_GetUserReposByUsername_PerPageCappedAt100(t *testing.T) {
	t.Parallel()

	handler := UserHandler{
		ProfileService: mockUserProfileService{
			listUserReposByUsernameFn: func(ctx context.Context, username string, page, perPage int) (services.RepoListResult, error) {
				// The route handler caps per_page before forwarding to service
				assert.Equal(t, 1, page)
				assert.Equal(t, 100, perPage)
				return services.RepoListResult{
					Items:      nil,
					TotalCount: 0,
					Page:       1,
					PerPage:    100,
				}, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/users/alice/repos?per_page=999", nil)
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("username", "alice")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))

	rec := httptest.NewRecorder()
	handler.GetUserReposByUsername(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
}

func TestUserHandler_GetUserReposByUsername_InvalidPagination(t *testing.T) {
	t.Parallel()

	handler := UserHandler{
		ProfileService: mockUserProfileService{
			listUserReposByUsernameFn: func(ctx context.Context, username string, page, perPage int) (services.RepoListResult, error) {
				t.Fatal("service should not be called for invalid pagination")
				return services.RepoListResult{}, nil
			},
		},
	}

	tests := []struct {
		name  string
		query string
	}{
		{"invalid page", "?page=abc"},
		{"zero page", "?page=0"},
		{"negative page", "?page=-1"},
		{"invalid per_page", "?per_page=abc"},
		{"zero per_page", "?per_page=0"},
		{"negative per_page", "?per_page=-1"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/users/alice/repos"+tc.query, nil)
			routeCtx := chi.NewRouteContext()
			routeCtx.URLParams.Add("username", "alice")
			req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))

			rec := httptest.NewRecorder()
			handler.GetUserReposByUsername(rec, req)

			require.Equal(t, http.StatusBadRequest, rec.Code)
		})
	}
}

func TestUserHandler_GetUserReposByUsername_ServiceError(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		err        error
		wantStatus int
	}{
		{"user not found", errors.NotFound("user not found"), http.StatusNotFound},
		{"internal error", errors.Internal("db failure"), http.StatusInternalServerError},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			handler := UserHandler{
				ProfileService: mockUserProfileService{
					listUserReposByUsernameFn: func(ctx context.Context, username string, page, perPage int) (services.RepoListResult, error) {
						return services.RepoListResult{}, tc.err
					},
				},
			}

			req := httptest.NewRequest(http.MethodGet, "/api/users/alice/repos", nil)
			routeCtx := chi.NewRouteContext()
			routeCtx.URLParams.Add("username", "alice")
			req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))

			rec := httptest.NewRecorder()
			handler.GetUserReposByUsername(rec, req)

			require.Equal(t, tc.wantStatus, rec.Code)
		})
	}
}
