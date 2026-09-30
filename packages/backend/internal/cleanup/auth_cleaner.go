// Package cleanup provides utilities for cleaning up expired data.
package cleanup

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
)

// CleanupStore defines the interface for cleanup operations.
type CleanupStore interface {
	DeleteExpiredSessions(ctx context.Context) error
	DeleteExpiredNonces(ctx context.Context) error
	DeleteExpiredOAuthStates(ctx context.Context) error
	DeleteExpiredVerificationTokens(ctx context.Context) error
	DeleteExpiredSSETickets(ctx context.Context) error
	// DeleteExpiredAccessTokens prunes PATs whose expires_at passed more than
	// a grace day ago; bounded per sweep (see db/product/queries/auth.sql). Returns
	// the number of rows deleted.
	DeleteExpiredAccessTokens(ctx context.Context) (int64, error)
}

// AuthCleaner periodically cleans up expired auth-related data.
type AuthCleaner struct {
	periodicRunner
	store       CleanupStore
	revocations revocation.Publisher
}

// rateLimitBucketRetention is how long an idle rate-limit bucket row is kept.
// It matches the longest window any Postgres-backed limiter uses.
const rateLimitBucketRetention = 24 * time.Hour

// expiredRateLimitStore prunes idle Postgres rate-limit buckets. The sweep
// runs here, once per process, so no user request waits on the DELETE.
type expiredRateLimitStore interface {
	DeleteExpiredSearchRateLimits(ctx context.Context, cutoffAt time.Time) error
}

type expiredOAuth2AccessTokenStore interface {
	DeleteExpiredOAuth2AccessTokens(context.Context) ([]db.Oauth2AccessToken, error)
}

// expiredOAuth2GrantStore deletes authorization codes and refresh tokens that
// can no longer be redeemed, so both tables stay bounded.
type expiredOAuth2GrantStore interface {
	DeleteExpiredOAuth2AuthorizationCodes(context.Context) error
	DeleteExpiredOAuth2RefreshTokens(context.Context) error
}

// SetRevocationPublisher announces expired OAuth2 access tokens so streams
// authenticated by them stop instead of surviving until disconnect.
func (c *AuthCleaner) SetRevocationPublisher(p revocation.Publisher) {
	c.revocations = p
}

// defaultAuthCleanupInterval is used when a non-positive interval is supplied.
const defaultAuthCleanupInterval = 5 * time.Minute

// NewAuthCleaner creates a new AuthCleaner.
func NewAuthCleaner(store CleanupStore, interval time.Duration) *AuthCleaner {
	c := &AuthCleaner{store: store}
	c.init("auth", interval, defaultAuthCleanupInterval)
	return c
}

// Start begins the periodic cleanup loop.
func (c *AuthCleaner) Start(ctx context.Context) { c.start(ctx, c.sweep) }

// sweep performs a single cleanup pass.
func (c *AuthCleaner) sweep(ctx context.Context) error {
	var errs []error

	if err := c.store.DeleteExpiredSessions(ctx); err != nil {
		errs = append(errs, fmt.Errorf("delete expired sessions: %w", err))
	}
	if err := c.store.DeleteExpiredNonces(ctx); err != nil {
		errs = append(errs, fmt.Errorf("delete expired nonces: %w", err))
	}
	if err := c.store.DeleteExpiredOAuthStates(ctx); err != nil {
		errs = append(errs, fmt.Errorf("delete expired oauth states: %w", err))
	}
	if err := c.store.DeleteExpiredVerificationTokens(ctx); err != nil {
		errs = append(errs, fmt.Errorf("delete expired verification tokens: %w", err))
	}
	if err := c.store.DeleteExpiredSSETickets(ctx); err != nil {
		errs = append(errs, fmt.Errorf("delete expired sse tickets: %w", err))
	}
	if deleted, err := c.store.DeleteExpiredAccessTokens(ctx); err != nil {
		errs = append(errs, fmt.Errorf("delete expired access tokens: %w", err))
	} else if deleted > 0 {
		slog.Info("pruned expired access tokens", "count", deleted)
	}
	if store, ok := c.store.(expiredRateLimitStore); ok {
		if err := store.DeleteExpiredSearchRateLimits(ctx, time.Now().Add(-rateLimitBucketRetention)); err != nil {
			errs = append(errs, fmt.Errorf("delete expired rate limit buckets: %w", err))
		}
	}
	if store, ok := c.store.(expiredOAuth2AccessTokenStore); ok {
		expired, err := store.DeleteExpiredOAuth2AccessTokens(ctx)
		if err != nil {
			errs = append(errs, fmt.Errorf("delete expired oauth2 access tokens: %w", err))
		} else {
			for _, token := range expired {
				revocation.PublishBestEffort(ctx, c.revocations, revocation.Event{
					Kind:      revocation.KindTokenRevoked,
					UserID:    token.UserID,
					TokenID:   token.ID,
					TokenHash: token.TokenHash,
					Reason:    "oauth2 access token expired",
				})
			}
		}
	}
	if store, ok := c.store.(expiredOAuth2GrantStore); ok {
		if err := store.DeleteExpiredOAuth2AuthorizationCodes(ctx); err != nil {
			errs = append(errs, fmt.Errorf("delete expired oauth2 authorization codes: %w", err))
		}
		if err := store.DeleteExpiredOAuth2RefreshTokens(ctx); err != nil {
			errs = append(errs, fmt.Errorf("delete expired oauth2 refresh tokens: %w", err))
		}
	}

	if len(errs) > 0 {
		return errors.Join(errs...)
	}
	return nil
}
