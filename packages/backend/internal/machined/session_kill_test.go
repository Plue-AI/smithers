package machined

import (
	"context"
	"io"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

func TestKillSessionConfirmsOnlyTargetAndAllowsRepeatedCancellation(t *testing.T) {
	r, link, peer := rpcFixture(t)
	s := NewSessions(link.Connection, "a", r.Sessions("a")).WithActor([]byte("actor-reference1"), "coding-run")
	for _, id := range []uint32{1, 2} {
		done := make(chan error, 1)
		go func() {
			_, err := s.OpenSession(t.Context(), SessionUser{"agent", 19999}, SessionExec, []string{"command"}, nil)
			done <- err
		}()
		answer(t, peer, wire.OpenSession, wire.Field(1, wire.U32(id)))
		require.NoError(t, <-done)
	}
	first, err := s.Stream(t.Context(), 1)
	require.NoError(t, err)
	second, err := s.Stream(t.Context(), 2)
	require.NoError(t, err)
	for _, count := range []uint16{1, 0} {
		done := make(chan error, 1)
		go func() {
			n, err := s.KillSession(t.Context(), 1)
			if err == nil {
				require.Equal(t, count, n)
			}
			done <- err
		}()
		req, err := wire.Read(peer)
		require.NoError(t, err)
		id, method, args, err := req.Request()
		require.NoError(t, err)
		require.Equal(t, byte(wire.KillSessions), method)
		f, err := wire.Fields("args9", args)
		require.NoError(t, err)
		require.Equal(t, []byte{3, 0, 0, 0, 5, 1, 0, 0, 0, 1}, f[1])
		require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(method, wire.Field(1, wire.U16(count)))))}))
		require.NoError(t, <-done)
	}
	_, err = first.Receive(t.Context())
	require.ErrorIs(t, err, io.EOF)
	_, run, _, err := link.SessionPresence("a", 2)
	require.NoError(t, err)
	require.Equal(t, "coding-run", run)
	require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Sessions, Stream: 2, Payload: []byte{1, 1, 'o', 'k'}}))
	got, err := second.Receive(t.Context())
	require.NoError(t, err)
	require.Equal(t, []byte{1, 1, 'o', 'k'}, got)
	// A replacement connection cannot reuse the old handle to kill another ID.
	authority, err := r.MintBoot("a", "replacement")
	require.NoError(t, err)
	replacement, _ := connectTest(t, r, "a", authority)
	require.NoError(t, replacement.Reconciled())
	_, err = s.KillSession(t.Context(), 1)
	errorCode(t, err, "unauthorized")
}

func TestKillSessionRejectsInvalidTargetsAndOldPeersBeforeSending(t *testing.T) {
	r, link, _ := rpcFixture(t)
	s := NewSessions(link.Connection, "a", r.Sessions("a"))
	for _, id := range []uint32{0, 0x80000000, ^uint32(0)} {
		_, err := s.KillSession(t.Context(), id)
		errorCode(t, err, "malformed")
	}
	for _, version := range []uint16{1, 2, 3} {
		link.protocol = version // immutable in production; fixture is idle
		ctx, cancel := context.WithTimeout(t.Context(), time.Second)
		_, err := s.KillSession(ctx, 1)
		cancel()
		errorCode(t, err, "unsupported")
	}
	for _, call := range []SessionCall{
		{Method: "kill_sessions"},
		{Method: "kill_sessions", Session: 1, Run: "run"},
		{Method: "kill_sessions", Session: 1, User: &SessionUser{"alice", 20001}},
		{Method: "kill_sessions", Run: "run", User: &SessionUser{"alice", 20001}},
	} {
		_, err := r.Sessions("a").CallSession(t.Context(), call)
		require.ErrorIs(t, err, wire.BadValue)
	}
}

func TestKillSessionDoesNotClaimUnconfirmedCleanup(t *testing.T) {
	for _, badCount := range []uint16{2, 65535} {
		t.Run("invalid_count", func(t *testing.T) {
			r, link, peer := rpcFixture(t)
			s := NewSessions(link.Connection, "a", r.Sessions("a"))
			done := make(chan error, 1)
			go func() { _, err := s.KillSession(t.Context(), 1); done <- err }()
			answer(t, peer, wire.KillSessions, wire.Field(1, wire.U16(badCount)))
			require.ErrorIs(t, <-done, wire.BadValue)
			require.Error(t, link.RequireReady("a"))
		})
	}
	r, link, peer := rpcFixture(t)
	s := NewSessions(link.Connection, "a", r.Sessions("a"))
	done := make(chan error, 1)
	go func() { _, err := s.KillSession(t.Context(), 1); done <- err }()
	req, err := wire.Read(peer)
	require.NoError(t, err)
	id, _, _, err := req.Request()
	require.NoError(t, err)
	// The broker may have killed some descendants but cannot confirm emptiness.
	require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(255, wire.Field(1, []byte{12}))))}))
	errorCode(t, <-done, "internal")
}
