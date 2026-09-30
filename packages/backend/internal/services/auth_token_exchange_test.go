package services

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func exchangeMockGitHubClient() mockGitHubClient {
	return mockGitHubClient{
		fetchUserFn: func(ctx context.Context, accessToken string) (GitHubUserProfile, error) {
			return GitHubUserProfile{ID: 777, Login: "octo", Name: "Octo Cat"}, nil
		},
		fetchEmailsFn: func(ctx context.Context, accessToken string) ([]GitHubEmail, error) {
			return []GitHubEmail{{Email: "octo@example.com", Primary: true, Verified: true}}, nil
		},
	}
}

func TestAuthService_ExchangeGitHubToken_ExistingUser(t *testing.T) {
	t.Parallel()

	existingUser := db.User{ID: 42, Username: "octo"}
	var deletedTokenID int64
	querier := &mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(ctx context.Context, arg db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			assert.Equal(t, "workos", arg.Provider)
			assert.Equal(t, "777", arg.ProviderUserID)
			return db.OauthAccount{UserID: existingUser.ID}, nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			return existingUser, nil
		},
		upsertOAuthAccountFn: func(ctx context.Context, arg db.UpsertOAuthAccountParams) (db.OauthAccount, error) {
			return db.OauthAccount{UserID: arg.UserID}, nil
		},
		upsertEmailAddressFn: func(ctx context.Context, arg db.UpsertEmailAddressParams) (db.UpsertEmailAddressRow, error) {
			return db.UpsertEmailAddressRow{}, nil
		},
		listAccessTokensByUserIDFn: func(ctx context.Context, userID int64) ([]db.AccessToken, error) {
			return []db.AccessToken{{ID: 9, UserID: userID, Name: "multi-worker"}}, nil
		},
		deleteAccessTokenByIDAndUserIDFn: func(ctx context.Context, arg db.DeleteAccessTokenByIDAndUserIDParams) (int64, error) {
			deletedTokenID = arg.ID
			return 1, nil
		},
		createAccessTokenFn: func(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
			assert.Equal(t, "multi-worker", arg.Name)
			return db.AccessToken{ID: 10, UserID: arg.UserID, Name: arg.Name, TokenLastEight: arg.TokenLastEight, Scopes: arg.Scopes}, nil
		},
	}

	m := newObserveV2Metrics()
	svc := NewAuthService(querier, defaultAuthConfig(), nil, exchangeMockGitHubClient(), WithAuthMetrics(m))

	result, err := svc.ExchangeGitHubToken(context.Background(), "gho_real_token", "", "", 0, nil)
	require.NoError(t, err)
	assert.Equal(t, existingUser.ID, result.User.ID)
	assert.Equal(t, int64(10), result.TokenID)
	assert.True(t, len(result.Token) > 9 && result.Token[:9] == "smithers_", "token should be a smithers_ PAT, got %q", result.Token)
	assert.Equal(t, int64(9), deletedTokenID, "existing same-name token should be rotated out")
	require.Equal(t, 1.0, testutil.ToFloat64(m.auth.WithLabelValues("github", "success")))
}

