package services

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// mockAdminUserQuerier implements AdminUserQuerier for unit tests.
type mockAdminUserQuerier struct {
	setSyntheticFn                 func(context.Context, db.AdminSetUserSyntheticParams) (db.User, error)
	listUsersFn                    func(ctx context.Context, arg db.ListUsersParams) ([]db.User, error)
	countUsersFn                   func(ctx context.Context) (int64, error)
	createUserFn                   func(ctx context.Context, arg db.CreateUserParams) (db.User, error)
	getUserByLowerUsernameFn       func(ctx context.Context, lowerUsername string) (db.User, error)
	adminGetUserForSuspensionFn    func(ctx context.Context, lowerUsername string) (db.User, error)
	suspendUserFn                  func(ctx context.Context, id int64) error
	setUserAdminFn                 func(ctx context.Context, arg db.SetUserAdminParams) error
	setUserSuspendedFn             func(ctx context.Context, arg db.SetUserSuspendedParams) (db.User, error)
	getAccessTokenByIDFn           func(ctx context.Context, id int64) (db.AccessToken, error)
	deleteAccessTokenByIDAndUserID func(ctx context.Context, arg db.DeleteAccessTokenByIDAndUserIDParams) (int64, error)
}

func (m *mockAdminUserQuerier) ListUsers(ctx context.Context, arg db.ListUsersParams) ([]db.User, error) {
	if m.listUsersFn != nil {
		return m.listUsersFn(ctx, arg)
	}
	return []db.User{}, nil
}

func (m *mockAdminUserQuerier) CountUsers(ctx context.Context) (int64, error) {
	if m.countUsersFn != nil {
		return m.countUsersFn(ctx)
	}
	return 0, nil
}

func (m *mockAdminUserQuerier) CreateUser(ctx context.Context, arg db.CreateUserParams) (db.User, error) {
	if m.createUserFn != nil {
		return m.createUserFn(ctx, arg)
	}
	return db.User{}, nil
}

func (m *mockAdminUserQuerier) GetUserByLowerUsername(ctx context.Context, lowerUsername string) (db.User, error) {
	if m.getUserByLowerUsernameFn != nil {
		return m.getUserByLowerUsernameFn(ctx, lowerUsername)
	}
	return db.User{}, nil
}

func (m *mockAdminUserQuerier) AdminGetUserForSuspension(ctx context.Context, lowerUsername string) (db.User, error) {
	if m.adminGetUserForSuspensionFn != nil {
		return m.adminGetUserForSuspensionFn(ctx, lowerUsername)
	}
	return db.User{}, nil
}

func (m *mockAdminUserQuerier) SuspendUser(ctx context.Context, id int64) error {
	if m.suspendUserFn != nil {
		return m.suspendUserFn(ctx, id)
	}
	return nil
}

func (m *mockAdminUserQuerier) SetUserAdmin(ctx context.Context, arg db.SetUserAdminParams) error {
	if m.setUserAdminFn != nil {
		return m.setUserAdminFn(ctx, arg)
	}
	return nil
}

func (m *mockAdminUserQuerier) SetUserSuspended(ctx context.Context, arg db.SetUserSuspendedParams) (db.User, error) {
	if m.setUserSuspendedFn != nil {
		return m.setUserSuspendedFn(ctx, arg)
	}
	return db.User{}, nil
}

func (m *mockAdminUserQuerier) GetAccessTokenByID(ctx context.Context, id int64) (db.AccessToken, error) {
	if m.getAccessTokenByIDFn != nil {
		return m.getAccessTokenByIDFn(ctx, id)
	}
	return db.AccessToken{}, nil
}

func (m *mockAdminUserQuerier) DeleteAccessTokenByIDAndUserID(ctx context.Context, arg db.DeleteAccessTokenByIDAndUserIDParams) (int64, error) {
	if m.deleteAccessTokenByIDAndUserID != nil {
		return m.deleteAccessTokenByIDAndUserID(ctx, arg)
	}
	return 0, nil
}

func makeDBUser(id int64, username string, isAdmin bool) db.User {
	now := time.Now().UTC()
	return db.User{
		ID:            id,
		Username:      username,
		LowerUsername: username,
		DisplayName:   "User " + username,
		IsActive:      true,
		IsAdmin:       isAdmin,
		CreatedAt:     now,
		UpdatedAt:     now,
	}
}

// mockAdminAuditor captures audit events for assertions in tests.
type mockAdminAuditor struct {
	events []AuditEvent
}

func (m *mockAdminAuditor) Log(_ context.Context, event AuditEvent) {
	m.events = append(m.events, event)
}

func adminAuditTestContext() context.Context {
	return ContextWithAdminAuditActor(context.Background(), AdminAuditActor{
		UserID:    99,
		Username:  "admin-user",
		IPAddress: "203.0.113.44",
	})
}

