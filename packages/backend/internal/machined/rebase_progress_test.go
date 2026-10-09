package machined

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

func TestRebaseProgressRetainsCancelledMutationUntilReply(t *testing.T) {
	for _, outcome := range []string{"success", "busy", "retired"} {
		t.Run(outcome, func(t *testing.T) {
			r, link, peer := rpcFixture(t)
			require.False(t, link.Rebasing("a"))
			require.False(t, link.Rebasing("other"))
			_, err := link.Request(t.Context(), "a", wire.Rebase)
			require.Error(t, err)
			require.False(t, link.Rebasing("a"), "malformed calls never begin progress")
			ctx, cancel := context.WithCancel(t.Context())
			done := make(chan error, 1)
			go func() { _, err := r.Rebase(ctx, "a", []byte("actor"), strings.Repeat("ab", 20)); done <- err }()
			frame, err := wire.Read(peer)
			require.NoError(t, err)
			id, method, _, err := frame.Request()
			require.NoError(t, err)
			require.Equal(t, byte(wire.Rebase), method)
			require.True(t, link.Rebasing("a"))
			require.False(t, link.Rebasing("other"))
			// Let the successful pipe write return before cancelling the
			// reply wait; cancellation during transport retires the link.
			time.Sleep(10 * time.Millisecond)
			cancel()
			require.ErrorIs(t, <-done, context.Canceled)
			require.True(t, link.Rebasing("a"), "dropping the caller does not stop the guest")
			switch outcome {
			case "retired":
				_, err := r.MintBoot("a", "replacement")
				require.NoError(t, err)
				require.False(t, link.Rebasing("a"), "an old boot cannot supply live progress")
			default:
				result := wire.Union(byte(wire.Rebase), wire.Field(1, make([]byte, 20)), wire.Field(2, wire.U16(0)))
				if outcome == "busy" {
					result = wire.Union(255, wire.Field(1, []byte{9}), wire.Field(4, wire.U32(7)))
				}
				require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, result))}))
				require.Eventually(t, func() bool { return !link.Rebasing("a") }, time.Second, time.Millisecond)
			}
		})
	}
}
