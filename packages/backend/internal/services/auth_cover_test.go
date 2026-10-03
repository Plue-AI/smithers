package services

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	smitherscrypto "github.com/smithersai/smithers/packages/backend/internal/pkg/crypto"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestAuth_Cov_Auth0FlowAndSessionRevocation(t *testing.T) {
	ctx := context.Background()
	cfg := defaultAuthConfig()

	svc := NewAuthService(&mockAuthQuerier{}, cfg, mockKeyAuthVerifier{}, mockGitHubClient{})
	_, err := svc.StartAuth0OAuth(ctx, "verifier")
	require.Error(t, err)
	authCovAssertAPIStatus(t, err, 500)

	var createdState db.CreateOAuthStateParams
	var authState string
	queries := &mockAuthQuerier{
		createOAuthStateFn: func(_ context.Context, arg db.CreateOAuthStateParams) (db.OauthState, error) {
			createdState = arg
			return db.OauthState{StateKey: arg.State, ExpiresAt: arg.ExpiresAt}, nil
		},
	}
	svc = NewAuthService(queries, cfg, mockKeyAuthVerifier{}, mockGitHubClient{})
	svc.SetAuth0Client(auth0Fixture(mockGitHubClient{authorizationURL: "https://auth0.test/authorize", authorizationSeen: &authState}))
	svc.generateState = func() string { return "auth0-state" }
	url, err := svc.StartAuth0OAuth(ctx, " verifier ")
	require.NoError(t, err)
	assert.Equal(t, "https://auth0.test/authorize?state=auth0-state", url)
	assert.Equal(t, "auth0-state", createdState.State)
	assert.Equal(t, "auth0-state", authState)
	assert.Equal(t, hashOAuthStateVerifier("verifier"), createdState.ContextHash)

	var upsertProvider string
	queries = &mockAuthQuerier{
		consumeOAuthStateFn: func(_ context.Context, arg db.ConsumeOAuthStateParams) (int64, error) {
			assert.Equal(t, "state-ok", arg.State)
			return 1, nil
		},
		getOAuthAccountByProviderUserIDFn: func(_ context.Context, arg db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			assert.Equal(t, "auth0", arg.Provider)
			return db.OauthAccount{}, pgx.ErrNoRows
		},
		createUserFn: func(_ context.Context, arg db.CreateUserParams) (db.User, error) {
			return db.User{ID: 44, Username: arg.Username, LowerUsername: arg.LowerUsername, Email: arg.Email, IsActive: true}, nil
		},
		upsertOAuthAccountFn: func(_ context.Context, arg db.UpsertOAuthAccountParams) (db.OauthAccount, error) {
			upsertProvider = arg.Provider
			return db.OauthAccount{UserID: arg.UserID, Provider: arg.Provider, ProviderUserID: arg.ProviderUserID}, nil
		},
		upsertEmailAddressFn: func(_ context.Context, arg db.UpsertEmailAddressParams) (db.UpsertEmailAddressRow, error) {
			return db.UpsertEmailAddressRow{UserID: arg.UserID, Email: arg.Email, LowerEmail: arg.LowerEmail, IsPrimary: arg.IsPrimary}, nil
		},
		createAuthSessionFn: func(_ context.Context, arg db.CreateAuthSessionParams) (db.AuthSession, error) {
			return db.AuthSession{SessionKey: arg.SessionKey, UserID: arg.UserID, Username: arg.Username, ExpiresAt: arg.ExpiresAt}, nil
		},
	}
	svc = NewAuthService(queries, cfg, mockKeyAuthVerifier{}, nil)
	svc.SetAuth0Client(auth0Fixture(mockGitHubClient{
		exchangeCodeFn: func(context.Context, string) (GitHubTokenResult, error) {
			return GitHubTokenResult{AccessToken: "auth0-access", RefreshToken: "auth0-refresh"}, nil
		},
		fetchUserFn: func(context.Context, string) (GitHubUserProfile, error) {
			return GitHubUserProfile{ID: 101, Login: "authcat", Name: "Auth Cat"}, nil
		},
		fetchEmailsFn: func(context.Context, string) ([]GitHubEmail, error) {
			return []GitHubEmail{{Email: "authcat@example.com", Primary: true, Verified: true}}, nil
		},
	}))
	result, err := svc.CompleteAuth0OAuth(ctx, "code-ok", "state-ok", "verifier-ok")
	require.NoError(t, err)
	assert.Equal(t, int64(44), result.User.ID)
	assert.Equal(t, "auth0", upsertProvider)
	assert.NotEmpty(t, result.SessionKey)

	sessionKey := "550e8400-e29b-41d4-a716-446655440000"
	publicID := SessionPublicID(sessionKey)
	var deleted string
	svc = NewAuthService(&mockAuthQuerier{
		listUserSessionsFn: func(context.Context, int64) ([]db.AuthSession, error) {
			return []db.AuthSession{{SessionKey: "550e8400-e29b-41d4-a716-446655440001"}, {SessionKey: sessionKey}}, nil
		},
		deleteAuthSessionFn: func(_ context.Context, key string) error {
			deleted = key
			return nil
		},
	}, cfg, nil, nil)
	require.NoError(t, svc.RevokeUserSession(ctx, 44, publicID))
	assert.Equal(t, sessionKey, deleted)
	err = svc.RevokeUserSession(ctx, 44, "missing")
	require.Error(t, err)
	authCovAssertAPIStatus(t, err, 404)
}