func assertAdminAuditActor(t *testing.T, ev AuditEvent) {
	t.Helper()
	require.NotNil(t, ev.ActorID)
	assert.Equal(t, int64(99), *ev.ActorID)
	assert.Equal(t, "admin-user", ev.ActorName)
	assert.Equal(t, "203.0.113.44", ev.IPAddress)
}

func TestAdminUserService_ListUsers(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	t.Run("returns paginated list of users", func(t *testing.T) {
		t.Parallel()

		q := &mockAdminUserQuerier{
			countUsersFn: func(ctx context.Context) (int64, error) {
				return 2, nil
			},
			listUsersFn: func(ctx context.Context, arg db.ListUsersParams) ([]db.User, error) {
				assert.Equal(t, int32(30), arg.PageSize)
				assert.Equal(t, int32(0), arg.PageOffset)
				human := makeDBUser(1, "alice", true)
				human.UserType = "user"
				synthetic := makeDBUser(2, "bob", false)
				synthetic.IsSynthetic = true
				synthetic.UserType = "bot"
				return []db.User{human, synthetic}, nil
			},
		}

		svc := NewAdminUserService(q)
		users, total, err := svc.ListUsers(ctx, AdminUserListInput{Page: 1, PerPage: 30})
		require.NoError(t, err)
		assert.Equal(t, int64(2), total)
		require.Len(t, users, 2)
		assert.Equal(t, int64(1), users[0].ID)
		assert.Equal(t, "alice", users[0].Username)
		assert.True(t, users[0].IsAdmin)
		assert.Equal(t, int64(2), users[1].ID)
		assert.Equal(t, "bob", users[1].Username)
		assert.False(t, users[1].IsAdmin)
		assert.False(t, users[0].IsSynthetic)
		assert.Equal(t, "user", users[0].UserType)
		assert.True(t, users[1].IsSynthetic)
		assert.Equal(t, "bot", users[1].UserType)
	})

	t.Run("returns empty list when no users exist", func(t *testing.T) {
		t.Parallel()

		q := &mockAdminUserQuerier{
			countUsersFn: func(ctx context.Context) (int64, error) {
				return 0, nil
			},
			listUsersFn: func(ctx context.Context, arg db.ListUsersParams) ([]db.User, error) {
				return []db.User{}, nil
			},
		}

		svc := NewAdminUserService(q)
		users, total, err := svc.ListUsers(ctx, AdminUserListInput{Page: 1, PerPage: 30})
		require.NoError(t, err)
		assert.Equal(t, int64(0), total)
		assert.Empty(t, users)
	})

	t.Run("normalizes zero page to page 1 with zero offset", func(t *testing.T) {
		t.Parallel()

		var capturedOffset int32
		q := &mockAdminUserQuerier{
			countUsersFn: func(ctx context.Context) (int64, error) { return 0, nil },
			listUsersFn: func(ctx context.Context, arg db.ListUsersParams) ([]db.User, error) {
				capturedOffset = arg.PageOffset
				return []db.User{}, nil
			},
		}

		svc := NewAdminUserService(q)
		_, _, err := svc.ListUsers(ctx, AdminUserListInput{Page: 0, PerPage: 10})
		require.NoError(t, err)
		// Page 0 normalized to page 1 → offset = (1-1)*10 = 0
		assert.Equal(t, int32(0), capturedOffset)
	})

	t.Run("computes correct offset for page 2", func(t *testing.T) {
		t.Parallel()

		var capturedOffset int32
		q := &mockAdminUserQuerier{
			countUsersFn: func(ctx context.Context) (int64, error) { return 25, nil },
			listUsersFn: func(ctx context.Context, arg db.ListUsersParams) ([]db.User, error) {
				capturedOffset = arg.PageOffset
				return []db.User{}, nil
			},
		}

		svc := NewAdminUserService(q)
		_, _, err := svc.ListUsers(ctx, AdminUserListInput{Page: 2, PerPage: 10})
		require.NoError(t, err)
		// Page 2 with perPage 10 → offset = (2-1)*10 = 10
		assert.Equal(t, int32(10), capturedOffset)
	})

	t.Run("returns internal error when CountUsers fails", func(t *testing.T) {
		t.Parallel()

		q := &mockAdminUserQuerier{
			countUsersFn: func(ctx context.Context) (int64, error) {
				return 0, errors.New("db connection lost")
			},
		}

		svc := NewAdminUserService(q)
		_, _, err := svc.ListUsers(ctx, AdminUserListInput{Page: 1, PerPage: 30})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "failed to count users")
	})

	t.Run("returns internal error when ListUsers fails", func(t *testing.T) {
		t.Parallel()

		q := &mockAdminUserQuerier{
			countUsersFn: func(ctx context.Context) (int64, error) {
				return 5, nil
			},
			listUsersFn: func(ctx context.Context, arg db.ListUsersParams) ([]db.User, error) {
				return nil, errors.New("query timeout")
			},
		}

		svc := NewAdminUserService(q)
		_, _, err := svc.ListUsers(ctx, AdminUserListInput{Page: 1, PerPage: 30})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "failed to list users")
	})

	t.Run("response maps user fields including is_admin flag", func(t *testing.T) {
		t.Parallel()

		user := makeDBUser(42, "superadmin", true)
		user.DisplayName = "Super Admin"

		q := &mockAdminUserQuerier{
			countUsersFn: func(ctx context.Context) (int64, error) { return 1, nil },
			listUsersFn: func(ctx context.Context, arg db.ListUsersParams) ([]db.User, error) {
				return []db.User{user}, nil
			},
		}

		svc := NewAdminUserService(q)
		users, total, err := svc.ListUsers(ctx, AdminUserListInput{Page: 1, PerPage: 30})
		require.NoError(t, err)
		assert.Equal(t, int64(1), total)
		require.Len(t, users, 1)
		u := users[0]
		assert.Equal(t, int64(42), u.ID)
		assert.Equal(t, "superadmin", u.Username)
		assert.Equal(t, "Super Admin", u.DisplayName)
		assert.True(t, u.IsAdmin)
	})
}

