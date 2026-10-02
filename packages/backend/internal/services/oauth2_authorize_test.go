package services

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// TestOAuth2Service_IsValidRegisteredRedirectURI_ExactMatch covers the default
// exact-string comparison required for non-loopback redirect URIs (RFC 6749
// §3.1.2.4, RFC 8252 §8.1).
func TestOAuth2Service_IsValidRegisteredRedirectURI_ExactMatch(t *testing.T) {
	t.Parallel()

	app := db.Oauth2Application{
		ID:       41,
		ClientID: FirstPartyClientID,
		RedirectUris: []string{
			"smithers://oauth2/callback",
			"smithers://auth/callback",
			"https://app.example/callback",
		},
	}
	svc := NewOAuth2Service(&mockOAuth2Querier{
		getApplicationByClientIDFn: func(_ context.Context, _ string) (db.Oauth2Application, error) {
			return app, nil
		},
	})

	cases := []struct {
		uri  string
		want bool
	}{
		{"smithers://oauth2/callback", true},
		{"smithers://oauth2/callback/", false},    // trailing slash differs
		{"smithers://oauth2/callback?x=1", false}, // extra query
		{"smithers://auth/callback", true},
		{"smithers://auth/callback/", false},    // trailing slash differs
		{"smithers://auth/callback?x=1", false}, // extra query
		{"https://app.example/callback", true},
		{"https://app.example/callback2", false},
		{"https://evil.example/callback", false},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.uri, func(t *testing.T) {
			t.Parallel()
			got, err := svc.IsValidRegisteredRedirectURI(context.Background(), FirstPartyClientID, tc.uri)
			require.NoError(t, err)
			assert.Equal(t, tc.want, got)
		})
	}
}

// TestOAuth2Service_IsValidRegisteredRedirectURI_LoopbackPortAgnostic covers
// RFC 8252 §7.3: a registered http://127.0.0.1/path entry MUST match any
// ephemeral port presented by the native app.
func TestOAuth2Service_IsValidRegisteredRedirectURI_LoopbackPortAgnostic(t *testing.T) {
	t.Parallel()

	app := db.Oauth2Application{
		ID:       41,
		ClientID: FirstPartyClientID,
		RedirectUris: []string{
			"http://127.0.0.1/callback",
			"http://[::1]/callback",
		},
	}
	svc := NewOAuth2Service(&mockOAuth2Querier{
		getApplicationByClientIDFn: func(_ context.Context, _ string) (db.Oauth2Application, error) {
			return app, nil
		},
	})

	cases := []struct {
		uri  string
		want bool
	}{
		{"http://127.0.0.1/callback", true},
		{"http://127.0.0.1:0/callback", true},
		{"http://127.0.0.1:54321/callback", true},
		{"http://127.0.0.1:65535/callback", true},
		{"http://[::1]:8080/callback", true},
		// Different path — must NOT match.
		{"http://127.0.0.1:54321/evil", false},
		// Different host — must NOT match (open-redirect defense).
		{"http://localhost:54321/callback", false},
		// Different scheme — must NOT match (no https loopback short-
		// circuit since cert pinning isn't feasible there).
		{"https://127.0.0.1:54321/callback", false},
		// Extra query — must NOT match (prevents sneaking parameters in).
		{"http://127.0.0.1:54321/callback?evil=1", false},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.uri, func(t *testing.T) {
			t.Parallel()
			got, err := svc.IsValidRegisteredRedirectURI(context.Background(), FirstPartyClientID, tc.uri)
			require.NoError(t, err)
			assert.Equal(t, tc.want, got, "uri=%s", tc.uri)
		})
	}
}

