package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	apierrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// userFProfileOK returns a fully-populated profile mock whose every method
// succeeds. The mockUserProfileService methods invoke their Fn fields without
// nil guards, so a success suite must set them all.
func userFProfileOK() mockUserProfileService {
	return mockUserProfileService{
		getAuthenticatedUserFn: func(context.Context, int64) (services.UserProfile, error) {
			return services.UserProfile{}, nil
		},
		getUserByUsernameFn: func(context.Context, string) (services.PublicUserProfile, error) {
			return services.PublicUserProfile{}, nil
		},
		updateAuthenticatedUserFn: func(context.Context, int64, services.UpdateUserRequest) (services.UserProfile, error) {
			return services.UserProfile{}, nil
		},
		listAuthenticatedUserReposFn: func(context.Context, int64, int, int) (services.RepoListResult, error) {
			return services.RepoListResult{TotalCount: 0}, nil
		},
		listAuthenticatedUserOrgsFn: func(context.Context, int64, int, int) (services.OrgListResult, error) {
			return services.OrgListResult{TotalCount: 0}, nil
		},
		listAuthenticatedUserStarredFn: func(context.Context, int64, int, int) (services.RepoListResult, error) {
			return services.RepoListResult{TotalCount: 0}, nil
		},
		listUserReposByUsernameFn: func(context.Context, string, int, int) (services.RepoListResult, error) {
			return services.RepoListResult{TotalCount: 0}, nil
		},
		getNotificationPreferencesFn: func(context.Context, int64) (services.NotificationPreferences, error) {
			return services.NotificationPreferences{}, nil
		},
		updateNotificationPreferencesFn: func(context.Context, int64, services.UpdateNotificationPreferencesRequest) (services.NotificationPreferences, error) {
			return services.NotificationPreferences{}, nil
		},
		listConnectedAccountsFn: func(context.Context, int64) ([]services.ConnectedAccountResponse, error) {
			return nil, nil
		},
		deleteConnectedAccountFn: func(context.Context, int64, int64) error { return nil },
		listUserActivityByUsernameFn: func(context.Context, string, int, int) (services.ActivityListResult, error) {
			return services.ActivityListResult{TotalCount: 0}, nil
		},
		listUserStarredReposByUsernameFn: func(context.Context, string, int, int) (services.RepoListResult, error) {
			return services.RepoListResult{TotalCount: 0}, nil
		},
		listReadableReposFn: func(context.Context, int64, int, int) (services.ReadableRepoListResult, error) {
			return services.ReadableRepoListResult{TotalCount: 0}, nil
		},
	}
}

// userFProfileError returns a fully-populated profile mock whose every method
// fails with NotFound.
func userFProfileError() mockUserProfileService {
	err := apierrors.NotFound("missing")
	return mockUserProfileService{
		getAuthenticatedUserFn: func(context.Context, int64) (services.UserProfile, error) {
			return services.UserProfile{}, err
		},
		getUserByUsernameFn: func(context.Context, string) (services.PublicUserProfile, error) {
			return services.PublicUserProfile{}, err
		},
		updateAuthenticatedUserFn: func(context.Context, int64, services.UpdateUserRequest) (services.UserProfile, error) {
			return services.UserProfile{}, err
		},
		listAuthenticatedUserReposFn: func(context.Context, int64, int, int) (services.RepoListResult, error) {
			return services.RepoListResult{}, err
		},
		listAuthenticatedUserOrgsFn: func(context.Context, int64, int, int) (services.OrgListResult, error) {
			return services.OrgListResult{}, err
		},
		listAuthenticatedUserStarredFn: func(context.Context, int64, int, int) (services.RepoListResult, error) {
			return services.RepoListResult{}, err
		},
		listUserReposByUsernameFn: func(context.Context, string, int, int) (services.RepoListResult, error) {
			return services.RepoListResult{}, err
		},
		getNotificationPreferencesFn: func(context.Context, int64) (services.NotificationPreferences, error) {
			return services.NotificationPreferences{}, err
		},
		updateNotificationPreferencesFn: func(context.Context, int64, services.UpdateNotificationPreferencesRequest) (services.NotificationPreferences, error) {
			return services.NotificationPreferences{}, err
		},
		listConnectedAccountsFn: func(context.Context, int64) ([]services.ConnectedAccountResponse, error) {
			return nil, err
		},
		deleteConnectedAccountFn: func(context.Context, int64, int64) error { return err },
		listUserActivityByUsernameFn: func(context.Context, string, int, int) (services.ActivityListResult, error) {
			return services.ActivityListResult{}, err
		},
		listUserStarredReposByUsernameFn: func(context.Context, string, int, int) (services.RepoListResult, error) {
			return services.RepoListResult{}, err
		},
		listReadableReposFn: func(context.Context, int64, int, int) (services.ReadableRepoListResult, error) {
			return services.ReadableRepoListResult{}, err
		},
	}
}