func TestAdminUserService_CreateUser(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	t.Run("creates user with valid input", func(t *testing.T) {
		t.Parallel()

		created := makeDBUser(99, "newuser", false)
		created.DisplayName = "newuser"

		q := &mockAdminUserQuerier{
			createUserFn: func(ctx context.Context, arg db.CreateUserParams) (db.User, error) {
				assert.Equal(t, "newuser", arg.Username)
				assert.Equal(t, "newuser", arg.LowerUsername)
				return created, nil
			},
		}

		svc := NewAdminUserService(q)
		profile, err := svc.CreateUser(ctx, AdminCreateUserInput{Username: "newuser"})
		require.NoError(t, err)
		assert.Equal(t, int64(99), profile.ID)
		assert.Equal(t, "newuser", profile.Username)
	})

	t.Run("defaults display_name to username if empty", func(t *testing.T) {
		t.Parallel()

		var capturedArg db.CreateUserParams
		q := &mockAdminUserQuerier{
			createUserFn: func(ctx context.Context, arg db.CreateUserParams) (db.User, error) {
				capturedArg = arg
				return makeDBUser(1, arg.Username, false), nil
			},
		}

		svc := NewAdminUserService(q)
		_, err := svc.CreateUser(ctx, AdminCreateUserInput{Username: "testuser", DisplayName: ""})
		require.NoError(t, err)
		assert.Equal(t, "testuser", capturedArg.DisplayName)
	})

	t.Run("returns validation error for empty username", func(t *testing.T) {
		t.Parallel()

		q := &mockAdminUserQuerier{}
		svc := NewAdminUserService(q)
		_, err := svc.CreateUser(ctx, AdminCreateUserInput{Username: ""})
		require.Error(t, err)
		apiErr, ok := err.(*pkgerrors.APIError)
		require.True(t, ok, "expected *APIError, got %T", err)
		assert.Equal(t, 422, apiErr.Status)
	})

	t.Run("rejects usernames outside the owner namespace grammar", func(t *testing.T) {
		t.Parallel()

		for _, username := range []string{"bad/name", "-leading", strings.Repeat("a", 256)} {
			username := username
			t.Run(username, func(t *testing.T) {
				t.Parallel()
				q := &mockAdminUserQuerier{
					createUserFn: func(context.Context, db.CreateUserParams) (db.User, error) {
						t.Fatal("invalid username must not reach PostgreSQL")
						return db.User{}, nil
					},
				}
				_, err := NewAdminUserService(q).CreateUser(ctx, AdminCreateUserInput{Username: username})
				require.Error(t, err)
				apiErr, ok := err.(*pkgerrors.APIError)
				require.True(t, ok, "expected *APIError, got %T", err)
				assert.Equal(t, 422, apiErr.Status)
			})
		}
	})

	t.Run("returns conflict error on duplicate username", func(t *testing.T) {
		t.Parallel()

		q := &mockAdminUserQuerier{
			createUserFn: func(ctx context.Context, arg db.CreateUserParams) (db.User, error) {
				return db.User{}, &pgconn.PgError{Code: "23505", ConstraintName: "owner_namespaces_pkey"}
			},
		}

		svc := NewAdminUserService(q)
		_, err := svc.CreateUser(ctx, AdminCreateUserInput{Username: "existinguser"})
		require.Error(t, err)
		apiErr, ok := err.(*pkgerrors.APIError)
		require.True(t, ok, "expected *APIError, got %T", err)
		assert.Equal(t, 409, apiErr.Status)
	})

	t.Run("returns internal error when db fails", func(t *testing.T) {
		t.Parallel()

		q := &mockAdminUserQuerier{
			createUserFn: func(ctx context.Context, arg db.CreateUserParams) (db.User, error) {
				return db.User{}, errors.New("db error")
			},
		}

		svc := NewAdminUserService(q)
		_, err := svc.CreateUser(ctx, AdminCreateUserInput{Username: "anyuser"})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "failed to create user")
	})

	t.Run("sets email and lower_email when email provided", func(t *testing.T) {
		t.Parallel()

		var capturedArg db.CreateUserParams
		q := &mockAdminUserQuerier{
			createUserFn: func(ctx context.Context, arg db.CreateUserParams) (db.User, error) {
				capturedArg = arg
				return makeDBUser(1, arg.Username, false), nil
			},
		}

		svc := NewAdminUserService(q)
		_, err := svc.CreateUser(ctx, AdminCreateUserInput{Username: "emailuser", Email: "Email@Example.COM"})
		require.NoError(t, err)
		assert.True(t, capturedArg.Email.Valid)
		assert.Equal(t, "Email@Example.COM", capturedArg.Email.String)
		assert.True(t, capturedArg.LowerEmail.Valid)
		assert.Equal(t, "email@example.com", capturedArg.LowerEmail.String)
	})
}

