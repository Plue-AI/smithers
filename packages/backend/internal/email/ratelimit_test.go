package email

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRateLimitedTransport_NoLimitsReturnsInner(t *testing.T) {
	t.Parallel()

	inner := &NoopTransport{}
	wrapped := NewRateLimitedTransport(inner, RateLimitConfig{})

	// Should return the inner transport directly when no limits set.
	assert.Equal(t, inner, wrapped)
}

func TestRateLimitedTransport_DelegatesAvailability(t *testing.T) {
	t.Parallel()

	disabled := NewRateLimitedTransport(&DisabledTransport{}, RateLimitConfig{
		MaxPerSecond: 10,
	})
	assert.False(t, DeliveryConfigured(disabled))

	available := NewRateLimitedTransport(&NoopTransport{}, RateLimitConfig{
		MaxPerSecond: 10,
	})
	assert.True(t, DeliveryConfigured(available))
}

func TestRateLimitedTransport_GlobalRateLimit(t *testing.T) {
	t.Parallel()

	inner := &NoopTransport{}
	wrapped := NewRateLimitedTransport(inner, RateLimitConfig{
		MaxPerSecond: 2,
	})

	msg := Message{
		To:      []string{"user@example.com"},
		Subject: "Test",
		Text:    "Hello",
	}

	// First two should succeed.
	require.NoError(t, wrapped.Send(context.Background(), msg))
	require.NoError(t, wrapped.Send(context.Background(), msg))

	// Third should be rate limited.
	err := wrapped.Send(context.Background(), msg)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "global rate limit exceeded")
}

func TestRateLimitedTransport_PerRecipientRateLimit(t *testing.T) {
	pool, _ := recipientLimitPools(t)

	inner := &NoopTransport{}
	wrapped := NewRateLimitedTransport(inner, RateLimitConfig{
		MaxPerRecipientPerHour: 2,
		RecipientPool:          pool,
	})

	msgAlice := Message{
		To:      []string{"alice@example.com"},
		Subject: "Test",
		Text:    "Hello",
	}
	msgBob := Message{
		To:      []string{"bob@example.com"},
		Subject: "Test",
		Text:    "Hello",
	}

	// Alice: first two should succeed.
	require.NoError(t, wrapped.Send(context.Background(), msgAlice))
	require.NoError(t, wrapped.Send(context.Background(), msgAlice))

	// Alice: third should fail.
	err := wrapped.Send(context.Background(), msgAlice)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "per-recipient rate limit exceeded")
	assert.Contains(t, err.Error(), "alice@example.com")

	// Bob: should still work (different recipient).
	require.NoError(t, wrapped.Send(context.Background(), msgBob))
}

func TestRateLimitedTransport_SharedBudget(t *testing.T) {
	firstPool, secondPool := recipientLimitPools(t)
	firstInner := &NoopTransport{}
	secondInner := &NoopTransport{}
	first := NewRateLimitedTransport(firstInner, RateLimitConfig{MaxPerRecipientPerHour: 1, RecipientPool: firstPool})
	second := NewRateLimitedTransport(secondInner, RateLimitConfig{MaxPerRecipientPerHour: 1, RecipientPool: secondPool})
	msg := Message{To: []string{"shared@example.com"}}
	require.NoError(t, first.Send(context.Background(), msg))
	require.ErrorContains(t, second.Send(context.Background(), msg), "per-recipient rate limit exceeded")
	require.Len(t, firstInner.Sent, 1)
	require.Empty(t, secondInner.Sent)
}

func TestRateLimitedTransport_PrunesExpiredRecipientWindows(t *testing.T) {
	pool, _ := recipientLimitPools(t)
	tr := NewRateLimitedTransport(&NoopTransport{}, RateLimitConfig{
		MaxPerRecipientPerHour: 10, RecipientPool: pool,
	})
	require.NoError(t, tr.Send(context.Background(), Message{To: []string{"expired@example.com"}}))
	_, err := pool.Exec(context.Background(),
		"UPDATE email_recipient_rate_limits SET reset_at = NOW() - INTERVAL '1 minute' WHERE recipient = 'expired@example.com'")
	require.NoError(t, err)
	require.NoError(t, tr.Send(context.Background(), Message{To: []string{"fresh@example.com"}}))
	var expiredRows int
	require.NoError(t, pool.QueryRow(context.Background(),
		"SELECT count(*) FROM email_recipient_rate_limits WHERE recipient = 'expired@example.com'").Scan(&expiredRows))
	assert.Zero(t, expiredRows)
	assert.EqualValues(t, 1, recipientCount(t, pool, "fresh@example.com"))
}

func TestRateLimitedTransport_DelegatesToInner(t *testing.T) {
	t.Parallel()

	inner := &NoopTransport{}
	wrapped := NewRateLimitedTransport(inner, RateLimitConfig{
		MaxPerSecond: 100,
	})

	msg := Message{
		To:      []string{"user@example.com"},
		Subject: "Delegated",
		Text:    "Hello",
	}

	require.NoError(t, wrapped.Send(context.Background(), msg))
	require.Len(t, inner.Sent, 1)
	assert.Equal(t, "Delegated", inner.Sent[0].Subject)
}
