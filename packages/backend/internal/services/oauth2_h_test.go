package services

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type oauth2HQuerier struct {
	getApplicationByClientIDFn        func(context.Context, string) (db.Oauth2Application, error)
	createAuthorizationCodeFn         func(context.Context, db.CreateOAuth2AuthorizationCodeParams) error
	getAuthorizationCodeByHashFn      func(context.Context, string) (db.Oauth2AuthorizationCode, error)
	consumeAuthorizationCodeFn        func(context.Context, string) (db.Oauth2AuthorizationCode, error)
	createAccessTokenFn               func(context.Context, db.CreateOAuth2AccessTokenParams) (db.Oauth2AccessToken, error)
	getAccessTokenByHashFn            func(context.Context, string) (db.Oauth2AccessToken, error)
	deleteAccessTokenByHashFn         func(context.Context, string) (int64, error)
	deleteAccessTokensByAppAndUserFn  func(context.Context, db.DeleteOAuth2AccessTokensByAppAndUserParams) error
	createRefreshTokenFn              func(context.Context, db.CreateOAuth2RefreshTokenParams) (db.Oauth2RefreshToken, error)
	getRefreshTokenByHashFn           func(context.Context, string) (db.Oauth2RefreshToken, error)
	consumeRefreshTokenFn             func(context.Context, string) (db.Oauth2RefreshToken, error)
	deleteRefreshTokenByHashFn        func(context.Context, string) (int64, error)
	deleteRefreshTokensByAppAndUserFn func(context.Context, db.DeleteOAuth2RefreshTokensByAppAndUserParams) error
	getUserByIDFn                     func(context.Context, int64) (db.User, error)
}

func (q *oauth2HQuerier) GetOAuth2ApplicationByClientID(ctx context.Context, clientID string) (db.Oauth2Application, error) {
	if q.getApplicationByClientIDFn != nil {
		return q.getApplicationByClientIDFn(ctx, clientID)
	}
	return testOAuth2Application(true), nil
}

func (q *oauth2HQuerier) CreateOAuth2AuthorizationCode(ctx context.Context, arg db.CreateOAuth2AuthorizationCodeParams) error {
	if q.createAuthorizationCodeFn != nil {
		return q.createAuthorizationCodeFn(ctx, arg)
	}
	return nil
}

func (q *oauth2HQuerier) GetOAuth2AuthorizationCodeByHash(ctx context.Context, codeHash string) (db.Oauth2AuthorizationCode, error) {
	if q.getAuthorizationCodeByHashFn != nil {
		return q.getAuthorizationCodeByHashFn(ctx, codeHash)
	}
	// Single-row fixtures declare the stored code once via the consume fn;
	// the service's validate-then-consume flow reads the same row both times.
	if q.consumeAuthorizationCodeFn != nil {
		return q.consumeAuthorizationCodeFn(ctx, codeHash)
	}
	return db.Oauth2AuthorizationCode{AppID: 41, UserID: 7, Scopes: []string{"read:user"}, RedirectUri: "https://app.example/callback"}, nil
}

func (q *oauth2HQuerier) ConsumeOAuth2AuthorizationCode(ctx context.Context, codeHash string) (db.Oauth2AuthorizationCode, error) {
	if q.consumeAuthorizationCodeFn != nil {
		return q.consumeAuthorizationCodeFn(ctx, codeHash)
	}
	return db.Oauth2AuthorizationCode{AppID: 41, UserID: 7, Scopes: []string{"read:user"}, RedirectUri: "https://app.example/callback"}, nil
}

func (q *oauth2HQuerier) CreateOAuth2AccessToken(ctx context.Context, arg db.CreateOAuth2AccessTokenParams) (db.Oauth2AccessToken, error) {
	if q.createAccessTokenFn != nil {
		return q.createAccessTokenFn(ctx, arg)
	}
	return db.Oauth2AccessToken{ID: 1, TokenHash: arg.TokenHash, AppID: arg.AppID, UserID: arg.UserID, Scopes: arg.Scopes, ExpiresAt: arg.ExpiresAt}, nil
}

