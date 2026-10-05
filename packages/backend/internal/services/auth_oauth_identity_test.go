package services

import (
	"context"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
)

// GitHub lets anyone list an address they do not own as unverified. Signup
// must not store it as users.email or activate it, or the attacker squats the
// real owner's address and blocks their signup on uq_users_lower_email.
func TestAuthService_ExchangeGitHubToken_UnverifiedEmailIsNeverStored(t *testing.T) {
	t.Parallel()

	var created db.CreateUserParams
	var upserts []db.UpsertEmailAddressParams
	querier := &mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return db.OauthAccount{}, pgx.ErrNoRows
		},
		createUserFn: func(_ context.Context, arg db.CreateUserParams) (db.User, error) {
			created = arg
			return db.User{ID: 100, Username: arg.Username, Email: arg.Email}, nil
		},
		upsertOAuthAccountFn: func(_ context.Context, arg db.UpsertOAuthAccountParams) (db.OauthAccount, error) {
			return db.OauthAccount{UserID: arg.UserID}, nil
		},
		upsertEmailAddressFn: func(_ context.Context, arg db.UpsertEmailAddressParams) (db.UpsertEmailAddressRow, error) {
			upserts = append(upserts, arg)
			return db.UpsertEmailAddressRow{}, nil
		},
		listAccessTokensByUserIDFn: func(context.Context, int64) ([]db.AccessToken, error) { return nil, nil },
		createAccessTokenFn: func(_ context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
			return db.AccessToken{ID: 1, UserID: arg.UserID, Name: arg.Name, Scopes: arg.Scopes}, nil
		},
	}
	client := mockGitHubClient{
		fetchUserFn: func(context.Context, string) (GitHubUserProfile, error) {
			return GitHubUserProfile{ID: 777, Login: "octo"}, nil
		},
		fetchEmailsFn: func(context.Context, string) ([]GitHubEmail, error) {
			return []GitHubEmail{{Email: "victim@corp.example", Primary: true, Verified: false}}, nil
		},
	}

	svc := NewAuthService(querier, defaultAuthConfig(), nil, client)
	_, err := svc.ExchangeGitHubToken(context.Background(), "gho_token", "", "", 0, nil)
	require.NoError(t, err)
	assert.False(t, created.Email.Valid, "users.email must stay NULL without a verified address")
	assert.False(t, created.LowerEmail.Valid)
	assert.Empty(t, upserts, "an unverified address must never be recorded as activated")
}

func TestAuthService_ExchangeGitHubToken_VerifiedEmailIsStored(t *testing.T) {
	t.Parallel()

	var created db.CreateUserParams
	var upserts []db.UpsertEmailAddressParams
	querier := &mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return db.OauthAccount{}, pgx.ErrNoRows
		},
		createUserFn: func(_ context.Context, arg db.CreateUserParams) (db.User, error) {
			created = arg
			return db.User{ID: 100, Username: arg.Username, Email: arg.Email}, nil
		},
		upsertOAuthAccountFn: func(_ context.Context, arg db.UpsertOAuthAccountParams) (db.OauthAccount, error) {
			return db.OauthAccount{UserID: arg.UserID}, nil
		},
		upsertEmailAddressFn: func(_ context.Context, arg db.UpsertEmailAddressParams) (db.UpsertEmailAddressRow, error) {
			upserts = append(upserts, arg)
			return db.UpsertEmailAddressRow{}, nil
		},
		listAccessTokensByUserIDFn: func(context.Context, int64) ([]db.AccessToken, error) { return nil, nil },
		createAccessTokenFn: func(_ context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
			return db.AccessToken{ID: 1, UserID: arg.UserID, Name: arg.Name, Scopes: arg.Scopes}, nil
		},
	}
	client := mockGitHubClient{
		fetchUserFn: func(context.Context, string) (GitHubUserProfile, error) {
			return GitHubUserProfile{ID: 777, Login: "octo"}, nil
		},
		fetchEmailsFn: func(context.Context, string) ([]GitHubEmail, error) {
			return []GitHubEmail{
				{Email: "squat@corp.example", Primary: true, Verified: false},
				{Email: "octo@example.com", Verified: true},
			}, nil
		},
	}

	svc := NewAuthService(querier, defaultAuthConfig(), nil, client)
	_, err := svc.ExchangeGitHubToken(context.Background(), "gho_token", "", "", 0, nil)
	require.NoError(t, err)
	assert.Equal(t, "octo@example.com", created.Email.String)
	require.Len(t, upserts, 1)
	assert.Equal(t, "octo@example.com", upserts[0].Email)
	assert.True(t, upserts[0].IsActivated)
}

