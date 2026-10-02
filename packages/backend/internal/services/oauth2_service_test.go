package services

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type mockOAuth2Querier struct {
	getApplicationByClientIDFn        func(ctx context.Context, clientID string) (db.Oauth2Application, error)
	createAuthorizationCodeFn         func(ctx context.Context, arg db.CreateOAuth2AuthorizationCodeParams) error
	getAuthorizationCodeByHashFn      func(ctx context.Context, codeHash string) (db.Oauth2AuthorizationCode, error)
	consumeAuthorizationCodeFn        func(ctx context.Context, codeHash string) (db.Oauth2AuthorizationCode, error)
	createAccessTokenFn               func(ctx context.Context, arg db.CreateOAuth2AccessTokenParams) (db.Oauth2AccessToken, error)
	createRefreshTokenFn              func(ctx context.Context, arg db.CreateOAuth2RefreshTokenParams) (db.Oauth2RefreshToken, error)
	getRefreshTokenByHashFn           func(ctx context.Context, tokenHash string) (db.Oauth2RefreshToken, error)
	consumeRefreshTokenFn             func(ctx context.Context, tokenHash string) (db.Oauth2RefreshToken, error)
	deleteRefreshTokenByHashFn        func(ctx context.Context, tokenHash string) (int64, error)
	deleteAccessTokensByAppAndUserFn  func(ctx context.Context, arg db.DeleteOAuth2AccessTokensByAppAndUserParams) error
	deleteRefreshTokensByAppAndUserFn func(ctx context.Context, arg db.DeleteOAuth2RefreshTokensByAppAndUserParams) error
	getUserByIDFn                     func(ctx context.Context, id int64) (db.User, error)
}

func (m *mockOAuth2Querier) GetOAuth2ApplicationByClientID(ctx context.Context, clientID string) (db.Oauth2Application, error) {
	if m.getApplicationByClientIDFn != nil {
		return m.getApplicationByClientIDFn(ctx, clientID)
	}
	return db.Oauth2Application{}, pgx.ErrNoRows
}

func (m *mockOAuth2Querier) CreateOAuth2AuthorizationCode(ctx context.Context, arg db.CreateOAuth2AuthorizationCodeParams) error {
	if m.createAuthorizationCodeFn != nil {
		return m.createAuthorizationCodeFn(ctx, arg)
	}
	return assert.AnError
}

func (m *mockOAuth2Querier) GetOAuth2AuthorizationCodeByHash(ctx context.Context, codeHash string) (db.Oauth2AuthorizationCode, error) {
	if m.getAuthorizationCodeByHashFn != nil {
		return m.getAuthorizationCodeByHashFn(ctx, codeHash)
	}
	// Single-row fixtures declare the stored code once via the consume fn;
	// the service's validate-then-consume flow reads the same row both times.
	if m.consumeAuthorizationCodeFn != nil {
		return m.consumeAuthorizationCodeFn(ctx, codeHash)
	}
	return db.Oauth2AuthorizationCode{}, pgx.ErrNoRows
}

func (m *mockOAuth2Querier) ConsumeOAuth2AuthorizationCode(ctx context.Context, codeHash string) (db.Oauth2AuthorizationCode, error) {
	if m.consumeAuthorizationCodeFn != nil {
		return m.consumeAuthorizationCodeFn(ctx, codeHash)
	}
	return db.Oauth2AuthorizationCode{}, pgx.ErrNoRows
}

func (m *mockOAuth2Querier) CreateOAuth2AccessToken(ctx context.Context, arg db.CreateOAuth2AccessTokenParams) (db.Oauth2AccessToken, error) {
	if m.createAccessTokenFn != nil {
		return m.createAccessTokenFn(ctx, arg)
	}
	return db.Oauth2AccessToken{}, assert.AnError
}

func (m *mockOAuth2Querier) GetOAuth2AccessTokenByHash(context.Context, string) (db.Oauth2AccessToken, error) {
	return db.Oauth2AccessToken{}, assert.AnError
}

func (m *mockOAuth2Querier) DeleteOAuth2AccessTokenByHash(context.Context, string) (int64, error) {
	return 0, assert.AnError
}