func (q *oauth2HQuerier) GetOAuth2AccessTokenByHash(ctx context.Context, tokenHash string) (db.Oauth2AccessToken, error) {
	if q.getAccessTokenByHashFn != nil {
		return q.getAccessTokenByHashFn(ctx, tokenHash)
	}
	return db.Oauth2AccessToken{}, pgx.ErrNoRows
}

func (q *oauth2HQuerier) DeleteOAuth2AccessTokenByHash(ctx context.Context, tokenHash string) (int64, error) {
	if q.deleteAccessTokenByHashFn != nil {
		return q.deleteAccessTokenByHashFn(ctx, tokenHash)
	}
	return 1, nil
}

func (q *oauth2HQuerier) DeleteOAuth2AccessTokensByAppAndUser(ctx context.Context, arg db.DeleteOAuth2AccessTokensByAppAndUserParams) error {
	if q.deleteAccessTokensByAppAndUserFn != nil {
		return q.deleteAccessTokensByAppAndUserFn(ctx, arg)
	}
	return nil
}

func (q *oauth2HQuerier) CreateOAuth2RefreshToken(ctx context.Context, arg db.CreateOAuth2RefreshTokenParams) (db.Oauth2RefreshToken, error) {
	if q.createRefreshTokenFn != nil {
		return q.createRefreshTokenFn(ctx, arg)
	}
	return db.Oauth2RefreshToken{ID: 2, TokenHash: arg.TokenHash, AppID: arg.AppID, UserID: arg.UserID, Scopes: arg.Scopes, ExpiresAt: arg.ExpiresAt}, nil
}

func (q *oauth2HQuerier) GetOAuth2RefreshTokenByHash(ctx context.Context, tokenHash string) (db.Oauth2RefreshToken, error) {
	if q.getRefreshTokenByHashFn != nil {
		return q.getRefreshTokenByHashFn(ctx, tokenHash)
	}
	return db.Oauth2RefreshToken{}, pgx.ErrNoRows
}

func (q *oauth2HQuerier) ConsumeOAuth2RefreshToken(ctx context.Context, tokenHash string) (db.Oauth2RefreshToken, error) {
	if q.consumeRefreshTokenFn != nil {
		return q.consumeRefreshTokenFn(ctx, tokenHash)
	}
	return db.Oauth2RefreshToken{AppID: 41, UserID: 7, Scopes: []string{"read:user"}}, nil
}

func (q *oauth2HQuerier) DeleteOAuth2RefreshTokenByHash(ctx context.Context, tokenHash string) (int64, error) {
	if q.deleteRefreshTokenByHashFn != nil {
		return q.deleteRefreshTokenByHashFn(ctx, tokenHash)
	}
	return 1, nil
}

func (q *oauth2HQuerier) DeleteOAuth2RefreshTokensByAppAndUser(ctx context.Context, arg db.DeleteOAuth2RefreshTokensByAppAndUserParams) error {
	if q.deleteRefreshTokensByAppAndUserFn != nil {
		return q.deleteRefreshTokensByAppAndUserFn(ctx, arg)
	}
	return nil
}

func (q *oauth2HQuerier) GetUserByID(ctx context.Context, id int64) (db.User, error) {
	if q.getUserByIDFn != nil {
		return q.getUserByIDFn(ctx, id)
	}
	return db.User{ID: id, Username: "alice", LowerUsername: "alice"}, nil
}

func oauth2HStatus(t *testing.T, err error) int {
	t.Helper()
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	return apiErr.Status
}