// TestOAuth2Service_RevokeToken_BindsToClient covers RFC 7009 §2.1 client
// ownership enforcement: presenting client A's credentials MUST NOT revoke
// client B's token.
func TestOAuth2Service_RevokeToken_BindsToClient(t *testing.T) {
	t.Parallel()

	t.Run("client A cannot revoke client B's access token", func(t *testing.T) {
		t.Parallel()

		deleted := false
		svc := NewOAuth2Service(&mockOAuth2Querier{
			getApplicationByClientIDFn: func(_ context.Context, clientID string) (db.Oauth2Application, error) {
				// Caller authenticates as client "client-a" (app ID 100).
				return db.Oauth2Application{
					ID:               100,
					ClientID:         "client-a",
					ClientSecretHash: hashOAuth2Secret("secret-a"),
					Confidential:     true,
				}, nil
			},
			// The token belongs to a DIFFERENT app (ID 200).
			// No dedicated getter in the mock — we reuse the access-token
			// hash path via adding a helper hook below.
		})

		// We need to intercept GetOAuth2AccessTokenByHash — add a stubbed
		// querier that returns a token for a different app.
		svc.queries = &revokeMockQuerier{
			getAppFn: func(clientID string) (db.Oauth2Application, error) {
				return db.Oauth2Application{
					ID:               100,
					ClientID:         "client-a",
					ClientSecretHash: hashOAuth2Secret("secret-a"),
					Confidential:     true,
				}, nil
			},
			getAccessFn: func(_ string) (db.Oauth2AccessToken, error) {
				return db.Oauth2AccessToken{ID: 1, AppID: 200, TokenHash: "hash"}, nil
			},
			deleteAccessFn: func(_ string) (int64, error) {
				deleted = true
				return 1, nil
			},
		}

		err := svc.RevokeToken(context.Background(), "client-a", "secret-a", "some-token")
		require.NoError(t, err, "RFC 7009 §2.2 — revoke of not-your-token returns 200")
		assert.False(t, deleted, "must NOT delete a token owned by a different client")
	})

	t.Run("client A can revoke client A's own access token", func(t *testing.T) {
		t.Parallel()

		deleted := false
		svc := NewOAuth2Service(&revokeMockQuerier{
			getAppFn: func(_ string) (db.Oauth2Application, error) {
				return db.Oauth2Application{
					ID:               100,
					ClientID:         "client-a",
					ClientSecretHash: hashOAuth2Secret("secret-a"),
					Confidential:     true,
				}, nil
			},
			getAccessFn: func(_ string) (db.Oauth2AccessToken, error) {
				return db.Oauth2AccessToken{ID: 1, AppID: 100, TokenHash: "hash"}, nil
			},
			deleteAccessFn: func(_ string) (int64, error) {
				deleted = true
				return 1, nil
			},
		})

		err := svc.RevokeToken(context.Background(), "client-a", "secret-a", "some-token")
		require.NoError(t, err)
		assert.True(t, deleted)
	})

	t.Run("wrong client secret is rejected", func(t *testing.T) {
		t.Parallel()

		svc := NewOAuth2Service(&revokeMockQuerier{
			getAppFn: func(_ string) (db.Oauth2Application, error) {
				return db.Oauth2Application{
					ID:               100,
					ClientID:         "client-a",
					ClientSecretHash: hashOAuth2Secret("correct-secret"),
					Confidential:     true,
				}, nil
			},
		})

		err := svc.RevokeToken(context.Background(), "client-a", "wrong-secret", "some-token")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "invalid client_secret")
	})

	t.Run("unknown token returns success (RFC 7009 §2.2)", func(t *testing.T) {
		t.Parallel()

		svc := NewOAuth2Service(&revokeMockQuerier{
			getAppFn: func(_ string) (db.Oauth2Application, error) {
				return db.Oauth2Application{
					ID:               100,
					ClientID:         "client-a",
					ClientSecretHash: hashOAuth2Secret("secret-a"),
					Confidential:     true,
				}, nil
			},
			getAccessFn: func(_ string) (db.Oauth2AccessToken, error) {
				return db.Oauth2AccessToken{}, pgx.ErrNoRows
			},
			getRefreshFn: func(_ string) (db.Oauth2RefreshToken, error) {
				return db.Oauth2RefreshToken{}, pgx.ErrNoRows
			},
		})

		err := svc.RevokeToken(context.Background(), "client-a", "secret-a", "nonexistent-token")
		require.NoError(t, err, "RFC 7009 §2.2 — invalid token is not an error")
	})

	t.Run("public client can revoke its own token without secret", func(t *testing.T) {
		t.Parallel()

		deleted := false
		svc := NewOAuth2Service(&revokeMockQuerier{
			getAppFn: func(_ string) (db.Oauth2Application, error) {
				return db.Oauth2Application{
					ID:               100,
					ClientID:         "public-client",
					ClientSecretHash: "unused",
					Confidential:     false,
				}, nil
			},
			getAccessFn: func(_ string) (db.Oauth2AccessToken, error) {
				return db.Oauth2AccessToken{ID: 1, AppID: 100}, nil
			},
			deleteAccessFn: func(_ string) (int64, error) {
				deleted = true
				return 1, nil
			},
		})

		// Public client presents client_id but no secret — this is RFC
		// 6749 §2.3 ("The client MAY omit the [credentials] when
		// authenticating as a public client").
		err := svc.RevokeToken(context.Background(), "public-client", "", "some-token")
		require.NoError(t, err)
		assert.True(t, deleted)
	})

	t.Run("token-only revocation without client_id is refused", func(t *testing.T) {
		t.Parallel()

		deleted := false
		svc := NewOAuth2Service(&revokeMockQuerier{
			getAccessFn: func(_ string) (db.Oauth2AccessToken, error) {
				return db.Oauth2AccessToken{ID: 1, AppID: 100}, nil
			},
			deleteAccessFn: func(_ string) (int64, error) {
				deleted = true
				return 1, nil
			},
		})

		// RFC 7009 §2.1 — the revoking client must authenticate; knowing a
		// token value alone must never be enough to destroy it.
		err := svc.RevokeToken(context.Background(), "", "", "some-token")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "client_id is required")
		assert.False(t, deleted, "an unauthenticated caller must not delete tokens")
	})
}

