package machined

import (
	"context"
	"io"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

func TestTerminalAdapterBytesCreditResizeExit(t *testing.T) {
	_, _, peer, stream, _ := sessionFixture(t)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	terminal := &Terminal{stream: stream, ctx: ctx, cancel: cancel}
	sent := make(chan error, 1)
	go func() { _, err := terminal.Write([]byte("input")); sent <- err }()
	frame, err := wire.Read(peer)
	require.NoError(t, err)
	require.Equal(t, []byte{1, 0, 'i', 'n', 'p', 'u', 't'}, frame.Payload)
	require.NoError(t, <-sent)
	go func() { sent <- terminal.Resize(ctx, 100, 40) }()
	frame, err = wire.Read(peer)
	require.NoError(t, err)
	require.Equal(t, []byte{3, 0, 40, 0, 100}, frame.Payload)
	require.NoError(t, <-sent)
	require.Error(t, terminal.Resize(ctx, 0, 24))
	sendSession(t, peer, []byte{1, 1, 'o', 'u', 't'})
	result := make(chan []byte, 1)
	go func() { b := make([]byte, 2); n, err := terminal.Read(b); sent <- err; result <- b[:n] }()
	frame, err = wire.Read(peer)
	require.NoError(t, err)
	require.Equal(t, []byte{6, 0, 0, 0, 3}, frame.Payload)
	require.NoError(t, <-sent)
	require.Equal(t, []byte("ou"), <-result)
	b := make([]byte, 8)
	n, err := terminal.Read(b)
	require.NoError(t, err)
	require.Equal(t, "t", string(b[:n]))
	sendSession(t, peer, []byte{5, 0, 0, 0, 0, 0})
	_, err = terminal.Read(b)
	require.ErrorIs(t, err, io.EOF)
	go func() { sent <- terminal.Close() }()
	answer(t, peer, wire.CloseSession)
	require.NoError(t, <-sent)
	require.NoError(t, terminal.Close())
}

func TestOwnerCredentialWriterRefusesBeforeRPC(t *testing.T) {
	calls := 0
	sessions := testSessions(t, sessionRPCFunc(func(context.Context, SessionCall) (SessionResult, error) { calls++; return SessionResult{}, nil }))
	writer := NewOwnerSessionCredentials(sessions, SessionUser{"ben", 20001}, "branch")
	for _, row := range []struct {
		branch, id, expected string
		token                []byte
	}{
		{"foreign", "session-a", "", []byte("token")},
		{"branch", "../other", "", []byte("token")},
		{"branch", "session-a", "bad", []byte("token")},
		{"branch", "session-a", "", nil},
		{"branch", "session-a", "", []byte("not a token")},
	} {
		_, err := writer.PutSessionToken(t.Context(), row.branch, row.id, row.token, row.expected)
		require.Error(t, err)
	}
	require.Error(t, writer.DeleteSessionToken(t.Context(), "branch", "session-a", ""))
	require.Zero(t, calls)
	for _, user := range []SessionUser{{"root", 0}, {"agent", 19999}, {"ben", 0}, {"../ben", 20001}} {
		_, err := NewOwnerSessionCredentials(sessions, user, "branch").PutSessionToken(t.Context(), "branch", "session-a", []byte("token"), "")
		require.Error(t, err)
	}
	require.Zero(t, calls)
}
