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
)

type authHInterfaceQuerier struct {
	AuthQuerier
}

type authHNoRefreshClient struct{}

func (authHNoRefreshClient) ExchangeCode(context.Context, string) (GitHubTokenResult, error) {
	return GitHubTokenResult{}, nil
}

func (authHNoRefreshClient) FetchUser(context.Context, string) (GitHubUserProfile, error) {
	return GitHubUserProfile{}, nil
}

func (authHNoRefreshClient) FetchEmails(context.Context, string) ([]GitHubEmail, error) {
	return nil, nil
}

func authHEncrypt(t *testing.T, secret, value string) []byte {
	t.Helper()
	encrypted, err := smitherscrypto.Encrypt(smitherscrypto.DeriveKey(secret), []byte(value))
	require.NoError(t, err)
	return encrypted
}

func TestAuth_H_KeyAuthAndOAuthStartBranches(t *testing.T) {
	ctx := context.Background()
	cfg := defaultAuthConfig()

	svc := NewAuthService(&mockAuthQuerier{
		consumeAuthNonceFn: func(context.Context, db.ConsumeAuthNonceParams) (int64, error) {
			return 0, errors.New("consume failed")
		},
	}, cfg, mockKeyAuthVerifier{verifyFn: func(string, string, string) (string, string, error) {
		return "0xabc", "nonce", nil
	}}, nil)
	_, err := svc.VerifyKeyAuth(ctx, "message", "sig")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	auth0 := mockGitHubClient{authorizationURL: "https://auth0.test/authorize"}
	svc = NewAuthService(&mockAuthQuerier{}, defaultAuthConfig(), nil, nil)
	svc.SetAuth0Client(auth0)
	_, err = svc.StartAuth0OAuth(ctx, " ")
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))

	svc = NewAuthService(&mockAuthQuerier{
		createOAuthStateFn: func(context.Context, db.CreateOAuthStateParams) (db.OauthState, error) {
			return db.OauthState{}, errors.New("state failed")
		},
	}, defaultAuthConfig(), nil, nil)
	svc.SetAuth0Client(auth0)
	_, err = svc.StartAuth0OAuth(ctx, "verifier")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	svc = NewAuthService(&mockAuthQuerier{}, defaultAuthConfig(), nil, nil)
	_, err = svc.CompleteAuth0OAuth(ctx, "code", "state", "verifier")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
}

func TestAuth_H_ResolveOAuthUserFailureBranches(t *testing.T) {
	ctx := context.Background()
	cfg := defaultAuthConfig()
	client := mockGitHubClient{
		fetchUserFn: func(context.Context, string) (GitHubUserProfile, error) {
			return GitHubUserProfile{ID: 101, Login: "octo", Name: "Octo"}, nil
		},
		fetchEmailsFn: func(context.Context, string) ([]GitHubEmail, error) {
			return []GitHubEmail{{Email: "   ", Verified: true}, {Email: "octo@example.com", Primary: true, Verified: true}}, nil
		},
	}

	svc := NewAuthService(&mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return db.OauthAccount{UserID: 5, AccessTokenEncrypted: []byte("not ciphertext")}, nil
		},
	}, cfg, nil, client)
	_, err := svc.resolveOAuthUser(ctx, client, "workos", "access", "", 0, "")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	cfg = defaultAuthConfig()
	cfg.SessionSecret = ""
	svc = NewAuthService(&mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return db.OauthAccount{}, pgx.ErrNoRows
		},
		createUserFn: func(context.Context, db.CreateUserParams) (db.User, error) {
			return db.User{ID: 6, Username: "octo"}, nil
		},
	}, cfg, nil, client)
	_, err = svc.resolveOAuthUser(ctx, client, "workos", "access", "refresh", 0, "")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	cfg = defaultAuthConfig()
	base := &mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return db.OauthAccount{}, pgx.ErrNoRows
		},
		createUserFn: func(context.Context, db.CreateUserParams) (db.User, error) {
			return db.User{ID: 7, Username: "octo"}, nil
		},
		upsertEmailAddressFn: func(context.Context, db.UpsertEmailAddressParams) (db.UpsertEmailAddressRow, error) {
			return db.UpsertEmailAddressRow{}, nil
		},
	}
	svc = NewAuthService(authHInterfaceQuerier{AuthQuerier: base}, cfg, nil, client)
	_, err = svc.resolveOAuthUser(ctx, client, "workos", "access", "", 0, "")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
}

