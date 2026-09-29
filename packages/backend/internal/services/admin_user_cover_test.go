package services

import (
	"context"
	stdErrors "errors"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestAdminUser_Cov_DeleteSetAdminCreateTokenErrorBranches(t *testing.T) {
	ctx := context.Background()

	svc := NewAdminUserService(&mockAdminUserQuerier{
		getUserByLowerUsernameFn: func(context.Context, string) (db.User, error) {
			return db.User{}, stdErrors.New("lookup failed")
		},
	})
	err := svc.DeleteUser(ctx, "alice")
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, adminUserCovStatus(t, err))

	_, err = svc.SetUserAdmin(ctx, " ", true)
	require.Error(t, err)
	assert.Equal(t, http.StatusBadRequest, adminUserCovStatus(t, err))

	_, err = svc.SetUserAdmin(ctx, "missing", true)
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, adminUserCovStatus(t, err))

	svc = NewAdminUserService(&mockAdminUserQuerier{
		getUserByLowerUsernameFn: func(context.Context, string) (db.User, error) {
			return makeDBUser(7, "alice", false), nil
		},
		setUserAdminFn: func(context.Context, db.SetUserAdminParams) error {
			return assert.AnError
		},
	})
	_, err = svc.SetUserAdmin(ctx, "alice", true)
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, adminUserCovStatus(t, err))

	svc = NewAdminUserService(&mockAdminUserQuerier{})
	_, err = svc.CreateTokenForUser(ctx, "alice", CreateTokenRequest{Name: "ci"})
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, adminUserCovStatus(t, err))

	svc = NewAdminUserService(&mockAdminUserQuerier{}, WithTokenCreator(&mockTokenCreator{}))
	_, err = svc.CreateTokenForUser(ctx, " ", CreateTokenRequest{Name: "ci"})
	require.Error(t, err)
	assert.Equal(t, http.StatusBadRequest, adminUserCovStatus(t, err))

	svc = NewAdminUserService(&mockAdminUserQuerier{
		getUserByLowerUsernameFn: func(context.Context, string) (db.User, error) {
			return db.User{}, pgx.ErrNoRows
		},
	}, WithTokenCreator(&mockTokenCreator{}))
	_, err = svc.CreateTokenForUser(ctx, "missing", CreateTokenRequest{Name: "ci"})
	require.Error(t, err)
	assert.Equal(t, http.StatusNotFound, adminUserCovStatus(t, err))

	svc = NewAdminUserService(&mockAdminUserQuerier{
		getUserByLowerUsernameFn: func(context.Context, string) (db.User, error) {
			return makeDBUser(9, "alice", false), nil
		},
	}, WithTokenCreator(&mockTokenCreator{
		createTokenFn: func(context.Context, int64, CreateTokenRequest) (CreateTokenResult, error) {
			return CreateTokenResult{}, pkgerrors.Forbidden("quota")
		},
	}))
	_, err = svc.CreateTokenForUser(ctx, "alice", CreateTokenRequest{Name: "ci"})
	require.Error(t, err)
	assert.Equal(t, http.StatusForbidden, adminUserCovStatus(t, err))
}

func TestAdminUser_Cov_SetSuspendedAndRevokeTokenErrorBranches(t *testing.T) {
	ctx := context.Background()

	svc := NewAdminUserService(&mockAdminUserQuerier{
		adminGetUserForSuspensionFn: func(context.Context, string) (db.User, error) {
			return db.User{}, stdErrors.New("lookup failed")
		},
	})
	_, err := svc.SetSuspended(ctx, "alice", true)
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, adminUserCovStatus(t, err))

	svc = NewAdminUserService(&mockAdminUserQuerier{
		getUserByLowerUsernameFn: func(context.Context, string) (db.User, error) {
			return db.User{}, stdErrors.New("lookup failed")
		},
	})
	err = svc.RevokeToken(ctx, "alice", 1)
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, adminUserCovStatus(t, err))

	svc = NewAdminUserService(&mockAdminUserQuerier{
		getUserByLowerUsernameFn: func(context.Context, string) (db.User, error) {
			return makeDBUser(10, "alice", false), nil
		},
		getAccessTokenByIDFn: func(context.Context, int64) (db.AccessToken, error) {
			return db.AccessToken{}, stdErrors.New("token lookup failed")
		},
	})
	err = svc.RevokeToken(ctx, "alice", 1)
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, adminUserCovStatus(t, err))
}

func adminUserCovStatus(t *testing.T, err error) int {
	t.Helper()
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	return apiErr.Status
}
