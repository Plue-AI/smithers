package machined

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

// The native composed queued-write test is in compose to avoid an import cycle.
// This independent wire control proves the Go rewrite client retains a blocker
// without fabricating a rewritten head or closing the admitted connection.
func TestMutationBusyRetainsBlockingSession(t *testing.T) {
	for _, method := range []wire.Method{wire.Rebase, wire.ReturnToItem} {
		t.Run(fmt.Sprint(method), func(t *testing.T) {
			registry, _, peer := rpcFixture(t)
			done := make(chan error, 1)
			go func() {
				var result RewriteResult
				var err error
				if method == wire.Rebase {
					result, err = registry.Rebase(t.Context(), "a", []byte("actor"), strings.Repeat("a", 40))
				} else {
					result, err = registry.ReturnToItem(t.Context(), "a", []byte("actor"))
				}
				if result.Head != "" {
					done <- errors.New("busy reply published a rewritten head")
					return
				}
				done <- err
			}()
			frame, err := wire.Read(peer)
			require.NoError(t, err)
			correlation, got, _, err := frame.Request()
			require.NoError(t, err)
			require.Equal(t, byte(method), got)
			// Literal ADR 0004 busy code and fixed session 73, not a production
			// refusal encoder or an oracle derived from the daemon.
			require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Control, Payload: wire.Union(2,
				wire.Field(1, wire.U32(correlation)), wire.Field(2, wire.Union(255,
					wire.Field(1, []byte{9}), wire.Field(4, []byte{0, 0, 0, 73}))))}))
			var refusal *SessionError
			require.ErrorAs(t, <-done, &refusal)
			require.Equal(t, "busy", refusal.Code)
			require.EqualValues(t, 73, refusal.Session)
			link, err := registry.Current("a")
			require.NoError(t, err)
			require.NoError(t, link.RequireReady("a"))
		})
	}
}

func TestMutationBatchBusyRetainsBlockingSession(t *testing.T) {
	registry, _, peer := rpcFixture(t)
	done := make(chan error, 1)
	go func() {
		result, err := registry.WriteFiles(t.Context(), "a", []byte("actor"), []FileChange{{Path: "README.md", Content: []byte("queued bytes")}})
		if len(result.Applied) != 0 {
			done <- errors.New("busy preflight applied a write")
			return
		}
		done <- err
	}()
	answer(t, peer, wire.WriteFiles, wire.Field(1, []byte{0, 0}), wire.Field(2, wire.Struct(
		wire.Field(1, []byte{0, 0}), wire.Field(2, []byte{1}), wire.Field(3, wire.Struct(
			wire.Field(1, []byte{9}), wire.Field(4, []byte{0, 0, 0, 73}))))))
	var refusal *SessionError
	require.ErrorAs(t, <-done, &refusal)
	require.Equal(t, "busy", refusal.Code)
	require.EqualValues(t, 73, refusal.Session)
}