func (m *mockOAuth2Querier) DeleteOAuth2AccessTokensByAppAndUser(ctx context.Context, arg db.DeleteOAuth2AccessTokensByAppAndUserParams) error {
	if m.deleteAccessTokensByAppAndUserFn != nil {
		return m.deleteAccessTokensByAppAndUserFn(ctx, arg)
	}
	return nil
}

func (m *mockOAuth2Querier) CreateOAuth2RefreshToken(ctx context.Context, arg db.CreateOAuth2RefreshTokenParams) (db.Oauth2RefreshToken, error) {
	if m.createRefreshTokenFn != nil {
		return m.createRefreshTokenFn(ctx, arg)
	}
	return db.Oauth2RefreshToken{}, assert.AnError
}

func (m *mockOAuth2Querier) GetOAuth2RefreshTokenByHash(ctx context.Context, tokenHash string) (db.Oauth2RefreshToken, error) {
	if m.getRefreshTokenByHashFn != nil {
		return m.getRefreshTokenByHashFn(ctx, tokenHash)
	}
	return db.Oauth2RefreshToken{}, pgx.ErrNoRows
}

func (m *mockOAuth2Querier) ConsumeOAuth2RefreshToken(ctx context.Context, tokenHash string) (db.Oauth2RefreshToken, error) {
	if m.consumeRefreshTokenFn != nil {
		return m.consumeRefreshTokenFn(ctx, tokenHash)
	}
	return db.Oauth2RefreshToken{}, pgx.ErrNoRows
}

func (m *mockOAuth2Querier) DeleteOAuth2RefreshTokenByHash(ctx context.Context, tokenHash string) (int64, error) {
	if m.deleteRefreshTokenByHashFn != nil {
		return m.deleteRefreshTokenByHashFn(ctx, tokenHash)
	}
	return 1, nil
}

func (m *mockOAuth2Querier) DeleteOAuth2RefreshTokensByAppAndUser(ctx context.Context, arg db.DeleteOAuth2RefreshTokensByAppAndUserParams) error {
	if m.deleteRefreshTokensByAppAndUserFn != nil {
		return m.deleteRefreshTokensByAppAndUserFn(ctx, arg)
	}
	return nil
}

func (m *mockOAuth2Querier) GetUserByID(ctx context.Context, id int64) (db.User, error) {
	if m.getUserByIDFn != nil {
		return m.getUserByIDFn(ctx, id)
	}
	return db.User{ID: id, Username: "alice", LowerUsername: "alice"}, nil
}

func testOAuth2Application(confidential bool) db.Oauth2Application {
	return db.Oauth2Application{
		ID:               41,
		ClientID:         FirstPartyClientID,
		ClientSecretHash: hashOAuth2Secret("secret-123"),
		Name:             "Test App",
		RedirectUris:     []string{"https://app.example/callback"},
		Scopes:           []string{"read:user"},
		OwnerID:          9,
		Confidential:     confidential,
	}
}

func s256Challenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func TestOAuth2Service_Authorize_EnforcesPKCEForPublicClients(t *testing.T) {
	t.Parallel()

	t.Run("public client requires code challenge", func(t *testing.T) {
		t.Parallel()

		createCalls := 0
		svc := NewOAuth2Service(&mockOAuth2Querier{
			getApplicationByClientIDFn: func(_ context.Context, clientID string) (db.Oauth2Application, error) {
				assert.Equal(t, FirstPartyClientID, clientID)
				return testOAuth2Application(false), nil
			},
			createAuthorizationCodeFn: func(_ context.Context, _ db.CreateOAuth2AuthorizationCodeParams) error {
				createCalls++
				return nil
			},
		})

		_, err := svc.Authorize(context.Background(), 7, FirstPartyClientID, "https://app.example/callback", "", "", "", nil)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "code_challenge is required for public clients")
		assert.Equal(t, 0, createCalls)
	})

	t.Run("plain PKCE method is rejected", func(t *testing.T) {
		t.Parallel()

		svc := NewOAuth2Service(&mockOAuth2Querier{
			getApplicationByClientIDFn: func(_ context.Context, _ string) (db.Oauth2Application, error) {
				return testOAuth2Application(false), nil
			},
		})

		_, err := svc.Authorize(context.Background(), 7, FirstPartyClientID, "https://app.example/callback", "", "challenge", "plain", nil)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "code_challenge_method must be S256")
	})

	t.Run("public client accepts S256 PKCE", func(t *testing.T) {
		t.Parallel()

		var created db.CreateOAuth2AuthorizationCodeParams
		svc := NewOAuth2Service(&mockOAuth2Querier{
			getApplicationByClientIDFn: func(_ context.Context, _ string) (db.Oauth2Application, error) {
				return testOAuth2Application(false), nil
			},
			createAuthorizationCodeFn: func(_ context.Context, arg db.CreateOAuth2AuthorizationCodeParams) error {
				created = arg
				return nil
			},
		})

		result, err := svc.Authorize(context.Background(), 7, FirstPartyClientID, "https://app.example/callback", "", "challenge", "S256", nil)
		require.NoError(t, err)
		assert.NotEmpty(t, result.Code)
		assert.Equal(t, "challenge", created.CodeChallenge)
		assert.Equal(t, "S256", created.CodeChallengeMethod)
	})
}