func TestAdminUserService_DeleteUser(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	t.Run("suspends existing user and preserves history", func(t *testing.T) {
		t.Parallel()

		target := makeDBUser(10, "targetuser", false)
		var suspendedID int64

		q := &mockAdminUserQuerier{
			getUserByLowerUsernameFn: func(ctx context.Context, lowerUsername string) (db.User, error) {
				assert.Equal(t, "targetuser", lowerUsername)
				return target, nil
			},
			suspendUserFn: func(ctx context.Context, id int64) error {
				suspendedID = id
				return nil
			},
		}

		auditor := &mockAdminAuditor{}
		svc := NewAdminUserService(q, WithAdminAuditor(auditor))
		err := svc.DeleteUser(adminAuditTestContext(), "targetuser")
		require.NoError(t, err)
		assert.Equal(t, int64(10), suspendedID)
		// Verify audit event was written
		require.Len(t, auditor.events, 1)
		ev := auditor.events[0]
		assert.Equal(t, "admin.user.suspend", ev.EventType)
		assert.Equal(t, "suspend", ev.Action)
		assert.Equal(t, "targetuser", ev.TargetName)
		assertAdminAuditActor(t, ev)
	})

	t.Run("audit event written even on minimal service setup", func(t *testing.T) {
		t.Parallel()

		target := makeDBUser(20, "userA", false)
		q := &mockAdminUserQuerier{
			getUserByLowerUsernameFn: func(ctx context.Context, lowerUsername string) (db.User, error) {
				return target, nil
			},
			suspendUserFn: func(ctx context.Context, id int64) error { return nil },
		}
		auditor := &mockAdminAuditor{}
		svc := NewAdminUserService(q, WithAdminAuditor(auditor))
		require.NoError(t, svc.DeleteUser(adminAuditTestContext(), "userA"))
		assert.Len(t, auditor.events, 1)
		assertAdminAuditActor(t, auditor.events[0])
	})

	t.Run("no audit event when auditor not configured", func(t *testing.T) {
		t.Parallel()

		target := makeDBUser(30, "userB", false)
		q := &mockAdminUserQuerier{
			getUserByLowerUsernameFn: func(ctx context.Context, lowerUsername string) (db.User, error) {
				return target, nil
			},
			suspendUserFn: func(ctx context.Context, id int64) error { return nil },
		}
		svc := NewAdminUserService(q) // no auditor
		require.NoError(t, svc.DeleteUser(ctx, "userB"))
	})

	t.Run("returns not found when user does not exist", func(t *testing.T) {
		t.Parallel()

		q := &mockAdminUserQuerier{
			getUserByLowerUsernameFn: func(ctx context.Context, lowerUsername string) (db.User, error) {
				return db.User{}, pgx.ErrNoRows
			},
		}

		svc := NewAdminUserService(q)
		err := svc.DeleteUser(ctx, "ghostuser")
		require.Error(t, err)
		apiErr, ok := err.(*pkgerrors.APIError)
		require.True(t, ok, "expected *APIError, got %T", err)
		assert.Equal(t, 404, apiErr.Status)
	})

	t.Run("returns bad request for empty username", func(t *testing.T) {
		t.Parallel()

		q := &mockAdminUserQuerier{}
		svc := NewAdminUserService(q)
		err := svc.DeleteUser(ctx, "")
		require.Error(t, err)
		apiErr, ok := err.(*pkgerrors.APIError)
		require.True(t, ok, "expected *APIError, got %T", err)
		assert.Equal(t, 400, apiErr.Status)
	})

	t.Run("lowercases username for lookup", func(t *testing.T) {
		t.Parallel()

		var capturedLowerUsername string
		q := &mockAdminUserQuerier{
			getUserByLowerUsernameFn: func(ctx context.Context, lowerUsername string) (db.User, error) {
				capturedLowerUsername = lowerUsername
				return makeDBUser(5, "Mixedcase", false), nil
			},
			suspendUserFn: func(ctx context.Context, id int64) error { return nil },
		}

		svc := NewAdminUserService(q)
		err := svc.DeleteUser(ctx, "MixedCase")
		require.NoError(t, err)
		assert.Equal(t, "mixedcase", capturedLowerUsername)
	})

	t.Run("returns internal error when suspend fails", func(t *testing.T) {
		t.Parallel()

		q := &mockAdminUserQuerier{
			getUserByLowerUsernameFn: func(ctx context.Context, lowerUsername string) (db.User, error) {
				return makeDBUser(7, "someone", false), nil
			},
			suspendUserFn: func(ctx context.Context, id int64) error {
				return errors.New("constraint violation")
			},
		}

		svc := NewAdminUserService(q)
		err := svc.DeleteUser(ctx, "someone")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "failed to suspend user")
	})
}