func TestOAuth2_H_ApplicationLookupErrors(t *testing.T) {
	ctx := context.Background()

	_, err := NewOAuth2Service(&oauth2HQuerier{
		getApplicationByClientIDFn: func(context.Context, string) (db.Oauth2Application, error) {
			return db.Oauth2Application{}, assert.AnError
		},
	}).GetApplicationByClientID(ctx, "client")
	require.Equal(t, 500, oauth2HStatus(t, err))

	valid, err := NewOAuth2Service(&oauth2HQuerier{}).IsValidRegisteredRedirectURI(ctx, "client", "https://app.example/callback")
	require.NoError(t, err)
	assert.True(t, valid)

	valid, err = NewOAuth2Service(&oauth2HQuerier{}).IsValidRegisteredRedirectURI(ctx, "client", "https://evil.example/callback")
	require.NoError(t, err)
	assert.False(t, valid)

	_, err = NewOAuth2Service(&oauth2HQuerier{
		getApplicationByClientIDFn: func(context.Context, string) (db.Oauth2Application, error) {
			return db.Oauth2Application{}, pgx.ErrNoRows
		},
	}).IsValidRegisteredRedirectURI(ctx, "client", "https://app.example/callback")
	require.Equal(t, 404, oauth2HStatus(t, err))

	_, err = NewOAuth2Service(&oauth2HQuerier{
		getApplicationByClientIDFn: func(context.Context, string) (db.Oauth2Application, error) {
			return db.Oauth2Application{}, assert.AnError
		},
	}).IsValidRegisteredRedirectURI(ctx, "client", "https://app.example/callback")
	require.Equal(t, 500, oauth2HStatus(t, err))

}

func TestOAuth2_H_AuthorizeEdgeScopesAndErrors(t *testing.T) {
	ctx := context.Background()
	baseApp := testOAuth2Application(true)
	baseApp.Scopes = []string{"", "read:user", "write:user"}
	svc := NewOAuth2Service(&oauth2HQuerier{
		getApplicationByClientIDFn: func(context.Context, string) (db.Oauth2Application, error) { return baseApp, nil },
	})

	res, err := svc.Authorize(ctx, 7, FirstPartyClientID, "https://app.example/callback", "read:user read:user", "challenge", "S256", []string{"", "read:user"})
	require.NoError(t, err)
	assert.NotEmpty(t, res.Code)

	_, err = svc.Authorize(ctx, 7, FirstPartyClientID, "https://evil.example/callback", "read:user", "challenge", "S256", nil)
	require.Equal(t, 400, oauth2HStatus(t, err))

	_, err = svc.Authorize(ctx, 7, FirstPartyClientID, "https://app.example/callback", "notascope", "challenge", "S256", nil)
	require.Equal(t, 400, oauth2HStatus(t, err))

	_, err = svc.Authorize(ctx, 7, FirstPartyClientID, "https://app.example/callback", "write:user", "challenge", "S256", []string{"read:user"})
	require.Equal(t, 400, oauth2HStatus(t, err))

	_, err = svc.Authorize(ctx, 7, FirstPartyClientID, "https://app.example/callback", "read:user", "", "S256", nil)
	require.Equal(t, 400, oauth2HStatus(t, err))

	_, err = NewOAuth2Service(&oauth2HQuerier{
		getApplicationByClientIDFn: func(context.Context, string) (db.Oauth2Application, error) {
			return db.Oauth2Application{}, assert.AnError
		},
	}).Authorize(ctx, 7, FirstPartyClientID, "https://app.example/callback", "read:user", "challenge", "S256", nil)
	require.Equal(t, 500, oauth2HStatus(t, err))

	_, err = NewOAuth2Service(&oauth2HQuerier{
		getApplicationByClientIDFn: func(context.Context, string) (db.Oauth2Application, error) { return baseApp, nil },
		createAuthorizationCodeFn:  func(context.Context, db.CreateOAuth2AuthorizationCodeParams) error { return assert.AnError },
	}).Authorize(ctx, 7, FirstPartyClientID, "https://app.example/callback", "read:user", "challenge", "S256", nil)
	require.Equal(t, 500, oauth2HStatus(t, err))
}