func TestAuth_H_ResolveOAuthUserMarshalAndEncryptSeams(t *testing.T) {
	ctx := context.Background()
	cfg := defaultAuthConfig()
	client := mockGitHubClient{
		fetchUserFn: func(context.Context, string) (GitHubUserProfile, error) {
			return GitHubUserProfile{ID: 404, Login: "seam", Name: "Seam"}, nil
		},
		fetchEmailsFn: func(context.Context, string) ([]GitHubEmail, error) {
			return []GitHubEmail{{Email: "seam@example.com", Primary: true, Verified: true}}, nil
		},
	}
	base := func() *mockAuthQuerier {
		return &mockAuthQuerier{
			getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
				return db.OauthAccount{}, pgx.ErrNoRows
			},
			createUserFn: func(context.Context, db.CreateUserParams) (db.User, error) {
				return db.User{ID: 404, Username: "seam"}, nil
			},
			upsertOAuthAccountFn: func(context.Context, db.UpsertOAuthAccountParams) (db.OauthAccount, error) {
				return db.OauthAccount{}, nil
			},
			upsertEmailAddressFn: func(context.Context, db.UpsertEmailAddressParams) (db.UpsertEmailAddressRow, error) {
				return db.UpsertEmailAddressRow{}, nil
			},
		}
	}

	oldMarshal := authJSONMarshal
	oldEncrypt := authEncrypt
	t.Cleanup(func() {
		authJSONMarshal = oldMarshal
		authEncrypt = oldEncrypt
	})
	authJSONMarshal = func(any) ([]byte, error) { return nil, errors.New("marshal failed") }
	_, err := NewAuthService(base(), cfg, nil, client).resolveOAuthUser(ctx, client, "workos", "access", "refresh", 0, "")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
	authJSONMarshal = oldMarshal

	authEncrypt = func([]byte, []byte) ([]byte, error) { return nil, errors.New("encrypt failed") }
	_, err = NewAuthService(base(), cfg, nil, client).resolveOAuthUser(ctx, client, "workos", "access", "refresh", 0, "")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	calls := 0
	authEncrypt = func(key, plaintext []byte) ([]byte, error) {
		calls++
		if calls == 2 {
			return nil, errors.New("refresh encrypt failed")
		}
		return oldEncrypt(key, plaintext)
	}
	_, err = NewAuthService(base(), cfg, nil, client).resolveOAuthUser(ctx, client, "workos", "access", "refresh", 0, "")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
	authEncrypt = oldEncrypt
}