func TestAdminUserService_SetUserAdmin(t *testing.T) {
	t.Parallel()

	t.Run("grants admin and writes audit event", func(t *testing.T) {
		t.Parallel()

		target := makeDBUser(10, "bob", false)
		q := &mockAdminUserQuerier{
			getUserByLowerUsernameFn: func(ctx context.Context, lowerUsername string) (db.User, error) {
				return target, nil
			},
			setUserAdminFn: func(ctx context.Context, arg db.SetUserAdminParams) error {
				assert.True(t, arg.IsAdmin)
				return nil
			},
		}
		auditor := &mockAdminAuditor{}
		svc := NewAdminUserService(q, WithAdminAuditor(auditor))
		profile, err := svc.SetUserAdmin(adminAuditTestContext(), "bob", true)
		require.NoError(t, err)
		assert.True(t, profile.IsAdmin)
		require.Len(t, auditor.events, 1)
		ev := auditor.events[0]
		assert.Equal(t, "admin.user.set_admin", ev.EventType)
		assert.Equal(t, "grant_admin", ev.Action)
		assertAdminAuditActor(t, ev)
	})

	t.Run("revokes admin and writes audit event", func(t *testing.T) {
		t.Parallel()

		target := makeDBUser(11, "carol", true)
		q := &mockAdminUserQuerier{
			getUserByLowerUsernameFn: func(ctx context.Context, lowerUsername string) (db.User, error) {
				return target, nil
			},
			setUserAdminFn: func(ctx context.Context, arg db.SetUserAdminParams) error { return nil },
		}
		auditor := &mockAdminAuditor{}
		svc := NewAdminUserService(q, WithAdminAuditor(auditor))
		profile, err := svc.SetUserAdmin(adminAuditTestContext(), "carol", false)
		require.NoError(t, err)
		assert.False(t, profile.IsAdmin)
		require.Len(t, auditor.events, 1)
		assert.Equal(t, "revoke_admin", auditor.events[0].Action)
		assertAdminAuditActor(t, auditor.events[0])
	})
}

func TestAdminUserService_CreateTokenForUser_AuditEvent(t *testing.T) {
	t.Parallel()

	t.Run("audit event written on token creation", func(t *testing.T) {
		t.Parallel()

		target := makeDBUser(20, "dave", false)
		q := &mockAdminUserQuerier{
			getUserByLowerUsernameFn: func(ctx context.Context, lowerUsername string) (db.User, error) {
				return target, nil
			},
		}

		created := CreateTokenResult{Token: "smithers_abc123", TokenSummary: TokenSummary{ID: 42}}
		tc := &mockTokenCreator{
			createTokenFn: func(ctx context.Context, userID int64, req CreateTokenRequest) (CreateTokenResult, error) {
				return created, nil
			},
		}

		auditor := &mockAdminAuditor{}
		svc := NewAdminUserService(q, WithTokenCreator(tc), WithAdminAuditor(auditor))
		result, err := svc.CreateTokenForUser(adminAuditTestContext(), "dave", CreateTokenRequest{
			Name:   "ci-token",
			Scopes: []string{"read:repository"},
		})
		require.NoError(t, err)
		assert.Equal(t, "smithers_abc123", result.Token)
		require.Len(t, auditor.events, 1)
		ev := auditor.events[0]
		assert.Equal(t, "admin.user.create_token", ev.EventType)
		assert.Equal(t, "create_token", ev.Action)
		assert.Equal(t, "dave", ev.TargetName)
		assertAdminAuditActor(t, ev)
	})
}