func TestOAuth2_H_ExchangeCodeErrors(t *testing.T) {
	ctx := context.Background()
	app := testOAuth2Application(true)

	for _, tc := range []struct {
		name string
		q    *oauth2HQuerier
		want int
	}{
		{"client lookup internal", &oauth2HQuerier{getApplicationByClientIDFn: func(context.Context, string) (db.Oauth2Application, error) {
			return db.Oauth2Application{}, assert.AnError
		}}, 500},
		{"bad secret", &oauth2HQuerier{getApplicationByClientIDFn: func(context.Context, string) (db.Oauth2Application, error) { return app, nil }}, 401},
		{"consume internal", &oauth2HQuerier{consumeAuthorizationCodeFn: func(context.Context, string) (db.Oauth2AuthorizationCode, error) {
			return db.Oauth2AuthorizationCode{}, assert.AnError
		}}, 500},
		{"app mismatch", &oauth2HQuerier{consumeAuthorizationCodeFn: func(context.Context, string) (db.Oauth2AuthorizationCode, error) {
			return db.Oauth2AuthorizationCode{AppID: 99, RedirectUri: "https://app.example/callback"}, nil
		}}, 400},
		{"redirect mismatch", &oauth2HQuerier{consumeAuthorizationCodeFn: func(context.Context, string) (db.Oauth2AuthorizationCode, error) {
			return db.Oauth2AuthorizationCode{AppID: app.ID, RedirectUri: "https://other.example/callback"}, nil
		}}, 400},
		{"challenge method invalid", &oauth2HQuerier{consumeAuthorizationCodeFn: func(context.Context, string) (db.Oauth2AuthorizationCode, error) {
			return db.Oauth2AuthorizationCode{AppID: app.ID, RedirectUri: "https://app.example/callback", CodeChallenge: "x", CodeChallengeMethod: "plain"}, nil
		}}, 400},
		{"missing verifier", &oauth2HQuerier{consumeAuthorizationCodeFn: func(context.Context, string) (db.Oauth2AuthorizationCode, error) {
			return db.Oauth2AuthorizationCode{AppID: app.ID, RedirectUri: "https://app.example/callback", CodeChallenge: s256Challenge("verifier"), CodeChallengeMethod: "S256"}, nil
		}}, 400},
		{"bad verifier", &oauth2HQuerier{consumeAuthorizationCodeFn: func(context.Context, string) (db.Oauth2AuthorizationCode, error) {
			return db.Oauth2AuthorizationCode{AppID: app.ID, RedirectUri: "https://app.example/callback", CodeChallenge: s256Challenge("verifier"), CodeChallengeMethod: "S256"}, nil
		}}, 400},
		{"consumed by concurrent redemption", &oauth2HQuerier{getAuthorizationCodeByHashFn: func(context.Context, string) (db.Oauth2AuthorizationCode, error) {
			return db.Oauth2AuthorizationCode{AppID: app.ID, RedirectUri: "https://app.example/callback"}, nil
		}, consumeAuthorizationCodeFn: func(context.Context, string) (db.Oauth2AuthorizationCode, error) {
			return db.Oauth2AuthorizationCode{}, pgx.ErrNoRows
		}}, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			secret := "secret-123"
			verifier := ""
			if tc.name == "bad secret" {
				secret = "wrong"
			}
			if tc.name == "bad verifier" {
				verifier = "wrong"
			}
			_, err := NewOAuth2Service(tc.q).ExchangeCode(ctx, FirstPartyClientID, secret, "code", "https://app.example/callback", verifier)
			require.Equal(t, tc.want, oauth2HStatus(t, err))
		})
	}
}

