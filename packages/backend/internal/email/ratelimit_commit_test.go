package email

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestRateLimitedTransport_RefusedSendConsumesNoQuota(t *testing.T) {
	pool, _ := recipientLimitPools(t)
	inner := &NoopTransport{}
	tr := NewRateLimitedTransport(inner, RateLimitConfig{
		MaxPerSecond: 2, MaxPerRecipientPerHour: 1, RecipientPool: pool,
	})

	require.NoError(t, tr.Send(context.Background(), Message{To: []string{"b@x.com"}}))
	// Refused: b@x.com is at its cap. Neither the global token nor a@x.com's
	// hourly slot may be spent.
	require.Error(t, tr.Send(context.Background(), Message{To: []string{"a@x.com", "b@x.com"}}))
	require.NoError(t, tr.Send(context.Background(), Message{To: []string{"a@x.com"}}))
	require.Len(t, inner.Sent, 2)
	require.EqualValues(t, 1, recipientCount(t, pool, "a@x.com"))
	require.EqualValues(t, 1, recipientCount(t, pool, "b@x.com"))
}

func TestRateLimitedTransport_RecipientKeyIgnoresCase(t *testing.T) {
	pool, _ := recipientLimitPools(t)
	inner := &NoopTransport{}
	tr := NewRateLimitedTransport(inner, RateLimitConfig{MaxPerRecipientPerHour: 1, RecipientPool: pool})

	require.NoError(t, tr.Send(context.Background(), Message{To: []string{" User@X.com ", "user@x.com"}}))
	require.EqualValues(t, 1, recipientCount(t, pool, "user@x.com"))
	require.ErrorContains(t, tr.Send(context.Background(), Message{To: []string{"user@x.com"}}), "per-recipient rate limit exceeded")
	require.Len(t, inner.Sent, 1)
}
