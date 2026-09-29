package email

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestRatelimit_Cover_GlobalRefillAfterWindow exercises the token refill branch
// in checkLimits: once a full second has elapsed since lastReset, the bucket is
// refilled to MaxPerSecond and the send succeeds again.
func TestRatelimit_Cover_GlobalRefillAfterWindow(t *testing.T) {
	t.Parallel()

	inner := &NoopTransport{}
	tr := NewRateLimitedTransport(inner, RateLimitConfig{MaxPerSecond: 1}).(*RateLimitedTransport)

	msg := Message{To: []string{"user@example.com"}, Subject: "s", Text: "t"}

	// First send consumes the only token.
	require.NoError(t, tr.Send(context.Background(), msg))

	// Without a refill the next send would be rate limited. Rewind lastReset so
	// that more than a second has "elapsed", forcing the refill branch.
	tr.mu.Lock()
	tr.lastReset = time.Now().Add(-2 * time.Second)
	tr.mu.Unlock()

	require.NoError(t, tr.Send(context.Background(), msg))

	// Bucket is exhausted again immediately after the refilled token is spent.
	err := tr.Send(context.Background(), msg)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "global rate limit exceeded")

	require.Len(t, inner.Sent, 2)
}

// TestRatelimit_Cover_PerRecipientExpiredWindowRecreated verifies that an
// expired database window starts a fresh count even across transport instances.
func TestRatelimit_Cover_PerRecipientExpiredWindowRecreated(t *testing.T) {
	firstPool, secondPool := recipientLimitPools(t)
	inner := &NoopTransport{}
	tr := NewRateLimitedTransport(inner, RateLimitConfig{MaxPerRecipientPerHour: 1, RecipientPool: firstPool})
	other := NewRateLimitedTransport(inner, RateLimitConfig{MaxPerRecipientPerHour: 1, RecipientPool: secondPool})

	msg := Message{To: []string{"user@example.com"}, Subject: "s", Text: "t"}

	require.NoError(t, tr.Send(context.Background(), msg))
	err := other.Send(context.Background(), msg)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "per-recipient rate limit exceeded")

	_, err = firstPool.Exec(context.Background(),
		"UPDATE email_recipient_rate_limits SET reset_at = $1 WHERE recipient = $2",
		time.Now().Add(-time.Minute), "user@example.com")
	require.NoError(t, err)
	require.NoError(t, other.Send(context.Background(), msg))
	assert.EqualValues(t, 1, recipientCount(t, firstPool, "user@example.com"))
}