func userFHandlerOK() *UserHandler {
	return &UserHandler{
		TokenService: mockUserTokenService{
			listTokensFn: func(context.Context, int64) ([]services.TokenSummary, error) { return nil, nil },
			createTokenFn: func(context.Context, int64, services.CreateTokenRequest) (services.CreateTokenResult, error) {
				return services.CreateTokenResult{TokenSummary: services.TokenSummary{ID: 5, Name: "t"}, Token: "smithers_x"}, nil
			},
			deleteTokenFn: func(context.Context, int64, int64) error { return nil },
		},
		ProfileService: userFProfileOK(),
		SessionService: mockUserSessionService{
			listUserSessionsFn: func(context.Context, int64) ([]db.AuthSession, error) {
				return []db.AuthSession{{SessionKey: "abc"}}, nil
			},
			revokeSessionFn: func(context.Context, int64, string) error { return nil },
		},
		EmailService: mockUserEmailService{
			listEmailsFn: func(context.Context, int64) ([]services.EmailResponse, error) { return nil, nil },
			addEmailFn: func(context.Context, int64, services.AddEmailRequest) (services.EmailResponse, error) {
				return services.EmailResponse{}, nil
			},
			deleteEmailFn:         func(context.Context, int64, int64) error { return nil },
			requestVerificationFn: func(context.Context, int64, int64) error { return nil },
			verifyEmailFn: func(context.Context, string) (services.VerifyEmailResult, error) {
				return services.VerifyEmailResult{UserID: 10, Email: "a@b.test"}, nil
			},
		},
	}
}

func TestUser_F_SuccessPaths(t *testing.T) {
	userParam := map[string]string{"username": "octo"}
	idParam := map[string]string{"id": "7"}

	tests := []struct {
		name       string
		handler    func(*UserHandler, http.ResponseWriter, *http.Request)
		method     string
		target     string
		body       string
		params     map[string]string
		authed     bool
		wantStatus int
	}{
		{"get tokens", (*UserHandler).GetUserTokens, http.MethodGet, "/x", "", nil, true, http.StatusOK},
		{"post token", (*UserHandler).PostUserToken, http.MethodPost, "/x", `{"name":"t","scopes":["read:user"]}`, nil, true, http.StatusCreated},
		{"delete token", (*UserHandler).DeleteUserToken, http.MethodDelete, "/x", "", idParam, true, http.StatusNoContent},
		{"get sessions", (*UserHandler).GetUserSessions, http.MethodGet, "/x", "", nil, true, http.StatusOK},
		{"delete session", (*UserHandler).DeleteUserSession, http.MethodDelete, "/x", "", map[string]string{"id": "sess"}, true, http.StatusNoContent},
		{"get authenticated user", (*UserHandler).GetAuthenticatedUser, http.MethodGet, "/x", "", nil, true, http.StatusOK},
		{"get user by username", (*UserHandler).GetUserByUsername, http.MethodGet, "/x", "", userParam, false, http.StatusOK},
		{"get user repos by username", (*UserHandler).GetUserReposByUsername, http.MethodGet, "/x", "", userParam, false, http.StatusOK},
		{"get user activity", (*UserHandler).GetUserActivityByUsername, http.MethodGet, "/x", "", userParam, false, http.StatusOK},
		{"patch authenticated user", (*UserHandler).PatchAuthenticatedUser, http.MethodPatch, "/x", `{"bio":"hi"}`, nil, true, http.StatusOK},
		{"get authenticated repos", (*UserHandler).GetAuthenticatedUserRepos, http.MethodGet, "/x", "", nil, true, http.StatusOK},
		{"get readable repos", (*UserHandler).GetAuthenticatedUserReadableRepos, http.MethodGet, "/x", "", nil, true, http.StatusOK},
		{"get authenticated orgs", (*UserHandler).GetAuthenticatedUserOrgs, http.MethodGet, "/x", "", nil, true, http.StatusOK},
		{"get emails", (*UserHandler).GetUserEmails, http.MethodGet, "/x", "", nil, true, http.StatusOK},
		{"post email", (*UserHandler).PostUserEmail, http.MethodPost, "/x", `{"email":"a@b.test"}`, nil, true, http.StatusCreated},
		{"delete email", (*UserHandler).DeleteUserEmail, http.MethodDelete, "/x", "", idParam, true, http.StatusNoContent},
		{"post email verify", (*UserHandler).PostUserEmailVerify, http.MethodPost, "/x", "", idParam, true, http.StatusNoContent},
		{"get notification prefs", (*UserHandler).GetNotificationPreferences, http.MethodGet, "/x", "", nil, true, http.StatusOK},
		{"put notification prefs", (*UserHandler).PutNotificationPreferences, http.MethodPut, "/x", `{}`, nil, true, http.StatusOK},
		{"get connected accounts", (*UserHandler).GetConnectedAccounts, http.MethodGet, "/x", "", nil, true, http.StatusOK},
		{"delete connected account", (*UserHandler).DeleteConnectedAccount, http.MethodDelete, "/x", "", map[string]string{"id": "9"}, true, http.StatusNoContent},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := userFHandlerOK()
			req := userHRequest(tt.method, tt.target, tt.body, tt.params, tt.authed)
			rec := httptest.NewRecorder()

			tt.handler(h, rec, req)

			require.Equal(t, tt.wantStatus, rec.Code)
		})
	}
}