func TestAuth_Cov_PickVerifiedEmail(t *testing.T) {
	assert.Equal(t, "", pickVerifiedEmail([]GitHubEmail{{Email: "unverified@example.com", Primary: true, Verified: false}}))
	assert.Equal(t, "primary@example.com", pickVerifiedEmail([]GitHubEmail{
		{Email: "secondary@example.com", Verified: true},
		{Email: "primary@example.com", Primary: true, Verified: true},
	}))
	assert.Equal(t, "verified@example.com", pickVerifiedEmail([]GitHubEmail{
		{Email: "first@example.com"},
		{Email: "verified@example.com", Verified: true},
	}))
}

func TestAuth_Cov_RefreshUserGitHubTokenBranches(t *testing.T) {
	ctx := context.Background()
	cfg := defaultAuthConfig()

	svc := NewAuthService(&mockAuthQuerier{}, cfg, nil, nil)
	_, err := svc.RefreshUserGitHubToken(ctx, db.OauthAccount{})
	require.Error(t, err)
	authCovAssertAPIStatus(t, err, 401)

	oldAccess := authCovEncrypt(t, cfg.SessionSecret, "old-access")
	oldRefresh := authCovEncrypt(t, cfg.SessionSecret, "old-refresh")
	freshAccess := authCovEncrypt(t, cfg.SessionSecret, "fresh-access")
	account := db.OauthAccount{UserID: 7, Provider: "workos", ProviderUserID: "101", AccessTokenEncrypted: oldAccess, RefreshTokenEncrypted: oldRefresh}

	svc = NewAuthService(&mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			current := account
			current.AccessTokenEncrypted = freshAccess
			return current, nil
		},
	}, cfg, nil, mockGitHubClient{
		refreshTokenFn: func(context.Context, string) (GitHubTokenResult, error) {
			t.Fatal("refresh should not run when another request already rotated the access token")
			return GitHubTokenResult{}, nil
		},
	})
	got, err := svc.RefreshUserGitHubToken(ctx, account)
	require.NoError(t, err)
	assert.Equal(t, "fresh-access", got)

	var cleared db.UpsertOAuthAccountParams
	svc = NewAuthService(&mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return account, nil
		},
		upsertOAuthAccountFn: func(_ context.Context, arg db.UpsertOAuthAccountParams) (db.OauthAccount, error) {
			cleared = arg
			return db.OauthAccount{UserID: arg.UserID}, nil
		},
	}, cfg, nil, mockGitHubClient{
		refreshTokenFn: func(context.Context, string) (GitHubTokenResult, error) {
			return GitHubTokenResult{}, ErrGitHubRefreshTokenInvalid
		},
	})
	_, err = svc.RefreshUserGitHubToken(ctx, account)
	require.Error(t, err)
	authCovAssertAPIStatus(t, err, 401)
	assert.Nil(t, cleared.RefreshTokenEncrypted)

	var stored db.UpsertOAuthAccountParams
	svc = NewAuthService(&mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return account, nil
		},
		upsertOAuthAccountFn: func(_ context.Context, arg db.UpsertOAuthAccountParams) (db.OauthAccount, error) {
			stored = arg
			return db.OauthAccount{UserID: arg.UserID}, nil
		},
	}, cfg, nil, mockGitHubClient{
		refreshTokenFn: func(_ context.Context, refresh string) (GitHubTokenResult, error) {
			assert.Equal(t, "old-refresh", refresh)
			return GitHubTokenResult{AccessToken: "new-access", RefreshToken: "new-refresh"}, nil
		},
	})
	got, err = svc.RefreshUserGitHubToken(ctx, account)
	require.NoError(t, err)
	assert.Equal(t, "new-access", got)
	assert.Equal(t, "new-access", authCovDecrypt(t, cfg.SessionSecret, stored.AccessTokenEncrypted))
	assert.Equal(t, "new-refresh", authCovDecrypt(t, cfg.SessionSecret, stored.RefreshTokenEncrypted))
}

func TestAuth_Cov_RandomIdentifiersHaveExpectedShape(t *testing.T) {
	hexValue := randomHex(4)
	assert.Len(t, hexValue, 8)
	assert.True(t, authCovLowerHex(hexValue))

	uuid := randomUUID()
	assert.Len(t, uuid, 36)
	assert.Equal(t, byte('4'), uuid[14])
	assert.Contains(t, "89ab", strings.ToLower(string(uuid[19])))

	sessionID := SessionPublicID("550e8400-e29b-41d4-a716-446655440000")
	assert.Len(t, sessionID, 64)
	assert.True(t, authCovLowerHex(sessionID))

	svc := NewAuthService(&mockAuthQuerier{
		listUserSessionsFn: func(context.Context, int64) ([]db.AuthSession, error) {
			return nil, errors.New("db unavailable")
		},
	}, defaultAuthConfig(), nil, nil)
	err := svc.RevokeUserSession(context.Background(), 1, SessionPublicID("x"))
	require.ErrorContains(t, err, "db unavailable")
}

func authCovEncrypt(t *testing.T, secret, plaintext string) []byte {
	t.Helper()
	ciphertext, err := smitherscrypto.Encrypt(smitherscrypto.DeriveKey(secret), []byte(plaintext))
	require.NoError(t, err)
	return ciphertext
}

func authCovDecrypt(t *testing.T, secret string, ciphertext []byte) string {
	t.Helper()
	plaintext, err := smitherscrypto.Decrypt(smitherscrypto.DeriveKey(secret), ciphertext)
	require.NoError(t, err)
	return string(plaintext)
}

func authCovLowerHex(value string) bool {
	for _, ch := range value {
		if (ch < '0' || ch > '9') && (ch < 'a' || ch > 'f') {
			return false
		}
	}
	return value != ""
}

func authCovAssertAPIStatus(t *testing.T, err error, status int) {
	t.Helper()
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, status, apiErr.Status)
}