func TestOAuth2Service_ExchangeCode_PublicClientsRequireS256PKCE(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		authCode  db.Oauth2AuthorizationCode
		verifier  string
		wantError string
	}{
		{
			name: "missing PKCE on public client is rejected",
			authCode: db.Oauth2AuthorizationCode{
				AppID:       41,
				UserID:      7,
				Scopes:      []string{"read:user"},
				RedirectUri: "https://app.example/callback",
			},
			wantError: "public clients require PKCE",
		},
		{
			name: "plain PKCE on public client is rejected",
			authCode: db.Oauth2AuthorizationCode{
				AppID:               41,
				UserID:              7,
				Scopes:              []string{"read:user"},
				RedirectUri:         "https://app.example/callback",
				CodeChallenge:       "plain-verifier",
				CodeChallengeMethod: "plain",
			},
			verifier:  "plain-verifier",
			wantError: "public clients require PKCE",
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			createAccessCalls := 0
			svc := NewOAuth2Service(&mockOAuth2Querier{
				getApplicationByClientIDFn: func(_ context.Context, _ string) (db.Oauth2Application, error) {
					return testOAuth2Application(false), nil
				},
				getAuthorizationCodeByHashFn: func(_ context.Context, codeHash string) (db.Oauth2AuthorizationCode, error) {
					assert.Equal(t, hashOAuth2Secret("auth-code-123"), codeHash)
					return tc.authCode, nil
				},
				consumeAuthorizationCodeFn: func(_ context.Context, _ string) (db.Oauth2AuthorizationCode, error) {
					t.Fatal("a failed redemption must not consume the one-time authorization code")
					return db.Oauth2AuthorizationCode{}, nil
				},
				createAccessTokenFn: func(_ context.Context, _ db.CreateOAuth2AccessTokenParams) (db.Oauth2AccessToken, error) {
					createAccessCalls++
					return db.Oauth2AccessToken{}, nil
				},
				createRefreshTokenFn: func(_ context.Context, _ db.CreateOAuth2RefreshTokenParams) (db.Oauth2RefreshToken, error) {
					t.Fatal("refresh token creation should not run when PKCE validation fails")
					return db.Oauth2RefreshToken{}, nil
				},
			})
			svc.now = func() time.Time { return time.Date(2026, 3, 12, 0, 0, 0, 0, time.UTC) }

			_, err := svc.ExchangeCode(context.Background(), FirstPartyClientID, "", "auth-code-123", "https://app.example/callback", tc.verifier)
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.wantError)
			assert.Equal(t, 0, createAccessCalls)
		})
	}
}