// Rotating a same-name PAT deletes the old row; live SSE streams and terminals
// authorized by it must be told, the same way DeleteToken tells them.
func TestAuthService_ExchangeGitHubToken_RotationPublishesRevocation(t *testing.T) {
	t.Parallel()

	publisher := &recordingPublisher{}
	querier := &mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return db.OauthAccount{UserID: 42}, nil
		},
		getUserByIDFn: func(context.Context, int64) (db.User, error) { return db.User{ID: 42, Username: "octo"}, nil },
		upsertOAuthAccountFn: func(_ context.Context, arg db.UpsertOAuthAccountParams) (db.OauthAccount, error) {
			return db.OauthAccount{UserID: arg.UserID}, nil
		},
		upsertEmailAddressFn: func(context.Context, db.UpsertEmailAddressParams) (db.UpsertEmailAddressRow, error) {
			return db.UpsertEmailAddressRow{}, nil
		},
		listAccessTokensByUserIDFn: func(_ context.Context, userID int64) ([]db.AccessToken, error) {
			return []db.AccessToken{
				{ID: 9, UserID: userID, Name: "multi-worker", TokenHash: "old-hash"},
				{ID: 10, UserID: userID, Name: "multi-worker", TokenHash: "new-hash"},
			}, nil
		},
		deleteAccessTokenByIDAndUserIDFn: func(context.Context, db.DeleteAccessTokenByIDAndUserIDParams) (int64, error) {
			return 1, nil
		},
		createAccessTokenFn: func(_ context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
			return db.AccessToken{ID: 10, UserID: arg.UserID, Name: arg.Name, Scopes: arg.Scopes}, nil
		},
	}

	svc := NewAuthService(querier, defaultAuthConfig(), nil, exchangeMockGitHubClient(), WithAuthRevocationPublisher(publisher))
	_, err := svc.ExchangeGitHubToken(context.Background(), "gho_token", "", "", 0, nil)
	require.NoError(t, err)

	events := publisher.all()
	require.Len(t, events, 1)
	assert.Equal(t, revocation.KindTokenRevoked, events[0].Kind)
	assert.Equal(t, int64(42), events[0].UserID)
	assert.Equal(t, int64(9), events[0].TokenID)
	assert.Equal(t, "old-hash", events[0].TokenHash)
}

func TestAuthService_ExchangeGitHubToken_RejectedGitHubTokenIsUnauthorized(t *testing.T) {
	t.Parallel()

	for name, fetchErr := range map[string]struct {
		user   error
		emails error
	}{
		"profile": {user: fmt.Errorf("github user request failed with status 401: %w", ErrGitHubTokenRejected)},
		"emails":  {emails: fmt.Errorf("github emails request failed with status 403: %w", ErrGitHubTokenRejected)},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			client := mockGitHubClient{
				fetchUserFn: func(context.Context, string) (GitHubUserProfile, error) {
					if fetchErr.user != nil {
						return GitHubUserProfile{}, fetchErr.user
					}
					return GitHubUserProfile{ID: 777, Login: "octo"}, nil
				},
				fetchEmailsFn: func(context.Context, string) ([]GitHubEmail, error) {
					return nil, fetchErr.emails
				},
			}
			svc := NewAuthService(&mockAuthQuerier{}, defaultAuthConfig(), nil, client)
			_, err := svc.ExchangeGitHubToken(context.Background(), "gho_expired", "", "", 0, nil)
			var apiErr *pkgerrors.APIError
			require.ErrorAs(t, err, &apiErr)
			assert.Equal(t, 401, apiErr.Status)
		})
	}
}

func TestAuthService_ExchangeGitHubToken_GitHubOutageKeepsCause(t *testing.T) {
	t.Parallel()

	client := mockGitHubClient{
		fetchUserFn: func(context.Context, string) (GitHubUserProfile, error) {
			return GitHubUserProfile{}, fmt.Errorf("github user request failed with status 502")
		},
	}
	svc := NewAuthService(&mockAuthQuerier{}, defaultAuthConfig(), nil, client)
	_, err := svc.ExchangeGitHubToken(context.Background(), "gho_token", "", "", 0, nil)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 500, apiErr.Status)
	require.NotNil(t, apiErr.Cause())
	assert.Contains(t, apiErr.Cause().Error(), "status 502")
	assert.NotContains(t, apiErr.Message, "status 502", "raw upstream details stay private")
}