// TestUser_F_VerifyTokenSuccess covers the query-string verify endpoint and the
// AuditService branch for both verify handlers.
func TestUser_F_VerifyTokenSuccess(t *testing.T) {
	audit := &userHAuditQuerier{}
	h := userFHandlerOK()
	h.AuditService = services.NewAuditService(audit)

	getReq := userHRequest(http.MethodGet, "/x?token=abc", "", nil, false)
	getRec := httptest.NewRecorder()
	h.GetUserEmailVerifyToken(getRec, getReq)
	require.Equal(t, http.StatusOK, getRec.Code)

	postReq := userHRequest(http.MethodPost, "/x", `{"token":"abc"}`, nil, false)
	postRec := httptest.NewRecorder()
	h.PostUserEmailVerifyToken(postRec, postReq)
	require.Equal(t, http.StatusNoContent, postRec.Code)

	require.Equal(t, 2, audit.calls)
}

func TestUser_F_TokenScopeDeEscalation(t *testing.T) {
	h := &UserHandler{TokenService: mockUserTokenService{
		createTokenFn: func(context.Context, int64, services.CreateTokenRequest) (services.CreateTokenResult, error) {
			t.Fatal("service should not be called when scope is disallowed")
			return services.CreateTokenResult{}, nil
		},
	}}
	req := httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(`{"name":"t","scopes":["write:user"]}`))
	req.Header.Set("Content-Type", "application/json")
	// Token-authed with only read:user, requesting write:user -> forbidden.
	req = withTokenAuth(req, 10, "alice", middleware.ScopeReadUser)
	rec := httptest.NewRecorder()
	h.PostUserToken(rec, req)
	require.Equal(t, http.StatusForbidden, rec.Code)
}