func TestOAuth2Service_ExchangeCode_PublicClientAcceptsValidS256PKCE(t *testing.T) {
	t.Parallel()

	verifier := "verifier-123"
	accessCreated := 0
	refreshCreated := 0
	svc := NewOAuth2Service(&mockOAuth2Querier{
		getApplicationByClientIDFn: func(_ context.Context, _ string) (db.Oauth2Application, error) {
			return testOAuth2Application(false), nil
		},
		consumeAuthorizationCodeFn: func(_ context.Context, _ string) (db.Oauth2AuthorizationCode, error) {
			return db.Oauth2AuthorizationCode{
				AppID:               41,
				UserID:              7,
				Scopes:              []string{"read:user"},
				RedirectUri:         "https://app.example/callback",
				CodeChallenge:       s256Challenge(verifier),
				CodeChallengeMethod: "S256",
			}, nil
		},
		createAccessTokenFn: func(_ context.Context, arg db.CreateOAuth2AccessTokenParams) (db.Oauth2AccessToken, error) {
			accessCreated++
			return db.Oauth2AccessToken{
				ID:        1,
				TokenHash: arg.TokenHash,
				AppID:     arg.AppID,
				UserID:    arg.UserID,
				Scopes:    arg.Scopes,
				ExpiresAt: arg.ExpiresAt,
			}, nil
		},
		createRefreshTokenFn: func(_ context.Context, arg db.CreateOAuth2RefreshTokenParams) (db.Oauth2RefreshToken, error) {
			refreshCreated++
			return db.Oauth2RefreshToken{
				ID:        1,
				TokenHash: arg.TokenHash,
				AppID:     arg.AppID,
				UserID:    arg.UserID,
				Scopes:    arg.Scopes,
				ExpiresAt: arg.ExpiresAt,
			}, nil
		},
		getUserByIDFn: func(_ context.Context, id int64) (db.User, error) {
			return db.User{ID: id, Username: "alice", LowerUsername: "alice"}, nil
		},
	})
	svc.now = func() time.Time { return time.Date(2026, 3, 12, 0, 0, 0, 0, time.UTC) }

	result, err := svc.ExchangeCode(context.Background(), FirstPartyClientID, "", "auth-code-123", "https://app.example/callback", verifier)
	require.NoError(t, err)
	assert.NotEmpty(t, result.AccessToken)
	assert.NotEmpty(t, result.RefreshToken)
	assert.Equal(t, int64(oauth2AccessTokenTTL.Seconds()), result.ExpiresIn)
	assert.Equal(t, 1, accessCreated)
	assert.Equal(t, 1, refreshCreated)
}

func TestOAuth2Service_RefreshToken_PreservesGrantedScopes(t *testing.T) {
	t.Parallel()

	grantedScopes := []string{"read:user"}
	accessCreated := 0
	refreshCreated := 0
	svc := NewOAuth2Service(&mockOAuth2Querier{
		getApplicationByClientIDFn: func(_ context.Context, _ string) (db.Oauth2Application, error) {
			app := testOAuth2Application(true)
			app.Scopes = []string{"read:user", "write:user"}
			return app, nil
		},
		getRefreshTokenByHashFn: func(_ context.Context, tokenHash string) (db.Oauth2RefreshToken, error) {
			assert.Equal(t, hashOAuth2Secret("refresh-123"), tokenHash)
			return db.Oauth2RefreshToken{
				ID:        1,
				TokenHash: tokenHash,
				AppID:     41,
				UserID:    7,
				Scopes:    grantedScopes,
				ExpiresAt: time.Now().Add(time.Hour),
			}, nil
		},
		consumeRefreshTokenFn: func(_ context.Context, tokenHash string) (db.Oauth2RefreshToken, error) {
			assert.Equal(t, hashOAuth2Secret("refresh-123"), tokenHash)
			return db.Oauth2RefreshToken{
				ID:        1,
				TokenHash: tokenHash,
				AppID:     41,
				UserID:    7,
				Scopes:    grantedScopes,
				ExpiresAt: time.Now().Add(time.Hour),
			}, nil
		},
		createAccessTokenFn: func(_ context.Context, arg db.CreateOAuth2AccessTokenParams) (db.Oauth2AccessToken, error) {
			accessCreated++
			assert.Equal(t, grantedScopes, arg.Scopes)
			return db.Oauth2AccessToken{
				ID:        1,
				TokenHash: arg.TokenHash,
				AppID:     arg.AppID,
				UserID:    arg.UserID,
				Scopes:    arg.Scopes,
				ExpiresAt: arg.ExpiresAt,
			}, nil
		},
		createRefreshTokenFn: func(_ context.Context, arg db.CreateOAuth2RefreshTokenParams) (db.Oauth2RefreshToken, error) {
			refreshCreated++
			assert.Equal(t, grantedScopes, arg.Scopes)
			return db.Oauth2RefreshToken{
				ID:        2,
				TokenHash: arg.TokenHash,
				AppID:     arg.AppID,
				UserID:    arg.UserID,
				Scopes:    arg.Scopes,
				ExpiresAt: arg.ExpiresAt,
			}, nil
		},
		getUserByIDFn: func(_ context.Context, id int64) (db.User, error) {
			return db.User{ID: id, Username: "alice", LowerUsername: "alice"}, nil
		},
	})
	svc.now = func() time.Time { return time.Date(2026, 3, 12, 0, 0, 0, 0, time.UTC) }

	result, err := svc.RefreshToken(context.Background(), FirstPartyClientID, "secret-123", "refresh-123")
	require.NoError(t, err)
	assert.NotEmpty(t, result.AccessToken)
	assert.NotEmpty(t, result.RefreshToken)
	assert.Equal(t, "read:user", result.Scope)
	assert.Equal(t, 1, accessCreated)
	assert.Equal(t, 1, refreshCreated)
}