func TestAuth_H_RefreshTokenAndCurrentTokenBranches(t *testing.T) {
	ctx := context.Background()
	cfg := defaultAuthConfig()
	account := db.OauthAccount{
		UserID:                8,
		Provider:              "workos",
		ProviderUserID:        "101",
		AccessTokenEncrypted:  authHEncrypt(t, cfg.SessionSecret, "old-access"),
		RefreshTokenEncrypted: authHEncrypt(t, cfg.SessionSecret, "old-refresh"),
	}

	svc := NewAuthService(&mockAuthQuerier{}, cfg, nil, authHNoRefreshClient{})
	_, err := svc.RefreshUserGitHubToken(ctx, account)
	require.Error(t, err)
	assert.Equal(t, 401, apiStatus(t, err))

	_, err = svc.oauthAccessTokenFromAccount(db.OauthAccount{AccessTokenEncrypted: []byte("bad")})
	require.Error(t, err)
	_, err = svc.oauthAccessTokenFromAccount(db.OauthAccount{AccessTokenEncrypted: authHEncrypt(t, cfg.SessionSecret, " ")})
	require.Error(t, err)
	assert.Equal(t, 401, apiStatus(t, err))

	svc = NewAuthService(&mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return db.OauthAccount{}, pgx.ErrNoRows
		},
	}, cfg, nil, mockGitHubClient{})
	_, err = svc.currentOAuthAccessToken(ctx, account)
	require.Error(t, err)
	assert.Equal(t, 401, apiStatus(t, err))

	svc = NewAuthService(&mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return db.OauthAccount{}, errors.New("query failed")
		},
	}, cfg, nil, mockGitHubClient{})
	_, err = svc.currentOAuthAccessToken(ctx, account)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	freshAccount := account
	freshAccount.AccessTokenEncrypted = authHEncrypt(t, cfg.SessionSecret, "fresh-access")
	svc = NewAuthService(&mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return freshAccount, nil
		},
	}, cfg, nil, mockGitHubClient{})
	got, err := svc.currentOAuthAccessToken(ctx, account)
	require.NoError(t, err)
	assert.Equal(t, "fresh-access", got)

	svc = NewAuthService(&mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return account, nil
		},
		clearOAuthAccountRefreshTokenCASFn: func(context.Context, db.ClearOAuthAccountRefreshTokenCASParams) (int64, error) {
			return 0, errors.New("clear failed")
		},
	}, cfg, nil, mockGitHubClient{refreshTokenFn: func(context.Context, string) (GitHubTokenResult, error) {
		return GitHubTokenResult{}, ErrGitHubRefreshTokenInvalid
	}})
	_, err = svc.RefreshUserGitHubToken(ctx, account)
	require.Error(t, err)
	assert.Equal(t, 401, apiStatus(t, err))

	svc = NewAuthService(&mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return account, nil
		},
		rotateOAuthAccountTokensCASFn: func(context.Context, db.RotateOAuthAccountTokensCASParams) (int64, error) {
			return 0, errors.New("persist failed")
		},
	}, cfg, nil, mockGitHubClient{refreshTokenFn: func(context.Context, string) (GitHubTokenResult, error) {
		return GitHubTokenResult{AccessToken: "new-access"}, nil
	}})
	got, err = svc.RefreshUserGitHubToken(ctx, account)
	require.NoError(t, err)
	assert.Equal(t, "new-access", got)

	cfg.SessionSecret = ""
	svc = NewAuthService(&mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return account, nil
		},
	}, cfg, nil, mockGitHubClient{refreshTokenFn: func(context.Context, string) (GitHubTokenResult, error) {
		return GitHubTokenResult{AccessToken: "new-access"}, nil
	}})
	_, err = svc.RefreshUserGitHubToken(ctx, account)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	cfg = defaultAuthConfig()
	changedBad := account
	changedBad.AccessTokenEncrypted = []byte("bad-current-access")
	svc = NewAuthService(&mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return changedBad, nil
		},
	}, cfg, nil, mockGitHubClient{refreshTokenFn: func(context.Context, string) (GitHubTokenResult, error) {
		return GitHubTokenResult{AccessToken: "after-bad-current"}, nil
	}})
	got, err = svc.RefreshUserGitHubToken(ctx, account)
	require.NoError(t, err)
	assert.Equal(t, "after-bad-current", got)

	emptyRefresh := account
	emptyRefresh.RefreshTokenEncrypted = authHEncrypt(t, cfg.SessionSecret, " ")
	svc = NewAuthService(&mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return emptyRefresh, nil
		},
	}, cfg, nil, mockGitHubClient{refreshTokenFn: func(context.Context, string) (GitHubTokenResult, error) {
		return GitHubTokenResult{}, nil
	}})
	_, err = svc.RefreshUserGitHubToken(ctx, emptyRefresh)
	require.Error(t, err)
	assert.Equal(t, 401, apiStatus(t, err))

	for _, tc := range []struct {
		name string
		err  error
		code int
	}{
		{"gone", pgx.ErrNoRows, 401},
		{"query", errors.New("query failed"), 500},
	} {
		t.Run("invalid refresh reread "+tc.name, func(t *testing.T) {
			calls := 0
			svc := NewAuthService(&mockAuthQuerier{
				getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
					calls++
					if calls == 1 {
						return account, nil
					}
					return db.OauthAccount{}, tc.err
				},
			}, cfg, nil, mockGitHubClient{refreshTokenFn: func(context.Context, string) (GitHubTokenResult, error) {
				return GitHubTokenResult{}, ErrGitHubRefreshTokenInvalid
			}})
			_, err := svc.RefreshUserGitHubToken(ctx, account)
			require.Error(t, err)
			assert.Equal(t, tc.code, apiStatus(t, err))
		})
	}

	freshAfterInvalid := account
	freshAfterInvalid.AccessTokenEncrypted = authHEncrypt(t, cfg.SessionSecret, "fresh-after-invalid")
	calls := 0
	svc = NewAuthService(&mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			calls++
			if calls == 1 {
				return account, nil
			}
			return freshAfterInvalid, nil
		},
	}, cfg, nil, mockGitHubClient{refreshTokenFn: func(context.Context, string) (GitHubTokenResult, error) {
		return GitHubTokenResult{}, ErrGitHubRefreshTokenInvalid
	}})
	got, err = svc.RefreshUserGitHubToken(ctx, account)
	require.NoError(t, err)
	assert.Equal(t, "fresh-after-invalid", got)

	calls = 0
	svc = NewAuthService(&mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			calls++
			if calls < 3 {
				return account, nil
			}
			return freshAfterInvalid, nil
		},
		clearOAuthAccountRefreshTokenCASFn: func(context.Context, db.ClearOAuthAccountRefreshTokenCASParams) (int64, error) {
			return 0, nil
		},
	}, cfg, nil, mockGitHubClient{refreshTokenFn: func(context.Context, string) (GitHubTokenResult, error) {
		return GitHubTokenResult{}, ErrGitHubRefreshTokenInvalid
	}})
	got, err = svc.RefreshUserGitHubToken(ctx, account)
	require.NoError(t, err)
	assert.Equal(t, "fresh-after-invalid", got)

	svc = NewAuthService(&mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return account, nil
		},
	}, cfg, nil, mockGitHubClient{refreshTokenFn: func(context.Context, string) (GitHubTokenResult, error) {
		return GitHubTokenResult{AccessToken: " "}, nil
	}})
	_, err = svc.RefreshUserGitHubToken(ctx, account)
	require.Error(t, err)
	assert.Equal(t, 401, apiStatus(t, err))

	calls = 0
	svc = NewAuthService(&mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			calls++
			if calls < 2 {
				return account, nil
			}
			return freshAfterInvalid, nil
		},
		rotateOAuthAccountTokensCASFn: func(context.Context, db.RotateOAuthAccountTokensCASParams) (int64, error) {
			return 0, nil
		},
	}, cfg, nil, mockGitHubClient{refreshTokenFn: func(context.Context, string) (GitHubTokenResult, error) {
		return GitHubTokenResult{AccessToken: "new-access", RefreshToken: "new-refresh"}, nil
	}})
	got, err = svc.RefreshUserGitHubToken(ctx, account)
	require.NoError(t, err)
	assert.Equal(t, "fresh-after-invalid", got)

	emptySecretCfg := defaultAuthConfig()
	emptySecretCfg.SessionSecret = ""
	emptySecretAccount := account
	emptySecretAccount.RefreshTokenEncrypted = authHEncrypt(t, "", "old-refresh")
	svc = NewAuthService(&mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return emptySecretAccount, nil
		},
	}, emptySecretCfg, nil, mockGitHubClient{refreshTokenFn: func(context.Context, string) (GitHubTokenResult, error) {
		return GitHubTokenResult{AccessToken: "new-access"}, nil
	}})
	_, err = svc.RefreshUserGitHubToken(ctx, emptySecretAccount)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	oldEncrypt := authEncrypt
	t.Cleanup(func() { authEncrypt = oldEncrypt })
	authEncrypt = func([]byte, []byte) ([]byte, error) { return nil, errors.New("encrypt failed") }
	svc = NewAuthService(&mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return account, nil
		},
	}, cfg, nil, mockGitHubClient{refreshTokenFn: func(context.Context, string) (GitHubTokenResult, error) {
		return GitHubTokenResult{AccessToken: "new-access"}, nil
	}})
	_, err = svc.RefreshUserGitHubToken(ctx, account)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	calls = 0
	authEncrypt = func(key, plaintext []byte) ([]byte, error) {
		calls++
		if calls == 2 {
			return nil, errors.New("refresh encrypt failed")
		}
		return oldEncrypt(key, plaintext)
	}
	svc = NewAuthService(&mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return account, nil
		},
	}, cfg, nil, mockGitHubClient{refreshTokenFn: func(context.Context, string) (GitHubTokenResult, error) {
		return GitHubTokenResult{AccessToken: "new-access", RefreshToken: "new-refresh"}, nil
	}})
	_, err = svc.RefreshUserGitHubToken(ctx, account)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
	authEncrypt = oldEncrypt
}

