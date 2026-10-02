package services

import (
	"context"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// txRefreshStore holds refresh tokens with transaction semantics: writes made
// inside a transaction become visible only when it commits.
type txRefreshStore struct {
	mu        sync.Mutex
	consumed  map[string]bool
	failNextR bool
}

func (s *txRefreshStore) querier(staged map[string]bool) *mockOAuth2Querier {
	app := testOAuth2Application(true)
	return &mockOAuth2Querier{
		getApplicationByClientIDFn: func(context.Context, string) (db.Oauth2Application, error) { return app, nil },
		getRefreshTokenByHashFn: func(_ context.Context, hash string) (db.Oauth2RefreshToken, error) {
			return db.Oauth2RefreshToken{AppID: app.ID, UserID: 7, TokenHash: hash, Scopes: []string{"read:user"}}, nil
		},
		consumeRefreshTokenFn: func(_ context.Context, hash string) (db.Oauth2RefreshToken, error) {
			s.mu.Lock()
			defer s.mu.Unlock()
			if s.consumed[hash] || staged[hash] {
				return db.Oauth2RefreshToken{}, pgx.ErrNoRows
			}
			staged[hash] = true
			return db.Oauth2RefreshToken{AppID: app.ID, UserID: 7, TokenHash: hash, Scopes: []string{"read:user"}}, nil
		},
		createAccessTokenFn: func(context.Context, db.CreateOAuth2AccessTokenParams) (db.Oauth2AccessToken, error) {
			return db.Oauth2AccessToken{}, nil
		},
		createRefreshTokenFn: func(context.Context, db.CreateOAuth2RefreshTokenParams) (db.Oauth2RefreshToken, error) {
			s.mu.Lock()
			defer s.mu.Unlock()
			if s.failNextR {
				s.failNextR = false
				return db.Oauth2RefreshToken{}, assert.AnError
			}
			return db.Oauth2RefreshToken{}, nil
		},
	}
}

func TestOAuth2Service_RefreshTokenSurvivesFailedRotation(t *testing.T) {
	t.Parallel()
	store := &txRefreshStore{consumed: map[string]bool{}, failNextR: true}
	svc := NewOAuth2Service(store.querier(map[string]bool{}))
	svc.inTx = func(ctx context.Context, fn func(OAuth2Querier) error) error {
		staged := map[string]bool{}
		if err := fn(store.querier(staged)); err != nil {
			return err // rollback: staged consumption is discarded
		}
		store.mu.Lock()
		defer store.mu.Unlock()
		for hash := range staged {
			store.consumed[hash] = true
		}
		return nil
	}

	_, err := svc.RefreshToken(context.Background(), FirstPartyClientID, "secret-123", "smithers_ort_old")
	require.Error(t, err, "the new refresh token insert failed")

	resp, err := svc.RefreshToken(context.Background(), FirstPartyClientID, "secret-123", "smithers_ort_old")
	require.NoError(t, err, "the old refresh token must stay usable after a failed rotation")
	require.NotEmpty(t, resp.RefreshToken)

	_, err = svc.RefreshToken(context.Background(), FirstPartyClientID, "secret-123", "smithers_ort_old")
	require.Error(t, err, "a committed rotation spends the old token")
}
