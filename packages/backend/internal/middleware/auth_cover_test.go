package middleware

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type authCovOAuthQuerier struct {
	token   db.Oauth2AccessToken
	user    db.User
	userErr error
}

func (q *authCovOAuthQuerier) GetFirstPartyOAuth2AccessTokenByHash(context.Context, string) (db.Oauth2AccessToken, error) {
	return q.token, nil
}

func (q *authCovOAuthQuerier) GetUserByID(context.Context, int64) (db.User, error) {
	return q.user, q.userErr
}

func TestAuth_Cov_LoadOAuth2AccessTokenUserFailures(t *testing.T) {
	t.Parallel()

	t.Run("user lookup error is returned", func(t *testing.T) {
		t.Parallel()

		q := &authCovOAuthQuerier{
			token:   db.Oauth2AccessToken{ID: 12, UserID: 44},
			userErr: assert.AnError,
		}

		info, err := loadOAuth2AccessToken(context.Background(), q, "hash")

		require.Nil(t, info)
		assert.ErrorIs(t, err, assert.AnError)
	})

	t.Run("inactive user is treated as missing token", func(t *testing.T) {
		t.Parallel()

		q := &authCovOAuthQuerier{
			token: db.Oauth2AccessToken{ID: 13, UserID: 45},
			user:  db.User{ID: 45, IsActive: false},
		}

		info, err := loadOAuth2AccessToken(context.Background(), q, "hash")

		require.Nil(t, info)
		assert.ErrorIs(t, err, pgx.ErrNoRows)
	})
}
