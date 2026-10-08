package machined

import (
	"context"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

func TestRunCleanupUsesReconnectedMachine(t *testing.T) {
	r := new(Registry)
	boot, err := r.MintBoot("a", "vm")
	require.NoError(t, err)
	old, _ := connectTest(t, r, "a", boot)
	require.NoError(t, old.Reconciled())
	current, peer := connectTest(t, r, "a", boot)
	require.NoError(t, current.Reconciled())
	require.Error(t, old.RequireReady("a"))
	done := make(chan error, 1)
	go func() { done <- r.KillRunOnMachine(t.Context(), "a", "vm", "coding-run") }()
	frame, err := wire.Read(peer)
	require.NoError(t, err)
	id, method, args, err := frame.Request()
	require.NoError(t, err)
	require.Equal(t, byte(wire.KillSessions), method)
	fields, err := wire.Fields("args9", args)
	require.NoError(t, err)
	// Selector 2 is a run; it is not a user or a broker-selected session.
	require.Equal(t, wire.Union(2, wire.Field(1, wire.String("coding-run"))), fields[1])
	require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(byte(wire.KillSessions), wire.Field(1, wire.U16(2)))))}))
	require.NoError(t, <-done)
	require.NoError(t, current.RequireReady("a"))
}

func TestRunCleanupRefusesReplacementMachine(t *testing.T) {
	r, _, _ := rpcFixture(t)
	boot, err := r.MintBoot("a", "replacement")
	require.NoError(t, err)
	current, peer := connectTest(t, r, "a", boot)
	require.NoError(t, current.Reconciled())
	require.ErrorIs(t, r.KillRunOnMachine(t.Context(), "a", "vm", "coding-run"), ErrUnauthorized)
	require.NoError(t, current.RequireReady("a"))
	require.NoError(t, peer.SetReadDeadline(time.Now().Add(20*time.Millisecond)))
	_, err = wire.Read(peer)
	require.Error(t, err, "no kill request may reach the replacement machine")
}

func TestRunCleanupFencesOnlyAttemptedConnection(t *testing.T) {
	r, original, peer := rpcFixture(t)
	done := make(chan error, 1)
	go func() { done <- r.KillRunOnMachine(t.Context(), "a", "vm", "coding-run") }()
	_, err := wire.Read(peer)
	require.NoError(t, err)
	boot, err := r.MintBoot("a", "replacement")
	require.NoError(t, err)
	replacement, _ := connectTest(t, r, "a", boot)
	require.NoError(t, replacement.Reconciled())
	require.Error(t, <-done)
	require.Error(t, original.RequireReady("a"))
	require.NoError(t, replacement.RequireReady("a"))
	// A caller cancellation without a receipt fences the attempted live link.
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	require.ErrorIs(t, r.KillRunOnMachine(ctx, "a", "replacement", "coding-run"), context.Canceled)
	require.Error(t, replacement.RequireReady("a"))
}