// mockTokenCreator satisfies TokenCreator for tests.
type mockTokenCreator struct {
	createTokenFn func(ctx context.Context, userID int64, req CreateTokenRequest) (CreateTokenResult, error)
}

func (m *mockTokenCreator) CreateToken(ctx context.Context, userID int64, req CreateTokenRequest) (CreateTokenResult, error) {
	if m.createTokenFn != nil {
		return m.createTokenFn(ctx, userID, req)
	}
	return CreateTokenResult{}, nil
}

func TestAdminUserService_SetSuspended(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	t.Run("suspends user and writes audit event", func(t *testing.T) {
		t.Parallel()

		target := makeDBUser(10, "alice", false)
		var capturedArg db.SetUserSuspendedParams
		updated := target
		updated.ProhibitLogin = true
		updated.IsActive = false

		q := &mockAdminUserQuerier{
			adminGetUserForSuspensionFn: func(ctx context.Context, lowerUsername string) (db.User, error) {
				return target, nil
			},
			setUserSuspendedFn: func(ctx context.Context, arg db.SetUserSuspendedParams) (db.User, error) {
				capturedArg = arg
				return updated, nil
			},
		}
		auditor := &mockAdminAuditor{}
		svc := NewAdminUserService(q, WithAdminAuditor(auditor))
		profile, err := svc.SetSuspended(adminAuditTestContext(), "alice", true)
		require.NoError(t, err)
		assert.True(t, profile.Suspended)
		assert.Equal(t, int64(10), capturedArg.UserID)
		assert.True(t, capturedArg.Suspended)
		require.Len(t, auditor.events, 1)
		ev := auditor.events[0]
		assert.Equal(t, "admin.user.set_suspended", ev.EventType)
		assert.Equal(t, "suspend", ev.Action)
		assert.Equal(t, "alice", ev.TargetName)
		assertAdminAuditActor(t, ev)
	})

	t.Run("unsuspends user and writes audit event with unsuspend action", func(t *testing.T) {
		t.Parallel()

		target := makeDBUser(11, "bob", false)
		target.ProhibitLogin = true
		target.IsActive = false
		restored := target
		restored.ProhibitLogin = false
		restored.IsActive = true

		q := &mockAdminUserQuerier{
			adminGetUserForSuspensionFn: func(ctx context.Context, lowerUsername string) (db.User, error) {
				return target, nil
			},
			setUserSuspendedFn: func(ctx context.Context, arg db.SetUserSuspendedParams) (db.User, error) {
				assert.False(t, arg.Suspended)
				return restored, nil
			},
		}
		auditor := &mockAdminAuditor{}
		svc := NewAdminUserService(q, WithAdminAuditor(auditor))
		profile, err := svc.SetSuspended(adminAuditTestContext(), "bob", false)
		require.NoError(t, err)
		assert.False(t, profile.Suspended)
		require.Len(t, auditor.events, 1)
		assert.Equal(t, "unsuspend", auditor.events[0].Action)
		assertAdminAuditActor(t, auditor.events[0])
	})

	t.Run("returns not found when user does not exist", func(t *testing.T) {
		t.Parallel()

		q := &mockAdminUserQuerier{
			adminGetUserForSuspensionFn: func(ctx context.Context, lowerUsername string) (db.User, error) {
				return db.User{}, pgx.ErrNoRows
			},
		}
		svc := NewAdminUserService(q)
		_, err := svc.SetSuspended(ctx, "ghost", true)
		require.Error(t, err)
		apiErr, ok := err.(*pkgerrors.APIError)
		require.True(t, ok)
		assert.Equal(t, 404, apiErr.Status)
	})

	t.Run("returns bad request for empty username", func(t *testing.T) {
		t.Parallel()

		svc := NewAdminUserService(&mockAdminUserQuerier{})
		_, err := svc.SetSuspended(ctx, "", true)
		require.Error(t, err)
		apiErr, ok := err.(*pkgerrors.APIError)
		require.True(t, ok)
		assert.Equal(t, 400, apiErr.Status)
	})

	t.Run("returns internal error when db update fails", func(t *testing.T) {
		t.Parallel()

		q := &mockAdminUserQuerier{
			adminGetUserForSuspensionFn: func(ctx context.Context, lowerUsername string) (db.User, error) {
				return makeDBUser(5, "charlie", false), nil
			},
			setUserSuspendedFn: func(ctx context.Context, arg db.SetUserSuspendedParams) (db.User, error) {
				return db.User{}, errors.New("db error")
			},
		}
		svc := NewAdminUserService(q)
		_, err := svc.SetSuspended(ctx, "charlie", true)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "failed to update suspension status")
	})

	t.Run("returns not found if user is deleted after lookup", func(t *testing.T) {
		t.Parallel()

		q := &mockAdminUserQuerier{
			adminGetUserForSuspensionFn: func(context.Context, string) (db.User, error) {
				return makeDBUser(7, "removed", false), nil
			},
			setUserSuspendedFn: func(context.Context, db.SetUserSuspendedParams) (db.User, error) {
				return db.User{}, pgx.ErrNoRows
			},
		}
		_, err := NewAdminUserService(q).SetSuspended(ctx, "removed", false)
		require.Equal(t, http.StatusNotFound, apiStatus(t, err))
	})

	t.Run("no audit event when auditor not configured", func(t *testing.T) {
		t.Parallel()

		target := makeDBUser(6, "dave", false)
		q := &mockAdminUserQuerier{
			adminGetUserForSuspensionFn: func(ctx context.Context, lowerUsername string) (db.User, error) {
				return target, nil
			},
			setUserSuspendedFn: func(ctx context.Context, arg db.SetUserSuspendedParams) (db.User, error) {
				return target, nil
			},
		}
		svc := NewAdminUserService(q) // no auditor
		_, err := svc.SetSuspended(ctx, "dave", true)
		require.NoError(t, err)
	})
}