func TestOAuth2_H_RefreshTokenErrorsAndScopeNarrowing(t *testing.T) {
	ctx := context.Background()
	app := testOAuth2Application(true)
	app.Scopes = []string{"read:user"}

	for _, tc := range []struct {
		name string
		q    *oauth2HQuerier
		want int
	}{
		{"client lookup internal", &oauth2HQuerier{getApplicationByClientIDFn: func(context.Context, string) (db.Oauth2Application, error) {
			return db.Oauth2Application{}, assert.AnError
		}}, 500},
		{"bad secret", &oauth2HQuerier{getApplicationByClientIDFn: func(context.Context, string) (db.Oauth2Application, error) { return app, nil }}, 401},
		{"get missing", &oauth2HQuerier{getRefreshTokenByHashFn: func(context.Context, string) (db.Oauth2RefreshToken, error) {
			return db.Oauth2RefreshToken{}, pgx.ErrNoRows
		}}, 400},
		{"get internal", &oauth2HQuerier{getRefreshTokenByHashFn: func(context.Context, string) (db.Oauth2RefreshToken, error) {
			return db.Oauth2RefreshToken{}, assert.AnError
		}}, 500},
		{"app mismatch", &oauth2HQuerier{getRefreshTokenByHashFn: func(context.Context, string) (db.Oauth2RefreshToken, error) {
			return db.Oauth2RefreshToken{AppID: 99}, nil
		}}, 400},
		{"consume missing", &oauth2HQuerier{getRefreshTokenByHashFn: func(context.Context, string) (db.Oauth2RefreshToken, error) {
			return db.Oauth2RefreshToken{AppID: app.ID}, nil
		}, consumeRefreshTokenFn: func(context.Context, string) (db.Oauth2RefreshToken, error) {
			return db.Oauth2RefreshToken{}, pgx.ErrNoRows
		}}, 400},
		{"consume internal", &oauth2HQuerier{getRefreshTokenByHashFn: func(context.Context, string) (db.Oauth2RefreshToken, error) {
			return db.Oauth2RefreshToken{AppID: app.ID}, nil
		}, consumeRefreshTokenFn: func(context.Context, string) (db.Oauth2RefreshToken, error) {
			return db.Oauth2RefreshToken{}, assert.AnError
		}}, 500},
		{"nil scopes", &oauth2HQuerier{getRefreshTokenByHashFn: func(context.Context, string) (db.Oauth2RefreshToken, error) {
			return db.Oauth2RefreshToken{AppID: app.ID}, nil
		}, consumeRefreshTokenFn: func(context.Context, string) (db.Oauth2RefreshToken, error) {
			return db.Oauth2RefreshToken{AppID: app.ID, Scopes: nil}, nil
		}}, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			secret := "secret-123"
			if tc.name == "bad secret" {
				secret = "wrong"
			}
			_, err := NewOAuth2Service(tc.q).RefreshToken(ctx, FirstPartyClientID, secret, "refresh")
			require.Equal(t, tc.want, oauth2HStatus(t, err))
		})
	}

	var accessScopes, refreshScopes []string
	resp, err := NewOAuth2Service(&oauth2HQuerier{
		getApplicationByClientIDFn: func(context.Context, string) (db.Oauth2Application, error) { return app, nil },
		getRefreshTokenByHashFn: func(context.Context, string) (db.Oauth2RefreshToken, error) {
			return db.Oauth2RefreshToken{AppID: app.ID}, nil
		},
		consumeRefreshTokenFn: func(context.Context, string) (db.Oauth2RefreshToken, error) {
			return db.Oauth2RefreshToken{AppID: app.ID, UserID: 7, Scopes: []string{"read:user", "write:user"}}, nil
		},
		createAccessTokenFn: func(_ context.Context, arg db.CreateOAuth2AccessTokenParams) (db.Oauth2AccessToken, error) {
			accessScopes = arg.Scopes
			return db.Oauth2AccessToken{}, nil
		},
		createRefreshTokenFn: func(_ context.Context, arg db.CreateOAuth2RefreshTokenParams) (db.Oauth2RefreshToken, error) {
			refreshScopes = arg.Scopes
			return db.Oauth2RefreshToken{}, nil
		},
	}).RefreshToken(ctx, FirstPartyClientID, "secret-123", "refresh")
	require.NoError(t, err)
	assert.Equal(t, []string{"read:user"}, accessScopes)
	assert.Equal(t, []string{"read:user"}, refreshScopes)
	assert.Equal(t, "read:user", resp.Scope)
}