func TestOAuth2Service_RefreshToken_RejectsLegacyTokenWithoutStoredScopes(t *testing.T) {
	t.Parallel()

	accessCreated := 0
	svc := NewOAuth2Service(&mockOAuth2Querier{
		getApplicationByClientIDFn: func(_ context.Context, _ string) (db.Oauth2Application, error) {
			return testOAuth2Application(true), nil
		},
		getRefreshTokenByHashFn: func(_ context.Context, tokenHash string) (db.Oauth2RefreshToken, error) {
			assert.Equal(t, hashOAuth2Secret("refresh-123"), tokenHash)
			return db.Oauth2RefreshToken{
				ID:        1,
				TokenHash: tokenHash,
				AppID:     41,
				UserID:    7,
				Scopes:    nil,
				ExpiresAt: time.Now().Add(time.Hour),
			}, nil
		},
		consumeRefreshTokenFn: func(_ context.Context, tokenHash string) (db.Oauth2RefreshToken, error) {
			assert.Equal(t, hashOAuth2Secret("refresh-123"), tokenHash)
			return db.Oauth2RefreshToken{
				ID:        1,
				TokenHash: tokenHash,
				AppID:     41,
				UserID:    7,
				Scopes:    nil,
				ExpiresAt: time.Now().Add(time.Hour),
			}, nil
		},
		createAccessTokenFn: func(_ context.Context, _ db.CreateOAuth2AccessTokenParams) (db.Oauth2AccessToken, error) {
			accessCreated++
			return db.Oauth2AccessToken{}, nil
		},
		createRefreshTokenFn: func(_ context.Context, _ db.CreateOAuth2RefreshTokenParams) (db.Oauth2RefreshToken, error) {
			t.Fatal("refresh token creation should not run for legacy refresh tokens without scopes")
			return db.Oauth2RefreshToken{}, nil
		},
	})

	_, err := svc.RefreshToken(context.Background(), FirstPartyClientID, "secret-123", "refresh-123")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "refresh token must be reauthorized")
	assert.Equal(t, 0, accessCreated)
}

func TestOAuth2Service_RefreshToken_RejectsReplayedToken(t *testing.T) {
	t.Parallel()

	accessCreated := 0
	svc := NewOAuth2Service(&mockOAuth2Querier{
		getApplicationByClientIDFn: func(_ context.Context, _ string) (db.Oauth2Application, error) {
			return testOAuth2Application(true), nil
		},
		getRefreshTokenByHashFn: func(_ context.Context, tokenHash string) (db.Oauth2RefreshToken, error) {
			assert.Equal(t, hashOAuth2Secret("refresh-123"), tokenHash)
			return db.Oauth2RefreshToken{
				ID:        1,
				TokenHash: tokenHash,
				AppID:     41,
				UserID:    7,
				Scopes:    []string{"read:user"},
				ExpiresAt: time.Now().Add(time.Hour),
			}, nil
		},
		consumeRefreshTokenFn: func(_ context.Context, tokenHash string) (db.Oauth2RefreshToken, error) {
			assert.Equal(t, hashOAuth2Secret("refresh-123"), tokenHash)
			return db.Oauth2RefreshToken{}, pgx.ErrNoRows
		},
		createAccessTokenFn: func(_ context.Context, _ db.CreateOAuth2AccessTokenParams) (db.Oauth2AccessToken, error) {
			accessCreated++
			return db.Oauth2AccessToken{}, nil
		},
		createRefreshTokenFn: func(_ context.Context, _ db.CreateOAuth2RefreshTokenParams) (db.Oauth2RefreshToken, error) {
			t.Fatal("refresh token creation should not run when the refresh token was already consumed")
			return db.Oauth2RefreshToken{}, nil
		},
	})

	_, err := svc.RefreshToken(context.Background(), FirstPartyClientID, "secret-123", "refresh-123")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "invalid or expired refresh token")
	assert.Equal(t, 0, accessCreated)
}