// revokeMockQuerier is a narrow-purpose mock used to exercise the ownership
// branches of RevokeToken. It fully implements OAuth2Querier via embedding
// a zero-valued mockOAuth2Querier for the methods we don't care about.
type revokeMockQuerier struct {
	mockOAuth2Querier
	getAppFn        func(clientID string) (db.Oauth2Application, error)
	getAccessFn     func(hash string) (db.Oauth2AccessToken, error)
	deleteAccessFn  func(hash string) (int64, error)
	getRefreshFn    func(hash string) (db.Oauth2RefreshToken, error)
	deleteRefreshFn func(hash string) (int64, error)
}

func (m *revokeMockQuerier) GetOAuth2ApplicationByClientID(_ context.Context, clientID string) (db.Oauth2Application, error) {
	if m.getAppFn != nil {
		return m.getAppFn(clientID)
	}
	return db.Oauth2Application{}, pgx.ErrNoRows
}

func (m *revokeMockQuerier) GetOAuth2AccessTokenByHash(_ context.Context, hash string) (db.Oauth2AccessToken, error) {
	if m.getAccessFn != nil {
		return m.getAccessFn(hash)
	}
	return db.Oauth2AccessToken{}, pgx.ErrNoRows
}

func (m *revokeMockQuerier) DeleteOAuth2AccessTokenByHash(_ context.Context, hash string) (int64, error) {
	if m.deleteAccessFn != nil {
		return m.deleteAccessFn(hash)
	}
	return 0, nil
}

func (m *revokeMockQuerier) GetOAuth2RefreshTokenByHash(_ context.Context, hash string) (db.Oauth2RefreshToken, error) {
	if m.getRefreshFn != nil {
		return m.getRefreshFn(hash)
	}
	return db.Oauth2RefreshToken{}, pgx.ErrNoRows
}

func (m *revokeMockQuerier) DeleteOAuth2RefreshTokenByHash(_ context.Context, hash string) (int64, error) {
	if m.deleteRefreshFn != nil {
		return m.deleteRefreshFn(hash)
	}
	return 0, nil
}

// TestOAuth2Service_GetApplicationByClientID_Public covers the public-facing
// app lookup used by the authorize handler (so it can validate client_id +
// redirect_uri WITHOUT requiring the caller to be authenticated).
func TestOAuth2Service_GetApplicationByClientID_Public(t *testing.T) {
	t.Parallel()

	svc := NewOAuth2Service(&mockOAuth2Querier{
		getApplicationByClientIDFn: func(_ context.Context, clientID string) (db.Oauth2Application, error) {
			if clientID != FirstPartyClientID {
				return db.Oauth2Application{}, pgx.ErrNoRows
			}
			return db.Oauth2Application{
				ID:               41,
				ClientID:         FirstPartyClientID,
				ClientSecretHash: "super-secret-hash-never-leaks",
				Name:             "app",
				RedirectUris:     []string{"smithers://oauth2/callback", "smithers://auth/callback"},
				Scopes:           []string{"read:user"},
				Confidential:     false,
			}, nil
		},
	})

	got, err := svc.GetApplicationByClientID(context.Background(), FirstPartyClientID)
	require.NoError(t, err)
	assert.Equal(t, FirstPartyClientID, got.ClientID)
	assert.Equal(t, []string{"smithers://oauth2/callback", "smithers://auth/callback"}, got.RedirectURIs)
	assert.False(t, got.Confidential)

	// Not-found surfaces as a proper 404 error.
	_, err = svc.GetApplicationByClientID(context.Background(), "does-not-exist")
	require.Error(t, err)
}