func makeDBToken(id, userID int64, name string) db.AccessToken {
	now := time.Now().UTC()
	return db.AccessToken{
		ID:        id,
		UserID:    userID,
		Name:      name,
		CreatedAt: now,
		UpdatedAt: now,
	}
}

func TestAdminUserService_RevokeToken(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	t.Run("revokes token and writes audit event", func(t *testing.T) {
		t.Parallel()

		target := makeDBUser(20, "eve", false)
		token := makeDBToken(42, 20, "ci-token")
		var deletedArg db.DeleteAccessTokenByIDAndUserIDParams

		q := &mockAdminUserQuerier{
			getUserByLowerUsernameFn: func(ctx context.Context, lowerUsername string) (db.User, error) {
				return target, nil
			},
			getAccessTokenByIDFn: func(ctx context.Context, id int64) (db.AccessToken, error) {
				assert.Equal(t, int64(42), id)
				return token, nil
			},
			deleteAccessTokenByIDAndUserID: func(ctx context.Context, arg db.DeleteAccessTokenByIDAndUserIDParams) (int64, error) {
				deletedArg = arg
				return 1, nil
			},
		}
		auditor := &mockAdminAuditor{}
		svc := NewAdminUserService(q, WithAdminAuditor(auditor))
		err := svc.RevokeToken(adminAuditTestContext(), "eve", 42)
		require.NoError(t, err)
		assert.Equal(t, int64(42), deletedArg.ID)
		assert.Equal(t, int64(20), deletedArg.UserID)
		require.Len(t, auditor.events, 1)
		ev := auditor.events[0]
		assert.Equal(t, "admin.user.revoke_token", ev.EventType)
		assert.Equal(t, "revoke_token", ev.Action)
		assert.Equal(t, "eve", ev.TargetName)
		assertAdminAuditActor(t, ev)
	})

	t.Run("returns not found when user does not exist", func(t *testing.T) {
		t.Parallel()

		q := &mockAdminUserQuerier{
			getUserByLowerUsernameFn: func(ctx context.Context, lowerUsername string) (db.User, error) {
				return db.User{}, pgx.ErrNoRows
			},
		}
		svc := NewAdminUserService(q)
		err := svc.RevokeToken(ctx, "ghost", 1)
		require.Error(t, err)
		apiErr, ok := err.(*pkgerrors.APIError)
		require.True(t, ok)
		assert.Equal(t, 404, apiErr.Status)
	})

	t.Run("returns not found when token does not exist", func(t *testing.T) {
		t.Parallel()

		q := &mockAdminUserQuerier{
			getUserByLowerUsernameFn: func(ctx context.Context, lowerUsername string) (db.User, error) {
				return makeDBUser(5, "frank", false), nil
			},
			getAccessTokenByIDFn: func(ctx context.Context, id int64) (db.AccessToken, error) {
				return db.AccessToken{}, pgx.ErrNoRows
			},
		}
		svc := NewAdminUserService(q)
		err := svc.RevokeToken(ctx, "frank", 99)
		require.Error(t, err)
		apiErr, ok := err.(*pkgerrors.APIError)
		require.True(t, ok)
		assert.Equal(t, 404, apiErr.Status)
	})

	t.Run("returns not found when token belongs to a different user", func(t *testing.T) {
		t.Parallel()

		q := &mockAdminUserQuerier{
			getUserByLowerUsernameFn: func(ctx context.Context, lowerUsername string) (db.User, error) {
				return makeDBUser(10, "grace", false), nil
			},
			getAccessTokenByIDFn: func(ctx context.Context, id int64) (db.AccessToken, error) {
				// Token belongs to user 99, not user 10
				return makeDBToken(7, 99, "other-user-token"), nil
			},
		}
		svc := NewAdminUserService(q)
		err := svc.RevokeToken(ctx, "grace", 7)
		require.Error(t, err)
		apiErr, ok := err.(*pkgerrors.APIError)
		require.True(t, ok)
		assert.Equal(t, 404, apiErr.Status)
	})

	t.Run("returns bad request for empty username", func(t *testing.T) {
		t.Parallel()

		svc := NewAdminUserService(&mockAdminUserQuerier{})
		err := svc.RevokeToken(ctx, "", 1)
		require.Error(t, err)
		apiErr, ok := err.(*pkgerrors.APIError)
		require.True(t, ok)
		assert.Equal(t, 400, apiErr.Status)
	})

	t.Run("returns internal error when delete fails", func(t *testing.T) {
		t.Parallel()

		target := makeDBUser(15, "henry", false)
		token := makeDBToken(8, 15, "dev-token")

		q := &mockAdminUserQuerier{
			getUserByLowerUsernameFn: func(ctx context.Context, lowerUsername string) (db.User, error) {
				return target, nil
			},
			getAccessTokenByIDFn: func(ctx context.Context, id int64) (db.AccessToken, error) {
				return token, nil
			},
			deleteAccessTokenByIDAndUserID: func(ctx context.Context, arg db.DeleteAccessTokenByIDAndUserIDParams) (int64, error) {
				return 0, errors.New("db error")
			},
		}
		svc := NewAdminUserService(q)
		err := svc.RevokeToken(ctx, "henry", 8)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "failed to revoke token")
	})

	t.Run("returns not found when delete returns zero rows", func(t *testing.T) {
		t.Parallel()

		target := makeDBUser(16, "iris", false)
		token := makeDBToken(9, 16, "api-token")

		q := &mockAdminUserQuerier{
			getUserByLowerUsernameFn: func(ctx context.Context, lowerUsername string) (db.User, error) {
				return target, nil
			},
			getAccessTokenByIDFn: func(ctx context.Context, id int64) (db.AccessToken, error) {
				return token, nil
			},
			deleteAccessTokenByIDAndUserID: func(ctx context.Context, arg db.DeleteAccessTokenByIDAndUserIDParams) (int64, error) {
				return 0, nil // concurrent deletion
			},
		}
		svc := NewAdminUserService(q)
		err := svc.RevokeToken(ctx, "iris", 9)
		require.Error(t, err)
		apiErr, ok := err.(*pkgerrors.APIError)
		require.True(t, ok)
		assert.Equal(t, 404, apiErr.Status)
	})

	t.Run("no audit event when auditor not configured", func(t *testing.T) {
		t.Parallel()

		target := makeDBUser(17, "jake", false)
		token := makeDBToken(11, 17, "test-token")

		q := &mockAdminUserQuerier{
			getUserByLowerUsernameFn: func(ctx context.Context, lowerUsername string) (db.User, error) {
				return target, nil
			},
			getAccessTokenByIDFn: func(ctx context.Context, id int64) (db.AccessToken, error) {
				return token, nil
			},
			deleteAccessTokenByIDAndUserID: func(ctx context.Context, arg db.DeleteAccessTokenByIDAndUserIDParams) (int64, error) {
				return 1, nil
			},
		}
		svc := NewAdminUserService(q) // no auditor
		err := svc.RevokeToken(ctx, "jake", 11)
		require.NoError(t, err)
	})
}

func TestAdminUserService_CreateUser_AuditEvent(t *testing.T) {
	t.Parallel()

	t.Run("audit event written on user creation", func(t *testing.T) {
		t.Parallel()

		created := makeDBUser(55, "newuser", false)
		q := &mockAdminUserQuerier{
			createUserFn: func(ctx context.Context, arg db.CreateUserParams) (db.User, error) {
				return created, nil
			},
		}
		auditor := &mockAdminAuditor{}
		svc := NewAdminUserService(q, WithAdminAuditor(auditor))
		profile, err := svc.CreateUser(adminAuditTestContext(), AdminCreateUserInput{Username: "newuser", Email: "newuser@example.com"})
		require.NoError(t, err)
		assert.Equal(t, "newuser", profile.Username)
		require.Len(t, auditor.events, 1)
		ev := auditor.events[0]
		assert.Equal(t, "admin.user.create", ev.EventType)
		assert.Equal(t, "create_user", ev.Action)
		assert.Equal(t, "newuser", ev.TargetName)
		assertAdminAuditActor(t, ev)
	})
}