func TestAuth_H_ExchangeRevokeRandomBranches(t *testing.T) {
	ctx := context.Background()
	cfg := defaultAuthConfig()

	svc := NewAuthService(&mockAuthQuerier{}, cfg, nil, mockGitHubClient{})
	_, err := svc.ExchangeGitHubToken(ctx, " ", "name", "", 0, nil)
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))

	err = NewAuthService(&mockAuthQuerier{}, cfg, nil, nil).RevokeUserSession(ctx, 1, " ")
	require.Error(t, err)
	assert.Equal(t, 404, apiStatus(t, err))

	old := authRandRead
	authRandRead = func([]byte) (int, error) { return 0, errors.New("no entropy") }
	t.Cleanup(func() { authRandRead = old })
	assert.Panics(t, func() { _ = randomHex(4) })
	assert.Panics(t, func() { _ = randomUUID() })

	authRandRead = func(buf []byte) (int, error) {
		for i := range buf {
			buf[i] = byte(i + 1)
		}
		return len(buf), nil
	}
	assert.Len(t, randomHex(2), 4)
	uuid := randomUUID()
	assert.Len(t, uuid, 36)
	assert.Equal(t, byte('4'), uuid[14])
	assert.Contains(t, "89ab", strings.ToLower(string(uuid[19])))
}

