package machined

import (
	"context"
	"sync/atomic"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

func TestEventObservationIncludesHintsAndRefusedEvents(t *testing.T) {
	registry := new(Registry)
	authority, err := registry.MintBoot("branch", "vm")
	require.NoError(t, err)
	var observed atomic.Int32
	stopObservation, err := registry.ObserveEventFrames(func(branch string, payload []byte) {
		require.Equal(t, "branch", branch)
		require.NotEmpty(t, payload)
		observed.Add(1)
		// Altering the observer's copy must not corrupt dispatch or ACK policy.
		payload[0] = 255
	})
	require.NoError(t, err)
	t.Cleanup(stopObservation)
	_, err = registry.ObserveEventFrames(func(string, []byte) {})
	require.ErrorIs(t, err, ErrNotReady)
	var writes atomic.Int32
	stop, err := registry.ConsumeEvents(t.Context(), func(context.Context, *Link, string, Event) (Acknowledgement, error) {
		writes.Add(1)
		return Acknowledgement{}, ErrUnauthorized
	})
	require.NoError(t, err)
	t.Cleanup(stop)
	_, peer := connectTest(t, registry, "branch", authority)
	hint := wire.Union(1, wire.Field(1, wire.String("changed.ts")), wire.Field(2, wire.Union(4)))
	require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Events, Payload: wire.Union(2, wire.Field(1, hint))}))
	sendConsumerEvent(t, peer, capturedEvent(7, [16]byte{1}))
	_, err = wire.Read(peer)
	require.Error(t, err, "refused event must not be acknowledged")
	require.Equal(t, int32(2), observed.Load())
	require.Equal(t, int32(1), writes.Load())
	stopObservation()
	stopObservation()
	registry.observeEvent("branch", []byte("after stop"))
	require.Equal(t, int32(2), observed.Load())
	replacement, err := registry.ObserveEventFrames(func(string, []byte) { observed.Add(1) })
	require.NoError(t, err)
	defer replacement()
	// A stale stop cannot detach the replacement.
	stopObservation()
	registry.observeEvent("branch", []byte("replacement"))
	require.Equal(t, int32(3), observed.Load())
}

func TestEventObservationRequiresObserver(t *testing.T) {
	var missing *Registry
	_, err := missing.ObserveEventFrames(func(string, []byte) {})
	require.ErrorIs(t, err, ErrNotReady)
	_, err = new(Registry).ObserveEventFrames(nil)
	require.ErrorIs(t, err, ErrNotReady)
}