func TestUser_F_GuardAndErrorBranches(t *testing.T) {
	errProfile := userFProfileError()

	t.Run("get tokens no auth", func(t *testing.T) {
		h := &UserHandler{}
		rec := httptest.NewRecorder()
		h.GetUserTokens(rec, userHRequest(http.MethodGet, "/x", "", nil, false))
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("get tokens service error", func(t *testing.T) {
		h := &UserHandler{TokenService: mockUserTokenService{
			listTokensFn: func(context.Context, int64) ([]services.TokenSummary, error) {
				return nil, apierrors.NotFound("x")
			},
		}}
		rec := httptest.NewRecorder()
		h.GetUserTokens(rec, userHRequest(http.MethodGet, "/x", "", nil, true))
		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("post token no auth", func(t *testing.T) {
		h := &UserHandler{}
		rec := httptest.NewRecorder()
		h.PostUserToken(rec, userHRequest(http.MethodPost, "/x", `{}`, nil, false))
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("post token bad body", func(t *testing.T) {
		h := &UserHandler{}
		rec := httptest.NewRecorder()
		h.PostUserToken(rec, userHRequest(http.MethodPost, "/x", "{", nil, true))
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("post token service error", func(t *testing.T) {
		h := &UserHandler{TokenService: mockUserTokenService{
			createTokenFn: func(context.Context, int64, services.CreateTokenRequest) (services.CreateTokenResult, error) {
				return services.CreateTokenResult{}, apierrors.BadRequest("x")
			},
		}}
		rec := httptest.NewRecorder()
		h.PostUserToken(rec, userHRequest(http.MethodPost, "/x", `{"name":"t"}`, nil, true))
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("delete token no auth", func(t *testing.T) {
		h := &UserHandler{}
		rec := httptest.NewRecorder()
		h.DeleteUserToken(rec, userHRequest(http.MethodDelete, "/x", "", map[string]string{"id": "1"}, false))
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("delete token bad id", func(t *testing.T) {
		h := &UserHandler{}
		rec := httptest.NewRecorder()
		h.DeleteUserToken(rec, userHRequest(http.MethodDelete, "/x", "", map[string]string{"id": "0"}, true))
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("delete token service error", func(t *testing.T) {
		h := &UserHandler{TokenService: mockUserTokenService{
			deleteTokenFn: func(context.Context, int64, int64) error { return apierrors.NotFound("x") },
		}}
		rec := httptest.NewRecorder()
		h.DeleteUserToken(rec, userHRequest(http.MethodDelete, "/x", "", map[string]string{"id": "5"}, true))
		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("delete session no auth", func(t *testing.T) {
		h := &UserHandler{}
		rec := httptest.NewRecorder()
		h.DeleteUserSession(rec, userHRequest(http.MethodDelete, "/x", "", map[string]string{"id": "s"}, false))
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("delete session service error", func(t *testing.T) {
		h := &UserHandler{SessionService: mockUserSessionService{
			revokeSessionFn: func(context.Context, int64, string) error { return apierrors.NotFound("x") },
		}}
		rec := httptest.NewRecorder()
		h.DeleteUserSession(rec, userHRequest(http.MethodDelete, "/x", "", map[string]string{"id": "s"}, true))
		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("get authenticated user no auth", func(t *testing.T) {
		h := &UserHandler{}
		rec := httptest.NewRecorder()
		h.GetAuthenticatedUser(rec, userHRequest(http.MethodGet, "/x", "", nil, false))
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("get authenticated user service error", func(t *testing.T) {
		h := &UserHandler{ProfileService: errProfile}
		rec := httptest.NewRecorder()
		h.GetAuthenticatedUser(rec, userHRequest(http.MethodGet, "/x", "", nil, true))
		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("get user by username service error", func(t *testing.T) {
		h := &UserHandler{ProfileService: errProfile}
		rec := httptest.NewRecorder()
		h.GetUserByUsername(rec, userHRequest(http.MethodGet, "/x", "", map[string]string{"username": "octo"}, false))
		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("get user repos by username bad pagination", func(t *testing.T) {
		h := &UserHandler{ProfileService: errProfile}
		rec := httptest.NewRecorder()
		h.GetUserReposByUsername(rec, userHRequest(http.MethodGet, "/x?limit=bad", "", map[string]string{"username": "octo"}, false))
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("get user repos by username service error", func(t *testing.T) {
		h := &UserHandler{ProfileService: errProfile}
		rec := httptest.NewRecorder()
		h.GetUserReposByUsername(rec, userHRequest(http.MethodGet, "/x", "", map[string]string{"username": "octo"}, false))
		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("get user activity bad pagination", func(t *testing.T) {
		h := &UserHandler{ProfileService: errProfile}
		rec := httptest.NewRecorder()
		h.GetUserActivityByUsername(rec, userHRequest(http.MethodGet, "/x?limit=bad", "", map[string]string{"username": "octo"}, false))
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("patch authenticated user no auth", func(t *testing.T) {
		h := &UserHandler{}
		rec := httptest.NewRecorder()
		h.PatchAuthenticatedUser(rec, userHRequest(http.MethodPatch, "/x", `{}`, nil, false))
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("patch authenticated user bad body", func(t *testing.T) {
		h := &UserHandler{}
		rec := httptest.NewRecorder()
		h.PatchAuthenticatedUser(rec, userHRequest(http.MethodPatch, "/x", "{", nil, true))
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("patch authenticated user service error", func(t *testing.T) {
		h := &UserHandler{ProfileService: errProfile}
		rec := httptest.NewRecorder()
		h.PatchAuthenticatedUser(rec, userHRequest(http.MethodPatch, "/x", `{"bio":"x"}`, nil, true))
		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("authenticated repos bad pagination", func(t *testing.T) {
		h := &UserHandler{ProfileService: errProfile}
		rec := httptest.NewRecorder()
		h.GetAuthenticatedUserRepos(rec, userHRequest(http.MethodGet, "/x?limit=bad", "", nil, true))
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("readable repos no auth", func(t *testing.T) {
		h := &UserHandler{}
		rec := httptest.NewRecorder()
		h.GetAuthenticatedUserReadableRepos(rec, userHRequest(http.MethodGet, "/x", "", nil, false))
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("readable repos bad pagination", func(t *testing.T) {
		h := &UserHandler{ProfileService: errProfile}
		rec := httptest.NewRecorder()
		h.GetAuthenticatedUserReadableRepos(rec, userHRequest(http.MethodGet, "/x?limit=bad", "", nil, true))
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("notification prefs no auth", func(t *testing.T) {
		h := &UserHandler{}
		rec := httptest.NewRecorder()
		h.GetNotificationPreferences(rec, userHRequest(http.MethodGet, "/x", "", nil, false))
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("notification prefs service error", func(t *testing.T) {
		h := &UserHandler{ProfileService: errProfile}
		rec := httptest.NewRecorder()
		h.GetNotificationPreferences(rec, userHRequest(http.MethodGet, "/x", "", nil, true))
		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("put notification prefs bad body", func(t *testing.T) {
		h := &UserHandler{}
		rec := httptest.NewRecorder()
		h.PutNotificationPreferences(rec, userHRequest(http.MethodPut, "/x", "{", nil, true))
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("delete connected account bad id", func(t *testing.T) {
		h := &UserHandler{}
		rec := httptest.NewRecorder()
		h.DeleteConnectedAccount(rec, userHRequest(http.MethodDelete, "/x", "", map[string]string{"id": "0"}, true))
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("delete connected account service error", func(t *testing.T) {
		h := &UserHandler{ProfileService: errProfile}
		rec := httptest.NewRecorder()
		h.DeleteConnectedAccount(rec, userHRequest(http.MethodDelete, "/x", "", map[string]string{"id": "9"}, true))
		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("connected accounts service error", func(t *testing.T) {
		h := &UserHandler{ProfileService: errProfile}
		rec := httptest.NewRecorder()
		h.GetConnectedAccounts(rec, userHRequest(http.MethodGet, "/x", "", nil, true))
		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("get emails no auth", func(t *testing.T) {
		h := &UserHandler{}
		rec := httptest.NewRecorder()
		h.GetUserEmails(rec, userHRequest(http.MethodGet, "/x", "", nil, false))
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("post email no auth", func(t *testing.T) {
		h := &UserHandler{}
		rec := httptest.NewRecorder()
		h.PostUserEmail(rec, userHRequest(http.MethodPost, "/x", `{}`, nil, false))
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("post email bad body", func(t *testing.T) {
		h := &UserHandler{}
		rec := httptest.NewRecorder()
		h.PostUserEmail(rec, userHRequest(http.MethodPost, "/x", "{", nil, true))
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("post email service error", func(t *testing.T) {
		h := &UserHandler{EmailService: mockUserEmailService{
			addEmailFn: func(context.Context, int64, services.AddEmailRequest) (services.EmailResponse, error) {
				return services.EmailResponse{}, apierrors.BadRequest("x")
			},
		}}
		rec := httptest.NewRecorder()
		h.PostUserEmail(rec, userHRequest(http.MethodPost, "/x", `{"email":"a@b.test"}`, nil, true))
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("delete email no auth", func(t *testing.T) {
		h := &UserHandler{}
		rec := httptest.NewRecorder()
		h.DeleteUserEmail(rec, userHRequest(http.MethodDelete, "/x", "", map[string]string{"id": "1"}, false))
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("delete email bad id", func(t *testing.T) {
		h := &UserHandler{}
		rec := httptest.NewRecorder()
		h.DeleteUserEmail(rec, userHRequest(http.MethodDelete, "/x", "", map[string]string{"id": "x"}, true))
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("delete email service error", func(t *testing.T) {
		h := &UserHandler{EmailService: mockUserEmailService{
			deleteEmailFn: func(context.Context, int64, int64) error { return apierrors.NotFound("x") },
		}}
		rec := httptest.NewRecorder()
		h.DeleteUserEmail(rec, userHRequest(http.MethodDelete, "/x", "", map[string]string{"id": "3"}, true))
		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("post email verify no auth", func(t *testing.T) {
		h := &UserHandler{}
		rec := httptest.NewRecorder()
		h.PostUserEmailVerify(rec, userHRequest(http.MethodPost, "/x", "", map[string]string{"id": "1"}, false))
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("post email verify bad id", func(t *testing.T) {
		h := &UserHandler{}
		rec := httptest.NewRecorder()
		h.PostUserEmailVerify(rec, userHRequest(http.MethodPost, "/x", "", map[string]string{"id": "0"}, true))
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("post email verify service error", func(t *testing.T) {
		h := &UserHandler{EmailService: mockUserEmailService{
			requestVerificationFn: func(context.Context, int64, int64) error { return apierrors.NotFound("x") },
		}}
		rec := httptest.NewRecorder()
		h.PostUserEmailVerify(rec, userHRequest(http.MethodPost, "/x", "", map[string]string{"id": "4"}, true))
		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("get verify token missing token", func(t *testing.T) {
		h := &UserHandler{}
		rec := httptest.NewRecorder()
		h.GetUserEmailVerifyToken(rec, userHRequest(http.MethodGet, "/x", "", nil, false))
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("get verify token service error", func(t *testing.T) {
		h := &UserHandler{EmailService: mockUserEmailService{
			verifyEmailFn: func(context.Context, string) (services.VerifyEmailResult, error) {
				return services.VerifyEmailResult{}, apierrors.BadRequest("x")
			},
		}}
		rec := httptest.NewRecorder()
		h.GetUserEmailVerifyToken(rec, userHRequest(http.MethodGet, "/x?token=bad", "", nil, false))
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("post verify token bad body", func(t *testing.T) {
		h := &UserHandler{}
		rec := httptest.NewRecorder()
		h.PostUserEmailVerifyToken(rec, userHRequest(http.MethodPost, "/x", "{", nil, false))
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("post verify token empty token", func(t *testing.T) {
		h := &UserHandler{}
		rec := httptest.NewRecorder()
		h.PostUserEmailVerifyToken(rec, userHRequest(http.MethodPost, "/x", `{"token":""}`, nil, false))
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})
}

func TestUser_F_PaginationHelpers(t *testing.T) {
	t.Run("parseReadableReposPagination default and cap", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/x", nil)
		cursor, limit, err := parseReadableReposPagination(req)
		require.NoError(t, err)
		require.Equal(t, "", cursor)
		require.Equal(t, services.UserDefaultPerPage, limit)

		req2 := httptest.NewRequest(http.MethodGet, "/x?limit=999999&cursor=30", nil)
		cursor2, limit2, err2 := parseReadableReposPagination(req2)
		require.NoError(t, err2)
		require.Equal(t, "30", cursor2)
		require.Equal(t, services.MaxReadableReposPerPage, limit2)

		req3 := httptest.NewRequest(http.MethodGet, "/x?limit=bad", nil)
		_, _, err3 := parseReadableReposPagination(req3)
		require.Error(t, err3)
	})

	t.Run("userPaginationURL with and without cursor", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/user/repos?limit=5", nil)
		withCursor := userPaginationURL(req, 10, "abc")
		require.Contains(t, withCursor, "limit=10")
		require.Contains(t, withCursor, "cursor=abc")

		noCursor := userPaginationURL(req, 10, "")
		require.Contains(t, noCursor, "limit=10")
		require.NotContains(t, noCursor, "cursor=")
	})

	t.Run("writeUserPaginationHeaders with and without next", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/user/repos", nil)
		recNext := httptest.NewRecorder()
		writeUserPaginationHeaders(recNext, req, 10, "next-cursor")
		require.Contains(t, recNext.Header().Get("Link"), `rel="next"`)

		recFirst := httptest.NewRecorder()
		writeUserPaginationHeaders(recFirst, req, 10, "")
		require.Contains(t, recFirst.Header().Get("Link"), `rel="first"`)
		require.NotContains(t, recFirst.Header().Get("Link"), `rel="next"`)
	})

	t.Run("mustUserPaginationQuery", func(t *testing.T) {
		require.Equal(t, "limit=5", mustUserPaginationQuery("limit=5"))
		require.Panics(t, func() { mustUserPaginationQuery("") })
	})

	t.Run("parseUserPagination default", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/x", nil)
		_, limit, err := parseUserPagination(req)
		require.NoError(t, err)
		require.Equal(t, services.UserDefaultPerPage, limit)
	})
}
