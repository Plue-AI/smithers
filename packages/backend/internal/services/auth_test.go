package services

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/crypto"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type mockAuthQuerier struct {
	createOAuthStateFn                  func(ctx context.Context, arg db.CreateOAuthStateParams) (db.OauthState, error)
	consumeOAuthStateFn                 func(ctx context.Context, arg db.ConsumeOAuthStateParams) (int64, error)
	consumeOAuthStateWithScopesFn       func(ctx context.Context, arg db.ConsumeOAuthStateWithScopesParams) ([]string, error)
	createAuthNonceFn                   func(ctx context.Context, arg db.CreateAuthNonceParams) (db.AuthNonce, error)
	consumeAuthNonceFn                  func(ctx context.Context, arg db.ConsumeAuthNonceParams) (int64, error)
	getUserByWalletAddressFn            func(ctx context.Context, walletAddress pgtype.Text) (db.User, error)
	createUserWithWalletFn              func(ctx context.Context, arg db.CreateUserWithWalletParams) (db.User, error)
	createAuthSessionFn                 func(ctx context.Context, arg db.CreateAuthSessionParams) (db.AuthSession, error)
	getOAuthAccountByProviderUserIDFn   func(ctx context.Context, arg db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error)
	getUserByIDFn                       func(ctx context.Context, id int64) (db.User, error)
	createUserFn                        func(ctx context.Context, arg db.CreateUserParams) (db.User, error)
	upsertOAuthAccountFn                func(ctx context.Context, arg db.UpsertOAuthAccountParams) (db.OauthAccount, error)
	upsertOAuthAccountPreserveRefreshFn func(ctx context.Context, arg db.UpsertOAuthAccountPreserveRefreshParams) (db.OauthAccount, error)
	rotateOAuthAccountTokensCASFn       func(ctx context.Context, arg db.RotateOAuthAccountTokensCASParams) (int64, error)
	rotateOAuthAccountTokensByAccessFn  func(ctx context.Context, arg db.RotateOAuthAccountTokensByAccessCASParams) (int64, error)
	clearOAuthAccountRefreshTokenCASFn  func(ctx context.Context, arg db.ClearOAuthAccountRefreshTokenCASParams) (int64, error)
	upsertEmailAddressFn                func(ctx context.Context, arg db.UpsertEmailAddressParams) (db.UpsertEmailAddressRow, error)
	deleteAuthSessionFn                 func(ctx context.Context, sessionKey string) error
	listUserSessionsFn                  func(ctx context.Context, userID int64) ([]db.AuthSession, error)
	listAccessTokensByUserIDFn          func(ctx context.Context, userID int64) ([]db.AccessToken, error)
	createAccessTokenFn                 func(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error)
	deleteAccessTokenByIDAndUserIDFn    func(ctx context.Context, arg db.DeleteAccessTokenByIDAndUserIDParams) (int64, error)
}

func (m *mockAuthQuerier) CreateAuthNonce(ctx context.Context, arg db.CreateAuthNonceParams) (db.AuthNonce, error) {
	return m.createAuthNonceFn(ctx, arg)
}

func (m *mockAuthQuerier) CreateOAuthState(ctx context.Context, arg db.CreateOAuthStateParams) (db.OauthState, error) {
	return m.createOAuthStateFn(ctx, arg)
}

func (m *mockAuthQuerier) ConsumeOAuthState(ctx context.Context, arg db.ConsumeOAuthStateParams) (int64, error) {
	return m.consumeOAuthStateFn(ctx, arg)
}

func (m *mockAuthQuerier) ConsumeOAuthStateWithScopes(ctx context.Context, arg db.ConsumeOAuthStateWithScopesParams) ([]string, error) {
	if m.consumeOAuthStateWithScopesFn != nil {
		return m.consumeOAuthStateWithScopesFn(ctx, arg)
	}
	rows, err := m.consumeOAuthStateFn(ctx, db.ConsumeOAuthStateParams(arg))
	if err != nil {
		return nil, err
	}
	if rows == 0 {
		return nil, pgx.ErrNoRows
	}
	return nil, nil
}

func (m *mockAuthQuerier) ConsumeAuthNonce(ctx context.Context, arg db.ConsumeAuthNonceParams) (int64, error) {
	return m.consumeAuthNonceFn(ctx, arg)
}

func (m *mockAuthQuerier) GetUserByWalletAddress(ctx context.Context, walletAddress pgtype.Text) (db.User, error) {
	return m.getUserByWalletAddressFn(ctx, walletAddress)
}

func (m *mockAuthQuerier) CreateUserWithWallet(ctx context.Context, arg db.CreateUserWithWalletParams) (db.User, error) {
	return m.createUserWithWalletFn(ctx, arg)
}

func (m *mockAuthQuerier) CreateAuthSession(ctx context.Context, arg db.CreateAuthSessionParams) (db.AuthSession, error) {
	return m.createAuthSessionFn(ctx, arg)
}

func (m *mockAuthQuerier) GetOAuthAccountByProviderUserID(ctx context.Context, arg db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
	return m.getOAuthAccountByProviderUserIDFn(ctx, arg)
}

func (m *mockAuthQuerier) GetUserByID(ctx context.Context, id int64) (db.User, error) {
	return m.getUserByIDFn(ctx, id)
}

func (m *mockAuthQuerier) CreateUser(ctx context.Context, arg db.CreateUserParams) (db.User, error) {
	return m.createUserFn(ctx, arg)
}

func (m *mockAuthQuerier) UpsertOAuthAccount(ctx context.Context, arg db.UpsertOAuthAccountParams) (db.OauthAccount, error) {
	return m.upsertOAuthAccountFn(ctx, arg)
}

func (m *mockAuthQuerier) UpsertOAuthAccountPreserveRefresh(ctx context.Context, arg db.UpsertOAuthAccountPreserveRefreshParams) (db.OauthAccount, error) {
	if m.upsertOAuthAccountPreserveRefreshFn != nil {
		return m.upsertOAuthAccountPreserveRefreshFn(ctx, arg)
	}
	if m.upsertOAuthAccountFn == nil {
		return db.OauthAccount{
			UserID:               arg.UserID,
			Provider:             arg.Provider,
			ProviderUserID:       arg.ProviderUserID,
			AccessTokenEncrypted: arg.AccessTokenEncrypted,
			ProfileData:          arg.ProfileData,
		}, nil
	}
	return m.upsertOAuthAccountFn(ctx, db.UpsertOAuthAccountParams{
		UserID:               arg.UserID,
		Provider:             arg.Provider,
		ProviderUserID:       arg.ProviderUserID,
		AccessTokenEncrypted: arg.AccessTokenEncrypted,
		ProfileData:          arg.ProfileData,
	})
}

func (m *mockAuthQuerier) RotateOAuthAccountTokensCAS(ctx context.Context, arg db.RotateOAuthAccountTokensCASParams) (int64, error) {
	if m.rotateOAuthAccountTokensCASFn != nil {
		return m.rotateOAuthAccountTokensCASFn(ctx, arg)
	}
	if m.upsertOAuthAccountFn == nil {
		return 1, nil
	}
	userID := int64(0)
	if m.getOAuthAccountByProviderUserIDFn != nil {
		account, err := m.getOAuthAccountByProviderUserIDFn(ctx, db.GetOAuthAccountByProviderUserIDParams{
			Provider:       arg.Provider,
			ProviderUserID: arg.ProviderUserID,
		})
		if err == nil {
			userID = account.UserID
		}
	}
	_, err := m.upsertOAuthAccountFn(ctx, db.UpsertOAuthAccountParams{
		UserID:                userID,
		Provider:              arg.Provider,
		ProviderUserID:        arg.ProviderUserID,
		AccessTokenEncrypted:  arg.AccessTokenEncrypted,
		RefreshTokenEncrypted: arg.RefreshTokenEncrypted,
	})
	if err != nil {
		return 0, err
	}
	return 1, nil
}

// RotateOAuthAccountTokensByAccessCAS backs the heal path. It is only reachable
// when rotateOAuthAccountTokensByAccessFn is set; left nil it reports "no rows"
// so tests that predate healing observe the pre-heal behavior unchanged.
func (m *mockAuthQuerier) RotateOAuthAccountTokensByAccessCAS(ctx context.Context, arg db.RotateOAuthAccountTokensByAccessCASParams) (int64, error) {
	if m.rotateOAuthAccountTokensByAccessFn != nil {
		return m.rotateOAuthAccountTokensByAccessFn(ctx, arg)
	}
	return 0, nil
}

func (m *mockAuthQuerier) ClearOAuthAccountRefreshTokenCAS(ctx context.Context, arg db.ClearOAuthAccountRefreshTokenCASParams) (int64, error) {
	if m.clearOAuthAccountRefreshTokenCASFn != nil {
		return m.clearOAuthAccountRefreshTokenCASFn(ctx, arg)
	}
	if m.upsertOAuthAccountFn == nil {
		return 1, nil
	}
	userID := int64(0)
	if m.getOAuthAccountByProviderUserIDFn != nil {
		account, err := m.getOAuthAccountByProviderUserIDFn(ctx, db.GetOAuthAccountByProviderUserIDParams{
			Provider:       arg.Provider,
			ProviderUserID: arg.ProviderUserID,
		})
		if err == nil {
			userID = account.UserID
		}
	}
	_, err := m.upsertOAuthAccountFn(ctx, db.UpsertOAuthAccountParams{
		UserID:                userID,
		Provider:              arg.Provider,
		ProviderUserID:        arg.ProviderUserID,
		AccessTokenEncrypted:  arg.OldAccessTokenEncrypted,
		RefreshTokenEncrypted: nil,
	})
	if err != nil {
		return 0, err
	}
	return 1, nil
}

func (m *mockAuthQuerier) UpsertEmailAddress(ctx context.Context, arg db.UpsertEmailAddressParams) (db.UpsertEmailAddressRow, error) {
	return m.upsertEmailAddressFn(ctx, arg)
}

func (m *mockAuthQuerier) DeleteAuthSession(ctx context.Context, sessionKey string) error {
	return m.deleteAuthSessionFn(ctx, sessionKey)
}

func (m *mockAuthQuerier) ListUserSessions(ctx context.Context, userID int64) ([]db.AuthSession, error) {
	return m.listUserSessionsFn(ctx, userID)
}

func (m *mockAuthQuerier) ListAccessTokensByUserID(ctx context.Context, userID int64) ([]db.AccessToken, error) {
	return m.listAccessTokensByUserIDFn(ctx, userID)
}

func (m *mockAuthQuerier) CreateAccessToken(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
	return m.createAccessTokenFn(ctx, arg)
}

func (m *mockAuthQuerier) DeleteAccessTokenByIDAndUserID(ctx context.Context, arg db.DeleteAccessTokenByIDAndUserIDParams) (int64, error) {
	return m.deleteAccessTokenByIDAndUserIDFn(ctx, arg)
}

type mockKeyAuthVerifier struct {
	verifyFn func(message, signature, expectedDomain string) (walletAddress string, nonce string, err error)
}

func (m mockKeyAuthVerifier) Verify(message, signature, expectedDomain string) (walletAddress string, nonce string, err error) {
	return m.verifyFn(message, signature, expectedDomain)
}

type mockGitHubClient struct {
	exchangeCodeFn    func(ctx context.Context, code string) (GitHubTokenResult, error)
	refreshTokenFn    func(ctx context.Context, refreshToken string) (GitHubTokenResult, error)
	fetchUserFn       func(ctx context.Context, accessToken string) (GitHubUserProfile, error)
	fetchEmailsFn     func(ctx context.Context, accessToken string) ([]GitHubEmail, error)
	authorizationURL  string
	authorizationSeen *string
	authorizationErr  error
}

func (m mockGitHubClient) ExchangeCode(ctx context.Context, code string) (GitHubTokenResult, error) {
	return m.exchangeCodeFn(ctx, code)
}

// RefreshToken lets mockGitHubClient satisfy the narrow refresher interface that
// AuthService.RefreshUserGitHubToken feature-detects. A nil refreshTokenFn means
// "this client cannot refresh" (returns an error).
func (m mockGitHubClient) RefreshToken(ctx context.Context, refreshToken string) (GitHubTokenResult, error) {
	if m.refreshTokenFn == nil {
		return GitHubTokenResult{}, fmt.Errorf("refresh not supported")
	}
	return m.refreshTokenFn(ctx, refreshToken)
}

func (m mockGitHubClient) FetchUser(ctx context.Context, accessToken string) (GitHubUserProfile, error) {
	return m.fetchUserFn(ctx, accessToken)
}

func (m mockGitHubClient) FetchEmails(ctx context.Context, accessToken string) ([]GitHubEmail, error) {
	return m.fetchEmailsFn(ctx, accessToken)
}

func (m mockGitHubClient) AuthorizationURL(ctx context.Context, state string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if m.authorizationErr != nil {
		return "", m.authorizationErr
	}
	if m.authorizationSeen != nil {
		*m.authorizationSeen = state
	}
	if m.authorizationURL != "" {
		return m.authorizationURL + "?state=" + state, nil
	}
	return "https://github.test/login/oauth/authorize?state=" + state, nil
}

func defaultAuthConfig() config.AuthConfig {
	return config.AuthConfig{
		SessionDuration:      "720h",
		SessionRefreshWindow: "168h",
		SessionCookieName:    "smithers_session",
		SessionSecret:        "test-session-secret-for-unit-tests",
		CookieSecure:         true,
		KeyAuthDomain:        "smithers.sh",
		GitHubRedirectURL:    "http://localhost:4000/api/auth/github/callback",
	}
}