func TestOAuth2Service_RefreshToken_RejectsWrongClientWithoutConsumingToken(t *testing.T) {
	t.Parallel()

	svc := NewOAuth2Service(&mockOAuth2Querier{
		getApplicationByClientIDFn: func(_ context.Context, _ string) (db.Oauth2Application, error) {
			return testOAuth2Application(true), nil
		},
		getRefreshTokenByHashFn: func(_ context.Context, tokenHash string) (db.Oauth2RefreshToken, error) {
			assert.Equal(t, hashOAuth2Secret("refresh-123"), tokenHash)
			return db.Oauth2RefreshToken{
				ID:        1,
				TokenHash: tokenHash,
				AppID:     99,
				UserID:    7,
				Scopes:    []string{"read:user"},
				ExpiresAt: time.Now().Add(time.Hour),
			}, nil
		},
		consumeRefreshTokenFn: func(_ context.Context, _ string) (db.Oauth2RefreshToken, error) {
			t.Fatal("refresh token should not be consumed when it belongs to a different application")
			return db.Oauth2RefreshToken{}, nil
		},
		createAccessTokenFn: func(_ context.Context, _ db.CreateOAuth2AccessTokenParams) (db.Oauth2AccessToken, error) {
			t.Fatal("access token creation should not run when the refresh token belongs to a different application")
			return db.Oauth2AccessToken{}, nil
		},
		createRefreshTokenFn: func(_ context.Context, _ db.CreateOAuth2RefreshTokenParams) (db.Oauth2RefreshToken, error) {
			t.Fatal("refresh token creation should not run when the refresh token belongs to a different application")
			return db.Oauth2RefreshToken{}, nil
		},
	})

	_, err := svc.RefreshToken(context.Background(), FirstPartyClientID, "secret-123", "refresh-123")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "refresh token does not belong to this application")
}

