package compose

import (
	"encoding/hex"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
	"sync/atomic"
	"testing"
)

// Only the guest is simulated: capture uses the install registry, authenticated
// event consumer, native object verifier and PostgreSQL projection. This does
// not qualify VM timing or root boundaries on the reference Mac.
func branchCapturePeer(t *testing.T, registry *machined.Registry, branch, old, head, tree, staleBase, mode string) *atomic.Int32 {
	t.Helper()
	link, guest := presenceTestLink(t, registry, branch)
	require.NoError(t, link.Reconciled())
	calls := new(atomic.Int32)
	bytesOf := func(s string) []byte { v, e := hex.DecodeString(s); require.NoError(t, e); return v }
	headBytes, treeBytes := bytesOf(head), bytesOf(tree)
	done := make(chan error, 1)
	go func() {
		var seq uint64
		for {
			frame, err := wire.Read(guest)
			if err != nil {
				done <- err
				return
			}
			if frame.Kind != wire.Control {
				continue
			}
			id, method, _, err := frame.Request()
			if err != nil {
				done <- err
				return
			}
			result := wire.Union(method)
			if method == byte(wire.Capture) {
				calls.Add(1)
				if mode == "s2-fail" {
					result = wire.Union(255, wire.Field(1, []byte{3}))
				} else {
					seq++
					base := old
					if mode == "s2-stale" {
						base = staleBase
					}
					event := wire.Union(2, wire.Field(1, headBytes), wire.Field(2, treeBytes), wire.Field(3, bytesOf(base)))
					eventID := [16]byte{77, byte(seq)}
					err = wire.Write(guest, wire.Frame{Kind: wire.Events, Payload: wire.Union(1, wire.Field(1, wire.U64(seq)), wire.Field(2, eventID[:]), wire.Field(3, event))})
					if err != nil {
						done <- err
						return
					}
					// Drain control frames until this capture is durably acknowledged.
					for {
						ack, err := wire.Read(guest)
						if err != nil {
							done <- err
							return
						}
						if ack.Kind == wire.Events && ack.Payload[0] == 3 {
							break
						}
					}
					old = head
					result = wire.Union(method, wire.Field(1, headBytes), wire.Field(2, treeBytes), wire.Field(3, wire.U16(1)))
				}
			}
			err = wire.Write(guest, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, result))})
			if err != nil {
				done <- err
				return
			}
		}
	}()
	t.Cleanup(func() { guest.Close(); <-done })
	return calls
}
