package compose

import (
	"context"
	"os"
	"testing"

	"github.com/coder/websocket"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

// The guest reply is the literal result checked against the real Rust daemon
// by tests/outbox.rs. Host authentication, RPC correlation, readiness and the
// browser HTTP/WebSocket document door use production composition here.
func TestOutboxFormatRefusalKeepsComposedDocumentDoorUnsaved(t *testing.T) {
	f := newDocFixture(t)
	registry := new(machined.Registry)
	const branch = "11111111-1111-4111-8111-111111111111"
	link, peer := presenceTestLink(t, registry, branch)
	result, err := os.ReadFile("../../../../crates/smithers-machined/tests/data/outbox/refusal.result")
	require.NoError(t, err)
	done := make(chan error, 1)
	go func() {
		request, err := wire.Read(peer)
		if err != nil {
			done <- err
			return
		}
		fields, err := wire.Fields("request", request.Payload[1:])
		if err != nil {
			done <- err
			return
		}
		done <- wire.Write(peer, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, fields[1]), wire.Field(2, result))})
	}()
	response, err := link.Request(t.Context(), branch, wire.Status)
	require.NoError(t, err)
	require.NoError(t, <-done)
	fields, err := wire.Fields("response", response.Payload[1:])
	require.NoError(t, err)
	require.Equal(t, result, fields[2])
	require.ErrorIs(t, link.RequireReady(branch), machined.ErrNotReady)
	f.relay.Connection = func(context.Context, string) (*machined.Connection, live.DocumentRPC) {
		return link.Connection, machined.Documents(registry, branch)
	}
	for range 2 {
		f.sub(t, "doc:code:"+branch+":retry.ts")
		kind, body := f.read(t)
		require.Equal(t, websocket.MessageText, kind)
		require.Contains(t, string(body), "unsupported")
		require.NotContains(t, string(body), "saved")
	}
}
