package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type mockAdminUserService struct {
	setSyntheticFn       func(context.Context, string, bool) (services.AdminSyntheticUserProfile, error)
	listUsersFn          func(ctx context.Context, input services.AdminUserListInput) ([]services.AdminUserProfile, int64, error)
	createUserFn         func(ctx context.Context, input services.AdminCreateUserInput) (services.UserProfile, error)
	deleteUserFn         func(ctx context.Context, username string) error
	setUserAdminFn       func(ctx context.Context, username string, isAdmin bool) (services.UserProfile, error)
	createTokenForUserFn func(ctx context.Context, username string, req services.CreateTokenRequest) (services.CreateTokenResult, error)
	setSuspendedFn       func(ctx context.Context, username string, suspended bool) (services.UserProfile, error)
	revokeTokenFn        func(ctx context.Context, username string, tokenID int64) error
	eraseUserFn          func(ctx context.Context, username string, req services.EraseUserRequest) (services.EraseUserResult, error)
	exportUserFn         func(ctx context.Context, username string, w io.Writer) (services.AccountExportManifest, error)
}

func (m *mockAdminUserService) ExportUser(ctx context.Context, username string, w io.Writer) (services.AccountExportManifest, error) {
	if m.exportUserFn != nil {
		return m.exportUserFn(ctx, username, w)
	}
	return services.AccountExportManifest{}, nil
}

func (m *mockAdminUserService) EraseUser(ctx context.Context, username string, req services.EraseUserRequest) (services.EraseUserResult, error) {
	if m.eraseUserFn != nil {
		return m.eraseUserFn(ctx, username, req)
	}
	return services.EraseUserResult{}, nil
}

func (m *mockAdminUserService) ListUsers(ctx context.Context, input services.AdminUserListInput) ([]services.AdminUserProfile, int64, error) {
	if m.listUsersFn != nil {
		return m.listUsersFn(ctx, input)
	}
	return []services.AdminUserProfile{}, 0, nil
}

func (m *mockAdminUserService) CreateUser(ctx context.Context, input services.AdminCreateUserInput) (services.UserProfile, error) {
	if m.createUserFn != nil {
		return m.createUserFn(ctx, input)
	}
	return services.UserProfile{}, nil
}

func (m *mockAdminUserService) DeleteUser(ctx context.Context, username string) error {
	if m.deleteUserFn != nil {
		return m.deleteUserFn(ctx, username)
	}
	return nil
}

func (m *mockAdminUserService) SetUserAdmin(ctx context.Context, username string, isAdmin bool) (services.UserProfile, error) {
	if m.setUserAdminFn != nil {
		return m.setUserAdminFn(ctx, username, isAdmin)
	}
	return services.UserProfile{}, nil
}

func (m *mockAdminUserService) CreateTokenForUser(ctx context.Context, username string, req services.CreateTokenRequest) (services.CreateTokenResult, error) {
	if m.createTokenForUserFn != nil {
		return m.createTokenForUserFn(ctx, username, req)
	}
	return services.CreateTokenResult{}, nil
}

func (m *mockAdminUserService) SetSuspended(ctx context.Context, username string, suspended bool) (services.UserProfile, error) {
	if m.setSuspendedFn != nil {
		return m.setSuspendedFn(ctx, username, suspended)
	}
	return services.UserProfile{Username: username, Suspended: suspended}, nil
}

func (m *mockAdminUserService) RevokeToken(ctx context.Context, username string, tokenID int64) error {
	if m.revokeTokenFn != nil {
		return m.revokeTokenFn(ctx, username, tokenID)
	}
	return nil
}