// A concurrent exchange must not delete a same-name token NEWER than the one it
// just minted. Interleave: call A creates id=10 while call B has already created
// id=11. A lists [9,10,11]; it must delete only the strictly-older id=9, never
// id=11 (B's fresh token) nor its own id=10 — otherwise both callers hand back a
// hard-deleted credential.
func TestAuthService_ExchangeGitHubToken_ConcurrentMintNotDeleted(t *testing.T) {
	t.Parallel()

	existingUser := db.User{ID: 42, Username: "octo"}
	var deleted []int64
	querier := &mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(ctx context.Context, arg db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return db.OauthAccount{UserID: existingUser.ID}, nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) { return existingUser, nil },
		upsertOAuthAccountFn: func(ctx context.Context, arg db.UpsertOAuthAccountParams) (db.OauthAccount, error) {
			return db.OauthAccount{UserID: arg.UserID}, nil
		},
		upsertEmailAddressFn: func(ctx context.Context, arg db.UpsertEmailAddressParams) (db.UpsertEmailAddressRow, error) {
			return db.UpsertEmailAddressRow{}, nil
		},
		listAccessTokensByUserIDFn: func(ctx context.Context, userID int64) ([]db.AccessToken, error) {
			return []db.AccessToken{
				{ID: 9, UserID: userID, Name: "multi-worker"},
				{ID: 10, UserID: userID, Name: "multi-worker"},
				{ID: 11, UserID: userID, Name: "multi-worker"}, // a concurrent exchange's newer mint
			}, nil
		},
		deleteAccessTokenByIDAndUserIDFn: func(ctx context.Context, arg db.DeleteAccessTokenByIDAndUserIDParams) (int64, error) {
			deleted = append(deleted, arg.ID)
			return 1, nil
		},
		createAccessTokenFn: func(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
			return db.AccessToken{ID: 10, UserID: arg.UserID, Name: arg.Name, Scopes: arg.Scopes}, nil
		},
	}

	svc := NewAuthService(querier, defaultAuthConfig(), nil, exchangeMockGitHubClient())

	_, err := svc.ExchangeGitHubToken(context.Background(), "gho_real_token", "", "", 0, nil)
	require.NoError(t, err)
	assert.Equal(t, []int64{9}, deleted, "only strictly-older same-name tokens may be deleted (never id 10 or the concurrent id 11)")
}

func TestAuthService_ExchangeGitHubToken_CreatesNewUser(t *testing.T) {
	t.Parallel()

	var createdUsername string
	querier := &mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(ctx context.Context, arg db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return db.OauthAccount{}, pgx.ErrNoRows
		},
		createUserFn: func(ctx context.Context, arg db.CreateUserParams) (db.User, error) {
			createdUsername = arg.Username
			return db.User{ID: 100, Username: arg.Username, Email: pgtype.Text{String: "octo@example.com", Valid: true}}, nil
		},
		upsertOAuthAccountFn: func(ctx context.Context, arg db.UpsertOAuthAccountParams) (db.OauthAccount, error) {
			return db.OauthAccount{UserID: arg.UserID}, nil
		},
		upsertEmailAddressFn: func(ctx context.Context, arg db.UpsertEmailAddressParams) (db.UpsertEmailAddressRow, error) {
			return db.UpsertEmailAddressRow{}, nil
		},
		listAccessTokensByUserIDFn: func(ctx context.Context, userID int64) ([]db.AccessToken, error) {
			return nil, nil
		},
		createAccessTokenFn: func(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
			return db.AccessToken{ID: 1, UserID: arg.UserID, Name: arg.Name, Scopes: arg.Scopes}, nil
		},
	}

	svc := NewAuthService(querier, defaultAuthConfig(), nil, exchangeMockGitHubClient())

	result, err := svc.ExchangeGitHubToken(context.Background(), "gho_real_token", "custom-name", "", 0, nil)
	require.NoError(t, err)
	assert.Equal(t, "octo", createdUsername)
	assert.Equal(t, int64(100), result.User.ID)
	assert.Equal(t, int64(1), result.TokenID)
}

func TestAuthService_ExchangeGitHubToken_NoGitHubClient(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{}, defaultAuthConfig(), nil, nil)

	_, err := svc.ExchangeGitHubToken(context.Background(), "gho_real_token", "", "", 0, nil)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "not configured")
}

// exchangeExpiryQuerier is a minimal existing-user querier that captures the
// CreateAccessToken params so expiry tests can assert on expires_at.
func exchangeExpiryQuerier(captured *db.CreateAccessTokenParams) *mockAuthQuerier {
	return &mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(ctx context.Context, arg db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return db.OauthAccount{UserID: 42}, nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			return db.User{ID: 42, Username: "octo"}, nil
		},
		upsertOAuthAccountFn: func(ctx context.Context, arg db.UpsertOAuthAccountParams) (db.OauthAccount, error) {
			return db.OauthAccount{UserID: arg.UserID}, nil
		},
		upsertEmailAddressFn: func(ctx context.Context, arg db.UpsertEmailAddressParams) (db.UpsertEmailAddressRow, error) {
			return db.UpsertEmailAddressRow{}, nil
		},
		listAccessTokensByUserIDFn: func(ctx context.Context, userID int64) ([]db.AccessToken, error) {
			return nil, nil
		},
		createAccessTokenFn: func(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
			*captured = arg
			return db.AccessToken{ID: 10, UserID: arg.UserID, Name: arg.Name, Scopes: arg.Scopes, ExpiresAt: arg.ExpiresAt}, nil
		},
	}
}

