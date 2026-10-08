package machined

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestAckDelayReadyConnectionFence(t *testing.T) {
	r := new(Registry)
	t.Cleanup(func() { require.NoError(t, r.Close()) })
	authority, err := r.MintBoot("branch", "vm")
	require.NoError(t, err)
	link, _ := connectTest(t, r, "branch", authority)
	_, err = r.AckDelay("branch", 10000, "", "")
	require.ErrorIs(t, err, ErrNotReady)
	require.NoError(t, link.Connection.Reconciled())
	first, err := r.AckDelay("branch", 10000, "", "")
	require.NoError(t, err)
	for _, invalid := range []int{-1, 1, 9999, 10001} {
		_, err = r.AckDelay("branch", invalid, "", "")
		require.ErrorIs(t, err, ErrNotReady)
	}
	replacement, err := r.MintBoot("branch", "replacement")
	require.NoError(t, err)
	fresh, _ := connectTest(t, r, "branch", replacement)
	require.NoError(t, fresh.Connection.Reconciled())
	_, err = r.ReadAckDelay("branch")
	require.ErrorIs(t, err, ErrUnauthorized, "old diagnostic cannot authenticate a new boot")
	next, err := r.AckDelay("branch", 10000, "", "")
	require.NoError(t, err)
	require.NotEqual(t, first.ID, next.ID)
	require.NotEqual(t, first.Boot, next.Boot)
	// An old event cannot consume the new connection's diagnostic.
	done := r.delayAcknowledgement(t.Context(), link, "branch", capturedEvent(1, [16]byte{1}))
	done(nil)
	current, err := r.ReadAckDelay("branch")
	require.NoError(t, err)
	require.Equal(t, "armed", current.State)
}
func TestAckDelayExpiryAndUnrelatedEvent(t *testing.T) {
	r := new(Registry)
	t.Cleanup(func() { require.NoError(t, r.Close()) })
	authority, err := r.MintBoot("branch", "vm")
	require.NoError(t, err)
	link, _ := connectTest(t, r, "branch", authority)
	require.NoError(t, link.Connection.Reconciled())
	_, err = r.AckDelay("branch", 10000, "", "")
	require.NoError(t, err)
	// A burst, hint or transcript must not consume the capture-only window.
	for _, kind := range []byte{1, 4, 5} {
		done := r.delayAcknowledgement(t.Context(), link, "branch", Event{Payload: []byte{kind}})
		done(nil)
	}
	receipt, err := r.ReadAckDelay("branch")
	require.NoError(t, err)
	require.Equal(t, "armed", receipt.State)
	r.ackDelayMu.Lock()
	r.ackDelays["branch"].receipt.ExpiresAt = time.Now().Add(-time.Second)
	r.ackDelayMu.Unlock()
	receipt, err = r.ReadAckDelay("branch")
	require.NoError(t, err)
	require.Equal(t, "expired", receipt.State)
	done := r.delayAcknowledgement(t.Context(), link, "branch", capturedEvent(1, [16]byte{1}))
	done(nil)
	receipt, err = r.ReadAckDelay("branch")
	require.NoError(t, err)
	require.Empty(t, receipt.Event)
	_, err = r.AckDelay("branch", 10000, "", "")
	require.NoError(t, err, "expired window permits a fresh attempt")
}

func TestAckDelayRestoreRequiresOwnedWindow(t *testing.T) {
	r := new(Registry)
	t.Cleanup(func() { require.NoError(t, r.Close()) })
	authority, err := r.MintBoot("branch", "vm")
	require.NoError(t, err)
	link, _ := connectTest(t, r, "branch", authority)
	require.NoError(t, link.Connection.Reconciled())
	_, err = r.AckDelay("branch", 0, "", "")
	require.ErrorIs(t, err, ErrUnauthorized)
	first, err := r.AckDelay("branch", 10000, "", "")
	require.NoError(t, err)
	for _, binding := range [][2]string{{"", ""}, {"foreign", first.Boot}, {first.ID, "foreign"}} {
		_, err = r.AckDelay("branch", 0, binding[0], binding[1])
		require.ErrorIs(t, err, ErrUnauthorized)
		current, err := r.ReadAckDelay("branch")
		require.NoError(t, err)
		require.Equal(t, first, current)
	}
	cancelled, err := r.AckDelay("branch", 0, first.ID, first.Boot)
	require.NoError(t, err)
	require.Equal(t, "cancelled", cancelled.State)
	repeated, err := r.AckDelay("branch", 0, first.ID, first.Boot)
	require.NoError(t, err)
	require.Equal(t, cancelled, repeated)
	second, err := r.AckDelay("branch", 10000, "", "")
	require.NoError(t, err)
	_, err = r.AckDelay("branch", 0, first.ID, first.Boot)
	require.ErrorIs(t, err, ErrUnauthorized)
	current, err := r.ReadAckDelay("branch")
	require.NoError(t, err)
	require.Equal(t, second, current)
	_, err = r.AckDelay("branch", 10000, second.ID, second.Boot)
	require.ErrorIs(t, err, ErrNotReady)
}