func TestOAuth2_ScopeBoundedToAppRegistration(t *testing.T) {
	t.Parallel()

	t.Run("requested scopes subset of app scopes succeeds", func(t *testing.T) {
		t.Parallel()

		var created db.CreateOAuth2AuthorizationCodeParams
		svc := NewOAuth2Service(&mockOAuth2Querier{
			getApplicationByClientIDFn: func(_ context.Context, _ string) (db.Oauth2Application, error) {
				app := testOAuth2Application(true)
				app.Scopes = []string{"read:user", "write:user"}
				return app, nil
			},
			createAuthorizationCodeFn: func(_ context.Context, arg db.CreateOAuth2AuthorizationCodeParams) error {
				created = arg
				return nil
			},
		})

		result, err := svc.Authorize(context.Background(), 7, FirstPartyClientID, "https://app.example/callback", "read:user", "", "", nil)
		require.NoError(t, err)
		assert.NotEmpty(t, result.Code)
		assert.Equal(t, []string{"read:user"}, created.Scopes)
	})

	t.Run("smithers ios scopes are recognized and canonicalized", func(t *testing.T) {
		t.Parallel()

		var created db.CreateOAuth2AuthorizationCodeParams
		svc := NewOAuth2Service(&mockOAuth2Querier{
			getApplicationByClientIDFn: func(_ context.Context, _ string) (db.Oauth2Application, error) {
				app := testOAuth2Application(false)
				app.RedirectUris = []string{"smithers://oauth2/callback"}
				app.Scopes = []string{"read:user", "read:repo", "write:workspace", "write:approval", "write:agent"}
				return app, nil
			},
			createAuthorizationCodeFn: func(_ context.Context, arg db.CreateOAuth2AuthorizationCodeParams) error {
				created = arg
				return nil
			},
		})

		result, err := svc.Authorize(
			context.Background(),
			7,
			FirstPartyClientID,
			"smithers://oauth2/callback",
			"read:user read:repo write:workspace write:approval write:agent",
			"challenge",
			"S256",
			nil,
		)
		require.NoError(t, err)
		assert.NotEmpty(t, result.Code)
		assert.Equal(t, []string{"read:user", "read:repository", "write:workspace", "write:approval", "write:agent"}, created.Scopes)
	})

	t.Run("requested scope exceeding registered scopes is rejected", func(t *testing.T) {
		t.Parallel()

		svc := NewOAuth2Service(&mockOAuth2Querier{
			getApplicationByClientIDFn: func(_ context.Context, _ string) (db.Oauth2Application, error) {
				app := testOAuth2Application(true)
				app.Scopes = []string{"read:user"}
				return app, nil
			},
			createAuthorizationCodeFn: func(_ context.Context, _ db.CreateOAuth2AuthorizationCodeParams) error {
				t.Fatal("authorization code must not be created when scope exceeds app registration")
				return nil
			},
		})

		_, err := svc.Authorize(context.Background(), 7, FirstPartyClientID, "https://app.example/callback", "read:user write:user", "", "", nil)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "requested scope exceeds application registered scopes")
	})

	t.Run("unknown requested scope is rejected", func(t *testing.T) {
		t.Parallel()

		svc := NewOAuth2Service(&mockOAuth2Querier{
			getApplicationByClientIDFn: func(_ context.Context, _ string) (db.Oauth2Application, error) {
				app := testOAuth2Application(true)
				app.Scopes = []string{"read:user", "write:user"}
				return app, nil
			},
			createAuthorizationCodeFn: func(_ context.Context, _ db.CreateOAuth2AuthorizationCodeParams) error {
				t.Fatal("authorization code must not be created when scope is unknown")
				return nil
			},
		})

		_, err := svc.Authorize(context.Background(), 7, FirstPartyClientID, "https://app.example/callback", "unknown:scope", "", "", nil)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "requested scope exceeds application registered scopes")
	})

	t.Run("empty scope defaults to registered app scopes", func(t *testing.T) {
		t.Parallel()

		var created db.CreateOAuth2AuthorizationCodeParams
		svc := NewOAuth2Service(&mockOAuth2Querier{
			getApplicationByClientIDFn: func(_ context.Context, _ string) (db.Oauth2Application, error) {
				app := testOAuth2Application(true)
				app.Scopes = []string{"read:user", "write:user"}
				return app, nil
			},
			createAuthorizationCodeFn: func(_ context.Context, arg db.CreateOAuth2AuthorizationCodeParams) error {
				created = arg
				return nil
			},
		})

		result, err := svc.Authorize(context.Background(), 7, FirstPartyClientID, "https://app.example/callback", "", "", "", nil)
		require.NoError(t, err)
		assert.NotEmpty(t, result.Code)
		assert.Equal(t, []string{"read:user", "write:user"}, created.Scopes)
	})
}