func makeTestUser(id int64, username string, isAdmin bool) services.UserProfile {
	now := time.Now().UTC()
	return services.UserProfile{
		ID:          id,
		Username:    username,
		DisplayName: "Display " + username,
		Email:       username + "@example.com",
		IsAdmin:     isAdmin,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
}

func TestAdminUserHandler_ListUsers(t *testing.T) {
	t.Parallel()

	t.Run("returns 200 with users list", func(t *testing.T) {
		t.Parallel()

		h := &AdminUserHandler{
			Service: &mockAdminUserService{
				listUsersFn: func(ctx context.Context, input services.AdminUserListInput) ([]services.AdminUserProfile, int64, error) {
					assert.Equal(t, 1, input.Page)
					assert.Equal(t, 30, input.PerPage)
					return []services.AdminUserProfile{
						{UserProfile: makeTestUser(1, "alice", true), IsSynthetic: false, UserType: "user"},
						{UserProfile: makeTestUser(2, "bob", false), IsSynthetic: true, UserType: "service"},
					}, 2, nil
				},
			},
		}

		req := httptest.NewRequest(http.MethodGet, "/api/admin/users", nil)
		req = withAdminContext(req)
		rec := httptest.NewRecorder()
		h.ListUsers(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "2", rec.Header().Get("X-Total-Count"))

		var payload []services.AdminUserProfile
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
		require.Len(t, payload, 2)
		assert.Equal(t, int64(1), payload[0].ID)
		assert.Equal(t, "alice", payload[0].Username)
		assert.True(t, payload[0].IsAdmin)
		assert.Equal(t, "bob", payload[1].Username)
		assert.False(t, payload[1].IsAdmin)

		var raw []map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &raw))
		assert.Equal(t, false, raw[0]["is_synthetic"])
		assert.Equal(t, "user", raw[0]["user_type"])
		assert.Equal(t, true, raw[1]["is_synthetic"])
		assert.Equal(t, "service", raw[1]["user_type"])
	})

	t.Run("returns empty array when no users", func(t *testing.T) {
		t.Parallel()

		h := &AdminUserHandler{
			Service: &mockAdminUserService{
				listUsersFn: func(ctx context.Context, input services.AdminUserListInput) ([]services.AdminUserProfile, int64, error) {
					return []services.AdminUserProfile{}, 0, nil
				},
			},
		}

		req := httptest.NewRequest(http.MethodGet, "/api/admin/users", nil)
		req = withAdminContext(req)
		rec := httptest.NewRecorder()
		h.ListUsers(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "0", rec.Header().Get("X-Total-Count"))

		var payload []services.AdminUserProfile
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
		assert.Empty(t, payload)
	})

	t.Run("returns 400 for invalid pagination", func(t *testing.T) {
		t.Parallel()

		h := &AdminUserHandler{Service: &mockAdminUserService{}}

		req := httptest.NewRequest(http.MethodGet, "/api/admin/users?page=abc", nil)
		req = withAdminContext(req)
		rec := httptest.NewRecorder()
		h.ListUsers(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("paginates with page and per_page", func(t *testing.T) {
		t.Parallel()

		h := &AdminUserHandler{
			Service: &mockAdminUserService{
				listUsersFn: func(ctx context.Context, input services.AdminUserListInput) ([]services.AdminUserProfile, int64, error) {
					assert.Equal(t, 3, input.Page)
					assert.Equal(t, 10, input.PerPage)
					return []services.AdminUserProfile{}, 35, nil
				},
			},
		}

		req := httptest.NewRequest(http.MethodGet, "/api/admin/users?page=3&per_page=10", nil)
		req = withAdminContext(req)
		rec := httptest.NewRecorder()
		h.ListUsers(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "35", rec.Header().Get("X-Total-Count"))
		assert.NotEmpty(t, rec.Header().Get("Link"))
	})

	t.Run("propagates service errors as 500", func(t *testing.T) {
		t.Parallel()

		h := &AdminUserHandler{
			Service: &mockAdminUserService{
				listUsersFn: func(ctx context.Context, input services.AdminUserListInput) ([]services.AdminUserProfile, int64, error) {
					return nil, 0, pkgerrors.Internal("db failure")
				},
			},
		}

		req := httptest.NewRequest(http.MethodGet, "/api/admin/users", nil)
		req = withAdminContext(req)
		rec := httptest.NewRecorder()
		h.ListUsers(rec, req)

		assert.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("response items have expected fields", func(t *testing.T) {
		t.Parallel()

		h := &AdminUserHandler{
			Service: &mockAdminUserService{
				listUsersFn: func(ctx context.Context, input services.AdminUserListInput) ([]services.AdminUserProfile, int64, error) {
					return []services.AdminUserProfile{{UserProfile: makeTestUser(10, "charlie", false), UserType: "bot"}}, 1, nil
				},
			},
		}

		req := httptest.NewRequest(http.MethodGet, "/api/admin/users", nil)
		req = withAdminContext(req)
		rec := httptest.NewRecorder()
		h.ListUsers(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)

		var payload []map[string]interface{}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
		require.Len(t, payload, 1)
		u := payload[0]
		assert.Contains(t, u, "id")
		assert.Contains(t, u, "username")
		assert.Contains(t, u, "display_name")
		assert.Contains(t, u, "email")
		assert.Contains(t, u, "is_admin")
		assert.Contains(t, u, "created_at")
		assert.Contains(t, u, "updated_at")
		assert.Equal(t, false, u["is_synthetic"])
		assert.Equal(t, "bot", u["user_type"])
	})
}

func TestAdminUserHandler_CreateUser(t *testing.T) {
	t.Parallel()

	t.Run("returns 201 with created user on valid input", func(t *testing.T) {
		t.Parallel()

		h := &AdminUserHandler{
			Service: &mockAdminUserService{
				createUserFn: func(ctx context.Context, input services.AdminCreateUserInput) (services.UserProfile, error) {
					assert.Equal(t, "newuser", input.Username)
					return makeTestUser(99, "newuser", false), nil
				},
			},
		}

		body := `{"username":"newuser"}`
		req := httptest.NewRequest(http.MethodPost, "/api/admin/users", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		req = withAdminContext(req)
		rec := httptest.NewRecorder()
		h.CreateUser(rec, req)

		require.Equal(t, http.StatusCreated, rec.Code)
		var profile services.UserProfile
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &profile))
		assert.Equal(t, "newuser", profile.Username)
		assert.Equal(t, int64(99), profile.ID)
	})

	t.Run("returns 400 for invalid JSON body", func(t *testing.T) {
		t.Parallel()

		h := &AdminUserHandler{Service: &mockAdminUserService{}}

		req := httptest.NewRequest(http.MethodPost, "/api/admin/users", bytes.NewBufferString("{bad json"))
		req.Header.Set("Content-Type", "application/json")
		req = withAdminContext(req)
		rec := httptest.NewRecorder()
		h.CreateUser(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("returns 409 when service returns conflict", func(t *testing.T) {
		t.Parallel()

		h := &AdminUserHandler{
			Service: &mockAdminUserService{
				createUserFn: func(ctx context.Context, input services.AdminCreateUserInput) (services.UserProfile, error) {
					return services.UserProfile{}, pkgerrors.Conflict("username or email already in use")
				},
			},
		}

		body := `{"username":"existing"}`
		req := httptest.NewRequest(http.MethodPost, "/api/admin/users", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		req = withAdminContext(req)
		rec := httptest.NewRecorder()
		h.CreateUser(rec, req)

		assert.Equal(t, http.StatusConflict, rec.Code)
	})

	t.Run("returns 422 when service returns validation error", func(t *testing.T) {
		t.Parallel()

		h := &AdminUserHandler{
			Service: &mockAdminUserService{
				createUserFn: func(ctx context.Context, input services.AdminCreateUserInput) (services.UserProfile, error) {
					return services.UserProfile{}, pkgerrors.ValidationFailed(
						pkgerrors.FieldError{Resource: "User", Field: "username", Code: "missing_field"},
					)
				},
			},
		}

		body := `{"username":""}`
		req := httptest.NewRequest(http.MethodPost, "/api/admin/users", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		req = withAdminContext(req)
		rec := httptest.NewRecorder()
		h.CreateUser(rec, req)

		assert.Equal(t, http.StatusUnprocessableEntity, rec.Code)
	})

	t.Run("returns 500 when service returns internal error", func(t *testing.T) {
		t.Parallel()

		h := &AdminUserHandler{
			Service: &mockAdminUserService{
				createUserFn: func(ctx context.Context, input services.AdminCreateUserInput) (services.UserProfile, error) {
					return services.UserProfile{}, pkgerrors.Internal("db failure")
				},
			},
		}

		body := `{"username":"someuser"}`
		req := httptest.NewRequest(http.MethodPost, "/api/admin/users", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		req = withAdminContext(req)
		rec := httptest.NewRecorder()
		h.CreateUser(rec, req)

		assert.Equal(t, http.StatusInternalServerError, rec.Code)
	})
}

func TestAdminUserHandler_MutationsAttachAuditActorContext(t *testing.T) {
	t.Parallel()

	assertActor := func(t *testing.T, ctx context.Context) {
		t.Helper()
		actor, ok := services.AdminAuditActorFromContext(ctx)
		require.True(t, ok)
		assert.Equal(t, int64(99), actor.UserID)
		assert.Equal(t, "admin-user", actor.Username)
		assert.Equal(t, "203.0.113.44:5555", actor.IPAddress)
	}

	t.Run("create user", func(t *testing.T) {
		t.Parallel()

		h := &AdminUserHandler{Service: &mockAdminUserService{
			createUserFn: func(ctx context.Context, input services.AdminCreateUserInput) (services.UserProfile, error) {
				assertActor(t, ctx)
				return makeTestUser(10, input.Username, false), nil
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/admin/users", bytes.NewBufferString(`{"username":"alice"}`))
		req.RemoteAddr = "203.0.113.44:5555"
		req = withAdminContext(req)
		rec := httptest.NewRecorder()

		h.CreateUser(rec, req)

		require.Equal(t, http.StatusCreated, rec.Code)
	})

	t.Run("delete user", func(t *testing.T) {
		t.Parallel()

		h := &AdminUserHandler{Service: &mockAdminUserService{
			deleteUserFn: func(ctx context.Context, username string) error {
				assertActor(t, ctx)
				return nil
			},
		}}
		req := httptest.NewRequest(http.MethodDelete, "/api/admin/users/alice", nil)
		req.RemoteAddr = "203.0.113.44:5555"
		req = withAdminContext(req)
		req = withURLParamAdminUser(req, "alice")
		rec := httptest.NewRecorder()

		h.DeleteUser(rec, req)

		require.Equal(t, http.StatusNoContent, rec.Code)
	})

	t.Run("set admin", func(t *testing.T) {
		t.Parallel()

		h := &AdminUserHandler{Service: &mockAdminUserService{
			setUserAdminFn: func(ctx context.Context, username string, isAdmin bool) (services.UserProfile, error) {
				assertActor(t, ctx)
				return services.UserProfile{Username: username, IsAdmin: isAdmin}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPatch, "/api/admin/users/alice/admin", bytes.NewBufferString(`{"is_admin":true}`))
		req.RemoteAddr = "203.0.113.44:5555"
		req = withAdminContext(req)
		req = withURLParamAdminUser(req, "alice")
		rec := httptest.NewRecorder()

		h.PatchUserAdmin(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
	})

	t.Run("create token", func(t *testing.T) {
		t.Parallel()

		h := &AdminUserHandler{Service: &mockAdminUserService{
			createTokenForUserFn: func(ctx context.Context, username string, req services.CreateTokenRequest) (services.CreateTokenResult, error) {
				assertActor(t, ctx)
				return services.CreateTokenResult{Token: "smithers_token"}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/admin/users/alice/tokens", bytes.NewBufferString(`{"name":"ci"}`))
		req.RemoteAddr = "203.0.113.44:5555"
		req = withAdminContext(req)
		req = withURLParamAdminUser(req, "alice")
		rec := httptest.NewRecorder()

		h.PostUserToken(rec, req)

		require.Equal(t, http.StatusCreated, rec.Code)
	})

	t.Run("set suspended", func(t *testing.T) {
		t.Parallel()

		h := &AdminUserHandler{Service: &mockAdminUserService{
			setSuspendedFn: func(ctx context.Context, username string, suspended bool) (services.UserProfile, error) {
				assertActor(t, ctx)
				return services.UserProfile{Username: username, Suspended: suspended}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPatch, "/api/admin/users/alice", bytes.NewBufferString(`{"suspended":true}`))
		req.RemoteAddr = "203.0.113.44:5555"
		req = withAdminContext(req)
		req = withURLParamAdminUser(req, "alice")
		rec := httptest.NewRecorder()

		h.PatchUser(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
	})

	t.Run("revoke token", func(t *testing.T) {
		t.Parallel()

		h := &AdminUserHandler{Service: &mockAdminUserService{
			revokeTokenFn: func(ctx context.Context, username string, tokenID int64) error {
				assertActor(t, ctx)
				return nil
			},
		}}
		req := httptest.NewRequest(http.MethodDelete, "/api/admin/users/alice/tokens/42", nil)
		req.RemoteAddr = "203.0.113.44:5555"
		req = withAdminContext(req)
		req = withURLParamAdminToken(req, "alice", "42")
		rec := httptest.NewRecorder()

		h.DeleteUserToken(rec, req)

		require.Equal(t, http.StatusNoContent, rec.Code)
	})
}

func withURLParamAdminUser(req *http.Request, username string) *http.Request {
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("username", username)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
}

func withURLParamAdminToken(req *http.Request, username, tokenID string) *http.Request {
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("username", username)
	rctx.URLParams.Add("token_id", tokenID)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
}

func TestAdminUserHandler_DeleteUser(t *testing.T) {
	t.Parallel()

	t.Run("returns 204 on successful delete", func(t *testing.T) {
		t.Parallel()

		var deletedUsername string
		h := &AdminUserHandler{
			Service: &mockAdminUserService{
				deleteUserFn: func(ctx context.Context, username string) error {
					deletedUsername = username
					return nil
				},
			},
		}

		req := httptest.NewRequest(http.MethodDelete, "/api/admin/users/targetuser", nil)
		req = withAdminContext(req)
		req = withURLParamAdminUser(req, "targetuser")
		rec := httptest.NewRecorder()
		h.DeleteUser(rec, req)

		require.Equal(t, http.StatusNoContent, rec.Code)
		assert.Equal(t, "targetuser", deletedUsername)
	})

	t.Run("returns 404 when user does not exist", func(t *testing.T) {
		t.Parallel()

		h := &AdminUserHandler{
			Service: &mockAdminUserService{
				deleteUserFn: func(ctx context.Context, username string) error {
					return pkgerrors.NotFound("user not found")
				},
			},
		}

		req := httptest.NewRequest(http.MethodDelete, "/api/admin/users/ghostuser", nil)
		req = withAdminContext(req)
		req = withURLParamAdminUser(req, "ghostuser")
		rec := httptest.NewRecorder()
		h.DeleteUser(rec, req)

		assert.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("returns 500 when service fails", func(t *testing.T) {
		t.Parallel()

		h := &AdminUserHandler{
			Service: &mockAdminUserService{
				deleteUserFn: func(ctx context.Context, username string) error {
					return pkgerrors.Internal("db error")
				},
			},
		}

		req := httptest.NewRequest(http.MethodDelete, "/api/admin/users/someuser", nil)
		req = withAdminContext(req)
		req = withURLParamAdminUser(req, "someuser")
		rec := httptest.NewRecorder()
		h.DeleteUser(rec, req)

		assert.Equal(t, http.StatusInternalServerError, rec.Code)
	})
}

func TestAdminUserHandler_EraseUser(t *testing.T) {
	t.Parallel()

	erase := func(t *testing.T, svc *mockAdminUserService, body string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/api/admin/users/target/erase", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.RemoteAddr = "203.0.113.44:5555"
		req = withURLParamAdminUser(withAdminContext(req), "target")
		rec := httptest.NewRecorder()
		(&AdminUserHandler{Service: svc}).EraseUser(rec, req)
		return rec
	}

	t.Run("passes the request date and audit actor, returns the result", func(t *testing.T) {
		t.Parallel()
		var gotUser string
		var gotReq services.EraseUserRequest
		rec := erase(t, &mockAdminUserService{eraseUserFn: func(ctx context.Context, username string, req services.EraseUserRequest) (services.EraseUserResult, error) {
			actor, ok := services.AdminAuditActorFromContext(ctx)
			require.True(t, ok)
			assert.Equal(t, "admin-user", actor.Username)
			gotUser, gotReq = username, req
			return services.EraseUserResult{UserID: 7, Tombstone: "erased-ab-7", RowsChanged: 12}, nil
		}}, `{"request_date":"2026-09-01"}`)
		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "target", gotUser)
		assert.Equal(t, time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC), gotReq.RequestedAt)
		assert.JSONEq(t, `{"user_id":7,"tombstone":"erased-ab-7","already_erased":false,"rows_changed":12,"repositories":0,"workspaces":0}`, rec.Body.String())
	})

	for name, body := range map[string]string{"missing": `{}`, "malformed": `{"request_date":"09/01/2026"}`} {
		t.Run("rejects a "+name+" request date", func(t *testing.T) {
			t.Parallel()
			called := false
			rec := erase(t, &mockAdminUserService{eraseUserFn: func(context.Context, string, services.EraseUserRequest) (services.EraseUserResult, error) {
				called = true
				return services.EraseUserResult{}, nil
			}}, body)
			assert.Equal(t, http.StatusBadRequest, rec.Code)
			assert.False(t, called)
		})
	}

	t.Run("maps a missing user to 404", func(t *testing.T) {
		t.Parallel()
		rec := erase(t, &mockAdminUserService{eraseUserFn: func(context.Context, string, services.EraseUserRequest) (services.EraseUserResult, error) {
			return services.EraseUserResult{}, pkgerrors.NotFound("user not found")
		}}, `{"request_date":"2026-09-01"}`)
		assert.Equal(t, http.StatusNotFound, rec.Code)
	})
}

func TestAdminUserHandler_PatchUser(t *testing.T) {
	t.Parallel()

	t.Run("suspends user and returns 200 with updated profile", func(t *testing.T) {
		t.Parallel()

		h := &AdminUserHandler{
			Service: &mockAdminUserService{
				setSuspendedFn: func(ctx context.Context, username string, suspended bool) (services.UserProfile, error) {
					assert.Equal(t, "alice", username)
					assert.True(t, suspended)
					return services.UserProfile{Username: username, Suspended: true}, nil
				},
			},
		}

		body := `{"suspended":true}`
		req := httptest.NewRequest(http.MethodPatch, "/api/admin/users/alice", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		req = withAdminContext(req)
		req = withURLParamAdminUser(req, "alice")
		rec := httptest.NewRecorder()
		h.PatchUser(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		var profile services.UserProfile
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &profile))
		assert.True(t, profile.Suspended)
		assert.Equal(t, "alice", profile.Username)
	})

	t.Run("unsuspends user and returns 200", func(t *testing.T) {
		t.Parallel()

		h := &AdminUserHandler{
			Service: &mockAdminUserService{
				setSuspendedFn: func(ctx context.Context, username string, suspended bool) (services.UserProfile, error) {
					assert.Equal(t, "bob", username)
					assert.False(t, suspended)
					return services.UserProfile{Username: username, Suspended: false}, nil
				},
			},
		}

		body := `{"suspended":false}`
		req := httptest.NewRequest(http.MethodPatch, "/api/admin/users/bob", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		req = withAdminContext(req)
		req = withURLParamAdminUser(req, "bob")
		rec := httptest.NewRecorder()
		h.PatchUser(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		var profile services.UserProfile
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &profile))
		assert.False(t, profile.Suspended)
	})

	t.Run("returns 400 when suspended field is missing", func(t *testing.T) {
		t.Parallel()

		h := &AdminUserHandler{Service: &mockAdminUserService{}}

		body := `{}`
		req := httptest.NewRequest(http.MethodPatch, "/api/admin/users/alice", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		req = withAdminContext(req)
		req = withURLParamAdminUser(req, "alice")
		rec := httptest.NewRecorder()
		h.PatchUser(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("returns 400 for invalid JSON body", func(t *testing.T) {
		t.Parallel()

		h := &AdminUserHandler{Service: &mockAdminUserService{}}

		req := httptest.NewRequest(http.MethodPatch, "/api/admin/users/alice", bytes.NewBufferString("{bad"))
		req.Header.Set("Content-Type", "application/json")
		req = withAdminContext(req)
		req = withURLParamAdminUser(req, "alice")
		rec := httptest.NewRecorder()
		h.PatchUser(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("returns 404 when user not found", func(t *testing.T) {
		t.Parallel()

		h := &AdminUserHandler{
			Service: &mockAdminUserService{
				setSuspendedFn: func(ctx context.Context, username string, suspended bool) (services.UserProfile, error) {
					return services.UserProfile{}, pkgerrors.NotFound("user not found")
				},
			},
		}

		body := `{"suspended":true}`
		req := httptest.NewRequest(http.MethodPatch, "/api/admin/users/ghost", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		req = withAdminContext(req)
		req = withURLParamAdminUser(req, "ghost")
		rec := httptest.NewRecorder()
		h.PatchUser(rec, req)

		assert.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("returns 500 when service fails", func(t *testing.T) {
		t.Parallel()

		h := &AdminUserHandler{
			Service: &mockAdminUserService{
				setSuspendedFn: func(ctx context.Context, username string, suspended bool) (services.UserProfile, error) {
					return services.UserProfile{}, pkgerrors.Internal("db failure")
				},
			},
		}

		body := `{"suspended":true}`
		req := httptest.NewRequest(http.MethodPatch, "/api/admin/users/alice", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		req = withAdminContext(req)
		req = withURLParamAdminUser(req, "alice")
		rec := httptest.NewRecorder()
		h.PatchUser(rec, req)

		assert.Equal(t, http.StatusInternalServerError, rec.Code)
	})
}

func TestAdminUserHandler_DeleteUserToken(t *testing.T) {
	t.Parallel()

	t.Run("revokes token and returns 204", func(t *testing.T) {
		t.Parallel()

		var capturedUsername string
		var capturedTokenID int64
		h := &AdminUserHandler{
			Service: &mockAdminUserService{
				revokeTokenFn: func(ctx context.Context, username string, tokenID int64) error {
					capturedUsername = username
					capturedTokenID = tokenID
					return nil
				},
			},
		}

		req := httptest.NewRequest(http.MethodDelete, "/api/admin/users/alice/tokens/42", nil)
		req = withAdminContext(req)
		req = withURLParamAdminToken(req, "alice", "42")
		rec := httptest.NewRecorder()
		h.DeleteUserToken(rec, req)

		require.Equal(t, http.StatusNoContent, rec.Code)
		assert.Equal(t, "alice", capturedUsername)
		assert.Equal(t, int64(42), capturedTokenID)
	})

	t.Run("returns 404 when token not found", func(t *testing.T) {
		t.Parallel()

		h := &AdminUserHandler{
			Service: &mockAdminUserService{
				revokeTokenFn: func(ctx context.Context, username string, tokenID int64) error {
					return pkgerrors.NotFound("token not found")
				},
			},
		}

		req := httptest.NewRequest(http.MethodDelete, "/api/admin/users/alice/tokens/99", nil)
		req = withAdminContext(req)
		req = withURLParamAdminToken(req, "alice", "99")
		rec := httptest.NewRecorder()
		h.DeleteUserToken(rec, req)

		assert.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("returns 400 for non-numeric token_id", func(t *testing.T) {
		t.Parallel()

		h := &AdminUserHandler{Service: &mockAdminUserService{}}

		req := httptest.NewRequest(http.MethodDelete, "/api/admin/users/alice/tokens/notanumber", nil)
		req = withAdminContext(req)
		req = withURLParamAdminToken(req, "alice", "notanumber")
		rec := httptest.NewRecorder()
		h.DeleteUserToken(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("returns 400 for zero token_id", func(t *testing.T) {
		t.Parallel()

		h := &AdminUserHandler{Service: &mockAdminUserService{}}

		req := httptest.NewRequest(http.MethodDelete, "/api/admin/users/alice/tokens/0", nil)
		req = withAdminContext(req)
		req = withURLParamAdminToken(req, "alice", "0")
		rec := httptest.NewRecorder()
		h.DeleteUserToken(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("returns 404 when user not found", func(t *testing.T) {
		t.Parallel()

		h := &AdminUserHandler{
			Service: &mockAdminUserService{
				revokeTokenFn: func(ctx context.Context, username string, tokenID int64) error {
					return pkgerrors.NotFound("user not found")
				},
			},
		}

		req := httptest.NewRequest(http.MethodDelete, "/api/admin/users/ghost/tokens/1", nil)
		req = withAdminContext(req)
		req = withURLParamAdminToken(req, "ghost", "1")
		rec := httptest.NewRecorder()
		h.DeleteUserToken(rec, req)

		assert.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("returns 500 when service fails", func(t *testing.T) {
		t.Parallel()

		h := &AdminUserHandler{
			Service: &mockAdminUserService{
				revokeTokenFn: func(ctx context.Context, username string, tokenID int64) error {
					return pkgerrors.Internal("db failure")
				},
			},
		}

		req := httptest.NewRequest(http.MethodDelete, "/api/admin/users/alice/tokens/7", nil)
		req = withAdminContext(req)
		req = withURLParamAdminToken(req, "alice", "7")
		rec := httptest.NewRecorder()
		h.DeleteUserToken(rec, req)

		assert.Equal(t, http.StatusInternalServerError, rec.Code)
	})
}

func TestAdminUserHandler_ExportUser(t *testing.T) {
	t.Parallel()

	export := func(t *testing.T, svc *mockAdminUserService, username string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/api/admin/users/u/export", nil)
		req = withURLParamAdminUser(withAdminContext(req), username)
		rec := httptest.NewRecorder()
		(&AdminUserHandler{Service: svc}).ExportUser(rec, req)
		return rec
	}

	t.Run("streams the archive after it is complete", func(t *testing.T) {
		t.Parallel()
		rec := export(t, &mockAdminUserService{exportUserFn: func(ctx context.Context, username string, w io.Writer) (services.AccountExportManifest, error) {
			actor, ok := services.AdminAuditActorFromContext(ctx)
			require.True(t, ok)
			assert.Equal(t, "admin-user", actor.Username)
			assert.Equal(t, "target", username)
			_, err := io.WriteString(w, "archive-bytes")
			return services.AccountExportManifest{Username: "target"}, err
		}}, "target")
		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "application/gzip", rec.Header().Get("Content-Type"))
		assert.Equal(t, `attachment; filename="target-export.tar.gz"`, rec.Header().Get("Content-Disposition"))
		assert.Equal(t, "13", rec.Header().Get("Content-Length"))
		assert.Equal(t, "archive-bytes", rec.Body.String())
	})

	t.Run("a failure mid-archive is an error, never a partial download", func(t *testing.T) {
		t.Parallel()
		rec := export(t, &mockAdminUserService{exportUserFn: func(_ context.Context, _ string, w io.Writer) (services.AccountExportManifest, error) {
			_, _ = io.WriteString(w, "partial")
			return services.AccountExportManifest{}, pkgerrors.Internal("failed to bundle target/repo")
		}}, "target")
		require.Equal(t, http.StatusInternalServerError, rec.Code)
		assert.NotContains(t, rec.Body.String(), "partial")
		assert.Contains(t, rec.Header().Get("Content-Type"), "application/json")
	})

	t.Run("unknown user", func(t *testing.T) {
		t.Parallel()
		rec := export(t, &mockAdminUserService{exportUserFn: func(context.Context, string, io.Writer) (services.AccountExportManifest, error) {
			return services.AccountExportManifest{}, pkgerrors.NotFound("user not found")
		}}, "ghost")
		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("blank username", func(t *testing.T) {
		t.Parallel()
		rec := export(t, &mockAdminUserService{}, " ")
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})
}