func TestAuth_H_ExchangeGitHubTokenRotationFailures(t *testing.T) {
	ctx := context.Background()
	cfg := defaultAuthConfig()
	client := mockGitHubClient{
		fetchUserFn: func(context.Context, string) (GitHubUserProfile, error) {
			return GitHubUserProfile{ID: 303, Login: "worker", Name: "Worker"}, nil
		},
		fetchEmailsFn: func(context.Context, string) ([]GitHubEmail, error) {
			return []GitHubEmail{{Email: "worker@example.com", Primary: true, Verified: true}}, nil
		},
	}
	base := func() *mockAuthQuerier {
		return &mockAuthQuerier{
			getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
				return db.OauthAccount{}, pgx.ErrNoRows
			},
			createUserFn: func(context.Context, db.CreateUserParams) (db.User, error) {
				return db.User{ID: 303, Username: "worker"}, nil
			},
			upsertOAuthAccountPreserveRefreshFn: func(context.Context, db.UpsertOAuthAccountPreserveRefreshParams) (db.OauthAccount, error) {
				return db.OauthAccount{}, nil
			},
			upsertEmailAddressFn: func(context.Context, db.UpsertEmailAddressParams) (db.UpsertEmailAddressRow, error) {
				return db.UpsertEmailAddressRow{}, nil
			},
		}
	}

	q := base()
	q.createAccessTokenFn = func(context.Context, db.CreateAccessTokenParams) (db.AccessToken, error) {
		return db.AccessToken{}, errors.New("create token failed")
	}
	_, err := NewAuthService(q, cfg, nil, client).ExchangeGitHubToken(ctx, "github-token", "worker", "", 0, nil)
	require.Error(t, err)

	q = base()
	q.createAccessTokenFn = func(context.Context, db.CreateAccessTokenParams) (db.AccessToken, error) {
		return db.AccessToken{ID: 10, UserID: 303, Name: "worker", TokenLastEight: "last8"}, nil
	}
	q.listAccessTokensByUserIDFn = func(context.Context, int64) ([]db.AccessToken, error) {
		return nil, errors.New("list tokens failed")
	}
	_, err = NewAuthService(q, cfg, nil, client).ExchangeGitHubToken(ctx, "github-token", "worker", "", 0, nil)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	q = base()
	q.createAccessTokenFn = func(context.Context, db.CreateAccessTokenParams) (db.AccessToken, error) {
		return db.AccessToken{ID: 10, UserID: 303, Name: "worker", TokenLastEight: "last8"}, nil
	}
	q.listAccessTokensByUserIDFn = func(context.Context, int64) ([]db.AccessToken, error) {
		return []db.AccessToken{{ID: 9, UserID: 303, Name: "worker"}}, nil
	}
	q.deleteAccessTokenByIDAndUserIDFn = func(context.Context, db.DeleteAccessTokenByIDAndUserIDParams) (int64, error) {
		return 0, errors.New("delete failed")
	}
	_, err = NewAuthService(q, cfg, nil, client).ExchangeGitHubToken(ctx, "github-token", "worker", "", 0, nil)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
}

func TestAuth_H_RefreshCASAbsentBranch(t *testing.T) {
	cfg := defaultAuthConfig()
	account := db.OauthAccount{
		UserID:                9,
		Provider:              "workos",
		ProviderUserID:        "101",
		AccessTokenEncrypted:  authHEncrypt(t, cfg.SessionSecret, "old-access"),
		RefreshTokenEncrypted: authHEncrypt(t, cfg.SessionSecret, "old-refresh"),
	}
	base := &mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return account, nil
		},
	}
	svc := NewAuthService(authHInterfaceQuerier{AuthQuerier: base}, cfg, nil, mockGitHubClient{refreshTokenFn: func(context.Context, string) (GitHubTokenResult, error) {
		return GitHubTokenResult{AccessToken: "new-access"}, nil
	}})
	_, err := svc.RefreshUserGitHubToken(context.Background(), account)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
}