func TestOAuth2_H_RevokeTokenBranches(t *testing.T) {
	ctx := context.Background()
	app := testOAuth2Application(true)

	tests := []struct {
		name string
		q    *oauth2HQuerier
		want int
	}{
		{"client missing", &oauth2HQuerier{getApplicationByClientIDFn: func(context.Context, string) (db.Oauth2Application, error) {
			return db.Oauth2Application{}, pgx.ErrNoRows
		}}, 401},
		{"client internal", &oauth2HQuerier{getApplicationByClientIDFn: func(context.Context, string) (db.Oauth2Application, error) {
			return db.Oauth2Application{}, assert.AnError
		}}, 500},
		{"bad secret", &oauth2HQuerier{getApplicationByClientIDFn: func(context.Context, string) (db.Oauth2Application, error) { return app, nil }}, 401},
		{"access get internal", &oauth2HQuerier{getApplicationByClientIDFn: func(context.Context, string) (db.Oauth2Application, error) { return app, nil }, getAccessTokenByHashFn: func(context.Context, string) (db.Oauth2AccessToken, error) {
			return db.Oauth2AccessToken{}, assert.AnError
		}}, 500},
		{"access delete internal", &oauth2HQuerier{getApplicationByClientIDFn: func(context.Context, string) (db.Oauth2Application, error) { return app, nil }, getAccessTokenByHashFn: func(context.Context, string) (db.Oauth2AccessToken, error) {
			return db.Oauth2AccessToken{AppID: app.ID}, nil
		}, deleteAccessTokenByHashFn: func(context.Context, string) (int64, error) { return 0, assert.AnError }}, 500},
		{"refresh delete internal", &oauth2HQuerier{getApplicationByClientIDFn: func(context.Context, string) (db.Oauth2Application, error) { return app, nil }, getAccessTokenByHashFn: func(context.Context, string) (db.Oauth2AccessToken, error) {
			return db.Oauth2AccessToken{}, pgx.ErrNoRows
		}, getRefreshTokenByHashFn: func(context.Context, string) (db.Oauth2RefreshToken, error) {
			return db.Oauth2RefreshToken{AppID: app.ID}, nil
		}, deleteRefreshTokenByHashFn: func(context.Context, string) (int64, error) { return 0, assert.AnError }}, 500},
		{"refresh get internal", &oauth2HQuerier{getApplicationByClientIDFn: func(context.Context, string) (db.Oauth2Application, error) { return app, nil }, getAccessTokenByHashFn: func(context.Context, string) (db.Oauth2AccessToken, error) {
			return db.Oauth2AccessToken{}, pgx.ErrNoRows
		}, getRefreshTokenByHashFn: func(context.Context, string) (db.Oauth2RefreshToken, error) {
			return db.Oauth2RefreshToken{}, assert.AnError
		}}, 500},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			secret := "secret-123"
			if tc.name == "bad secret" {
				secret = "wrong"
			}
			err := NewOAuth2Service(tc.q).RevokeToken(ctx, FirstPartyClientID, secret, "token")
			require.Equal(t, tc.want, oauth2HStatus(t, err))
		})
	}

	err := NewOAuth2Service(&oauth2HQuerier{
		getApplicationByClientIDFn: func(context.Context, string) (db.Oauth2Application, error) { return app, nil },
		getAccessTokenByHashFn: func(context.Context, string) (db.Oauth2AccessToken, error) {
			return db.Oauth2AccessToken{AppID: app.ID + 1}, nil
		},
	}).RevokeToken(ctx, FirstPartyClientID, "secret-123", "token")
	require.NoError(t, err)

	err = NewOAuth2Service(&oauth2HQuerier{
		getApplicationByClientIDFn: func(context.Context, string) (db.Oauth2Application, error) { return app, nil },
		getAccessTokenByHashFn: func(context.Context, string) (db.Oauth2AccessToken, error) {
			return db.Oauth2AccessToken{}, pgx.ErrNoRows
		},
		getRefreshTokenByHashFn: func(context.Context, string) (db.Oauth2RefreshToken, error) {
			return db.Oauth2RefreshToken{AppID: app.ID + 1}, nil
		},
	}).RevokeToken(ctx, FirstPartyClientID, "secret-123", "token")
	require.NoError(t, err)
}