func TestAuthService_CreateKeyAuthNonce(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{
		createAuthNonceFn: func(ctx context.Context, arg db.CreateAuthNonceParams) (db.AuthNonce, error) {
			require.NotEmpty(t, arg.Nonce)
			require.True(t, arg.ExpiresAt.After(time.Now().UTC()))
			return db.AuthNonce{NonceKey: arg.Nonce, ExpiresAt: arg.ExpiresAt}, nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{})

	nonce, err := svc.CreateKeyAuthNonce(context.Background())
	require.NoError(t, err)
	assert.NotEmpty(t, nonce)
}

func TestAuthService_VerifyKeyAuth_ExistingWalletUser(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{
		consumeAuthNonceFn: func(ctx context.Context, arg db.ConsumeAuthNonceParams) (int64, error) {
			require.Equal(t, "nonce-1", arg.Nonce)
			return 1, nil
		},
		getUserByWalletAddressFn: func(ctx context.Context, walletAddress pgtype.Text) (db.User, error) {
			return db.User{ID: 99, Username: "wallet-user", LowerUsername: "wallet-user", IsActive: true}, nil
		},
		createAuthSessionFn: func(ctx context.Context, arg db.CreateAuthSessionParams) (db.AuthSession, error) {
			return db.AuthSession{
				SessionKey: arg.SessionKey,
				UserID:     arg.UserID,
				Username:   arg.Username,
				ExpiresAt:  arg.ExpiresAt,
			}, nil
		},
		createUserWithWalletFn: func(ctx context.Context, arg db.CreateUserWithWalletParams) (db.User, error) {
			t.Fatal("should not create a new wallet user when one already exists")
			return db.User{}, nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{
		verifyFn: func(message, signature, expectedDomain string) (walletAddress string, nonce string, err error) {
			return "0x1234567890123456789012345678901234567890", "nonce-1", nil
		},
	}, mockGitHubClient{})

	m := newObserveV2Metrics()
	WithAuthMetrics(m)(svc)
	result, err := svc.VerifyKeyAuth(context.Background(), "message", "signature")
	require.NoError(t, err)
	assert.Equal(t, int64(99), result.User.ID)
	assert.NotEmpty(t, result.SessionKey)
	require.Equal(t, 1.0, testutil.ToFloat64(m.auth.WithLabelValues("key", "success")))
}

func TestAuthService_VerifyKeyAuth_PassesConfiguredDomain(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{
		consumeAuthNonceFn: func(ctx context.Context, arg db.ConsumeAuthNonceParams) (int64, error) {
			return 1, nil
		},
		getUserByWalletAddressFn: func(ctx context.Context, walletAddress pgtype.Text) (db.User, error) {
			return db.User{ID: 99, Username: "wallet-user", LowerUsername: "wallet-user", IsActive: true}, nil
		},
		createAuthSessionFn: func(ctx context.Context, arg db.CreateAuthSessionParams) (db.AuthSession, error) {
			return db.AuthSession{
				SessionKey: arg.SessionKey,
				UserID:     arg.UserID,
				Username:   arg.Username,
				ExpiresAt:  arg.ExpiresAt,
			}, nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{
		verifyFn: func(message, signature, expectedDomain string) (walletAddress string, nonce string, err error) {
			assert.Equal(t, "smithers.sh", expectedDomain)
			return "0x1234567890123456789012345678901234567890", "nonce-1", nil
		},
	}, mockGitHubClient{})

	_, err := svc.VerifyKeyAuth(context.Background(), "message", "signature")
	require.NoError(t, err)
}

func TestAuthService_VerifyKeyAuth_CreatesWalletUser(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{
		consumeAuthNonceFn: func(ctx context.Context, arg db.ConsumeAuthNonceParams) (int64, error) {
			return 1, nil
		},
		getUserByWalletAddressFn: func(ctx context.Context, walletAddress pgtype.Text) (db.User, error) {
			return db.User{}, pgx.ErrNoRows
		},
		createUserWithWalletFn: func(ctx context.Context, arg db.CreateUserWithWalletParams) (db.User, error) {
			require.True(t, arg.WalletAddress.Valid)
			return db.User{ID: 55, Username: arg.Username, LowerUsername: arg.LowerUsername, WalletAddress: arg.WalletAddress, IsActive: true}, nil
		},
		createAuthSessionFn: func(ctx context.Context, arg db.CreateAuthSessionParams) (db.AuthSession, error) {
			return db.AuthSession{SessionKey: arg.SessionKey, UserID: arg.UserID, Username: arg.Username, ExpiresAt: arg.ExpiresAt}, nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{
		verifyFn: func(message, signature, expectedDomain string) (walletAddress string, nonce string, err error) {
			return "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd", "nonce-create", nil
		},
	}, mockGitHubClient{})

	result, err := svc.VerifyKeyAuth(context.Background(), "message", "signature")
	require.NoError(t, err)
	assert.Equal(t, int64(55), result.User.ID)
}

func TestAuthService_VerifyKeyAuth_RejectsConsumedNonce(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{
		consumeAuthNonceFn: func(ctx context.Context, arg db.ConsumeAuthNonceParams) (int64, error) {
			return 0, nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{
		verifyFn: func(message, signature, expectedDomain string) (walletAddress string, nonce string, err error) {
			return "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd", "nonce-consumed", nil
		},
	}, mockGitHubClient{})

	_, err := svc.VerifyKeyAuth(context.Background(), "message", "signature")
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 401, apiErr.Status)
}

func TestAuthService_StartGitHubOAuth_ReturnsRedirect(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{
		createOAuthStateFn: func(ctx context.Context, arg db.CreateOAuthStateParams) (db.OauthState, error) {
			assert.NotEmpty(t, arg.ContextHash)
			return db.OauthState{
				StateKey:  arg.State,
				ExpiresAt: arg.ExpiresAt,
			}, nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{})

	url, err := svc.StartGitHubOAuth(context.Background(), "verifier-redirect")
	require.NoError(t, err)
	// GitHub sign-in goes DIRECT to the GitHub App authorize endpoint.
	assert.Contains(t, url, "github.test/login/oauth/authorize")
	assert.Contains(t, url, "state=")
}

func TestAuthService_StartGitHubOAuth_Direct(t *testing.T) {
	t.Parallel()

	cfg := defaultAuthConfig()
	var createdState string
	var authorizationState string
	svc := NewAuthService(&mockAuthQuerier{
		createOAuthStateFn: func(ctx context.Context, arg db.CreateOAuthStateParams) (db.OauthState, error) {
			createdState = arg.State
			assert.NotEmpty(t, arg.ContextHash)
			return db.OauthState{
				StateKey:  arg.State,
				ExpiresAt: arg.ExpiresAt,
			}, nil
		},
	}, cfg, mockKeyAuthVerifier{}, mockGitHubClient{
		authorizationURL:  "https://github.test/login/oauth/authorize",
		authorizationSeen: &authorizationState,
	})
	svc.generateState = func() string { return "direct-state" }

	url, err := svc.StartGitHubOAuth(context.Background(), "verifier-direct")
	require.NoError(t, err)
	assert.Equal(t, "direct-state", createdState)
	assert.Equal(t, "direct-state", authorizationState)
	assert.Equal(t, "https://github.test/login/oauth/authorize?state=direct-state", url)
}

func TestAuthService_StartGitHubOAuthWithScopes_PersistsNormalizedScopes(t *testing.T) {
	t.Parallel()

	var persisted []string
	svc := NewAuthService(&mockAuthQuerier{
		createOAuthStateFn: func(ctx context.Context, arg db.CreateOAuthStateParams) (db.OauthState, error) {
			persisted = arg.RequestedScopes
			return db.OauthState{StateKey: arg.State, RequestedScopes: arg.RequestedScopes, ExpiresAt: arg.ExpiresAt}, nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{})

	_, err := svc.StartGitHubOAuthWithScopes(context.Background(), "verifier-scoped", "read:user,read:organization,read:repository,write:repository,read:workspace,write:workspace,write:agent,write:approval,read:user")
	require.NoError(t, err)
	assert.Equal(t, []string{
		"read:organization",
		"read:repository",
		"read:user",
		"read:workspace",
		"write:agent",
		"write:approval",
		"write:repository",
		"write:workspace",
	}, persisted)
}

func TestAuthService_StartGitHubOAuthWithScopes_DefaultsAndRejectsDisallowed(t *testing.T) {
	t.Parallel()

	var persisted []string
	svc := NewAuthService(&mockAuthQuerier{
		createOAuthStateFn: func(ctx context.Context, arg db.CreateOAuthStateParams) (db.OauthState, error) {
			persisted = arg.RequestedScopes
			return db.OauthState{StateKey: arg.State, RequestedScopes: arg.RequestedScopes, ExpiresAt: arg.ExpiresAt}, nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{})

	_, err := svc.StartGitHubOAuthWithScopes(context.Background(), "verifier-default", "")
	require.NoError(t, err)
	assert.Equal(t, []string{"write:organization", "write:repository", "write:user"}, persisted)

	for _, scopes := range []string{"read:user,destroy:workspace", "read:user,admin", "all"} {
		_, err = svc.StartGitHubOAuthWithScopes(context.Background(), "verifier-rejected", scopes)
		require.Error(t, err)
		var apiErr *errors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, 422, apiErr.Status)
	}
}

func TestAuthService_CompleteGitHubOAuth_ExistingOAuthAccount(t *testing.T) {
	t.Parallel()

	consumed := false
	svc := NewAuthService(&mockAuthQuerier{
		consumeOAuthStateWithScopesFn: func(ctx context.Context, arg db.ConsumeOAuthStateWithScopesParams) ([]string, error) {
			consumed = true
			assert.Equal(t, "state-1", arg.State)
			assert.NotEmpty(t, arg.ContextHash)
			return []string{"read:user", "write:workspace"}, nil
		},
		getOAuthAccountByProviderUserIDFn: func(ctx context.Context, arg db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return db.OauthAccount{ID: 7, UserID: 22, Provider: "github", ProviderUserID: "101"}, nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			return db.User{ID: id, Username: "octocat", LowerUsername: "octocat", IsActive: true}, nil
		},
		upsertOAuthAccountFn: func(ctx context.Context, arg db.UpsertOAuthAccountParams) (db.OauthAccount, error) {
			assert.Equal(t, int64(22), arg.UserID)
			return db.OauthAccount{UserID: arg.UserID, Provider: arg.Provider, ProviderUserID: arg.ProviderUserID}, nil
		},
		createAuthSessionFn: func(ctx context.Context, arg db.CreateAuthSessionParams) (db.AuthSession, error) {
			return db.AuthSession{SessionKey: arg.SessionKey, UserID: arg.UserID, Username: arg.Username, ExpiresAt: arg.ExpiresAt}, nil
		},
		upsertEmailAddressFn: func(ctx context.Context, arg db.UpsertEmailAddressParams) (db.UpsertEmailAddressRow, error) {
			return db.UpsertEmailAddressRow{UserID: arg.UserID, Email: arg.Email, LowerEmail: arg.LowerEmail, IsPrimary: arg.IsPrimary}, nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{
		exchangeCodeFn: func(ctx context.Context, code string) (GitHubTokenResult, error) {
			return GitHubTokenResult{AccessToken: "gho_abc"}, nil
		},
		fetchUserFn: func(ctx context.Context, accessToken string) (GitHubUserProfile, error) {
			return GitHubUserProfile{ID: 101, Login: "octocat"}, nil
		},
		fetchEmailsFn: func(ctx context.Context, accessToken string) ([]GitHubEmail, error) {
			return []GitHubEmail{{Email: "octo@example.com", Primary: true, Verified: true}}, nil
		},
	})

	m := newObserveV2Metrics()
	WithAuthMetrics(m)(svc)
	result, err := svc.CompleteGitHubOAuth(context.Background(), "code-1", "state-1", "verifier-1")
	require.NoError(t, err)
	assert.True(t, consumed)
	assert.Equal(t, int64(22), result.User.ID)
	assert.NotEmpty(t, result.SessionKey)
	assert.Equal(t, []string{"read:user", "write:workspace"}, result.TokenScopes)
	require.Equal(t, 1.0, testutil.ToFloat64(m.auth.WithLabelValues("github", "success")))
}

func TestAuthService_CompleteGitHubOAuth_CreatesUserAndOAuthAccount(t *testing.T) {
	t.Parallel()

	consumed := false
	svc := NewAuthService(&mockAuthQuerier{
		consumeOAuthStateFn: func(ctx context.Context, arg db.ConsumeOAuthStateParams) (int64, error) {
			consumed = true
			assert.Equal(t, "state-new", arg.State)
			assert.NotEmpty(t, arg.ContextHash)
			return 1, nil
		},
		getOAuthAccountByProviderUserIDFn: func(ctx context.Context, arg db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return db.OauthAccount{}, pgx.ErrNoRows
		},
		createUserFn: func(ctx context.Context, arg db.CreateUserParams) (db.User, error) {
			return db.User{
				ID:            88,
				Username:      arg.Username,
				LowerUsername: arg.LowerUsername,
				Email:         arg.Email,
				LowerEmail:    arg.LowerEmail,
				IsActive:      true,
			}, nil
		},
		upsertOAuthAccountFn: func(ctx context.Context, arg db.UpsertOAuthAccountParams) (db.OauthAccount, error) {
			assert.Equal(t, int64(88), arg.UserID)
			var profile map[string]any
			require.NoError(t, json.Unmarshal(arg.ProfileData, &profile))
			assert.Equal(t, "newcat", profile["login"])
			return db.OauthAccount{UserID: arg.UserID, Provider: arg.Provider, ProviderUserID: arg.ProviderUserID}, nil
		},
		upsertEmailAddressFn: func(ctx context.Context, arg db.UpsertEmailAddressParams) (db.UpsertEmailAddressRow, error) {
			return db.UpsertEmailAddressRow{UserID: arg.UserID, Email: arg.Email, LowerEmail: arg.LowerEmail, IsPrimary: arg.IsPrimary}, nil
		},
		createAuthSessionFn: func(ctx context.Context, arg db.CreateAuthSessionParams) (db.AuthSession, error) {
			return db.AuthSession{SessionKey: arg.SessionKey, UserID: arg.UserID, Username: arg.Username, ExpiresAt: arg.ExpiresAt}, nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{
		exchangeCodeFn: func(ctx context.Context, code string) (GitHubTokenResult, error) {
			return GitHubTokenResult{AccessToken: "gho_new"}, nil
		},
		fetchUserFn: func(ctx context.Context, accessToken string) (GitHubUserProfile, error) {
			return GitHubUserProfile{ID: 999, Login: "newcat", Name: "New Cat"}, nil
		},
		fetchEmailsFn: func(ctx context.Context, accessToken string) ([]GitHubEmail, error) {
			return []GitHubEmail{{Email: "newcat@example.com", Primary: true, Verified: true}}, nil
		},
	})

	result, err := svc.CompleteGitHubOAuth(context.Background(), "code-new", "state-new", "verifier-new")
	require.NoError(t, err)
	assert.True(t, consumed)
	assert.Equal(t, int64(88), result.User.ID)
	assert.Equal(t, []string{"write:organization", "write:repository", "write:user"}, result.TokenScopes)
}

func TestAuthService_Logout_DeletesSession(t *testing.T) {
	t.Parallel()

	validUUID := "550e8400-e29b-41d4-a716-446655440000"
	var deleted []string
	svc := NewAuthService(&mockAuthQuerier{
		deleteAuthSessionFn: func(ctx context.Context, sessionKey string) error {
			deleted = append(deleted, sessionKey)
			return nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{})

	err := svc.Logout(context.Background(), validUUID)
	require.NoError(t, err)
	require.NotEmpty(t, deleted)
	// The raw (legacy) storage form must always be among the deletions.
	assert.Contains(t, deleted, validUUID)
}

func TestAuthService_ListUserSessions(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC()
	svc := NewAuthService(&mockAuthQuerier{
		listUserSessionsFn: func(ctx context.Context, userID int64) ([]db.AuthSession, error) {
			assert.Equal(t, int64(77), userID)
			return []db.AuthSession{
				{
					SessionKey: "550e8400-e29b-41d4-a716-446655440000",
					UserID:     userID,
					Username:   "alice",
					IsAdmin:    false,
					ExpiresAt:  now.Add(24 * time.Hour),
					CreatedAt:  now.Add(-time.Hour),
				},
			}, nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{})

	sessions, err := svc.ListUserSessions(context.Background(), 77)
	require.NoError(t, err)
	require.Len(t, sessions, 1)
	assert.Equal(t, "550e8400-e29b-41d4-a716-446655440000", sessions[0].SessionKey)
	assert.Equal(t, int64(77), sessions[0].UserID)
}

func TestAuthService_ListUserSessions_Empty(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{
		listUserSessionsFn: func(ctx context.Context, userID int64) ([]db.AuthSession, error) {
			assert.Equal(t, int64(88), userID)
			return []db.AuthSession{}, nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{})

	sessions, err := svc.ListUserSessions(context.Background(), 88)
	require.NoError(t, err)
	require.Empty(t, sessions)
}

func TestAuthService_ListTokens_UserScoped(t *testing.T) {
	t.Parallel()

	expiresAt := time.Now().UTC().Add(24 * time.Hour)
	svc := NewAuthService(&mockAuthQuerier{
		listAccessTokensByUserIDFn: func(ctx context.Context, userID int64) ([]db.AccessToken, error) {
			assert.Equal(t, int64(77), userID)
			return []db.AccessToken{
				{
					ID:             1,
					UserID:         userID,
					Name:           "ci",
					TokenLastEight: "12345678",
					Scopes:         "read:repository",
					ExpiresAt:      pgtype.Timestamptz{Time: expiresAt, Valid: true},
				},
			}, nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{})

	tokens, err := svc.ListTokens(context.Background(), 77)
	require.NoError(t, err)
	require.Len(t, tokens, 1)
	assert.Equal(t, int64(1), tokens[0].ID)
	assert.Equal(t, "12345678", tokens[0].TokenLastEight)
	require.NotNil(t, tokens[0].ExpiresAt)
	assert.WithinDuration(t, expiresAt, *tokens[0].ExpiresAt, time.Second)
}

func TestAuthService_CreateToken_HashesAndReturnsRawOnce(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC)
	svc := NewAuthService(&mockAuthQuerier{
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			assert.Equal(t, int64(42), id)
			return db.User{ID: id, IsAdmin: false}, nil
		},
		createAccessTokenFn: func(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
			assert.Equal(t, int64(42), arg.UserID)
			assert.NotEmpty(t, arg.TokenHash)
			assert.Len(t, arg.TokenLastEight, 8)
			require.True(t, arg.ExpiresAt.Valid)
			assert.WithinDuration(t, now.Add(defaultAccessTokenTTL), arg.ExpiresAt.Time, time.Second)
			return db.AccessToken{
				ID:             11,
				UserID:         arg.UserID,
				Name:           arg.Name,
				TokenHash:      arg.TokenHash,
				TokenLastEight: arg.TokenLastEight,
				Scopes:         arg.Scopes,
				ExpiresAt:      arg.ExpiresAt,
				CreatedAt:      time.Now().UTC(),
			}, nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{})
	svc.now = func() time.Time { return now }

	result, err := svc.CreateToken(context.Background(), 42, CreateTokenRequest{
		Name:   "deploy",
		Scopes: []string{"write:user"},
	})
	require.NoError(t, err)
	assert.Equal(t, int64(11), result.ID)
	assert.True(t, len(result.Token) > 0)
	assert.NotContains(t, result.Token, result.TokenLastEight)
	require.NotNil(t, result.ExpiresAt)
	assert.WithinDuration(t, now.Add(defaultAccessTokenTTL), *result.ExpiresAt, time.Second)
}

func TestAuthService_CreateToken_UsesRequestedExpiry(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC)
	requested := now.Add(7 * 24 * time.Hour)
	svc := NewAuthService(&mockAuthQuerier{
		createAccessTokenFn: func(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
			require.True(t, arg.ExpiresAt.Valid)
			assert.WithinDuration(t, requested, arg.ExpiresAt.Time, time.Second)
			return db.AccessToken{
				ID:             12,
				UserID:         arg.UserID,
				Name:           arg.Name,
				TokenHash:      arg.TokenHash,
				TokenLastEight: arg.TokenLastEight,
				Scopes:         arg.Scopes,
				ExpiresAt:      arg.ExpiresAt,
			}, nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{})
	svc.now = func() time.Time { return now }

	result, err := svc.CreateToken(context.Background(), 42, CreateTokenRequest{
		Name:      "one-week",
		Scopes:    []string{"read:repository"},
		ExpiresAt: &requested,
	})
	require.NoError(t, err)
	require.NotNil(t, result.ExpiresAt)
	assert.WithinDuration(t, requested, *result.ExpiresAt, time.Second)
}

func TestAuthService_DeleteToken_UserScoped(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{
		deleteAccessTokenByIDAndUserIDFn: func(ctx context.Context, arg db.DeleteAccessTokenByIDAndUserIDParams) (int64, error) {
			assert.Equal(t, int64(77), arg.UserID)
			assert.Equal(t, int64(8), arg.ID)
			return 1, nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{})

	err := svc.DeleteToken(context.Background(), 77, 8)
	require.NoError(t, err)
}

func TestAuthService_CreateToken_RejectsEmptyName(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{
		createAccessTokenFn: func(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
			t.Fatal("CreateAccessToken should not be called for invalid request")
			return db.AccessToken{}, nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{})

	_, err := svc.CreateToken(context.Background(), 1, CreateTokenRequest{
		Name:   "   ",
		Scopes: []string{"read:repository"},
	})
	require.Error(t, err)

	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 422, apiErr.Status)
	assert.Equal(t, "validation failed", apiErr.Message)
	require.Len(t, apiErr.Errors, 1)
	assert.Equal(t, "name", apiErr.Errors[0].Field)
	assert.Equal(t, "missing_field", apiErr.Errors[0].Code)
}

func TestAuthService_CreateToken_RejectsEmptyScopes(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{
		createAccessTokenFn: func(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
			t.Fatal("CreateAccessToken should not be called for invalid request")
			return db.AccessToken{}, nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{})

	_, err := svc.CreateToken(context.Background(), 1, CreateTokenRequest{
		Name:   "deploy",
		Scopes: []string{},
	})
	require.Error(t, err)

	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 422, apiErr.Status)
	assert.Equal(t, "validation failed", apiErr.Message)
	require.Len(t, apiErr.Errors, 1)
	assert.Equal(t, "scopes", apiErr.Errors[0].Field)
	assert.Equal(t, "missing_field", apiErr.Errors[0].Code)
}

func TestAuthService_CreateToken_RejectsUnknownScopes(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{
		createAccessTokenFn: func(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
			t.Fatal("CreateAccessToken should not be called for unknown scopes")
			return db.AccessToken{}, nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{})

	_, err := svc.CreateToken(context.Background(), 1, CreateTokenRequest{
		Name:   "deploy",
		Scopes: []string{"write:repository", "destroy:instance"},
	})
	require.Error(t, err)

	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 422, apiErr.Status)
	assert.Equal(t, "validation failed", apiErr.Message)
	require.Len(t, apiErr.Errors, 1)
	assert.Equal(t, "scopes[1]", apiErr.Errors[0].Field)
	assert.Equal(t, "invalid", apiErr.Errors[0].Code)
}

func TestAuthService_CreateToken_RejectsExpiredExpiry(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC)
	past := now.Add(-time.Minute)
	svc := NewAuthService(&mockAuthQuerier{
		createAccessTokenFn: func(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
			t.Fatal("CreateAccessToken should not be called for expired expires_at")
			return db.AccessToken{}, nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{})
	svc.now = func() time.Time { return now }

	_, err := svc.CreateToken(context.Background(), 1, CreateTokenRequest{
		Name:      "stale",
		Scopes:    []string{"read:repository"},
		ExpiresAt: &past,
	})
	require.Error(t, err)

	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 422, apiErr.Status)
	require.Len(t, apiErr.Errors, 1)
	assert.Equal(t, "expires_at", apiErr.Errors[0].Field)
	assert.Equal(t, "invalid", apiErr.Errors[0].Code)
}

func TestAuthService_CreateToken_NonAdminCannotMintPrivilegedScopes(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		scopes []string
	}{
		{name: "admin scope", scopes: []string{"admin"}},
		{name: "read admin scope", scopes: []string{"read:admin"}},
		{name: "write admin scope", scopes: []string{"write:admin"}},
		{name: "all scope", scopes: []string{"ALL"}},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			svc := NewAuthService(&mockAuthQuerier{
				getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
					assert.Equal(t, int64(5), id)
					return db.User{ID: id, IsAdmin: false}, nil
				},
				createAccessTokenFn: func(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
					t.Fatal("CreateAccessToken should not be called when requesting privileged scopes")
					return db.AccessToken{}, nil
				},
			}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{})

			_, err := svc.CreateToken(context.Background(), 5, CreateTokenRequest{
				Name:   "privileged",
				Scopes: tc.scopes,
			})
			require.Error(t, err)

			apiErr, ok := err.(*errors.APIError)
			require.True(t, ok)
			assert.Equal(t, 403, apiErr.Status)
			assert.Equal(t, "insufficient privileges for requested token scopes", apiErr.Message)
		})
	}
}

func TestAuthService_CreateToken_AdminCanMintPrivilegedScopes(t *testing.T) {
	t.Parallel()

	lookedUpUser := false
	svc := NewAuthService(&mockAuthQuerier{
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			lookedUpUser = true
			assert.Equal(t, int64(9), id)
			return db.User{ID: id, IsAdmin: true}, nil
		},
		createAccessTokenFn: func(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
			assert.Equal(t, "admin", arg.Scopes)
			return db.AccessToken{
				ID:             88,
				UserID:         arg.UserID,
				Name:           arg.Name,
				TokenHash:      arg.TokenHash,
				TokenLastEight: arg.TokenLastEight,
				Scopes:         arg.Scopes,
			}, nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{})

	_, err := svc.CreateToken(context.Background(), 9, CreateTokenRequest{
		Name:   "admin-token",
		Scopes: []string{"admin"},
	})
	require.NoError(t, err)
	assert.True(t, lookedUpUser, "GetUserByID should be used for privileged scopes")
}

func TestAuthService_CreateToken_NormalizesAndDedupesScopes(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			return db.User{ID: id, IsAdmin: false}, nil
		},
		createAccessTokenFn: func(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
			assert.Equal(t, "read:organization,write:repository,write:user", arg.Scopes)
			return db.AccessToken{
				ID:             9,
				UserID:         arg.UserID,
				Name:           arg.Name,
				TokenHash:      arg.TokenHash,
				TokenLastEight: arg.TokenLastEight,
				Scopes:         arg.Scopes,
			}, nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{})

	result, err := svc.CreateToken(context.Background(), 1, CreateTokenRequest{
		Name:   "normalizer",
		Scopes: []string{" USER ", "repository", "WRITE:repository", "read:organization"},
	})
	require.NoError(t, err)
	assert.Equal(t, []string{"read:organization", "write:repository", "write:user"}, result.Scopes)
}

// --- Edge case tests ---

func TestAuthService_Logout_EmptySessionKey_NoOp(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{
		deleteAuthSessionFn: func(ctx context.Context, sessionKey string) error {
			t.Fatal("DB should not be called for empty session key")
			return nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{})

	err := svc.Logout(context.Background(), "")
	require.NoError(t, err)
}

func TestAuthService_Logout_WhitespaceSessionKey_NoOp(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{
		deleteAuthSessionFn: func(ctx context.Context, sessionKey string) error {
			t.Fatal("DB should not be called for whitespace session key")
			return nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{})

	err := svc.Logout(context.Background(), "   ")
	require.NoError(t, err)
}

// Logout revokes every cookie shape auth accepts (#3559): it deletes the
// digest-keyed row for any non-empty cookie and the legacy raw-keyed row
// for every cookie auth would also look up raw, which excludes a 64-hex
// string so a stored digest cannot sign out the session it names.
func TestAuthService_Logout_DeletesEveryAcceptedShape(t *testing.T) {
	t.Parallel()

	hex64 := sha256HexOf("seeded")
	tests := []struct {
		name       string
		sessionKey string
		raw        bool
	}{
		{"uuid", "550e8400-e29b-41d4-a716-446655440000", true},
		{"64-hex", hex64, false},
		{"64-hex upper case", strings.ToUpper(hex64), false},
		{"too short uuid", "550e8400-e29b", true},
		{"no dashes", "550e8400e29b41d4a716446655440000", true},
		{"non-hex characters", "gggggggg-gggg-gggg-gggg-gggggggggggg", true},
		{"plain string", "fake-session-key-12345", true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var deleted []string
			svc := NewAuthService(&mockAuthQuerier{
				deleteAuthSessionFn: func(ctx context.Context, sessionKey string) error {
					deleted = append(deleted, sessionKey)
					return nil
				},
			}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{})

			require.NoError(t, svc.Logout(context.Background(), tc.sessionKey))
			want := []string{sha256HexOf(tc.sessionKey)}
			if tc.raw {
				want = append(want, tc.sessionKey)
			}
			assert.Equal(t, want, deleted)
		})
	}
}

func TestAuthService_VerifyKeyAuth_NilVerifier(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{}, defaultAuthConfig(), nil, mockGitHubClient{})

	_, err := svc.VerifyKeyAuth(context.Background(), "message", "signature")
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 500, apiErr.Status)
	assert.Contains(t, apiErr.Message, "key auth verifier is not configured")
}

func TestAuthService_CompleteGitHubOAuth_NilClient(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{
		consumeOAuthStateFn: func(ctx context.Context, arg db.ConsumeOAuthStateParams) (int64, error) {
			return 1, nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, nil)

	_, err := svc.CompleteGitHubOAuth(context.Background(), "code", "state", "verifier")
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 500, apiErr.Status)
	assert.Contains(t, apiErr.Message, "github oauth is not configured")
}

func TestAuthService_DeleteToken_NotFound(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{
		deleteAccessTokenByIDAndUserIDFn: func(ctx context.Context, arg db.DeleteAccessTokenByIDAndUserIDParams) (int64, error) {
			return 0, nil // 0 rows affected = not found
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{})

	err := svc.DeleteToken(context.Background(), 1, 999)
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 404, apiErr.Status)
}

func TestAuthService_CreateToken_HasSmithersPrefix(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{
		createAccessTokenFn: func(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
			return db.AccessToken{
				ID:             1,
				UserID:         arg.UserID,
				Name:           arg.Name,
				TokenHash:      arg.TokenHash,
				TokenLastEight: arg.TokenLastEight,
				Scopes:         arg.Scopes,
			}, nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{})

	result, err := svc.CreateToken(context.Background(), 1, CreateTokenRequest{
		Name:   "test-token",
		Scopes: []string{"read:repository"},
	})
	require.NoError(t, err)
	assert.True(t, len(result.Token) > 9)
	assert.Equal(t, "smithers_", result.Token[:9])
	assert.Len(t, result.Token, 49) // smithers_ + 40 hex chars
}

func TestAuthService_ListTokens_EmptyResult(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{
		listAccessTokensByUserIDFn: func(ctx context.Context, userID int64) ([]db.AccessToken, error) {
			return []db.AccessToken{}, nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{})

	tokens, err := svc.ListTokens(context.Background(), 1)
	require.NoError(t, err)
	assert.NotNil(t, tokens)
	assert.Len(t, tokens, 0)
}

func TestAuthService_SessionDuration_DefaultFallback(t *testing.T) {
	t.Parallel()

	cfg := defaultAuthConfig()
	cfg.SessionDuration = "invalid"
	svc := NewAuthService(&mockAuthQuerier{}, cfg, mockKeyAuthVerifier{}, mockGitHubClient{})

	// sessionDuration() should fall back to 720h (30 days) for invalid duration
	assert.Equal(t, 720*time.Hour, svc.sessionDuration())
}

func TestAuthService_SessionDuration_ZeroFallback(t *testing.T) {
	t.Parallel()

	cfg := defaultAuthConfig()
	cfg.SessionDuration = "0s"
	svc := NewAuthService(&mockAuthQuerier{}, cfg, mockKeyAuthVerifier{}, mockGitHubClient{})

	// sessionDuration() should fall back to 720h for zero duration
	assert.Equal(t, 720*time.Hour, svc.sessionDuration())
}

func TestAuthService_SessionDuration_NegativeFallback(t *testing.T) {
	t.Parallel()

	cfg := defaultAuthConfig()
	cfg.SessionDuration = "-1h"
	svc := NewAuthService(&mockAuthQuerier{}, cfg, mockKeyAuthVerifier{}, mockGitHubClient{})

	// sessionDuration() should fall back to 720h for negative duration
	assert.Equal(t, 720*time.Hour, svc.sessionDuration())
}

func TestSplitScopes_EdgeCases(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		input    string
		expected []string
	}{
		{"empty", "", []string{}},
		{"whitespace only", "   ", []string{}},
		{"single scope", "read:repository", []string{"read:repository"}},
		{"multiple scopes", "read:repository,write:user", []string{"read:repository", "write:user"}},
		{"trailing comma", "read:repository,", []string{"read:repository"}},
		{"leading comma", ",read:repository", []string{"read:repository"}},
		{"double comma", "read:repository,,write:user", []string{"read:repository", "write:user"}},
		{"spaces around commas", " read:repository , write:user ", []string{"read:repository", "write:user"}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			result := splitScopes(tc.input)
			assert.Equal(t, tc.expected, result)
		})
	}
}

func TestPickVerifiedEmail_Preferences(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		emails   []GitHubEmail
		expected string
	}{
		{"empty list", []GitHubEmail{}, ""},
		{"primary verified preferred", []GitHubEmail{
			{Email: "secondary@example.com", Primary: false, Verified: true},
			{Email: "primary@example.com", Primary: true, Verified: true},
		}, "primary@example.com"},
		{"falls back to any verified", []GitHubEmail{
			{Email: "unverified@example.com", Primary: true, Verified: false},
			{Email: "verified@example.com", Primary: false, Verified: true},
		}, "verified@example.com"},
		{"never returns an unverified email", []GitHubEmail{
			{Email: "only@example.com", Primary: false, Verified: false},
		}, ""},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			result := pickVerifiedEmail(tc.emails)
			assert.Equal(t, tc.expected, result)
		})
	}
}

func TestWalletUsernameCandidates_Generation(t *testing.T) {
	t.Parallel()

	t.Run("standard address yields increasing-entropy candidates", func(t *testing.T) {
		candidates := walletUsernameCandidates("0x1234567890123456789012345678901234567890")
		assert.Equal(t, []string{
			"wallet-34567890",
			"wallet-5678901234567890",
			"wallet-1234567890123456789012345678901234567890",
		}, candidates)
	})

	t.Run("uppercase address is lowercased", func(t *testing.T) {
		candidates := walletUsernameCandidates("0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD")
		require.Len(t, candidates, 3)
		assert.Equal(t, "wallet-cdefabcd", candidates[0])
		assert.Equal(t, "wallet-abcdefabcdefabcdefabcdefabcdefabcdefabcd", candidates[2])
	})

	t.Run("short address yields single full candidate", func(t *testing.T) {
		candidates := walletUsernameCandidates("0x1234")
		assert.Equal(t, []string{"wallet-1234"}, candidates)
	})

	t.Run("empty address yields random fallback", func(t *testing.T) {
		candidates := walletUsernameCandidates("   ")
		require.Len(t, candidates, 1)
		assert.True(t, strings.HasPrefix(candidates[0], "wallet-"))
		assert.Len(t, candidates[0], len("wallet-")+8)
	})

	t.Run("colliding suffixes diverge on later candidates", func(t *testing.T) {
		a := walletUsernameCandidates("0x1111111111111111111111111111111134567890")
		b := walletUsernameCandidates("0x2222222222222222222222222222222234567890")
		assert.Equal(t, a[0], b[0], "8-char suffix collides by construction")
		assert.NotEqual(t, a[1], b[1])
		assert.NotEqual(t, a[2], b[2])
	})
}

func TestFirstNonEmpty(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		input    []string
		expected string
	}{
		{"first non-empty", []string{"hello", "world"}, "hello"},
		{"skips empty", []string{"", "world"}, "world"},
		{"skips whitespace", []string{"  ", "world"}, "world"},
		{"all empty", []string{"", "  ", ""}, ""},
		{"no args", []string{}, ""},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			result := firstNonEmpty(tc.input...)
			assert.Equal(t, tc.expected, result)
		})
	}
}

func TestIsValidUUID(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		input string
		valid bool
	}{
		{"valid uuid v4", "550e8400-e29b-41d4-a716-446655440000", true},
		{"valid uuid all zeros", "00000000-0000-0000-0000-000000000000", true},
		{"valid uuid uppercase", "550E8400-E29B-41D4-A716-446655440000", true},
		{"too short", "550e8400-e29b", false},
		{"no dashes", "550e8400e29b41d4a716446655440000", false},
		{"wrong dash positions", "550e-8400-e29b-41d4-a716446655440", false},
		// 36-char string where position 8 has 'a' instead of '-' → triggers ch != '-' return false
		{"non-dash at required dash position", "550e8400ae29b-41d4-a716-446655440000", false},
		{"non-hex characters", "gggggggg-gggg-gggg-gggg-gggggggggggg", false},
		{"plain string", "fake-session-key-12345", false},
		{"empty", "", false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			result := isValidUUID(tc.input)
			assert.Equal(t, tc.valid, result, "isValidUUID(%q) = %v, want %v", tc.input, result, tc.valid)
		})
	}
}

func TestAuthService_VerifyKeyAuth_VerifierReturnsError(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{}, defaultAuthConfig(), mockKeyAuthVerifier{
		verifyFn: func(message, signature, expectedDomain string) (walletAddress string, nonce string, err error) {
			return "", "", fmt.Errorf("invalid signature data")
		},
	}, mockGitHubClient{})

	_, err := svc.VerifyKeyAuth(context.Background(), "bad-msg", "bad-sig")
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 401, apiErr.Status)
	assert.Contains(t, apiErr.Message, "invalid signature")
}

func TestAuthService_CreateKeyAuthNonce_DBError(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{
		createAuthNonceFn: func(ctx context.Context, arg db.CreateAuthNonceParams) (db.AuthNonce, error) {
			return db.AuthNonce{}, fmt.Errorf("db connection failed")
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{})

	_, err := svc.CreateKeyAuthNonce(context.Background())
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 500, apiErr.Status)
}

func TestAuthService_CompleteGitHubOAuth_EmptyState(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{
		exchangeCodeFn: func(ctx context.Context, code string) (GitHubTokenResult, error) {
			t.Fatal("should not exchange code with invalid state")
			return GitHubTokenResult{}, nil
		},
		fetchUserFn: func(ctx context.Context, accessToken string) (GitHubUserProfile, error) {
			return GitHubUserProfile{}, nil
		},
		fetchEmailsFn: func(ctx context.Context, accessToken string) ([]GitHubEmail, error) {
			return nil, nil
		},
	})

	_, err := svc.CompleteGitHubOAuth(context.Background(), "code", "", "verifier")
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 400, apiErr.Status)
}

func TestAuthService_VerifyKeyAuth_DuplicateWalletConflict(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{
		consumeAuthNonceFn: func(ctx context.Context, arg db.ConsumeAuthNonceParams) (int64, error) {
			return 1, nil
		},
		getUserByWalletAddressFn: func(ctx context.Context, walletAddress pgtype.Text) (db.User, error) {
			return db.User{}, pgx.ErrNoRows
		},
		createUserWithWalletFn: func(ctx context.Context, arg db.CreateUserWithWalletParams) (db.User, error) {
			return db.User{}, &pgconn.PgError{Code: "23505"}
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{
		verifyFn: func(message, signature, expectedDomain string) (walletAddress string, nonce string, err error) {
			return "0xDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF", "nonce-dup", nil
		},
	}, mockGitHubClient{})

	_, err := svc.VerifyKeyAuth(context.Background(), "message", "signature")
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 409, apiErr.Status)
	assert.Contains(t, apiErr.Message, "wallet address is already in use")
}

func TestAuthService_VerifyKeyAuth_UsernameCollisionRetriesLongerCandidate(t *testing.T) {
	t.Parallel()

	// Another wallet already owns "wallet-<last8>"; signup must retry with a
	// higher-entropy username instead of permanently rejecting the address.
	var attempts []string
	svc := NewAuthService(&mockAuthQuerier{
		consumeAuthNonceFn: func(ctx context.Context, arg db.ConsumeAuthNonceParams) (int64, error) {
			return 1, nil
		},
		getUserByWalletAddressFn: func(ctx context.Context, walletAddress pgtype.Text) (db.User, error) {
			return db.User{}, pgx.ErrNoRows
		},
		createUserWithWalletFn: func(ctx context.Context, arg db.CreateUserWithWalletParams) (db.User, error) {
			attempts = append(attempts, arg.Username)
			if len(attempts) == 1 {
				// The same retry path must handle a username reserved by an
				// organization through the canonical owner namespace.
				return db.User{}, &pgconn.PgError{Code: "23505", ConstraintName: "owner_namespaces_pkey"}
			}
			return db.User{ID: 77, Username: arg.Username, LowerUsername: arg.LowerUsername, WalletAddress: arg.WalletAddress, IsActive: true}, nil
		},
		createAuthSessionFn: func(ctx context.Context, arg db.CreateAuthSessionParams) (db.AuthSession, error) {
			return db.AuthSession{SessionKey: arg.SessionKey, UserID: arg.UserID, Username: arg.Username, ExpiresAt: arg.ExpiresAt}, nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{
		verifyFn: func(message, signature, expectedDomain string) (walletAddress string, nonce string, err error) {
			return "0x2222222222222222222222222222222234567890", "nonce-collide", nil
		},
	}, mockGitHubClient{})

	result, err := svc.VerifyKeyAuth(context.Background(), "message", "signature")
	require.NoError(t, err)
	assert.Equal(t, int64(77), result.User.ID)
	require.Equal(t, []string{"wallet-34567890", "wallet-2222222234567890"}, attempts)
}

func TestAuthService_VerifyKeyAuth_UsernameCollisionOnAllCandidatesConflicts(t *testing.T) {
	t.Parallel()

	var attempts int
	svc := NewAuthService(&mockAuthQuerier{
		consumeAuthNonceFn: func(ctx context.Context, arg db.ConsumeAuthNonceParams) (int64, error) {
			return 1, nil
		},
		getUserByWalletAddressFn: func(ctx context.Context, walletAddress pgtype.Text) (db.User, error) {
			return db.User{}, pgx.ErrNoRows
		},
		createUserWithWalletFn: func(ctx context.Context, arg db.CreateUserWithWalletParams) (db.User, error) {
			attempts++
			return db.User{}, &pgconn.PgError{Code: "23505", ConstraintName: "users_username_key"}
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{
		verifyFn: func(message, signature, expectedDomain string) (walletAddress string, nonce string, err error) {
			return "0x2222222222222222222222222222222234567890", "nonce-exhaust", nil
		},
	}, mockGitHubClient{})

	_, err := svc.VerifyKeyAuth(context.Background(), "message", "signature")
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 409, apiErr.Status)
	assert.Contains(t, apiErr.Message, "wallet-derived username is already in use")
	assert.Equal(t, 3, attempts)
}

func TestAuthService_CompleteGitHubOAuth_DuplicateEmailConflict(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{
		consumeOAuthStateFn: func(ctx context.Context, arg db.ConsumeOAuthStateParams) (int64, error) {
			return 1, nil
		},
		getOAuthAccountByProviderUserIDFn: func(ctx context.Context, arg db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return db.OauthAccount{}, pgx.ErrNoRows
		},
		createUserFn: func(ctx context.Context, arg db.CreateUserParams) (db.User, error) {
			return db.User{}, &pgconn.PgError{Code: "23505"}
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{
		exchangeCodeFn: func(ctx context.Context, code string) (GitHubTokenResult, error) {
			return GitHubTokenResult{AccessToken: "gho_dup"}, nil
		},
		fetchUserFn: func(ctx context.Context, accessToken string) (GitHubUserProfile, error) {
			return GitHubUserProfile{ID: 777, Login: "dupuser"}, nil
		},
		fetchEmailsFn: func(ctx context.Context, accessToken string) ([]GitHubEmail, error) {
			return []GitHubEmail{{Email: "taken@example.com", Primary: true, Verified: true}}, nil
		},
	})

	_, err := svc.CompleteGitHubOAuth(context.Background(), "code-dup", "state-dup", "verifier-dup")
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 409, apiErr.Status)
	assert.Contains(t, apiErr.Message, "email address is already in use")
}

// ── VerifyKeyAuth error paths ────────────────────────────────────────────────────

func TestAuthService_CompleteGitHubOAuth_OwnerNamespaceConflict(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{
		consumeOAuthStateFn: func(ctx context.Context, arg db.ConsumeOAuthStateParams) (int64, error) {
			return 1, nil
		},
		getOAuthAccountByProviderUserIDFn: func(ctx context.Context, arg db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return db.OauthAccount{}, pgx.ErrNoRows
		},
		createUserFn: func(ctx context.Context, arg db.CreateUserParams) (db.User, error) {
			return db.User{}, &pgconn.PgError{Code: "23505", ConstraintName: "owner_namespaces_pkey"}
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{
		exchangeCodeFn: func(ctx context.Context, code string) (GitHubTokenResult, error) {
			return GitHubTokenResult{AccessToken: "gho_owner_namespace"}, nil
		},
		fetchUserFn: func(ctx context.Context, accessToken string) (GitHubUserProfile, error) {
			return GitHubUserProfile{ID: 778, Login: "org-owned-slug"}, nil
		},
		fetchEmailsFn: func(ctx context.Context, accessToken string) ([]GitHubEmail, error) {
			return []GitHubEmail{{Email: "new@example.com", Primary: true, Verified: true}}, nil
		},
	})

	_, err := svc.CompleteGitHubOAuth(context.Background(), "code-owner", "state-owner", "verifier-owner")
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 409, apiErr.Status)
	assert.Contains(t, apiErr.Message, "username is already in use")
}

func TestAuthService_VerifyKeyAuth_GetUserByWalletAddressDBError(t *testing.T) {
	t.Parallel()

	// Simulate GetUserByWalletAddress returning a non-ErrNoRows DB error.
	svc := NewAuthService(&mockAuthQuerier{
		consumeAuthNonceFn: func(ctx context.Context, arg db.ConsumeAuthNonceParams) (int64, error) {
			return 1, nil
		},
		getUserByWalletAddressFn: func(ctx context.Context, walletAddress pgtype.Text) (db.User, error) {
			return db.User{}, fmt.Errorf("connection reset by peer")
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{
		verifyFn: func(message, signature, expectedDomain string) (string, string, error) {
			return "0xdeadbeef", "test-nonce", nil
		},
	}, mockGitHubClient{})

	_, err := svc.VerifyKeyAuth(context.Background(), "msg", "sig")
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 500, apiErr.Status)
	assert.Contains(t, apiErr.Message, "failed to find wallet user")
}

func TestAuthService_VerifyKeyAuth_CreateUserWithWalletDBError(t *testing.T) {
	t.Parallel()

	// Simulate CreateUserWithWallet returning a non-unique-violation DB error.
	svc := NewAuthService(&mockAuthQuerier{
		consumeAuthNonceFn: func(ctx context.Context, arg db.ConsumeAuthNonceParams) (int64, error) {
			return 1, nil
		},
		getUserByWalletAddressFn: func(ctx context.Context, walletAddress pgtype.Text) (db.User, error) {
			return db.User{}, pgx.ErrNoRows
		},
		createUserWithWalletFn: func(ctx context.Context, arg db.CreateUserWithWalletParams) (db.User, error) {
			return db.User{}, fmt.Errorf("disk full")
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{
		verifyFn: func(message, signature, expectedDomain string) (string, string, error) {
			return "0xdeadbeef1234", "test-nonce", nil
		},
	}, mockGitHubClient{})

	_, err := svc.VerifyKeyAuth(context.Background(), "msg", "sig")
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 500, apiErr.Status)
	assert.Contains(t, apiErr.Message, "failed to create wallet user")
}

func TestAuthService_VerifyKeyAuth_CreateAuthSessionError(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{
		consumeAuthNonceFn: func(ctx context.Context, arg db.ConsumeAuthNonceParams) (int64, error) {
			return 1, nil
		},
		getUserByWalletAddressFn: func(ctx context.Context, walletAddress pgtype.Text) (db.User, error) {
			return db.User{ID: 42, Username: "test"}, nil
		},
		createAuthSessionFn: func(ctx context.Context, arg db.CreateAuthSessionParams) (db.AuthSession, error) {
			return db.AuthSession{}, fmt.Errorf("session table locked")
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{
		verifyFn: func(message, signature, expectedDomain string) (string, string, error) {
			return "0xdeadbeef", "test-nonce", nil
		},
	}, mockGitHubClient{})

	_, err := svc.VerifyKeyAuth(context.Background(), "msg", "sig")
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 500, apiErr.Status)
	assert.Contains(t, apiErr.Message, "failed to create session")
}

// ── VerifyKeyAuth domain configuration ─────────────────────────────────────────

func TestAuthService_VerifyKeyAuth_EmptyDomainReturnsConfigError(t *testing.T) {
	t.Parallel()

	cfg := defaultAuthConfig()
	cfg.KeyAuthDomain = "   "
	svc := NewAuthService(&mockAuthQuerier{}, cfg, mockKeyAuthVerifier{
		verifyFn: func(message, signature, expectedDomain string) (string, string, error) {
			return "0xdeadbeef", "nonce", nil
		},
	}, mockGitHubClient{})

	_, err := svc.VerifyKeyAuth(context.Background(), "msg", "sig")
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 500, apiErr.Status)
	assert.Contains(t, apiErr.Message, "key auth domain is not configured")
}

func TestAuthService_VerifyKeyAuth_UsesOverriddenDomain(t *testing.T) {
	t.Parallel()

	cfg := defaultAuthConfig()
	cfg.KeyAuthDomain = "localhost:4100"
	svc := NewAuthService(&mockAuthQuerier{
		consumeAuthNonceFn: func(ctx context.Context, arg db.ConsumeAuthNonceParams) (int64, error) {
			return 0, nil // zero rows → nonce expired/consumed
		},
	}, cfg, mockKeyAuthVerifier{
		verifyFn: func(message, signature, expectedDomain string) (string, string, error) {
			assert.Equal(t, "localhost:4100", expectedDomain)
			return "0xdeadbeef", "nonce", nil
		},
	}, mockGitHubClient{})

	_, err := svc.VerifyKeyAuth(context.Background(), "msg", "sig")
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 401, apiErr.Status)
	assert.Contains(t, apiErr.Message, "invalid or expired nonce")
}

func TestAuthService_VerifyKeyAuth_IgnoresGitHubRedirectURLWhenDomainConfigured(t *testing.T) {
	t.Parallel()

	cfg := defaultAuthConfig()
	cfg.KeyAuthDomain = "auth.smithers.local"
	cfg.GitHubRedirectURL = "://not-a-valid-url"
	svc := NewAuthService(&mockAuthQuerier{
		consumeAuthNonceFn: func(ctx context.Context, arg db.ConsumeAuthNonceParams) (int64, error) {
			return 0, nil // zero rows → nonce expired/consumed
		},
	}, cfg, mockKeyAuthVerifier{
		verifyFn: func(message, signature, expectedDomain string) (string, string, error) {
			assert.Equal(t, "auth.smithers.local", expectedDomain)
			return "0xdeadbeef", "nonce", nil
		},
	}, mockGitHubClient{})

	_, err := svc.VerifyKeyAuth(context.Background(), "msg", "sig")
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 401, apiErr.Status)
	assert.Contains(t, apiErr.Message, "invalid or expired nonce")
}

// ── StartGitHubOAuth empty redirect URL ──────────────────────────────────────

func TestAuthService_StartGitHubOAuth_EmptyRedirectURLStillStarts(t *testing.T) {
	t.Parallel()

	// An empty GitHubRedirectURL must not break the direct GitHub authorize
	// flow — the redirect URI is owned by the GitHub client, not the service.
	cfg := defaultAuthConfig()
	cfg.GitHubRedirectURL = ""
	svc := NewAuthService(&mockAuthQuerier{
		createOAuthStateFn: func(ctx context.Context, arg db.CreateOAuthStateParams) (db.OauthState, error) {
			return db.OauthState{StateKey: arg.State}, nil
		},
	}, cfg, mockKeyAuthVerifier{}, mockGitHubClient{
		// GitHub client must be non-nil (created via mockGitHubClient struct literal)
		exchangeCodeFn: func(ctx context.Context, code string) (GitHubTokenResult, error) { return GitHubTokenResult{}, nil },
		fetchUserFn: func(ctx context.Context, accessToken string) (GitHubUserProfile, error) {
			return GitHubUserProfile{}, nil
		},
		fetchEmailsFn: func(ctx context.Context, accessToken string) ([]GitHubEmail, error) { return nil, nil },
	})

	redirectURL, err := svc.StartGitHubOAuth(context.Background(), "test-verifier")
	require.NoError(t, err)
	// GitHub sign-in goes DIRECT to the GitHub App authorize endpoint.
	assert.Contains(t, redirectURL, "github.test/login/oauth/authorize")
}

// ── ListTokens error path ────────────────────────────────────────────────────

func TestAuthService_ListTokens_DBError(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{
		listAccessTokensByUserIDFn: func(ctx context.Context, userID int64) ([]db.AccessToken, error) {
			return nil, fmt.Errorf("db unavailable")
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{})

	_, err := svc.ListTokens(context.Background(), 1)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "db unavailable")
}

// ── CreateToken error paths ──────────────────────────────────────────────────

func TestAuthService_CreateToken_GetUserByIDError(t *testing.T) {
	t.Parallel()

	// Test the GetUserByID error path when containsPrivilegedScope returns true.
	svc := NewAuthService(&mockAuthQuerier{
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			return db.User{}, fmt.Errorf("db connection lost")
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{})

	_, err := svc.CreateToken(context.Background(), 1, CreateTokenRequest{
		Name:   "test-token",
		Scopes: []string{"admin"},
	})
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 500, apiErr.Status)
	assert.Contains(t, apiErr.Message, "failed to resolve user")
}

func TestAuthService_CreateToken_CreateAccessTokenDBError(t *testing.T) {
	t.Parallel()

	// Test CreateAccessToken DB error path (non-admin user, non-privileged scope).
	svc := NewAuthService(&mockAuthQuerier{
		createAccessTokenFn: func(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
			return db.AccessToken{}, fmt.Errorf("db write failed")
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{})

	_, err := svc.CreateToken(context.Background(), 1, CreateTokenRequest{
		Name:   "my-token",
		Scopes: []string{"read:repository"},
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "db write failed")
}

// ── DeleteToken error path ───────────────────────────────────────────────────

func TestAuthService_DeleteToken_DBError(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{
		deleteAccessTokenByIDAndUserIDFn: func(ctx context.Context, arg db.DeleteAccessTokenByIDAndUserIDParams) (int64, error) {
			return 0, fmt.Errorf("db error")
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{})

	err := svc.DeleteToken(context.Background(), 1, 99)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "db error")
}

// ── CompleteGitHubOAuth error paths ─────────────────────────────────────────

func TestAuthService_CompleteGitHubOAuth_ExchangeCodeError(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{
		consumeOAuthStateFn: func(ctx context.Context, arg db.ConsumeOAuthStateParams) (int64, error) {
			return 1, nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{
		exchangeCodeFn: func(ctx context.Context, code string) (GitHubTokenResult, error) {
			return GitHubTokenResult{}, fmt.Errorf("github rate limited")
		},
		fetchUserFn: func(ctx context.Context, accessToken string) (GitHubUserProfile, error) {
			return GitHubUserProfile{}, nil
		},
		fetchEmailsFn: func(ctx context.Context, accessToken string) ([]GitHubEmail, error) { return nil, nil },
	})

	_, err := svc.CompleteGitHubOAuth(context.Background(), "code", "state", "verifier")
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 400, apiErr.Status)
	assert.Contains(t, apiErr.Message, "failed to exchange oauth code")
}

func TestAuthService_CompleteGitHubOAuth_FetchUserError(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{
		consumeOAuthStateFn: func(ctx context.Context, arg db.ConsumeOAuthStateParams) (int64, error) {
			return 1, nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{
		exchangeCodeFn: func(ctx context.Context, code string) (GitHubTokenResult, error) {
			return GitHubTokenResult{AccessToken: "gho_test"}, nil
		},
		fetchUserFn: func(ctx context.Context, accessToken string) (GitHubUserProfile, error) {
			return GitHubUserProfile{}, fmt.Errorf("github api error")
		},
		fetchEmailsFn: func(ctx context.Context, accessToken string) ([]GitHubEmail, error) { return nil, nil },
	})

	_, err := svc.CompleteGitHubOAuth(context.Background(), "code", "state", "verifier")
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 500, apiErr.Status)
	assert.Contains(t, apiErr.Message, "failed to fetch oauth profile")
}

func TestAuthService_CompleteGitHubOAuth_FetchEmailsError(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{
		consumeOAuthStateFn: func(ctx context.Context, arg db.ConsumeOAuthStateParams) (int64, error) {
			return 1, nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{
		exchangeCodeFn: func(ctx context.Context, code string) (GitHubTokenResult, error) {
			return GitHubTokenResult{AccessToken: "gho_test"}, nil
		},
		fetchUserFn: func(ctx context.Context, accessToken string) (GitHubUserProfile, error) {
			return GitHubUserProfile{ID: 42, Login: "testuser"}, nil
		},
		fetchEmailsFn: func(ctx context.Context, accessToken string) ([]GitHubEmail, error) {
			return nil, fmt.Errorf("emails api error")
		},
	})

	_, err := svc.CompleteGitHubOAuth(context.Background(), "code", "state", "verifier")
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 500, apiErr.Status)
	assert.Contains(t, apiErr.Message, "failed to fetch oauth emails")
}

func TestAuthService_CompleteGitHubOAuth_GetUserByIDError(t *testing.T) {
	t.Parallel()

	// When GetOAuthAccountByProviderUserID succeeds (existing account) but
	// GetUserByID fails, the service should return an internal error.
	svc := NewAuthService(&mockAuthQuerier{
		consumeOAuthStateFn: func(ctx context.Context, arg db.ConsumeOAuthStateParams) (int64, error) {
			return 1, nil
		},
		getOAuthAccountByProviderUserIDFn: func(ctx context.Context, arg db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return db.OauthAccount{UserID: 99}, nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			return db.User{}, fmt.Errorf("user table unavailable")
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{
		exchangeCodeFn: func(ctx context.Context, code string) (GitHubTokenResult, error) {
			return GitHubTokenResult{AccessToken: "gho_test"}, nil
		},
		fetchUserFn: func(ctx context.Context, accessToken string) (GitHubUserProfile, error) {
			return GitHubUserProfile{ID: 42, Login: "testuser"}, nil
		},
		fetchEmailsFn: func(ctx context.Context, accessToken string) ([]GitHubEmail, error) {
			return []GitHubEmail{{Email: "test@example.com", Primary: true, Verified: true}}, nil
		},
	})

	_, err := svc.CompleteGitHubOAuth(context.Background(), "code", "state", "verifier")
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 500, apiErr.Status)
	assert.Contains(t, apiErr.Message, "failed to load oauth user")
}

func TestAuthService_CompleteGitHubOAuth_GetOAuthAccountDBError(t *testing.T) {
	t.Parallel()

	// GetOAuthAccountByProviderUserID returns a non-ErrNoRows error.
	svc := NewAuthService(&mockAuthQuerier{
		consumeOAuthStateFn: func(ctx context.Context, arg db.ConsumeOAuthStateParams) (int64, error) {
			return 1, nil
		},
		getOAuthAccountByProviderUserIDFn: func(ctx context.Context, arg db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return db.OauthAccount{}, fmt.Errorf("oauth account table locked")
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{
		exchangeCodeFn: func(ctx context.Context, code string) (GitHubTokenResult, error) {
			return GitHubTokenResult{AccessToken: "gho_test"}, nil
		},
		fetchUserFn: func(ctx context.Context, accessToken string) (GitHubUserProfile, error) {
			return GitHubUserProfile{ID: 42, Login: "testuser"}, nil
		},
		fetchEmailsFn: func(ctx context.Context, accessToken string) ([]GitHubEmail, error) {
			return []GitHubEmail{}, nil
		},
	})

	_, err := svc.CompleteGitHubOAuth(context.Background(), "code", "state", "verifier")
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 500, apiErr.Status)
	assert.Contains(t, apiErr.Message, "failed to query oauth account")
}

func TestAuthService_CompleteGitHubOAuth_CreateUserDBError(t *testing.T) {
	t.Parallel()

	// CreateUser returns a non-unique-violation DB error (disk full, etc.).
	svc := NewAuthService(&mockAuthQuerier{
		consumeOAuthStateFn: func(ctx context.Context, arg db.ConsumeOAuthStateParams) (int64, error) {
			return 1, nil
		},
		getOAuthAccountByProviderUserIDFn: func(ctx context.Context, arg db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return db.OauthAccount{}, pgx.ErrNoRows
		},
		createUserFn: func(ctx context.Context, arg db.CreateUserParams) (db.User, error) {
			return db.User{}, fmt.Errorf("disk full")
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{
		exchangeCodeFn: func(ctx context.Context, code string) (GitHubTokenResult, error) {
			return GitHubTokenResult{AccessToken: "gho_test"}, nil
		},
		fetchUserFn: func(ctx context.Context, accessToken string) (GitHubUserProfile, error) {
			return GitHubUserProfile{ID: 42, Login: "testuser"}, nil
		},
		fetchEmailsFn: func(ctx context.Context, accessToken string) ([]GitHubEmail, error) {
			return []GitHubEmail{}, nil
		},
	})

	_, err := svc.CompleteGitHubOAuth(context.Background(), "code", "state", "verifier")
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 500, apiErr.Status)
	assert.Contains(t, apiErr.Message, "failed to create oauth user")
}

func TestAuthService_CompleteGitHubOAuth_UpsertOAuthAccountError(t *testing.T) {
	t.Parallel()

	for _, refreshToken := range []string{"", "ghr_test"} {
		t.Run("refresh_token="+refreshToken, func(t *testing.T) {
			svc := NewAuthService(&mockAuthQuerier{
				consumeOAuthStateFn: func(ctx context.Context, arg db.ConsumeOAuthStateParams) (int64, error) {
					return 1, nil
				},
				getOAuthAccountByProviderUserIDFn: func(ctx context.Context, arg db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
					return db.OauthAccount{}, pgx.ErrNoRows
				},
				createUserFn: func(ctx context.Context, arg db.CreateUserParams) (db.User, error) {
					return db.User{ID: 10, Username: "testuser"}, nil
				},
				upsertOAuthAccountFn: func(ctx context.Context, arg db.UpsertOAuthAccountParams) (db.OauthAccount, error) {
					return db.OauthAccount{}, fmt.Errorf("upsert failed")
				},
			}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{
				exchangeCodeFn: func(ctx context.Context, code string) (GitHubTokenResult, error) {
					return GitHubTokenResult{AccessToken: "gho_test", RefreshToken: refreshToken}, nil
				},
				fetchUserFn: func(ctx context.Context, accessToken string) (GitHubUserProfile, error) {
					return GitHubUserProfile{ID: 42, Login: "testuser"}, nil
				},
				fetchEmailsFn: func(ctx context.Context, accessToken string) ([]GitHubEmail, error) {
					return []GitHubEmail{}, nil
				},
			})

			_, err := svc.CompleteGitHubOAuth(context.Background(), "code", "state", "verifier")
			require.Error(t, err)
			apiErr, ok := err.(*errors.APIError)
			require.True(t, ok)
			assert.Equal(t, 500, apiErr.Status)
			assert.Contains(t, apiErr.Message, "failed to upsert oauth account")
		})
	}
}

func TestAuthService_CompleteGitHubOAuth_UpsertEmailErrorDoesNotBlockSession(t *testing.T) {
	t.Parallel()

	sessionCreated := false
	svc := NewAuthService(&mockAuthQuerier{
		consumeOAuthStateFn: func(ctx context.Context, arg db.ConsumeOAuthStateParams) (int64, error) {
			return 1, nil
		},
		getOAuthAccountByProviderUserIDFn: func(ctx context.Context, arg db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return db.OauthAccount{}, pgx.ErrNoRows
		},
		createUserFn: func(ctx context.Context, arg db.CreateUserParams) (db.User, error) {
			return db.User{ID: 10, Username: "testuser"}, nil
		},
		upsertOAuthAccountFn: func(ctx context.Context, arg db.UpsertOAuthAccountParams) (db.OauthAccount, error) {
			return db.OauthAccount{}, nil
		},
		upsertEmailAddressFn: func(ctx context.Context, arg db.UpsertEmailAddressParams) (db.UpsertEmailAddressRow, error) {
			return db.UpsertEmailAddressRow{}, fmt.Errorf("email upsert failed")
		},
		createAuthSessionFn: func(ctx context.Context, arg db.CreateAuthSessionParams) (db.AuthSession, error) {
			sessionCreated = true
			return db.AuthSession{SessionKey: arg.SessionKey, UserID: arg.UserID, Username: arg.Username, ExpiresAt: arg.ExpiresAt}, nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{
		exchangeCodeFn: func(ctx context.Context, code string) (GitHubTokenResult, error) {
			return GitHubTokenResult{AccessToken: "gho_test"}, nil
		},
		fetchUserFn: func(ctx context.Context, accessToken string) (GitHubUserProfile, error) {
			return GitHubUserProfile{ID: 42, Login: "testuser"}, nil
		},
		fetchEmailsFn: func(ctx context.Context, accessToken string) ([]GitHubEmail, error) {
			return []GitHubEmail{{Email: "test@example.com", Primary: true, Verified: true}}, nil
		},
	})

	result, err := svc.CompleteGitHubOAuth(context.Background(), "code", "state", "verifier")
	require.NoError(t, err)
	assert.True(t, sessionCreated)
	assert.Equal(t, int64(10), result.User.ID)
	assert.NotEmpty(t, result.SessionKey)
}

func TestAuthService_CompleteGitHubOAuth_CreateAuthSessionError(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{
		consumeOAuthStateFn: func(ctx context.Context, arg db.ConsumeOAuthStateParams) (int64, error) {
			return 1, nil
		},
		getOAuthAccountByProviderUserIDFn: func(ctx context.Context, arg db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return db.OauthAccount{}, pgx.ErrNoRows
		},
		createUserFn: func(ctx context.Context, arg db.CreateUserParams) (db.User, error) {
			return db.User{ID: 10, Username: "testuser"}, nil
		},
		upsertOAuthAccountFn: func(ctx context.Context, arg db.UpsertOAuthAccountParams) (db.OauthAccount, error) {
			return db.OauthAccount{}, nil
		},
		upsertEmailAddressFn: func(ctx context.Context, arg db.UpsertEmailAddressParams) (db.UpsertEmailAddressRow, error) {
			return db.UpsertEmailAddressRow{}, nil
		},
		createAuthSessionFn: func(ctx context.Context, arg db.CreateAuthSessionParams) (db.AuthSession, error) {
			return db.AuthSession{}, fmt.Errorf("session write failed")
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{
		exchangeCodeFn: func(ctx context.Context, code string) (GitHubTokenResult, error) {
			return GitHubTokenResult{AccessToken: "gho_test"}, nil
		},
		fetchUserFn: func(ctx context.Context, accessToken string) (GitHubUserProfile, error) {
			return GitHubUserProfile{ID: 42, Login: "testuser"}, nil
		},
		fetchEmailsFn: func(ctx context.Context, accessToken string) ([]GitHubEmail, error) {
			return []GitHubEmail{{Email: "test@example.com", Primary: true, Verified: true}}, nil
		},
	})

	_, err := svc.CompleteGitHubOAuth(context.Background(), "code", "state", "verifier")
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 500, apiErr.Status)
	assert.Contains(t, apiErr.Message, "failed to create session")
}

// --- prohibit_login enforcement tests ---

func TestAuthService_VerifyKeyAuth_RejectsProhibitedLoginUser(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{
		consumeAuthNonceFn: func(ctx context.Context, arg db.ConsumeAuthNonceParams) (int64, error) {
			return 1, nil
		},
		getUserByWalletAddressFn: func(ctx context.Context, walletAddress pgtype.Text) (db.User, error) {
			return db.User{
				ID:            55,
				Username:      "banned-wallet-user",
				LowerUsername: "banned-wallet-user",
				IsActive:      true,
				ProhibitLogin: true,
			}, nil
		},
		createAuthSessionFn: func(ctx context.Context, arg db.CreateAuthSessionParams) (db.AuthSession, error) {
			t.Fatal("CreateAuthSession must not be called for prohibited-login user")
			return db.AuthSession{}, nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{
		verifyFn: func(message, signature, expectedDomain string) (walletAddress string, nonce string, err error) {
			return "0xbanned000000000000000000000000000000000", "nonce-banned", nil
		},
	}, mockGitHubClient{})

	_, err := svc.VerifyKeyAuth(context.Background(), "message", "signature")
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 403, apiErr.Status)
	assert.Equal(t, "account is suspended", apiErr.Message)
}

func TestAuthService_CompleteGitHubOAuth_RejectsProhibitedLoginExistingUser(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{
		consumeOAuthStateFn: func(ctx context.Context, arg db.ConsumeOAuthStateParams) (int64, error) {
			return 1, nil
		},
		getOAuthAccountByProviderUserIDFn: func(ctx context.Context, arg db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return db.OauthAccount{ID: 7, UserID: 66, Provider: "github", ProviderUserID: "200"}, nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			return db.User{
				ID:            66,
				Username:      "banned-github-user",
				LowerUsername: "banned-github-user",
				IsActive:      true,
				ProhibitLogin: true,
			}, nil
		},
		upsertOAuthAccountFn: func(ctx context.Context, arg db.UpsertOAuthAccountParams) (db.OauthAccount, error) {
			t.Fatal("UpsertOAuthAccount must not be called for prohibited-login user")
			return db.OauthAccount{}, nil
		},
		createAuthSessionFn: func(ctx context.Context, arg db.CreateAuthSessionParams) (db.AuthSession, error) {
			t.Fatal("CreateAuthSession must not be called for prohibited-login user")
			return db.AuthSession{}, nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{
		exchangeCodeFn: func(ctx context.Context, code string) (GitHubTokenResult, error) {
			return GitHubTokenResult{AccessToken: "gho_banned"}, nil
		},
		fetchUserFn: func(ctx context.Context, accessToken string) (GitHubUserProfile, error) {
			return GitHubUserProfile{ID: 200, Login: "banned-github-user"}, nil
		},
		fetchEmailsFn: func(ctx context.Context, accessToken string) ([]GitHubEmail, error) {
			return []GitHubEmail{{Email: "banned@example.com", Primary: true, Verified: true}}, nil
		},
	})

	_, err := svc.CompleteGitHubOAuth(context.Background(), "code", "state", "verifier")
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 403, apiErr.Status)
	assert.Equal(t, "account is suspended", apiErr.Message)
}

func TestAuthService_CompleteGitHubOAuth_RejectsProhibitedLoginNewUser(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{
		consumeOAuthStateFn: func(ctx context.Context, arg db.ConsumeOAuthStateParams) (int64, error) {
			return 1, nil
		},
		getOAuthAccountByProviderUserIDFn: func(ctx context.Context, arg db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return db.OauthAccount{}, pgx.ErrNoRows
		},
		createUserFn: func(ctx context.Context, arg db.CreateUserParams) (db.User, error) {
			return db.User{
				ID:            99,
				Username:      arg.Username,
				LowerUsername: arg.LowerUsername,
				IsActive:      true,
				ProhibitLogin: true, // edge case: newly created user marked as prohibited
			}, nil
		},
		upsertOAuthAccountFn: func(ctx context.Context, arg db.UpsertOAuthAccountParams) (db.OauthAccount, error) {
			return db.OauthAccount{}, nil
		},
		upsertEmailAddressFn: func(ctx context.Context, arg db.UpsertEmailAddressParams) (db.UpsertEmailAddressRow, error) {
			return db.UpsertEmailAddressRow{}, nil
		},
		createAuthSessionFn: func(ctx context.Context, arg db.CreateAuthSessionParams) (db.AuthSession, error) {
			t.Fatal("CreateAuthSession must not be called for prohibited-login user")
			return db.AuthSession{}, nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{
		exchangeCodeFn: func(ctx context.Context, code string) (GitHubTokenResult, error) {
			return GitHubTokenResult{AccessToken: "gho_newbanned"}, nil
		},
		fetchUserFn: func(ctx context.Context, accessToken string) (GitHubUserProfile, error) {
			return GitHubUserProfile{ID: 300, Login: "newbanned"}, nil
		},
		fetchEmailsFn: func(ctx context.Context, accessToken string) ([]GitHubEmail, error) {
			return []GitHubEmail{{Email: "newbanned@example.com", Primary: true, Verified: true}}, nil
		},
	})

	_, err := svc.CompleteGitHubOAuth(context.Background(), "code", "state", "verifier")
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 403, apiErr.Status)
	assert.Equal(t, "account is suspended", apiErr.Message)
}

// ── OAuth token encryption tests ─────────────────────────────────────────────

func TestAuthService_CompleteGitHubOAuth_EncryptsAccessTokenBeforeUpsert(t *testing.T) {
	t.Parallel()

	const plainToken = "gho_encrypted_test_token_abc123"
	cfg := defaultAuthConfig()

	var capturedCiphertext []byte
	svc := NewAuthService(&mockAuthQuerier{
		consumeOAuthStateFn: func(ctx context.Context, arg db.ConsumeOAuthStateParams) (int64, error) {
			return 1, nil
		},
		getOAuthAccountByProviderUserIDFn: func(ctx context.Context, arg db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return db.OauthAccount{}, pgx.ErrNoRows
		},
		createUserFn: func(ctx context.Context, arg db.CreateUserParams) (db.User, error) {
			return db.User{ID: 100, Username: arg.Username, LowerUsername: arg.LowerUsername, IsActive: true}, nil
		},
		upsertOAuthAccountFn: func(ctx context.Context, arg db.UpsertOAuthAccountParams) (db.OauthAccount, error) {
			capturedCiphertext = arg.AccessTokenEncrypted
			// Assert the stored bytes are NOT plaintext
			assert.False(t, bytes.Equal(arg.AccessTokenEncrypted, []byte(plainToken)),
				"access_token_encrypted must not contain plaintext token")
			return db.OauthAccount{UserID: arg.UserID, Provider: arg.Provider, ProviderUserID: arg.ProviderUserID}, nil
		},
		upsertEmailAddressFn: func(ctx context.Context, arg db.UpsertEmailAddressParams) (db.UpsertEmailAddressRow, error) {
			return db.UpsertEmailAddressRow{}, nil
		},
		createAuthSessionFn: func(ctx context.Context, arg db.CreateAuthSessionParams) (db.AuthSession, error) {
			return db.AuthSession{SessionKey: arg.SessionKey, UserID: arg.UserID, Username: arg.Username, ExpiresAt: arg.ExpiresAt}, nil
		},
	}, cfg, mockKeyAuthVerifier{}, mockGitHubClient{
		exchangeCodeFn: func(ctx context.Context, code string) (GitHubTokenResult, error) {
			return GitHubTokenResult{AccessToken: plainToken}, nil
		},
		fetchUserFn: func(ctx context.Context, accessToken string) (GitHubUserProfile, error) {
			return GitHubUserProfile{ID: 501, Login: "encryptuser"}, nil
		},
		fetchEmailsFn: func(ctx context.Context, accessToken string) ([]GitHubEmail, error) {
			return []GitHubEmail{{Email: "enc@example.com", Primary: true, Verified: true}}, nil
		},
	})

	_, err := svc.CompleteGitHubOAuth(context.Background(), "code-enc", "state-enc", "verifier-enc")
	require.NoError(t, err)

	// Verify captured ciphertext decrypts back to original token
	require.NotEmpty(t, capturedCiphertext, "UpsertOAuthAccount should have been called")
	key := crypto.DeriveKey(cfg.SessionSecret)
	decrypted, err := crypto.Decrypt(key, capturedCiphertext)
	require.NoError(t, err, "ciphertext should be decryptable with derived key")
	assert.Equal(t, plainToken, string(decrypted), "decrypted token should match original")
}

func TestAuthService_CompleteGitHubOAuth_EncryptionFailsWhenSessionSecretMissing(t *testing.T) {
	t.Parallel()

	cfg := defaultAuthConfig()
	cfg.SessionSecret = "" // empty session secret

	upsertCalled := false
	svc := NewAuthService(&mockAuthQuerier{
		consumeOAuthStateFn: func(ctx context.Context, arg db.ConsumeOAuthStateParams) (int64, error) {
			return 1, nil
		},
		getOAuthAccountByProviderUserIDFn: func(ctx context.Context, arg db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return db.OauthAccount{}, pgx.ErrNoRows
		},
		createUserFn: func(ctx context.Context, arg db.CreateUserParams) (db.User, error) {
			return db.User{ID: 200, Username: arg.Username, LowerUsername: arg.LowerUsername, IsActive: true}, nil
		},
		upsertOAuthAccountFn: func(ctx context.Context, arg db.UpsertOAuthAccountParams) (db.OauthAccount, error) {
			upsertCalled = true
			return db.OauthAccount{}, nil
		},
		upsertEmailAddressFn: func(ctx context.Context, arg db.UpsertEmailAddressParams) (db.UpsertEmailAddressRow, error) {
			return db.UpsertEmailAddressRow{}, nil
		},
		createAuthSessionFn: func(ctx context.Context, arg db.CreateAuthSessionParams) (db.AuthSession, error) {
			return db.AuthSession{SessionKey: arg.SessionKey, UserID: arg.UserID, Username: arg.Username, ExpiresAt: arg.ExpiresAt}, nil
		},
	}, cfg, mockKeyAuthVerifier{}, mockGitHubClient{
		exchangeCodeFn: func(ctx context.Context, code string) (GitHubTokenResult, error) {
			return GitHubTokenResult{AccessToken: "gho_should_fail"}, nil
		},
		fetchUserFn: func(ctx context.Context, accessToken string) (GitHubUserProfile, error) {
			return GitHubUserProfile{ID: 601, Login: "nosecret"}, nil
		},
		fetchEmailsFn: func(ctx context.Context, accessToken string) ([]GitHubEmail, error) {
			return []GitHubEmail{{Email: "nosecret@example.com", Primary: true, Verified: true}}, nil
		},
	})

	_, err := svc.CompleteGitHubOAuth(context.Background(), "code", "state", "verifier")
	require.Error(t, err, "should fail when SessionSecret is empty")
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 500, apiErr.Status)
	assert.False(t, upsertCalled, "UpsertOAuthAccount should not be called when encryption fails")
}

func TestAuthService_DecryptOAuthAccessToken_RoundTrip(t *testing.T) {
	t.Parallel()

	cfg := defaultAuthConfig()
	svc := NewAuthService(&mockAuthQuerier{}, cfg, mockKeyAuthVerifier{}, mockGitHubClient{})

	// Encrypt a token using pkg/crypto directly
	plainToken := "gho_roundtrip_token_xyz789"
	key := crypto.DeriveKey(cfg.SessionSecret)
	ciphertext, err := crypto.Encrypt(key, []byte(plainToken))
	require.NoError(t, err)

	// Decrypt using service helper
	decrypted, err := svc.DecryptOAuthAccessToken(ciphertext)
	require.NoError(t, err)
	assert.Equal(t, plainToken, decrypted)
}

func TestAuthService_DecryptOAuthAccessToken_InvalidCiphertext(t *testing.T) {
	t.Parallel()

	cfg := defaultAuthConfig()
	svc := NewAuthService(&mockAuthQuerier{}, cfg, mockKeyAuthVerifier{}, mockGitHubClient{})

	// Malformed/truncated ciphertext
	_, err := svc.DecryptOAuthAccessToken([]byte("not-valid-ciphertext"))
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 500, apiErr.Status)
}

func TestAuthService_DecryptOAuthAccessToken_EmptyCiphertext(t *testing.T) {
	t.Parallel()

	cfg := defaultAuthConfig()
	svc := NewAuthService(&mockAuthQuerier{}, cfg, mockKeyAuthVerifier{}, mockGitHubClient{})

	_, err := svc.DecryptOAuthAccessToken([]byte{})
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 500, apiErr.Status)
}

func TestAuthService_DecryptOAuthAccessToken_NilCiphertext(t *testing.T) {
	t.Parallel()

	cfg := defaultAuthConfig()
	svc := NewAuthService(&mockAuthQuerier{}, cfg, mockKeyAuthVerifier{}, mockGitHubClient{})

	_, err := svc.DecryptOAuthAccessToken(nil)
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 500, apiErr.Status)
}

func TestAuthService_CompleteGitHubOAuth_ExistingAccountReadDecryptFailure(t *testing.T) {
	t.Parallel()

	// Mock GetOAuthAccountByProviderUserID to return an account with invalid (plaintext/corrupt) ciphertext
	svc := NewAuthService(&mockAuthQuerier{
		consumeOAuthStateFn: func(ctx context.Context, arg db.ConsumeOAuthStateParams) (int64, error) {
			return 1, nil
		},
		getOAuthAccountByProviderUserIDFn: func(ctx context.Context, arg db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return db.OauthAccount{
				ID:                   7,
				UserID:               22,
				Provider:             "github",
				ProviderUserID:       "101",
				AccessTokenEncrypted: []byte("invalid-not-encrypted-ciphertext"),
			}, nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			return db.User{ID: id, Username: "octocat", LowerUsername: "octocat", IsActive: true}, nil
		},
		upsertOAuthAccountFn: func(ctx context.Context, arg db.UpsertOAuthAccountParams) (db.OauthAccount, error) {
			t.Fatal("UpsertOAuthAccount should not be called when decrypt fails")
			return db.OauthAccount{}, nil
		},
		createAuthSessionFn: func(ctx context.Context, arg db.CreateAuthSessionParams) (db.AuthSession, error) {
			t.Fatal("CreateAuthSession should not be called when decrypt fails")
			return db.AuthSession{}, nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{
		exchangeCodeFn: func(ctx context.Context, code string) (GitHubTokenResult, error) {
			return GitHubTokenResult{AccessToken: "gho_abc"}, nil
		},
		fetchUserFn: func(ctx context.Context, accessToken string) (GitHubUserProfile, error) {
			return GitHubUserProfile{ID: 101, Login: "octocat"}, nil
		},
		fetchEmailsFn: func(ctx context.Context, accessToken string) ([]GitHubEmail, error) {
			return []GitHubEmail{{Email: "octo@example.com", Primary: true, Verified: true}}, nil
		},
	})

	_, err := svc.CompleteGitHubOAuth(context.Background(), "code-1", "state-1", "verifier-1")
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 500, apiErr.Status)
}

// TestAuthService_CompleteGitHubOAuth_PersistsRefreshToken verifies the connect
// flow now stores an encrypted refresh token (previously always nil) so the
// access token can be renewed after its ~8h expiry.
func TestAuthService_CompleteGitHubOAuth_PersistsRefreshToken(t *testing.T) {
	t.Parallel()

	const plainAccess = "gho_access_abc"
	const plainRefresh = "ghr_refresh_xyz"
	cfg := defaultAuthConfig()

	var captured db.UpsertOAuthAccountParams
	svc := NewAuthService(&mockAuthQuerier{
		consumeOAuthStateFn: func(ctx context.Context, arg db.ConsumeOAuthStateParams) (int64, error) { return 1, nil },
		getOAuthAccountByProviderUserIDFn: func(ctx context.Context, arg db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return db.OauthAccount{}, pgx.ErrNoRows
		},
		createUserFn: func(ctx context.Context, arg db.CreateUserParams) (db.User, error) {
			return db.User{ID: 100, Username: arg.Username, LowerUsername: arg.LowerUsername, IsActive: true}, nil
		},
		upsertOAuthAccountFn: func(ctx context.Context, arg db.UpsertOAuthAccountParams) (db.OauthAccount, error) {
			captured = arg
			return db.OauthAccount{UserID: arg.UserID, Provider: arg.Provider, ProviderUserID: arg.ProviderUserID}, nil
		},
		upsertEmailAddressFn: func(ctx context.Context, arg db.UpsertEmailAddressParams) (db.UpsertEmailAddressRow, error) {
			return db.UpsertEmailAddressRow{}, nil
		},
		createAuthSessionFn: func(ctx context.Context, arg db.CreateAuthSessionParams) (db.AuthSession, error) {
			return db.AuthSession{SessionKey: arg.SessionKey, UserID: arg.UserID, Username: arg.Username, ExpiresAt: arg.ExpiresAt}, nil
		},
	}, cfg, mockKeyAuthVerifier{}, mockGitHubClient{
		exchangeCodeFn: func(ctx context.Context, code string) (GitHubTokenResult, error) {
			return GitHubTokenResult{AccessToken: plainAccess, RefreshToken: plainRefresh, ExpiresIn: 28800}, nil
		},
		fetchUserFn: func(ctx context.Context, accessToken string) (GitHubUserProfile, error) {
			return GitHubUserProfile{ID: 777, Login: "refreshuser"}, nil
		},
		fetchEmailsFn: func(ctx context.Context, accessToken string) ([]GitHubEmail, error) {
			return []GitHubEmail{{Email: "r@example.com", Primary: true, Verified: true}}, nil
		},
	})

	_, err := svc.CompleteGitHubOAuth(context.Background(), "code", "state", "verifier")
	require.NoError(t, err)

	require.NotEmpty(t, captured.RefreshTokenEncrypted, "connect flow must persist the refresh token")
	key := crypto.DeriveKey(cfg.SessionSecret)
	decrypted, err := crypto.Decrypt(key, captured.RefreshTokenEncrypted)
	require.NoError(t, err)
	assert.Equal(t, plainRefresh, string(decrypted))
}

func TestAuthService_RefreshUserGitHubToken(t *testing.T) {
	t.Parallel()

	cfg := defaultAuthConfig()
	key := crypto.DeriveKey(cfg.SessionSecret)
	sealedRefresh, err := crypto.Encrypt(key, []byte("ghr_old_refresh"))
	require.NoError(t, err)

	t.Run("refreshes, persists rotated tokens, returns new access token", func(t *testing.T) {
		t.Parallel()

		var captured db.UpsertOAuthAccountParams
		var upserts int
		var seenRefresh string
		account := db.OauthAccount{UserID: 42, Provider: "workos", ProviderUserID: "777", RefreshTokenEncrypted: sealedRefresh}
		svc := NewAuthService(&mockAuthQuerier{
			getOAuthAccountByProviderUserIDFn: func(ctx context.Context, arg db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
				return account, nil
			},
			upsertOAuthAccountFn: func(ctx context.Context, arg db.UpsertOAuthAccountParams) (db.OauthAccount, error) {
				upserts++
				captured = arg
				return db.OauthAccount{}, nil
			},
		}, cfg, mockKeyAuthVerifier{}, mockGitHubClient{
			refreshTokenFn: func(ctx context.Context, refreshToken string) (GitHubTokenResult, error) {
				seenRefresh = refreshToken
				return GitHubTokenResult{AccessToken: "gho_new_access", RefreshToken: "ghr_new_refresh"}, nil
			},
		})

		newToken, err := svc.RefreshUserGitHubToken(context.Background(), account)
		require.NoError(t, err)
		assert.Equal(t, "gho_new_access", newToken)
		assert.Equal(t, "ghr_old_refresh", seenRefresh, "the stored refresh token is decrypted and sent to GitHub")

		require.Equal(t, 1, upserts, "rotation is persisted exactly once")
		assert.Equal(t, int64(42), captured.UserID)
		assert.Equal(t, "workos", captured.Provider)
		assert.Equal(t, "777", captured.ProviderUserID)

		gotAccess, err := crypto.Decrypt(key, captured.AccessTokenEncrypted)
		require.NoError(t, err)
		assert.Equal(t, "gho_new_access", string(gotAccess))
		gotRefresh, err := crypto.Decrypt(key, captured.RefreshTokenEncrypted)
		require.NoError(t, err)
		assert.Equal(t, "ghr_new_refresh", string(gotRefresh), "the rotated refresh token is re-encrypted and stored")
	})

	t.Run("no stored refresh token returns credential-gone without calling GitHub", func(t *testing.T) {
		t.Parallel()

		var refreshed bool
		var upserts int
		svc := NewAuthService(&mockAuthQuerier{
			upsertOAuthAccountFn: func(ctx context.Context, arg db.UpsertOAuthAccountParams) (db.OauthAccount, error) {
				upserts++
				return db.OauthAccount{}, nil
			},
		}, cfg, mockKeyAuthVerifier{}, mockGitHubClient{
			refreshTokenFn: func(ctx context.Context, refreshToken string) (GitHubTokenResult, error) {
				refreshed = true
				return GitHubTokenResult{AccessToken: "should_not_happen"}, nil
			},
		})

		account := db.OauthAccount{UserID: 42, Provider: "workos", ProviderUserID: "777"} // no RefreshTokenEncrypted
		_, err := svc.RefreshUserGitHubToken(context.Background(), account)
		require.Error(t, err)
		apiErr, ok := err.(*errors.APIError)
		require.True(t, ok)
		assert.Equal(t, 401, apiErr.Status)
		assert.False(t, refreshed, "GitHub must not be called when no refresh token is stored")
		assert.Equal(t, 0, upserts, "nothing is persisted")
	})

	t.Run("GitHub refresh failure surfaces credential-gone", func(t *testing.T) {
		t.Parallel()

		account := db.OauthAccount{UserID: 42, Provider: "workos", ProviderUserID: "777", RefreshTokenEncrypted: sealedRefresh}
		svc := NewAuthService(&mockAuthQuerier{
			getOAuthAccountByProviderUserIDFn: func(ctx context.Context, arg db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
				return account, nil
			},
			upsertOAuthAccountFn: func(ctx context.Context, arg db.UpsertOAuthAccountParams) (db.OauthAccount, error) {
				return db.OauthAccount{}, nil
			},
		}, cfg, mockKeyAuthVerifier{}, mockGitHubClient{
			refreshTokenFn: func(ctx context.Context, refreshToken string) (GitHubTokenResult, error) {
				return GitHubTokenResult{}, fmt.Errorf("github oauth refresh failed: %w", ErrGitHubRefreshTokenInvalid)
			},
		})

		_, err := svc.RefreshUserGitHubToken(context.Background(), account)
		require.Error(t, err)
		apiErr, ok := err.(*errors.APIError)
		require.True(t, ok)
		assert.Equal(t, 401, apiErr.Status)
	})
}

func TestUserLockRegistry_EvictsEntriesOnRelease(t *testing.T) {
	t.Parallel()

	var registry userLockRegistry

	registry.acquire(42)
	registry.mu.Lock()
	assert.Len(t, registry.locks, 1)
	registry.mu.Unlock()
	registry.release(42)
	registry.mu.Lock()
	assert.Empty(t, registry.locks, "released lock must be evicted from the map")
	registry.mu.Unlock()

	// Under contention the lock must still serialize holders per key and the
	// map must be empty once every goroutine has released.
	const goroutines = 32
	var wg sync.WaitGroup
	counter := 0
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			registry.acquire(7)
			defer registry.release(7)
			counter++
		}()
	}
	wg.Wait()

	assert.Equal(t, goroutines, counter)
	registry.mu.Lock()
	assert.Empty(t, registry.locks, "map must not retain locks after all holders release")
	registry.mu.Unlock()
}

// Auth0 retains its own state-only URL API; this fixture isolates that contract.
type mockAuth0Client struct{ mockGitHubClient }

func (m mockAuth0Client) AuthorizationURL(state string) string {
	value, _ := m.mockGitHubClient.AuthorizationURL(context.Background(), state)
	return value
}
func auth0Fixture(client mockGitHubClient) mockAuth0Client { return mockAuth0Client{client} }