func TestOAuth2_RefreshTokenRotation(t *testing.T) {
	t.Parallel()

	var (
		consumedTokenHash string
		consumed          bool
		accessCreated     int
		refreshCreated    int
	)

	svc := NewOAuth2Service(&mockOAuth2Querier{
		getApplicationByClientIDFn: func(_ context.Context, _ string) (db.Oauth2Application, error) {
			return testOAuth2Application(true), nil
		},
		getRefreshTokenByHashFn: func(_ context.Context, tokenHash string) (db.Oauth2RefreshToken, error) {
			if consumed {
				return db.Oauth2RefreshToken{}, pgx.ErrNoRows
			}
			return db.Oauth2RefreshToken{
				ID:        1,
				TokenHash: tokenHash,
				AppID:     41,
				UserID:    7,
				Scopes:    []string{"read:user"},
				ExpiresAt: time.Now().Add(time.Hour),
			}, nil
		},
		consumeRefreshTokenFn: func(_ context.Context, tokenHash string) (db.Oauth2RefreshToken, error) {
			if consumed {
				return db.Oauth2RefreshToken{}, pgx.ErrNoRows
			}
			consumed = true
			consumedTokenHash = tokenHash
			return db.Oauth2RefreshToken{
				ID:        1,
				TokenHash: tokenHash,
				AppID:     41,
				UserID:    7,
				Scopes:    []string{"read:user"},
				ExpiresAt: time.Now().Add(time.Hour),
			}, nil
		},
		createAccessTokenFn: func(_ context.Context, arg db.CreateOAuth2AccessTokenParams) (db.Oauth2AccessToken, error) {
			accessCreated++
			return db.Oauth2AccessToken{
				ID:        1,
				TokenHash: arg.TokenHash,
				AppID:     arg.AppID,
				UserID:    arg.UserID,
				Scopes:    arg.Scopes,
				ExpiresAt: arg.ExpiresAt,
			}, nil
		},
		createRefreshTokenFn: func(_ context.Context, arg db.CreateOAuth2RefreshTokenParams) (db.Oauth2RefreshToken, error) {
			refreshCreated++
			return db.Oauth2RefreshToken{
				ID:        2,
				TokenHash: arg.TokenHash,
				AppID:     arg.AppID,
				UserID:    arg.UserID,
				Scopes:    arg.Scopes,
				ExpiresAt: arg.ExpiresAt,
			}, nil
		},
	})

	firstResult, err := svc.RefreshToken(context.Background(), FirstPartyClientID, "secret-123", "refresh-123")
	require.NoError(t, err)
	assert.NotEmpty(t, firstResult.AccessToken)
	assert.NotEmpty(t, firstResult.RefreshToken)
	assert.Equal(t, hashOAuth2Secret("refresh-123"), consumedTokenHash)

	_, err = svc.RefreshToken(context.Background(), FirstPartyClientID, "secret-123", "refresh-123")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "invalid or expired refresh token")
	assert.Equal(t, 1, accessCreated)
	assert.Equal(t, 1, refreshCreated)
}

func TestOAuth2Service_RevokeAllByAppAndUser(t *testing.T) {
	t.Parallel()

	t.Run("deletes refresh and access tokens for the app/user pair", func(t *testing.T) {
		t.Parallel()

		refreshCalls := 0
		accessCalls := 0
		svc := NewOAuth2Service(&mockOAuth2Querier{
			deleteRefreshTokensByAppAndUserFn: func(_ context.Context, arg db.DeleteOAuth2RefreshTokensByAppAndUserParams) error {
				refreshCalls++
				assert.Equal(t, int64(41), arg.AppID)
				assert.Equal(t, int64(7), arg.UserID)
				return nil
			},
			deleteAccessTokensByAppAndUserFn: func(_ context.Context, arg db.DeleteOAuth2AccessTokensByAppAndUserParams) error {
				accessCalls++
				assert.Equal(t, int64(41), arg.AppID)
				assert.Equal(t, int64(7), arg.UserID)
				return nil
			},
		})

		err := svc.RevokeAllByAppAndUser(context.Background(), 41, 7)
		require.NoError(t, err)
		assert.Equal(t, 1, refreshCalls)
		assert.Equal(t, 1, accessCalls)
	})

	t.Run("surfaces refresh-token delete failures", func(t *testing.T) {
		t.Parallel()

		svc := NewOAuth2Service(&mockOAuth2Querier{
			deleteRefreshTokensByAppAndUserFn: func(_ context.Context, _ db.DeleteOAuth2RefreshTokensByAppAndUserParams) error {
				return assert.AnError
			},
			deleteAccessTokensByAppAndUserFn: func(_ context.Context, _ db.DeleteOAuth2AccessTokensByAppAndUserParams) error {
				t.Fatal("access token delete must not run after refresh delete failure")
				return nil
			},
		})

		err := svc.RevokeAllByAppAndUser(context.Background(), 41, 7)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "failed to revoke tokens")
	})
}