func TestAuthService_ExchangeGitHubToken_MultiWorkerDefaultsToEightDayExpiry(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 7, 4, 12, 0, 0, 0, time.UTC)
	var captured db.CreateAccessTokenParams
	svc := NewAuthService(exchangeExpiryQuerier(&captured), defaultAuthConfig(), nil, exchangeMockGitHubClient())
	svc.now = func() time.Time { return now }

	// Legacy exact name, no ttl_seconds: behaves as today PLUS the default
	// 8-day expiry so per-session tokens self-expire.
	result, err := svc.ExchangeGitHubToken(context.Background(), "gho_real_token", "multi-worker", "", 0, nil)
	require.NoError(t, err)
	require.True(t, captured.ExpiresAt.Valid, "multi-worker token must get an expiry")
	assert.Equal(t, now.Add(8*24*time.Hour), captured.ExpiresAt.Time)
	require.NotNil(t, result.ExpiresAt)
	assert.Equal(t, now.Add(8*24*time.Hour), *result.ExpiresAt)
}

func TestAuthService_ExchangeGitHubToken_MultiWorkerPrefixedSessionName(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 7, 4, 12, 0, 0, 0, time.UTC)
	var captured db.CreateAccessTokenParams
	svc := NewAuthService(exchangeExpiryQuerier(&captured), defaultAuthConfig(), nil, exchangeMockGitHubClient())
	svc.now = func() time.Time { return now }

	// Arbitrary per-session names are honored verbatim; the multi-worker
	// prefix still triggers the self-expiry default.
	_, err := svc.ExchangeGitHubToken(context.Background(), "gho_real_token", "multi-worker-session-abc123", "", 0, nil)
	require.NoError(t, err)
	assert.Equal(t, "multi-worker-session-abc123", captured.Name)
	require.True(t, captured.ExpiresAt.Valid)
	assert.Equal(t, now.Add(8*24*time.Hour), captured.ExpiresAt.Time)
}

func TestAuthService_ExchangeGitHubToken_TTLSecondsHonored(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 7, 4, 12, 0, 0, 0, time.UTC)
	var captured db.CreateAccessTokenParams
	svc := NewAuthService(exchangeExpiryQuerier(&captured), defaultAuthConfig(), nil, exchangeMockGitHubClient())
	svc.now = func() time.Time { return now }

	ttl := int64(3600)
	_, err := svc.ExchangeGitHubToken(context.Background(), "gho_real_token", "multi-worker-session-x", "", 0, &ttl)
	require.NoError(t, err)
	require.True(t, captured.ExpiresAt.Valid)
	assert.Equal(t, now.Add(time.Hour), captured.ExpiresAt.Time)
}

func TestAuthService_ExchangeGitHubToken_TTLSecondsCappedAtEightDays(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 7, 4, 12, 0, 0, 0, time.UTC)
	var captured db.CreateAccessTokenParams
	svc := NewAuthService(exchangeExpiryQuerier(&captured), defaultAuthConfig(), nil, exchangeMockGitHubClient())
	svc.now = func() time.Time { return now }

	ttl := int64(30 * 24 * 3600) // 30 days, above the cap
	_, err := svc.ExchangeGitHubToken(context.Background(), "gho_real_token", "multi-worker", "", 0, &ttl)
	require.NoError(t, err)
	require.True(t, captured.ExpiresAt.Valid)
	assert.Equal(t, now.Add(8*24*time.Hour), captured.ExpiresAt.Time, "ttl_seconds must be capped at 8 days")
}

func TestAuthService_ExchangeGitHubToken_NonPositiveTTLRejected(t *testing.T) {
	t.Parallel()

	var captured db.CreateAccessTokenParams
	svc := NewAuthService(exchangeExpiryQuerier(&captured), defaultAuthConfig(), nil, exchangeMockGitHubClient())

	for _, ttl := range []int64{0, -60} {
		ttl := ttl
		_, err := svc.ExchangeGitHubToken(context.Background(), "gho_real_token", "multi-worker", "", 0, &ttl)
		require.Error(t, err, "ttl_seconds=%d must be rejected", ttl)
		apiErr, ok := err.(*pkgerrors.APIError)
		require.True(t, ok, "expected APIError, got %T", err)
		assert.Equal(t, 400, apiErr.Status)
	}
}

