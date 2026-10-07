package machined

import (
	"context"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

func TestOwnerCredentialPrepareUsesOwnerSessionBeforeToken(t *testing.T) {
	r, l, peer := rpcFixture(t)
	sessions := NewSessions(l.Connection, "a", r.Sessions("a"))
	writer := NewOwnerSessionCredentials(sessions, SessionUser{"ben", 20001}, "a")
	done := make(chan error, 1)
	go func() { done <- writer.Prepare(t.Context(), "session-a") }()
	frame, err := wire.Read(peer)
	require.NoError(t, err)
	id, method, _, err := frame.Request()
	require.NoError(t, err)
	require.Equal(t, byte(wire.OpenSession), method)
	require.Contains(t, string(frame.Payload), "ben")
	require.Contains(t, string(frame.Payload), "/usr/bin/python3")
	require.NotContains(t, string(frame.Payload), "smithers_delegated")
	require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(byte(wire.OpenSession), wire.Field(1, wire.U32(17)))))}))
	require.NoError(t, <-done)
	go func() {
		path, err := writer.PutSessionToken(t.Context(), "a", "session-a", []byte("smithers_delegated"), "")
		if err == nil && path != "/run/smithers/20001/token/sessions/session-a/token" {
			t.Error(path)
		}
		done <- err
	}()
	frame, err = wire.Read(peer)
	require.NoError(t, err)
	require.Equal(t, wire.Sessions, frame.Kind)
	require.Equal(t, append([]byte{1, 0}, []byte("smithers_delegated")...), frame.Payload)
	frame, err = wire.Read(peer)
	require.NoError(t, err)
	require.Equal(t, []byte{2, 0}, frame.Payload)
	sendSession(t, peer, []byte{5, 0, 0, 0, 0, 0})
	answer(t, peer, wire.CloseSession)
	require.NoError(t, <-done)
	writer.ClosePrepared()
}
func TestOwnerCredentialPrepareRefusesUnavailableBroker(t *testing.T) {
	calls := 0
	sessions := testSessions(t, sessionRPCFunc(func(context.Context, SessionCall) (SessionResult, error) {
		calls++
		return SessionResult{}, refused("unsupported", "providers missing")
	}))
	writer := NewOwnerSessionCredentials(sessions, SessionUser{"ben", 20001}, "branch")
	require.Error(t, writer.Prepare(t.Context(), "session-a"))
	require.Equal(t, 1, calls)
	writer.ClosePrepared()
}
