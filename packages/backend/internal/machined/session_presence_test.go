package machined

import (
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestSessionPresenceAdmittedIdentityAndLifecycle(t *testing.T) {
	registry, link, guest := rpcFixture(t)
	s := NewSessions(link.Connection, "a", registry.Sessions("a")).WithActor([]byte("actor-reference1"), "").WithPresenceVia("terminal")
	result := make(chan error, 1)
	go func() {
		_, err := s.OpenSession(t.Context(), SessionUser{"alice", 20001}, SessionPTY, nil, nil)
		result <- err
	}()
	answer(t, guest, wire.OpenSession, wire.Field(1, wire.U32(1)))
	require.NoError(t, <-result)
	user, run, via, err := link.SessionPresence("a", 1)
	require.NoError(t, err)
	require.Equal(t, SessionUser{"alice", 20001}, user)
	require.Empty(t, run)
	require.Equal(t, "terminal", via)
	_, _, _, err = link.SessionPresence("b", 1)
	require.ErrorIs(t, err, ErrUnauthorized)
	_, _, _, err = link.SessionPresence("a", 2)
	require.ErrorIs(t, err, ErrUnauthorized)
	require.ErrorIs(t, s.RegisterRun(t.Context(), "run-1", 1), ErrUnauthorized)
	_, run, _, err = link.SessionPresence("a", 1)
	require.NoError(t, err)
	require.Empty(t, run)
	go func() { result <- s.CloseSession(t.Context(), 1) }()
	answer(t, guest, wire.CloseSession)
	require.NoError(t, <-result)
	_, _, _, err = link.SessionPresence("a", 1)
	require.ErrorIs(t, err, ErrUnauthorized)
	require.NoError(t, link.Close())
	_, _, _, err = link.SessionPresence("a", 1)
	require.Error(t, err)
}

func TestSessionPresenceTransportRefusesUnavailableOrInvalidAdapters(t *testing.T) {
	var missing *Sessions
	require.Nil(t, missing.WithPresenceVia("ssh"))
	registry, link, _ := rpcFixture(t)
	s := NewSessions(link.Connection, "a", registry.Sessions("a")).WithActor([]byte("actor-reference1"), "").WithPresenceVia("spoof")
	_, err := s.OpenSession(t.Context(), SessionUser{"alice", 20001}, SessionPTY, nil, nil)
	var refusal *SessionError
	require.ErrorAs(t, err, &refusal)
	require.Equal(t, "unauthorized", refusal.Code)
}

func TestRunPresenceRequiresRegisteredLiveAgent(t *testing.T) {
	registry, link, guest := rpcFixture(t)
	s := NewSessions(link.Connection, "a", registry.Sessions("a")).WithActor([]byte("actor-reference1"), "").WithPresenceVia("cli")
	_, err := link.RunPresence("a", "run-1")
	require.ErrorIs(t, err, ErrUnauthorized)
	done := make(chan error, 1)
	go func() {
		_, err := s.WithActor([]byte("actor-reference1"), "run-1").OpenSession(t.Context(), SessionUser{"agent", 19999}, SessionExec, []string{"/bin/true"}, nil)
		done <- err
	}()
	answer(t, guest, wire.OpenSession, wire.Field(1, wire.U32(7)))
	require.NoError(t, <-done)
	{
		via, err := link.RunPresence("a", "run-1")
		require.NoError(t, err)
		require.Equal(t, "cli", via)
		require.ErrorIs(t, s.RegisterRun(t.Context(), "replacement", 7), ErrUnauthorized)
	}
	go func() { done <- s.RegisterRun(t.Context(), "run-1", 7) }()
	answer(t, guest, wire.RegisterRun)
	require.NoError(t, <-done)
	via, err := link.RunPresence("a", "run-1")
	require.NoError(t, err)
	require.Equal(t, "cli", via)
	for _, run := range []string{"", "foreign"} {
		_, err = link.RunPresence("a", run)
		require.ErrorIs(t, err, ErrUnauthorized)
	}
	_, err = link.RunPresence("other", "run-1")
	require.ErrorIs(t, err, ErrUnauthorized)
	go func() { done <- s.CloseSession(t.Context(), 7) }()
	answer(t, guest, wire.CloseSession)
	require.NoError(t, <-done)
	_, err = link.RunPresence("a", "run-1")
	require.ErrorIs(t, err, ErrUnauthorized)
}