func TestAuthService_ExchangeGitHubToken_CustomNameKeepsNinetyDayDefault(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 7, 4, 12, 0, 0, 0, time.UTC)
	var captured db.CreateAccessTokenParams
	svc := NewAuthService(exchangeExpiryQuerier(&captured), defaultAuthConfig(), nil, exchangeMockGitHubClient())
	svc.now = func() time.Time { return now }

	// Non-multi-worker names without ttl_seconds keep the standard PAT
	// default (90 days) — exactly today's behavior.
	_, err := svc.ExchangeGitHubToken(context.Background(), "gho_real_token", "ci-bot", "", 0, nil)
	require.NoError(t, err)
	require.True(t, captured.ExpiresAt.Valid)
	assert.Equal(t, now.Add(90*24*time.Hour), captured.ExpiresAt.Time)
}

func TestAuthService_ExchangeGitHubToken_TTLProvidedRotatesInPlace(t *testing.T) {
	t.Parallel()

	// Rotation semantics are unchanged by expiry: same (user, name) rotates
	// out the old row after minting the replacement.
	var deletedTokenID int64
	querier := exchangeExpiryQuerier(&db.CreateAccessTokenParams{})
	querier.listAccessTokensByUserIDFn = func(ctx context.Context, userID int64) ([]db.AccessToken, error) {
		return []db.AccessToken{{ID: 9, UserID: userID, Name: "multi-worker-session-x"}}, nil
	}
	querier.deleteAccessTokenByIDAndUserIDFn = func(ctx context.Context, arg db.DeleteAccessTokenByIDAndUserIDParams) (int64, error) {
		deletedTokenID = arg.ID
		return 1, nil
	}
	svc := NewAuthService(querier, defaultAuthConfig(), nil, exchangeMockGitHubClient())

	ttl := int64(3600)
	result, err := svc.ExchangeGitHubToken(context.Background(), "gho_real_token", "multi-worker-session-x", "", 0, &ttl)
	require.NoError(t, err)
	assert.Equal(t, int64(10), result.TokenID)
	assert.Equal(t, int64(9), deletedTokenID, "existing same-name token should be rotated out")
}

// Signup is public (#2145): with the deployment's default configuration a
// fresh GitHub account that no one invited gets a Smithers Cloud user and a
// token from the worker exchange; no whitelist or waitlist is consulted.
func TestAuthService_ExchangeGitHubToken_DefaultConfigAdmitsFreshAccount(t *testing.T) {
	cfg, err := config.Load("")
	require.NoError(t, err)
	auth := cfg.Auth
	auth.SessionSecret = "test-session-secret-for-unit-tests"

	var created bool
	querier := &mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(ctx context.Context, arg db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return db.OauthAccount{}, pgx.ErrNoRows
		},
		createUserFn: func(ctx context.Context, arg db.CreateUserParams) (db.User, error) {
			created = true
			return db.User{ID: 100, Username: arg.Username}, nil
		},
		upsertOAuthAccountFn: func(ctx context.Context, arg db.UpsertOAuthAccountParams) (db.OauthAccount, error) {
			return db.OauthAccount{UserID: arg.UserID}, nil
		},
		upsertEmailAddressFn: func(ctx context.Context, arg db.UpsertEmailAddressParams) (db.UpsertEmailAddressRow, error) {
			return db.UpsertEmailAddressRow{}, nil
		},
		listAccessTokensByUserIDFn: func(ctx context.Context, userID int64) ([]db.AccessToken, error) { return nil, nil },
		createAccessTokenFn: func(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
			return db.AccessToken{ID: 1, UserID: arg.UserID, Name: arg.Name, Scopes: arg.Scopes}, nil
		},
	}

	svc := NewAuthService(querier, auth, nil, exchangeMockGitHubClient())
	result, err := svc.ExchangeGitHubToken(context.Background(), "gho_real_token", "", "", 0, nil)
	require.NoError(t, err)
	assert.True(t, created)
	assert.Equal(t, int64(100), result.User.ID)
}