func TestOAuth2_H_RevokeAllAndIssueTokenPairErrors(t *testing.T) {
	ctx := context.Background()

	err := NewOAuth2Service(&oauth2HQuerier{
		deleteRefreshTokensByAppAndUserFn: func(context.Context, db.DeleteOAuth2RefreshTokensByAppAndUserParams) error { return assert.AnError },
	}).RevokeAllByAppAndUser(ctx, 41, 7)
	require.Equal(t, 500, oauth2HStatus(t, err))

	err = NewOAuth2Service(&oauth2HQuerier{
		deleteAccessTokensByAppAndUserFn: func(context.Context, db.DeleteOAuth2AccessTokensByAppAndUserParams) error { return assert.AnError },
	}).RevokeAllByAppAndUser(ctx, 41, 7)
	require.Equal(t, 500, oauth2HStatus(t, err))

	failAccess := &oauth2HQuerier{
		createAccessTokenFn: func(context.Context, db.CreateOAuth2AccessTokenParams) (db.Oauth2AccessToken, error) {
			return db.Oauth2AccessToken{}, assert.AnError
		},
	}
	_, err = NewOAuth2Service(failAccess).issueTokenPair(ctx, failAccess, 41, 7, nil, grantSource{})
	require.Equal(t, 500, oauth2HStatus(t, err))

	failRefresh := &oauth2HQuerier{
		createRefreshTokenFn: func(context.Context, db.CreateOAuth2RefreshTokenParams) (db.Oauth2RefreshToken, error) {
			return db.Oauth2RefreshToken{}, assert.AnError
		},
	}
	_, err = NewOAuth2Service(failRefresh).issueTokenPair(ctx, failRefresh, 41, 7, []string{"read:user"}, grantSource{})
	require.Equal(t, 500, oauth2HStatus(t, err))
}

func TestOAuth2_H_LoopbackScopeAndGeneratorEdges(t *testing.T) {
	assert.False(t, isLoopbackMatch("%", "http://127.0.0.1/callback"))
	assert.False(t, isLoopbackMatch("http://127.0.0.1/callback", "%"))
	assert.False(t, isLoopbackMatch("http://localhost/callback", "http://localhost:123/callback"))
	assert.False(t, isLoopbackMatch("http://127.0.0.1/callback?x=1", "http://127.0.0.1:123/callback?x=2"))

	assert.Equal(t, []string{"read:user"}, scopeIntersection([]string{"", "read:user", "read:user", "write:user"}, []string{"", "read:user"}))
}

func TestOAuth2_H_IssueTokenPairUsesServiceClock(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	var accessExpires, refreshExpires time.Time
	svc := NewOAuth2Service(&oauth2HQuerier{
		createAccessTokenFn: func(_ context.Context, arg db.CreateOAuth2AccessTokenParams) (db.Oauth2AccessToken, error) {
			accessExpires = arg.ExpiresAt
			return db.Oauth2AccessToken{}, nil
		},
		createRefreshTokenFn: func(_ context.Context, arg db.CreateOAuth2RefreshTokenParams) (db.Oauth2RefreshToken, error) {
			refreshExpires = arg.ExpiresAt
			return db.Oauth2RefreshToken{}, nil
		},
	})
	svc.now = func() time.Time { return now }

	resp, err := svc.issueTokenPair(ctx, svc.queries, 41, 7, nil, grantSource{})
	require.NoError(t, err)
	assert.Equal(t, now.Add(oauth2AccessTokenTTL), accessExpires)
	assert.Equal(t, now.Add(oauth2RefreshTokenTTL), refreshExpires)
	assert.Empty(t, resp.Scope)
}

type stubDriverError struct{ msg string }

func (e *stubDriverError) Error() string { return e.msg }
